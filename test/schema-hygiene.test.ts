/**
 * Group G — schema hygiene.
 *
 * History: the console tamper query scanned the 500 newest applicants and
 * filtered to decided ones AFTER the LIMIT, so 500 newer undecided cases
 * could crowd a tampered decision out of the window (C2). The per-user bell
 * queries had no index at all (C3). Dead letters carried no org, so the
 * console could never show them per-org (ST-P12 / C10). Each test below
 * fails on the pre-fix code and passes after.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { hashPassword } from "../src/util/password";
import { ingestNewEmails, resolveFailureOrg } from "../src/ingestion";
import type { GmailClient } from "../src/ingestion/gmailClient";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";

let repo: Repo;

beforeEach(() => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  repo.createStaff("admin1", "Org One Admin", hashPassword("x"), "admin", false, 1);
});

afterEach(() => {
  repo.db.close();
});

describe("C2 — tamper window is decided-only", () => {
  it("still flags a tampered decision crowded out by 500 newer undecided cases", () => {
    // Tampered FIRST (lowest id): a human outcome with no audit trail.
    const tampered = repo.getOrCreateApplicant("tampered@example.org", "t-tampered", { organizationId: 1 }).id;
    repo.db.prepare("UPDATE applicants SET admission_decision = 'not_admitted', admission_route = 'human', decision_by = 'admin1' WHERE id = ?").run(tampered);
    // Then 500 newer undecided cases — the old inner LIMIT 500 saw ONLY
    // these and the flag silently vanished.
    for (let i = 0; i < 500; i++) {
      repo.getOrCreateApplicant(`crowd${i}@example.org`, `t-crowd${i}`, { organizationId: 1 });
    }
    const flags = repo.consoleTamperOutcomes(1).filter((r) => r.signal === "no_trail").map((r) => r.applicant_id);
    expect(flags).toEqual([tampered]);
  });
});

describe("C3 — notifications staff index", () => {
  it("exists with (staff_id, read, id) and serves the bell query", () => {
    const cols = repo.db.prepare("PRAGMA index_info(idx_notifications_staff)").all() as Array<{ seqno: number; name: string }>;
    expect(cols.map((c) => c.name)).toEqual(["staff_id", "read", "id"]);
    // Exact unreadCount shape (public bell count): the covering index must
    // serve both arms of the broadcast-or-addressed OR — no table scan.
    const plan = repo.db.prepare(
      `EXPLAIN QUERY PLAN SELECT COUNT(*) AS n FROM notifications n LEFT JOIN applicants a ON a.id = n.applicant_id
       WHERE (n.staff_id IS NULL OR n.staff_id = 1) AND n.read = 0`
    ).all() as Array<{ detail: string }>;
    const details = plan.map((p) => p.detail);
    expect(details.some((d) => d.includes("idx_notifications_staff"))).toBe(true);
    expect(details.some((d) => d.includes("SCAN n"))).toBe(false);
  });
});

describe("C10/ST-P12 — dead-letter org threading", () => {
  it("persists the org on record and keeps the first attribution on repeat", () => {
    repo.recordDeadLetter({ message_id: "m-org", subject: "s", from_addr: "a@x", error: "boom", organization_id: 2 });
    const row = repo.db.prepare("SELECT organization_id AS o FROM dead_letters WHERE message_id = ?").get("m-org") as { o: number | null };
    expect(row.o).toBe(2);
    // A retry that arrives without org context must not wipe attribution.
    repo.recordDeadLetter({ message_id: "m-org", subject: "s", from_addr: "a@x", error: "boom2" });
    const row2 = repo.db.prepare("SELECT organization_id AS o, attempts AS a FROM dead_letters WHERE message_id = ?").get("m-org") as { o: number | null; a: number };
    expect(row2).toMatchObject({ o: 2, a: 2 });
  });

  it("resolveFailureOrg: sender case org, else NULL", () => {
    const a = repo.getOrCreateApplicant("known@example.org", "t-known", { organizationId: 1 });
    expect(resolveFailureOrg(repo, a.id)).toBe(1);
    expect(resolveFailureOrg(repo, undefined)).toBeNull(); // unknown sender
    expect(resolveFailureOrg(repo, 424242)).toBeNull(); // deleted/guessed case
  });

  it("fetch failures stay NULL-org and never create cases", async () => {
    const gmail = {
      listRecentMessageIds: async () => ["m-fetch-fail"],
      fetchEmail: async () => { throw new Error("imap exploded"); },
      watchTarget: () => "test-mailbox",
    } as unknown as GmailClient;
    const ctx: PipelineContext = { repo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender: new MockSender() } };
    const before = (repo.db.prepare("SELECT COUNT(*) AS n FROM applicants").get() as { n: number }).n;
    await ingestNewEmails(gmail, ctx, 1);
    const row = repo.db.prepare("SELECT organization_id AS o FROM dead_letters WHERE message_id = ?").get("m-fetch-fail") as { o: number | null };
    expect(row.o).toBeNull();
    expect((repo.db.prepare("SELECT COUNT(*) AS n FROM applicants").get() as { n: number }).n).toBe(before);
  });

  it("migrates a pre-org dead_letters table in place", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dl-org-")), "old.db");
    try {
      // A database from before ST-P12: dead_letters without organization_id.
      const oldDb = new (require("better-sqlite3"))(file) as {
        exec: (sql: string) => void; close: () => void;
      };
      oldDb.exec(`CREATE TABLE dead_letters (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL UNIQUE,
        subject TEXT NOT NULL DEFAULT '', from_addr TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
        attempts INTEGER NOT NULL DEFAULT 1, dead INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));`);
      oldDb.exec(`INSERT INTO dead_letters (message_id, subject, from_addr, error, attempts, dead) VALUES ('m-legacy', 's', 'a@x', 'boom', 3, 0);`);
      oldDb.close();
      const migrated = new Repo(openDb(file));
      try {
        const cols = migrated.db.prepare("PRAGMA table_info(dead_letters)").all() as Array<{ name: string }>;
        expect(cols.map((c) => c.name)).toContain("organization_id");
        const legacy = migrated.db.prepare("SELECT attempts AS a, organization_id AS o FROM dead_letters WHERE message_id = ?").get("m-legacy") as { a: number; o: number | null };
        expect(legacy).toEqual({ a: 3, o: null });
        migrated.recordDeadLetter({ message_id: "m-new", subject: "s", from_addr: "b@x", error: "x", organization_id: 1 });
        const fresh = migrated.db.prepare("SELECT organization_id AS o FROM dead_letters WHERE message_id = ?").get("m-new") as { o: number | null };
        expect(fresh.o).toBe(1);
      } finally {
        migrated.db.close();
      }
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });
});
