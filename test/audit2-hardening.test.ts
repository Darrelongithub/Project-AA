/**
 * Hostile audit — round 2 (new vectors, none repeat-checked from round 1).
 *
 *  1. HIGH  — held-draft approval is read → await send → delete. With a
 *             real (slow) SMTP call, two concurrent staff approvals both
 *             read the still-present draft and the SAME reply goes out
 *             TWICE. The send path must claim the draft atomically first.
 *  2. MED   — follow-up ladder rungs are read-then-write: two sweeps that
 *             both fetched the due list before either wrote (daemon + cron
 *             CLI, or two daemons) produce duplicate reminders for the same
 *             rung. Rung advancement must be claimed optimistically per
 *             case before any reminder is drafted/queued.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "http";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { DEFAULT_REQUIREMENTS } from "../src/config";
import { hashPassword } from "../src/util/password";
import { createApp } from "../src/web/server";
import { runFollowUpSweep } from "../src/followups";
import type { PipelineContext } from "../src/pipeline/adapters";
import { webLogin } from "./helpers";

let repo: Repo;
let server: Server | undefined;

beforeEach(() => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  repo.seedBaseRequirements(DEFAULT_REQUIREMENTS);
});
afterEach(() => { server?.close(); server = undefined; });

/** A sender that blocks long enough for a second handler to interleave —
 *  exactly what real Gmail/SMTP does (100–2000 ms per message). */
class SlowSender {
  sent: unknown[][] = [];
  async send(...args: unknown[]): Promise<void> {
    await new Promise((r) => setTimeout(r, 80));
    this.sent.push(args);
  }
}

describe("round 2 · finding 1 — held-draft approval race", () => {
  it("two concurrent approvals of the same draft send it EXACTLY ONCE", async () => {
    repo.createStaff("admin", "Race Admin", hashPassword("admin123"), "admin");
    const sender = new SlowSender();
    const ctx: PipelineContext = { repo, adapters: { vision: null as never, watcher: null as never, sender: sender as never } };
    const app = createApp({ repo, ctx });
    const s = app.listen(0);
    server = s;
    const base = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
    const { cookie, csrf } = await webLogin(base, "admin", "admin123");

    const a = repo.getOrCreateApplicant("draft-race@example.org", "thr-draft-race");
    const draftId = (repo as unknown as { db: { prepare: (q: string) => { run: (...a: unknown[]) => { lastInsertRowid: number } } } })
      .db.prepare("INSERT INTO outbox (applicant_id, to_address, subject, body, mode, template_key) VALUES (?,?,?,?,?,?)")
      .run(a.id, a.email_address, "Held reply", "Draft body for the officer.", "queued", "").lastInsertRowid;
    expect(draftId).toBeGreaterThan(0);

    const post = () =>
      fetch(`${base}/case/${a.id}/draft`, {
        method: "POST", redirect: "manual",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: `_csrf=${encodeURIComponent(csrf)}&decision=send`,
      });
    const [r1, r2] = await Promise.all([post(), post()]);
    expect(r1.status).toBe(302);
    expect(r2.status).toBe(302); // second officer is told, not crashe
    expect(sender.sent.length).toBe(1); // ← the bite: today this is 2

    const outbound = repo.emailsForApplicant(a.id).filter((e) => e.direction === "out");
    expect(outbound.length).toBe(1);
    expect(repo.auditForApplicant(a.id).filter((x) => x.event === "human_override").length).toBe(1);
  });
});

describe("round 2 · finding 2 — follow-up ladder concurrency", () => {
  function armDue(r: Repo, email: string): number {
    const a = r.getOrCreateApplicant(email, `thr-${email}`);
    r.setFollowup(a.id, 0, "2026-09-10T08:00:00Z", "2026-09-10T07:00:00Z"); // due since yesterday
    return a.id;
  }

  it("the ladder rung claim is optimistic: a stale rung cannot be claimed twice", () => {
    const r1 = repo;
    const id = armDue(r1, "claim@example.org");
    expect(r1.claimFollowupRung(id, 0, 1, "2026-09-20T08:00:00Z")).toBe(true);
    // a concurrent sweeper holding a stale read (rung 0) must lose now
    expect(r1.claimFollowupRung(id, 0, 1, "2026-09-20T08:00:00Z")).toBe(false);
    // the winner moves on from its own new state
    expect(r1.claimFollowupRung(id, 1, 2, "2026-09-23T08:00:00Z")).toBe(true);
  });

  it("a sweep holding a stale due-list never duplicates the reminder another sweep queued", async () => {
    // Two independent Repo connections = two sweepers in different processes.
    const file = `/tmp/followup-race-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`;
    const r1 = new Repo(openDb(file));
    seedDefaults(r1);
    r1.seedBaseRequirements(DEFAULT_REQUIREMENTS);
    const r2 = new Repo(openDb(file));
    const ctx1: PipelineContext = { repo: r1, adapters: { vision: null as never, watcher: null as never, sender: null as never } };
    const ctx2: PipelineContext = { repo: r2, adapters: { vision: null as never, watcher: null as never, sender: null as never } };

    const id = armDue(r1, "stale-sweep@example.org");
    // r2 snapshots the due list BEFORE r1's sweep writes — the exact TOCTOU window.
    const now = new Date().toISOString();
    const stale = r2.dueFollowUps(now);
    expect(stale.length).toBe(1);
    (r2 as unknown as { dueFollowUps: (n: string) => typeof stale }).dueFollowUps = () => stale;

    const sent1 = await runFollowUpSweep(r1, ctx1); // daemon passes first — expects rung 0 → 1
    expect(sent1).toBe(1);
    const sent2 = await runFollowUpSweep(r2, ctx2); // cron arrives with the stale list
    expect(sent2).toBe(0);                            // ← today: 1 (duplicate reminder + wrong rung jump)

    const audits = r1.auditForApplicant(id).filter((e) => e.event === "followup_held_qualification");
    expect(audits.length).toBe(1); // exactly one reminder drafted across BOTH sweeps
    expect(r1.getApplicant(id)!.followup_rung).toBe(1); // rung advanced once, not twice
  });
});
