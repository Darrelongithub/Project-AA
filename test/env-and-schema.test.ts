/**
 * Numeric environment variables and schema hygiene.
 *
 * - A typo'd numeric env var (PORT=abc, GEMINI_TIMEOUT_MS=60o00, …) used to
 *   leak NaN into listen()/timeouts/guards, where comparisons against NaN are
 *   always false — silently disabling the protection the knob configures.
 *   Every numeric env parse now falls back to its documented default.
 * - The outbox table is probed with a correlated EXISTS per rendered applicant
 *   row in queue listings; without an index on (applicant_id, mode) each probe
 *   was a full outbox scan.
 */
import { describe, expect, it, afterEach } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { envInt, envNum } from "../src/util/envnum";
import { loadConfig } from "../src/config";
import { processEmail } from "../src/pipeline";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";
import type { IncomingEmail } from "../src/types";
import { configureTestOrganization } from "./helpers";

afterEach(() => {
  delete process.env.PORT;
  delete process.env.INGEST_LOOKBACK_DAYS;
});

describe("numeric env parsing never yields NaN", () => {
  it("envInt/envNum fall back on garbage, zero and negatives; envNum keeps fractions", () => {
    expect(envInt("abc", 8080)).toBe(8080);
    expect(envInt(undefined, 14)).toBe(14);
    expect(envInt("", 14)).toBe(14);
    expect(envInt("-5", 14)).toBe(14);
    expect(envInt("0", 14)).toBe(14);
    expect(envInt(" 9999 ", 8080)).toBe(9999); // trim + accept
    expect(envInt("999.7", 8080)).toBe(999); // integers floor
    expect(envNum("2.2", 1)).toBe(2.2); // fractional knobs stay fractional
    expect(envNum("oops", 2.2)).toBe(2.2);
  });

  it("loadConfig survives a typo'd PORT / INGEST_LOOKBACK_DAYS", () => {
    process.env.PORT = "abc";
    process.env.INGEST_LOOKBACK_DAYS = "two weeks";
    const cfg = loadConfig();
    expect(cfg.port).toBe(8080);
    expect(cfg.ingestLookbackDays).toBe(14);
    process.env.PORT = "9151";
    process.env.INGEST_LOOKBACK_DAYS = "30";
    const cfg2 = loadConfig();
    expect(cfg2.port).toBe(9151);
    expect(cfg2.ingestLookbackDays).toBe(30);
  });
});

describe("corrupt numeric SETTINGS cannot crash intake", () => {
  it("sla_target_hours=garbage still sets a valid SLA due date on triaged mail", async () => {
    const repo = new Repo(openDb(":memory:"));
    seedDefaults(repo);
    configureTestOrganization(repo);
    repo.setSetting("sla_target_hours", "as soon as possible"); // poison
    const sender = new MockSender();
    const ctx: PipelineContext = { repo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender } };
    const res = await processEmail({
      id: "sla-poison-1", threadId: "sla-poison", from: "poison@example.org",
      subject: "Service request enquiry", body: "What information do you need from me?",
      receivedAt: "2026-09-14T09:00:00Z", attachments: [],
    } as IncomingEmail, ctx);
    expect(res.skipped).not.toBe(true);
    const a = repo.getApplicant(res.applicantId!)!;
    expect(a.sla_due_at).toBeTruthy();
    expect(Number.isNaN(new Date(a.sla_due_at!).getTime())).toBe(false); // a real instant, not Invalid Date
  });
});

describe("outbox is indexed for the queue-listing EXISTS probes", () => {
  it("idx_outbox_applicant exists and the correlated probe searches it", () => {
    const repo = new Repo(openDb(":memory:"));
    seedDefaults(repo);
    const indexes = repo.db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='outbox' AND sql IS NOT NULL")
      .all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain("idx_outbox_applicant");

    const plan = repo.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM applicants a WHERE EXISTS (SELECT 1 FROM outbox o WHERE o.applicant_id = a.id AND o.mode = 'queued')"
      )
      .all() as Array<{ detail: string }>;
    const detail = plan.map((p) => p.detail).join(" | ");
    expect(detail).toContain("idx_outbox_applicant");
    expect(detail).not.toMatch(/SCAN o(?!\w)/); // no full outbox scans
  });
});
