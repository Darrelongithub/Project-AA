/**
 * Phase 12 admin security console — data-layer pins.
 *
 * Every console query is org-scoped in SQL. These tests seed two orgs and
 * assert Org B rows NEVER appear in Org A results (the #6 isolation
 * property), plus per-section correctness. Route-level 403 tests live
 * further below (added with the route in Step D).
 */
import { describe, expect, it, beforeEach } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { hashPassword } from "../src/util/password";

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
