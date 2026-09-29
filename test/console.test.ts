/**
 * Phase 12 admin security console — data-layer pins.
 *
 * Every console query is org-scoped in SQL. These tests seed two orgs and
 * assert Org B rows NEVER appear in Org A results (the #6 isolation
 * property), plus per-section correctness. Route-level 403 tests live
 * further below (added with the route in Step D).
 */
import { describe, expect, it, beforeEach, beforeAll, afterAll } from "vitest";
import type { Server } from "http";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { hashPassword } from "../src/util/password";
import { createApp } from "../src/web/server";
import { webLogin } from "./helpers";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";
import { metrics } from "../src/metrics";
import { utcDay } from "../src/util/day";
import { orgDurationMetric } from "../src/db/repo/console";
import { processEmail } from "../src/pipeline";
import type { IncomingEmail } from "../src/types";
import { handleHttpError } from "../src/web/routes/system";
import { ingestNewEmails } from "../src/ingestion";
import type { GmailClient } from "../src/ingestion/gmailClient";

let repo: Repo;
let a1: number; // org 1 applicant
let a2: number; // org 1 applicant
let b1: number; // org 2 applicant

function backdate(table: string, idCol: string, id: number, col: string): void {
  (repo as unknown as { db: { prepare: (q: string) => { run: (...x: unknown[]) => unknown } } }).db
    .prepare(`UPDATE ${table} SET ${col} = '2020-01-01 00:00:00' WHERE ${idCol} = ?`)
    .run(id);
}

beforeEach(() => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  repo.createStaff("admin1", "Org One Admin", hashPassword("x"), "admin", false, 1);
  repo.createStaff("user1", "Org One User", hashPassword("x"), "user", false, 1);
  repo.createStaff("admin2", "Org Two Admin", hashPassword("x"), "admin", false, 2);
  a1 = repo.getOrCreateApplicant("a1@example.org", "t-a1", { organizationId: 1 }).id;
  a2 = repo.getOrCreateApplicant("a2@example.org", "t-a2", { organizationId: 1 }).id;
  b1 = repo.getOrCreateApplicant("b1@example.org", "t-b1", { organizationId: 2 }).id;
  // getOrCreateApplicant only stamps organization_id when the org has a
  // GENERAL case type (org 2 has none) — pin it explicitly.
  repo.db.prepare("UPDATE applicants SET organization_id = 2 WHERE id = ?").run(b1);
});

const SINCE = "2026-01-01T00:00:00.000Z";

describe("console logins", () => {
  it("returns only the org's staff auth events, newest first", () => {
    repo.audit(null, "admin1", "staff_login", "ip=10.0.0.1");
    repo.audit(null, "user1", "staff_login_failed", "ip=10.0.0.9");
    repo.audit(null, "admin2", "staff_login", "ip=10.0.0.2");
    repo.audit(null, "ghost", "staff_login_failed", "ip=10.0.0.3"); // unknown user: unattributable, excluded
    const rows = repo.consoleLogins(1);
    expect(rows.map((r) => r.actor).sort()).toEqual(["admin1", "user1"]);
    expect(rows[0].at >= rows[1].at).toBe(true);
    expect(rows.find((r) => r.actor === "admin1")!.display_name).toBe("Org One Admin");
    expect(rows.find((r) => r.actor === "user1")!.event).toBe("staff_login_failed");
    expect(repo.consoleLogins(2).map((r) => r.actor)).toEqual(["admin2"]);
  });
  it("counts repeated failures per staff member and honors since", () => {
    repo.audit(null, "user1", "staff_login_failed", "ip=1.1.1.1");
    repo.audit(null, "user1", "staff_login_failed", "ip=1.1.1.1");
    repo.audit(null, "user1", "staff_login_failed", "ip=1.1.1.1");
    const fresh = (repo.db.prepare("SELECT id FROM audit_log ORDER BY id DESC LIMIT 1").get() as { id: number }).id;
    backdate("audit_log", "id", fresh, "at");
    expect(repo.consoleLoginFailCounts(1)).toEqual([
      { actor: "user1", display_name: "Org One User", fails: 3, last_at: expect.any(String) },
    ]);
    expect(repo.consoleLoginFailCounts(1, SINCE)).toEqual([
      { actor: "user1", display_name: "Org One User", fails: 2, last_at: expect.any(String) },
    ]);
    expect(repo.consoleLoginFailCounts(2)).toEqual([]);
  });
});

describe("console runs", () => {
  it("returns org runs with decision latency, excluding other orgs", () => {
    repo.insertEmail({ applicant_id: a1, message_id: "m1", thread_id: "t-a1", direction: "in", from_addr: "a1@example.org", to_addr: "", subject: "Applying", body: "hi", category: null, auto: 0, at: "2026-09-29T10:00:00.000Z" });
    repo.insertDecisionLog({ applicant_id: a1, triggering_email_id: "m1", computed_status: "Green", reasoning: "ok", auto_sent: true });
    const rowId = (repo.db.prepare("SELECT MAX(id) AS m FROM decision_logs").get() as { m: number }).m;
    (repo as unknown as { db: { prepare: (q: string) => { run: (...x: unknown[]) => unknown } } }).db
      .prepare("UPDATE decision_logs SET timestamp = '2026-09-29 10:05:00' WHERE id = ?").run(rowId);
    repo.insertEmail({ applicant_id: b1, message_id: "mB", thread_id: "t-b1", direction: "in", from_addr: "b1@example.org", to_addr: "", subject: "Hi", body: "hi", category: null, auto: 0, at: "2026-09-29T10:00:00.000Z" });
    repo.insertDecisionLog({ applicant_id: b1, triggering_email_id: "mB", computed_status: "Red", reasoning: "no", auto_sent: false });
    const runs = repo.consoleRuns(1);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ applicant_id: a1, computed_status: "Green", auto_sent: true, latency_secs: 300, subject: "Applying" });
    expect(runs[0].ref_number).toMatch(/RU-/);
    expect(repo.consoleRuns(2)).toHaveLength(1);
  });
  it("nulls latency when the triggering email is unknown", () => {
    repo.insertDecisionLog({ applicant_id: a1, triggering_email_id: "nope", computed_status: "Orange", reasoning: "?", auto_sent: false });
    expect(repo.consoleRuns(1)[0].latency_secs).toBeNull();
  });
});

describe("console errors + alerts", () => {
  it("returns org-attributed errors and alerts only", () => {
    repo.audit(a1, "staff", "send_failed", "smtp down");
    repo.audit(b1, "staff", "send_failed", "smtp down");
    repo.audit(null, "staff", "dead_letter_dropped", "unattributable"); // NULL applicant: excluded
    repo.notify("escalation", "needs eyes", a1);
    repo.notify("escalation", "other org", b1);
    repo.notify("review_needed", "broadcast, no case", null); // unattributable: excluded
    expect(repo.consoleErrors(1).map((r) => r.applicant_id)).toEqual([a1]);
    expect(repo.consoleErrors(2).map((r) => r.applicant_id)).toEqual([b1]);
    expect(repo.consoleAlerts(1).map((r) => r.applicant_id)).toEqual([a1]);
    expect(repo.consoleAlerts(2).map((r) => r.applicant_id)).toEqual([b1]);
  });
});

describe("console tampering signals", () => {
  it("flags multi-decisions, missing trails, bad actors — per org", () => {
    // multi: two human decisions on a1.
    repo.audit(a1, "admin1", "human_admission_decision", "admit");
    repo.audit(a1, "admin1", "human_admission_decision", "admit again");
    (repo as unknown as { db: { prepare: (q: string) => { run: (...x: unknown[]) => unknown } } }).db
      .prepare("UPDATE applicants SET admission_decision = 'admitted_after_review', admission_route = 'human', decision_by = 'admin1' WHERE id = ?").run(a1);
    // no_trail: human outcome on a2 with no audit (out-of-flow write).
    (repo as unknown as { db: { prepare: (q: string) => { run: (...x: unknown[]) => unknown } } }).db
      .prepare("UPDATE applicants SET admission_decision = 'not_admitted', admission_route = 'human', decision_by = 'user1' WHERE id = ?").run(a2);
    // unpermitted: user1 (no record_outcome grant) decides on... a2 already used; use b1? No — org isolation: put it on a1? a1 has admin1 audits already (permitted, no flag). Add third applicant for the unpermitted case.
    const a3 = repo.getOrCreateApplicant("a3@example.org", "t-a3", { organizationId: 1 }).id;
    repo.audit(a3, "user1", "human_admission_decision", "admit");
    (repo as unknown as { db: { prepare: (q: string) => { run: (...x: unknown[]) => unknown } } }).db
      .prepare("UPDATE applicants SET admission_decision = 'admitted_after_review', admission_route = 'human', decision_by = 'user1' WHERE id = ?").run(a3);
    // unknown actor on b1 (org 2).
    repo.audit(b1, "ghost", "human_admission_decision", "admit");
    // clean org-2 decision (admin2 decides b1... b1 already has ghost; use second org2 applicant).
    const b2 = repo.getOrCreateApplicant("b2@example.org", "t-b2", { organizationId: 2 }).id;
    repo.db.prepare("UPDATE applicants SET organization_id = 2 WHERE id = ?").run(b2);
    repo.audit(b2, "admin2", "human_admission_decision", "admit");
    (repo as unknown as { db: { prepare: (q: string) => { run: (...x: unknown[]) => unknown } } }).db
      .prepare("UPDATE applicants SET admission_decision = 'admitted_after_review', admission_route = 'human', decision_by = 'admin2' WHERE id = ?").run(b2);

    const out1 = repo.consoleTamperOutcomes(1);
    expect(out1.filter((r) => r.signal === "multi_decision").map((r) => r.applicant_id)).toEqual([a1]);
    expect(out1.filter((r) => r.signal === "no_trail").map((r) => r.applicant_id)).toEqual([a2]);
    // b1 has no recorded outcome row (only the ghost audit) → no outcome signals; b2 clean.
    expect(repo.consoleTamperOutcomes(2)).toEqual([]);

    const act1 = repo.consoleTamperActors(1);
    expect(act1.filter((r) => r.signal === "unpermitted_actor").map((r) => r.applicant_id)).toEqual([a3]);
    expect(act1.find((r) => r.signal === "unknown_actor")).toBeUndefined();
    const act2 = repo.consoleTamperActors(2);
    expect(act2).toHaveLength(1);
    expect(act2[0]).toMatchObject({ applicant_id: b1, signal: "unknown_actor" });
  });
  it("a granted non-admin decider is not flagged", () => {
    const ofs = repo.getStaffByUsername("user1")!;
    repo.setPermissions(ofs.id, ["record_outcome"]);
    repo.audit(a1, "user1", "human_admission_decision", "admit");
    expect(repo.consoleTamperActors(1)).toEqual([]);
  });
});

describe("login auditing (HTTP)", () => {
  let wrepo: Repo;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    wrepo = new Repo(openDb(":memory:"));
    seedDefaults(wrepo);
    wrepo.createStaff("cadmin", "Console Admin", hashPassword("adminpass99"), "admin", false, 1);
    const sender = new MockSender();
    const ctx: PipelineContext = { repo: wrepo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender } };
    const app = createApp({ repo: wrepo, ctx });
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve()) as unknown as Server;
    });
    const addr = server.address() as { port: number };
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(() => {
    server?.close();
  });

  function lastAudit(event: string): { actor: string; detail: string } {
    return wrepo.db.prepare("SELECT actor, detail FROM audit_log WHERE event = ? ORDER BY id DESC LIMIT 1").get(event) as { actor: string; detail: string };
  }

  it("persists failed logins with who + IP", async () => {
    const r = await webLogin(base, "cadmin", "wrong-password");
    expect(r.status).toBe(401);
    expect(lastAudit("staff_login_failed")).toMatchObject({ actor: "cadmin" });
    expect(lastAudit("staff_login_failed").detail).toMatch(/^ip=.*127\.0\.0\.1/);
    expect(wrepo.consoleLogins(1).some((l) => l.event === "staff_login_failed" && l.actor === "cadmin")).toBe(true);
  });

  it("records the IP on successful logins", async () => {
    const r = await webLogin(base, "cadmin", "adminpass99");
    expect(r.status).toBe(302);
    expect(lastAudit("staff_login").detail).toMatch(/^ip=.*127\.0\.0\.1/);
  });

  it("persists throttle-blocked attempts", async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await webLogin(base, "cadmin", "wrong-again")).status;
    expect(last).toBe(429);
    expect(lastAudit("staff_login_blocked")).toMatchObject({ actor: "cadmin" });
    expect(wrepo.consoleLogins(1).some((l) => l.event === "staff_login_blocked")).toBe(true);
  });
});

describe("console health", () => {
  it("scopes vision attempts, routings and fallback triggers by org", () => {
    repo.insertDocument({ applicant_id: a1, document_type: "unknown", source_email_id: "m1", extraction_method: "gemini_vision", extracted_text: "t", extracted_fields: {}, confidence: "high", received_at: "2026-09-29T10:00:00.000Z" });
    repo.insertDocument({ applicant_id: a1, document_type: "unknown", source_email_id: "m2", extraction_method: "none", extracted_text: "", extracted_fields: {}, confidence: "low", received_at: "2026-09-29T11:00:00.000Z", extraction_note: "Vision model unavailable (timeout). The document is preserved for human review." });
    repo.insertDocument({ applicant_id: b1, document_type: "unknown", source_email_id: "mB", extraction_method: "none", extracted_text: "", extracted_fields: {}, confidence: "low", received_at: "2026-09-29T11:00:00.000Z", extraction_note: "Vision model unavailable (api). x" });
    repo.insertEvaluation({ applicant_id: a1, set_id: null, programme: null, system: null, set_version: null, result: "undetermined", routing: "human_review", reason: "r", reason_code: "manual_decision_required", detail: "{}", rule_snapshot: "[]" });
    repo.insertEvaluation({ applicant_id: b1, set_id: null, programme: null, system: null, set_version: null, result: "passed", routing: "auto_admit", reason: "r", reason_code: "auto", detail: "{}", rule_snapshot: "[]" });
    repo.audit(a1, "system", "human_review_triggered", "why");
    repo.audit(b1, "system", "human_review_triggered", "why");
    const v = repo.consoleVisionAttempts(1);
    expect(v).toHaveLength(2);
    expect(v.filter((r) => r.note.startsWith("Vision model unavailable"))).toHaveLength(1);
    expect(repo.consoleVisionAttempts(2)).toHaveLength(1);
    expect(repo.consoleRoutings(1).map((r) => r.routing)).toEqual(["human_review"]);
    expect(repo.consoleRoutings(2).map((r) => r.routing)).toEqual(["auto_admit"]);
    expect(repo.consoleFallbackTriggers(1).map((r) => r.applicant_id)).toEqual([a1]);
    expect(repo.consoleFallbackTriggers(2).map((r) => r.applicant_id)).toEqual([b1]);
  });
});

describe("org-scoped durations", () => {
  it("averages per-org durations from metric_daily, split by org", () => {
    const day = utcDay();
    repo.upsertMetric(day, orgDurationMetric(1), 2, 100);
    repo.upsertMetric(day, orgDurationMetric(1), 2, 300);
    repo.upsertMetric(day, orgDurationMetric(2), 1, 9999);
    repo.upsertMetric(day, "email.duration_ms", 9, 9000); // global row ignored
    expect(repo.consoleOrgDuration(1, 14)).toEqual({ n: 4, avgMs: 100 });
    expect(repo.consoleOrgDuration(2, 14)).toEqual({ n: 1, avgMs: 9999 });
    expect(repo.consoleOrgDuration(3, 14)).toEqual({ n: 0, avgMs: 0 });
  });

  it("processEmail observes the applicant's org duration (additive-only)", async () => {
    const prepo = new Repo(openDb(":memory:"));
    seedDefaults(prepo);
    const sender = new MockSender();
    const ctx: PipelineContext = { repo: prepo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender } };
    metrics.drain(() => {});
    const email: IncomingEmail = {
      id: "dur-e1", threadId: "dur-t1", from: "dur@example.org", fromName: "Dur",
      subject: "Hello", body: "I want to apply", receivedAt: new Date().toISOString(), attachments: [],
    };
    const res = await processEmail(email, ctx);
    expect(res.applicantId).not.toBeNull();
    const seen = new Map<string, { n: number; sum: number }>();
    metrics.drain((name, n, sum) => seen.set(name, { n, sum }));
    expect(seen.get("email.processed")).toMatchObject({ n: 1 });
    const org = seen.get("email.duration_ms.org.1");
    expect(org).toBeDefined();
    expect(org!.n).toBe(1);
    expect(org!.sum).toBeGreaterThanOrEqual(0);
  });
});

describe("console route access + rendering (HTTP)", () => {
  let crepo: Repo;
  let server: Server;
  let base: string;
  let r1: string;
  let r2: string;
  let rb: string;

  beforeAll(async () => {
    crepo = new Repo(openDb(":memory:"));
    seedDefaults(crepo);
    crepo.createStaff("kadmin1", "K Admin One", hashPassword("pw1pw1pw1"), "admin", false, 1);
    crepo.createStaff("kadmin2", "K Admin Two", hashPassword("pw2pw2pw2"), "admin", false, 2);
    crepo.createStaff("kuser1", "K User One", hashPassword("pw3pw3pw3"), "user", false, 1);
    const ka1 = crepo.getOrCreateApplicant("ka1@example.org", "kt-a1", { organizationId: 1 }).id;
    const ka2 = crepo.getOrCreateApplicant("ka2@example.org", "kt-a2", { organizationId: 1 }).id;
    const kb1 = crepo.getOrCreateApplicant("kb1@example.org", "kt-b1", { organizationId: 2 }).id;
    crepo.db.prepare("UPDATE applicants SET organization_id = 2 WHERE id = ?").run(kb1);
    r1 = crepo.requireApplicant(ka1).ref_number;
    r2 = crepo.requireApplicant(ka2).ref_number;
    rb = crepo.requireApplicant(kb1).ref_number;
    // logins
    crepo.audit(null, "kadmin1", "staff_login", "ip=1.2.3.4");
    // runs (one fresh, one backdated)
    crepo.insertEmail({ applicant_id: ka1, message_id: "km1", thread_id: "kt-a1", direction: "in", from_addr: "ka1@example.org", to_addr: "", subject: "Hello", body: "hi", category: null, auto: 0, at: "2026-09-29T10:00:00.000Z" });
    crepo.insertDecisionLog({ applicant_id: ka1, triggering_email_id: "km1", computed_status: "Green", reasoning: "ok", auto_sent: true });
    crepo.insertDecisionLog({ applicant_id: ka2, triggering_email_id: "km2", computed_status: "Red", reasoning: "old", auto_sent: false });
    crepo.db.prepare("UPDATE decision_logs SET timestamp = '2020-05-05 05:05:05' WHERE applicant_id = ?").run(ka2);
    // errors + decoy
    crepo.audit(ka1, "system", "send_failed", "smtp boom");
    crepo.audit(kb1, "system", "send_failed", "other org boom");
    crepo.insertDecisionLog({ applicant_id: kb1, triggering_email_id: "kmB", computed_status: "Red", reasoning: "no", auto_sent: false });
    // tampering: ka1 decided twice (multi_decision)
    crepo.audit(ka1, "kadmin1", "human_admission_decision", "admit");
    crepo.audit(ka1, "kadmin1", "human_admission_decision", "admit again");
    crepo.db.prepare("UPDATE applicants SET admission_decision = 'admitted_after_review', admission_route = 'human', decision_by = 'kadmin1' WHERE id = ?").run(ka1);
    // health: 1 success + 1 timeout failure + human fallback on ka1; decoy failure on kb1
    crepo.insertDocument({ applicant_id: ka1, document_type: "unknown", source_email_id: "km1", extraction_method: "gemini_vision", extracted_text: "t", extracted_fields: {}, confidence: "high", received_at: new Date().toISOString() });
    crepo.insertDocument({ applicant_id: ka1, document_type: "unknown", source_email_id: "km1", extraction_method: "none", extracted_text: "", extracted_fields: {}, confidence: "low", received_at: new Date().toISOString(), extraction_note: "Vision model unavailable (timeout). kept." });
    crepo.insertDocument({ applicant_id: kb1, document_type: "unknown", source_email_id: "kmB", extraction_method: "none", extracted_text: "", extracted_fields: {}, confidence: "low", received_at: new Date().toISOString(), extraction_note: "Vision model unavailable (api). kept." });
    crepo.insertEvaluation({ applicant_id: ka1, set_id: null, programme: null, system: null, set_version: null, result: "undetermined", routing: "human_review", reason: "r", reason_code: "manual_decision_required", detail: "{}", rule_snapshot: "[]" });
    crepo.audit(ka1, "system", "human_review_triggered", "why");
    // unhandled exceptions: one per org + one unattributable
    crepo.recordErrorEvent({ source: "http", applicant_id: ka1, actor: "kadmin1", request: "GET /case/1", message: "render-check kaboom" });
    crepo.recordErrorEvent({ source: "ingest", request: "mX", message: "unattributable fetch failure" });
    crepo.recordErrorEvent({ source: "http", applicant_id: kb1, actor: "kadmin2", request: "GET /case/9", message: "org-two kaboom" });

    const sender = new MockSender();
    const ctx: PipelineContext = { repo: crepo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender } };
    const app = createApp({ repo: crepo, ctx });
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve()) as unknown as Server;
    });
    const addr = server.address() as { port: number };
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(() => {
    server?.close();
  });

  async function get(path: string, username: string, password: string): Promise<{ status: number; html: string }> {
    const l = await webLogin(base, username, password);
    expect(l.status).toBe(302);
    const res = await fetch(`${base}${path}`, { headers: { cookie: l.cookie } });
    return { status: res.status, html: await res.text() };
  }

  it("refuses non-admin staff with 403", async () => {
    const r = await get("/console", "kuser1", "pw3pw3pw3");
    expect(r.status).toBe(403);
  });

  it("refuses cross-org ?org= with 403 and renders nothing", async () => {
    const r = await get("/console?org=2", "kadmin1", "pw1pw1pw1");
    expect(r.status).toBe(403);
    expect(r.html).not.toContain(rb);
    expect(r.html).not.toContain(r1);
  });

  it("scopes every section to the admin's own org", async () => {
    const a = await get("/console?range=all", "kadmin1", "pw1pw1pw1");
    expect(a.status).toBe(200);
    expect(a.html).toContain("Security console");
    for (const marker of [r1, "Hello", "1.2.3.4", "send_failed", "smtp boom", "decided more than once", "50%", "timeout: 1", "Human-review fallback"]) {
      expect(a.html, marker).toContain(marker);
    }
    expect(a.html).not.toContain(rb);
    expect(a.html).not.toContain("other org boom");
    const b = await get("/console?range=all", "kadmin2", "pw2pw2pw2");
    expect(b.status).toBe(200);
    expect(b.html).toContain(rb);
    expect(b.html).not.toContain(r1);
  });

  it("reflects a simulated vision failure in the health rates", async () => {
    const a = await get("/console?range=all", "kadmin1", "pw1pw1pw1");
    // 1 failure of 2 attempts = 50%; the failed case reached human review = 100% fallback.
    expect(a.html).toContain("Gemini failure rate");
    expect(a.html).toContain("50%");
    expect(a.html).toContain("100%");
  });

  it("range filtering hides out-of-range rows", async () => {
    const day = await get("/console?range=24h", "kadmin1", "pw1pw1pw1");
    expect(day.status).toBe(200);
    expect(day.html).not.toContain(r2); // backdated 2020 run
    expect(day.html).toContain(r1);
    const all = await get("/console?range=all", "kadmin1", "pw1pw1pw1");
    expect(all.html).toContain(r2);
    const custom = await get("/console?range=custom&from=2020-05-01&to=2020-05-31", "kadmin1", "pw1pw1pw1");
    expect(custom.html).toContain(r2);
    expect(custom.html).not.toContain("Hello"); // fresh run outside the window
  });

  it("renders unhandled exceptions scoped to the admin's org", async () => {
    const a = await get("/console?range=all", "kadmin1", "pw1pw1pw1");
    expect(a.status).toBe(200);
    expect(a.html).toContain("Unhandled exceptions");
    expect(a.html).toContain("render-check kaboom");
    expect(a.html).not.toContain("org-two kaboom");
    expect(a.html).not.toContain("unattributable fetch failure");
    const b = await get("/console?range=all", "kadmin2", "pw2pw2pw2");
    expect(b.status).toBe(200);
    expect(b.html).toContain("org-two kaboom");
    expect(b.html).not.toContain("render-check kaboom");
    expect(b.html).not.toContain("unattributable fetch failure");
  });
});

describe("error events (data layer)", () => {
  function eventCount(): number {
    return (repo.db.prepare("SELECT COUNT(*) AS n FROM error_events").get() as { n: number }).n;
  }

  it("records and queries attributed events, newest first", () => {
    repo.recordErrorEvent({ source: "http", applicant_id: a1, actor: "admin1", request: "GET /case/1", message: "boom1" });
    // applicant org is authoritative even when the caller passes another org
    repo.recordErrorEvent({ source: "intake_test", applicant_id: a2, organization_id: 2, actor: "admin1", request: "/intake/test", message: "boom2" });
    const rows = repo.consoleErrorEvents(1);
    expect(rows.map((r) => r.message)).toEqual(["boom2", "boom1"]);
    expect(rows[0].ref_number).toBe(repo.requireApplicant(a2).ref_number);
    expect(rows[0].actor).toBe("admin1");
    expect(rows[0].source).toBe("intake_test");
    expect(repo.consoleErrorEvents(2)).toEqual([]);
  });

  it("stores unattributable rows but shows them to no org", () => {
    repo.recordErrorEvent({ source: "ingest", request: "m1", message: "fetch down" });
    repo.recordErrorEvent({ source: "http", organization_id: 2, actor: "admin2", request: "GET /", message: "org2boom" });
    expect(eventCount()).toBe(2);
    expect(repo.consoleErrorEvents(1)).toEqual([]);
    expect(repo.consoleErrorEvents(2).map((r) => r.message)).toEqual(["org2boom"]);
  });

  it("never defaults dangling applicant ids into an org", () => {
    repo.recordErrorEvent({ source: "http", applicant_id: 424242, organization_id: 1, message: "ghost" });
    expect(repo.consoleErrorEvents(1)).toEqual([]);
    expect(repo.consoleErrorEvents(2)).toEqual([]);
    const row = repo.db.prepare("SELECT organization_id AS o, applicant_id AS a, detail AS d FROM error_events").get() as { o: number | null; a: number | null; d: string };
    expect(row.o).toBeNull();
    expect(row.a).toBeNull();
    expect(row.d).toContain("424242");
  });

  it("honors since/until and truncates long fields", () => {
    repo.recordErrorEvent({ source: "http", applicant_id: a1, message: "fresh" });
    repo.recordErrorEvent({ source: "http", applicant_id: a1, message: "old" });
    const oldId = (repo.db.prepare("SELECT MAX(id) AS m FROM error_events").get() as { m: number }).m;
    backdate("error_events", "id", oldId, "at");
    expect(repo.consoleErrorEvents(1, SINCE).map((r) => r.message)).toEqual(["fresh"]);
    expect(repo.consoleErrorEvents(1, undefined, "2021-01-01T00:00:00.000Z").map((r) => r.message)).toEqual(["old"]);
    repo.recordErrorEvent({ source: "http", applicant_id: a1, actor: "y".repeat(100), message: "x".repeat(600) });
    const trunc = repo.db.prepare("SELECT LENGTH(message) AS m, LENGTH(actor) AS a FROM error_events ORDER BY id DESC LIMIT 1").get() as { m: number; a: number };
    expect(trunc).toEqual({ m: 500, a: 80 });
  });
});

describe("findApplicantId (lookup-only)", () => {
  it("matches existing cases case-insensitively and never creates", () => {
    const before = (repo.db.prepare("SELECT COUNT(*) AS n FROM applicants").get() as { n: number }).n;
    expect(repo.findApplicantId("a1@example.org", "t-a1")).toBe(a1);
    expect(repo.findApplicantId("A1@EXAMPLE.ORG", "t-a1")).toBe(a1);
    expect(repo.findApplicantId("nobody@example.org", "t-nope")).toBeUndefined();
    expect(repo.findApplicantId("a1@example.org", "wrong-thread")).toBeUndefined();
    expect(repo.findApplicantId(undefined as unknown as string, "t-a1")).toBeUndefined();
    const after = (repo.db.prepare("SELECT COUNT(*) AS n FROM applicants").get() as { n: number }).n;
    expect(after).toBe(before);
  });
});

describe("http error persistence", () => {
  type Rt = Parameters<typeof handleHttpError>[0];
  type Req = Parameters<typeof handleHttpError>[2];
  type Res = Parameters<typeof handleHttpError>[3];
  function rig(path: string, staff?: Record<string, unknown>): { req: Req; res: Res; sent: { status: number; json?: unknown; html?: string } } {
    const sent: { status: number; json?: unknown; html?: string } = { status: 0 };
    const req = { method: "GET", path, staff } as unknown as Req;
    const res = {
      headersSent: false,
      status: (code: number) => {
        sent.status = code;
        return { json: (b: unknown) => { sent.json = b; }, send: (b: string) => { sent.html = b; } };
      },
    } as unknown as Res;
    return { req, res, sent };
  }
  function rt(): Rt {
    return { repo, instName: () => "Test School" } as unknown as Rt;
  }

  it("attributes case paths to the case org (case wins over session)", () => {
    const { req, res, sent } = rig(`/case/${a1}`, { username: "admin2", organization_id: 2, role: "admin", display_name: "Org Two Admin" });
    handleHttpError(rt(), new Error("page exploded"), req, res);
    expect(sent.status).toBe(500);
    expect(sent.html).toContain("Something went wrong");
    const rows = repo.consoleErrorEvents(1);
    expect(rows.map((r) => r.message)).toEqual(["page exploded"]);
    expect(rows[0].actor).toBe("admin2");
    expect(rows[0].applicant_id).toBe(a1);
    expect(repo.consoleErrorEvents(2)).toEqual([]);
  });

  it("keeps the JSON 500 contract for /api/ and falls back to the session org", () => {
    const { req, res, sent } = rig("/api/cases", { username: "admin2", organization_id: 2 });
    handleHttpError(rt(), new Error("api exploded"), req, res);
    expect(sent.status).toBe(500);
    expect(sent.json).toEqual({ ok: false, error: "internal error" });
    expect(repo.consoleErrorEvents(2).map((r) => r.message)).toEqual(["api exploded"]);
    expect(repo.consoleErrorEvents(1)).toEqual([]);
  });

  it("stores anonymous non-case failures as unattributable", () => {
    const { req, res, sent } = rig("/login");
    handleHttpError(rt(), new Error("anon exploded"), req, res);
    expect(sent.status).toBe(500);
    expect(repo.consoleErrorEvents(1)).toEqual([]);
    expect(repo.consoleErrorEvents(2)).toEqual([]);
    expect((repo.db.prepare("SELECT COUNT(*) AS n FROM error_events").get() as { n: number }).n).toBe(1);
  });
});

describe("ingestion error persistence", () => {
  it("persists fetch failures as unattributable and keeps the poll alive", async () => {
    const gmail = {
      listRecentMessageIds: async () => ["m-fail"],
      fetchEmail: async () => { throw new Error("imap exploded"); },
      watchTarget: () => "test-mailbox",
    } as unknown as GmailClient;
    const ctx: PipelineContext = { repo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender: new MockSender() } };
    const results = await ingestNewEmails(gmail, ctx, 1);
    expect(results).toEqual([]);
    expect(repo.isDeadLetter("m-fail")).toBe(false); // attempt 1 of budget, not parked
    const row = repo.db.prepare("SELECT source AS s, organization_id AS o, request AS r, message AS m FROM error_events").get() as { s: string; o: number | null; r: string; m: string };
    expect(row).toEqual({ s: "ingest", o: null, r: "m-fail", m: "imap exploded" });
    expect(repo.consoleErrorEvents(1)).toEqual([]);
    expect(repo.consoleErrorEvents(2)).toEqual([]);
  });
});
