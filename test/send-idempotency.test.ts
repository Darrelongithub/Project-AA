/** Audit Group E — send/ingest idempotency and race hardening.
 * R1a: dropping a dead letter buries it (processed) so the next sync does
 *      not re-ingest it as new mail.
 * R1b/R11: the double-click guard is one shared claim-once throttle (no
 *      bespoke bulk-clearing map) and now also covers both compose POSTs.
 * R10: throttle eviction is amortized (one pass evicts to 90% of cap).
 * R12: dead-letter attempt recording is an atomic upsert.
 * R13: outbound message ids carry entropy, not just Date.now().
 */
import { describe, expect, it } from "vitest";
import type { Server } from "http";
import { webLogin } from "./helpers";
import { createApp } from "../src/web/server";
import { hashPassword } from "../src/util/password";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { LoginThrottle } from "../src/web/throttle";
import { outgoingMessageId } from "../src/util/ids";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";

function fresh(): Repo {
  const repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  repo.createStaff("admin", "Administrator", hashPassword("admin123"), "admin");
  return repo;
}

async function boot(repo: Repo, sender: MockSender): Promise<{ base: string; close: () => Promise<void> }> {
  const ctx: PipelineContext = { repo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender } };
  const app = createApp({ repo, ctx });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = server.address() as { port: number };
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

describe("audit E — R10/R11: claim-once throttle with amortized eviction", () => {
  it("claims once per window, then releases", () => {
    const t = new LoginThrottle({ windowMs: 5000, maxFails: 1, maxEntries: 2000 });
    const now = Date.now();
    expect(t.claim("a:b:c", now)).toBe(true);
    expect(t.claim("a:b:c", now + 100)).toBe(false);
    expect(t.claim("a:b:c", now + 5001)).toBe(true);
    expect(t.claim("other", now + 100)).toBe(true);
  });

  it("evicts oldest-first in batches under flood, keeps the blocked IP blocked", () => {
    const t = new LoginThrottle({ windowMs: 60_000, maxFails: 3, maxEntries: 100 });
    const now = Date.now();
    for (let i = 0; i < 100; i++) t.recordFail(`10.1.0.${i}`, now + i);
    expect(t.size).toBe(100);
    // The 101st entry triggers one pass down to 90% of cap — a per-entry
    // eviction would sit at exactly maxEntries and re-sort the whole map
    // on every insert under flood (attacker-paced O(n log n)).
    t.recordFail("10.1.0.200", now + 100);
    expect(t.size).toBe(90);
    for (let i = 0; i < 3; i++) t.recordFail("9.9.9.9", now + 200);
    for (let i = 0; i < 60; i++) t.recordFail(`10.2.0.${i}`, now + 300 + i);
    expect(t.size).toBeLessThanOrEqual(100);
    expect(t.size).toBeGreaterThan(0); // never a bulk clear
    expect(t.allowed("9.9.9.9", now + 5000)).toBe(false); // still blocked
  });
});

describe("audit E — R12: dead-letter recording is an atomic upsert", () => {
  it("counts attempts and parks at the budget", () => {
    const repo = fresh();
    repo.setSetting("dead_letter_max_attempts", "2");
    const first = repo.recordDeadLetter({ message_id: "m1", subject: "s", from_addr: "f", error: "e1" });
    expect(first).toMatchObject({ attempts: 1, dead: false });
    const second = repo.recordDeadLetter({ message_id: "m1", subject: "s", from_addr: "f", error: "e2" });
    expect(second).toMatchObject({ attempts: 2, dead: true, id: first.id });
    expect(repo.getDeadLetter(first.id)?.error).toBe("e2");
  });
});

describe("audit E — R13: outbound message ids are unique", () => {
  it("mints 5000 ids without a collision", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) seen.add(outgoingMessageId("t"));
    expect(seen.size).toBe(5000);
    expect([...seen][0]).toMatch(/^t-[0-9a-z]+-[0-9a-f]{8}$/);
  });
});

describe("audit E — R1a: drop buries, retry re-queues", () => {
  it("a dropped letter stays buried; a retried one is re-queued", async () => {
    const repo = fresh();
    const sender = new MockSender();
    const { base, close } = await boot(repo, sender);
    try {
      const auth = await webLogin(base, "admin", "admin123");
      const post = (path: string, body: Record<string, string>) => fetch(`${base}${path}`, {
        method: "POST",
        headers: { cookie: auth.cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ _csrf: auth.csrf, ...body }),
        redirect: "manual",
      });

      const drop = repo.parkDeadLetter({ message_id: "drop-me", subject: "zombie", from_addr: "z@example.test", error: "poison" });
      const r1 = await post("/config/dead-letter/delete", { id: String(drop.id) });
      expect(r1.status).toBe(302);
      expect(repo.getDeadLetter(drop.id)).toBeUndefined();
      // Buried: neither sync skip-gate can miss it now.
      expect(repo.isProcessed("drop-me")).toBe(true);
      expect(repo.isDeadLetter("drop-me")).toBe(false);

      const retry = repo.parkDeadLetter({ message_id: "retry-me", subject: "again", from_addr: "a@example.test", error: "flaky" });
      repo.markProcessed("retry-me", "thread-x");
      const r2 = await post("/config/dead-letter/retry", { id: String(retry.id) });
      expect(r2.status).toBe(302);
      expect(repo.getDeadLetter(retry.id)).toMatchObject({ dead: 0, attempts: 0 });
      expect(repo.isProcessed("retry-me")).toBe(false);
    } finally {
      await close();
    }
  });
});

describe("audit E — R1b: compose double-submit sends once", () => {
  it("the second identical POST is ignored", async () => {
    const repo = fresh();
    repo.upsertTemplate("e2e_note", "E2E Note", "Hello {name}", "Body {name}", false, "none", 1, 0);
    const a = repo.getOrCreateApplicant("e2e-composer@example.test", "thread-e2e-composer");
    const sender = new MockSender();
    const { base, close } = await boot(repo, sender);
    try {
      const auth = await webLogin(base, "admin", "admin123");
      const fields = { _csrf: auth.csrf, template: "e2e_note", subject: "Your file", body: "All good." };
      const post = () => fetch(`${base}/case/${a.id}/compose`, {
        method: "POST",
        headers: { cookie: auth.cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields),
        redirect: "manual",
      });
      const first = await post();
      expect(first.status).toBe(302);
      expect(decodeURIComponent(first.headers.get("location") ?? "")).toContain("Reply sent");
      const second = await post();
      expect(second.status).toBe(302);
      expect(decodeURIComponent(second.headers.get("location") ?? "")).toContain("Duplicate send ignored");
      expect(sender.sent.length).toBe(1);
      const audits = repo.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE applicant_id = ? AND event = 'email_sent_manual'").get(a.id) as { n: number };
      expect(audits.n).toBe(1);
    } finally {
      await close();
    }
  });
});
