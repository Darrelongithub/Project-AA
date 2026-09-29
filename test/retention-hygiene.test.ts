/** Audit Group F — delete/archive hygiene.
 * R7: full case delete covers error_events (the enforced FK threw
 *     SQLITE_CONSTRAINT on cases with recorded errors).
 * R9: demo-staff purge clears staff child rows first (sessions, reset
 *     codes, notifications, permission/scope rows) and nulls surviving
 *     task/note attributions instead of aborting on the FKs.
 * R8: the retention archive carries the case's error_events.
 * R14: the archive directory mode is ENFORCED every run (mkdir's mode
 *      applies at creation only — a 0755 dir from an older release
 *      stayed open); backups and purge backups locked to 0600.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "node:child_process";
import { Repo } from "../src/db/repo";
import { openDb } from "../src/db/db";
import { seedDefaults } from "../src/db/seed";
import { DEFAULT_REQUIREMENTS } from "../src/config";
import { hashPassword } from "../src/util/password";
import { purgeMockData } from "../src/db/purge";
import { ARCHIVE_ENC_SUFFIX, decryptArchive } from "../src/archive/crypto";

/** Clearly-fake vector — NEVER use for real data (see ARCHIVE_ENCRYPTION.md). */
const TEST_KEY_HEX = "0123456789abcdef".repeat(4);
const TEST_KEY = Buffer.from(TEST_KEY_HEX, "hex");
const REPO = path.resolve(__dirname, "..");

function runCli(script: string, args: string[], env: Record<string, string | undefined>) {
  return spawnSync("./node_modules/.bin/tsx", [script, ...args], {
    cwd: REPO,
    env: { ...process.env, ...env },
    timeout: 60_000,
    encoding: "utf8",
  });
}

function fresh(): Repo {
  const repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  return repo;
}

describe("audit F — R7: full delete covers error events", () => {
  it("deletes a case with recorded errors without an FK violation", () => {
    const repo = fresh();
    const a = repo.getOrCreateApplicant("err-case@example.test", "t-err");
    repo.recordErrorEvent({ source: "ingest", applicant_id: a.id, message: "boom", detail: "d" });
    expect(repo.errorEventsForApplicant(a.id)).toHaveLength(1);
    expect(() => repo.deleteApplicantFull(a.id)).not.toThrow();
    expect(repo.getApplicant(a.id)).toBeUndefined();
    expect(repo.db.prepare("SELECT COUNT(*) AS n FROM error_events").get()).toMatchObject({ n: 0 });
  });
});

describe("audit F — R9: purge clears demo staff children", () => {
  it("removes sessions, codes, notifications and grants with the account", () => {
    const repo = fresh();
    repo.createStaff("demo_admin", "Demo Admin", hashPassword("demo123"), "admin", true);
    repo.createStaff("realadmin", "Real Admin", hashPassword("real-password-99"), "admin");
    const demo = repo.getStaffByUsername("demo_admin")!;
    const real = repo.getStaffByUsername("realadmin")!;
    repo.createSession(demo.id);
    repo.issueResetCode(demo.id, "realadmin");
    repo.notify("review_needed", "demo note", null, demo.id);
    repo.setPermissions(demo.id, ["send_automated"]);
    repo.createSession(real.id);
    // Legacy-shaped data: a demo-attributed note surviving on a LIVE case.
    const live = repo.getOrCreateApplicant("live@example.test", "t-live");
    repo.db.prepare("INSERT INTO notes (applicant_id, staff_id, body) VALUES (?, ?, ?)").run(live.id, demo.id, "keep me");
    repo.db.prepare("UPDATE applicants SET assigned_to = ? WHERE id = ?").run(demo.id, live.id);

    const removed = purgeMockData(repo, {});
    expect(removed.staff).toBe(1);
    expect(repo.getStaffByUsername("demo_admin")).toBeUndefined();
    expect(repo.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE staff_id = ?").get(demo.id)).toMatchObject({ n: 0 });
    expect(repo.db.prepare("SELECT COUNT(*) AS n FROM password_reset_codes WHERE staff_id = ?").get(demo.id)).toMatchObject({ n: 0 });
    expect(repo.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE staff_id = ?").get(demo.id)).toMatchObject({ n: 0 });
    expect(repo.db.prepare("SELECT COUNT(*) AS n FROM staff_permissions WHERE staff_id = ?").get(demo.id)).toMatchObject({ n: 0 });
    // The live admin's session and the live note survive (note unattributed).
    expect(repo.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE staff_id = ?").get(real.id)).toMatchObject({ n: 1 });
    const note = repo.db.prepare("SELECT staff_id, body FROM notes WHERE applicant_id = ?").get(live.id) as { staff_id: number | null; body: string };
    expect(note).toMatchObject({ staff_id: null, body: "keep me" });
    // G6: the assignment NULLs instead of aborting the purge on the FK.
    const assignee = repo.db.prepare("SELECT assigned_to AS a FROM applicants WHERE id = ?").get(live.id) as { a: number | null };
    expect(assignee.a).toBeNull();
  });
});

describe("audit F — R8/R14: archive carries errors and locks the directory", () => {
  function scratchDbWithOldCase(): { dir: string; dbPath: string; ref: string; applicantId: number } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audf-retain-"));
    const dbPath = path.join(dir, "t.sqlite");
    const r = new Repo(openDb(dbPath));
    seedDefaults(r);
    r.seedBaseRequirements(DEFAULT_REQUIREMENTS);
    const a = r.getOrCreateApplicant("oldf@example.ke", "t1f");
    const old = new Date(Date.now() - 1000 * 24 * 3600_000).toISOString();
    r.db.prepare("UPDATE applicants SET lifecycle='completed', demo=0, updated_at=? WHERE id=?").run(old, a.id);
    r.recordErrorEvent({ source: "ingest", applicant_id: a.id, message: "fetch failed once", detail: "attempt 1" });
    const full = r.getApplicant(a.id)!;
    return { dir, dbPath, ref: full.ref_number, applicantId: a.id };
  }

  it("archives error_events and enforces 0700 on a pre-existing 0755 dir", () => {
    const { dir, dbPath, ref } = scratchDbWithOldCase();
    // Simulate a directory left behind by an older release.
    fs.mkdirSync(path.join(dir, "archive"), { recursive: true });
    fs.chmodSync(path.join(dir, "archive"), 0o755);
    const run = runCli("src/cli/retain.ts", [], { ARCHIVE_KEY: TEST_KEY_HEX, DB_PATH: dbPath, DISABLE_OCR: "1" });
    expect(run.status).toBe(0);
    expect(fs.statSync(path.join(dir, "archive")).mode & 0o777).toBe(0o700);
    const files = fs.readdirSync(path.join(dir, "archive"));
    expect(files).toEqual([`${ref}${ARCHIVE_ENC_SUFFIX}`]);
    const record = JSON.parse(decryptArchive(fs.readFileSync(path.join(dir, "archive", files[0]), "utf8"), TEST_KEY)) as {
      error_events: Array<{ message: string; detail: string }>;
    };
    expect(record.error_events).toHaveLength(1);
    expect(record.error_events[0]).toMatchObject({ message: "fetch failed once" });
    const r2 = new Repo(openDb(dbPath));
    expect(r2.allApplicants(0).length).toBe(0);
  });
});
