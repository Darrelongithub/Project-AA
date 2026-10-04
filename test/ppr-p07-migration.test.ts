/**
 * PPR P0-7 acceptance (generalized): the storage migration is TESTED on a
 * production-shaped COPY of a legacy instance — old table and column names,
 * frozen requirement snapshots, human-recorded outcomes, audit and decision
 * logs, a school-scoped staff matrix, and secrets sitting in the settings bag
 * — with before/after evidence for every invariant:
 *
 *   1. table and column NAMES are kept; only the declared legacy storage
 *      names are renamed, and extension columns are added,
 *   2. tenant structures are added and existing rows are stamped ONCE into
 *      the migrated organization,
 *   3. the school dimension is dropped, and staff who were scoped by school
 *      are NARROWED to no access — never silently widened,
 *   4. one-shot markers never re-run (a deliberate setting stays as it is),
 *   5. secrets leave the settings bag exactly once,
 *   6. historical cases are never rewritten (snapshots, logs, reference
 *      numbers and recorded outcomes byte-identical),
 *   7. legacy uniqueness constraints are rebuilt per tenant, so two
 *      organizations may hold the same contact email,
 *   8. a database written by a NEWER version of the application is refused.
 *
 * The historical storage names in the fixture below (admission_*,
 * education_module, qualification_gate) are the OLD column names a real
 * upgrade carries; `migrations/legacy-storage.json` declares the rename and
 * nothing in the product reads them any more.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import type Database from "better-sqlite3";

// ── The production-shaped pre-migration copy ─────────────────────────────
// Values below are the "BEFORE" evidence: every one of them is asserted to
// survive the migration unchanged (or to change in exactly the declared way).

const REF1 = "LW-2025-000123";
const REF2 = "LW-2025-000124";
const REF3 = "LW-2025-000125";
const SNAPSHOT1 = JSON.stringify([
  { document_type: "request_form", required: true, blocking: true },
  { document_type: "birth_cert", required: true, blocking: true },
]);
const SNAPSHOT2 = JSON.stringify([{ document_type: "request_form", required: true, blocking: true }]);
const REASON1 = "Cleared under the documented exception route 4.2.";
const AUDIT_ROWS: Array<[number, string, string, string]> = [
  [1, "system", "case_created", `Case ${REF1} opened for amara@example.test`],
  [1, "officer", "human_outcome_recorded", REASON1],
  [2, "system", "requirements_checked", "verdict=Red; missing=request_form"],
];
const DECISION_REASONING = "- [request_form] verified (high confidence)\n- [coverage] 250000 >= 100000 — pass";
const SECRET_KEYS: Array<[string, string]> = [
  ["gemini_api_key", "sk-legacy-gemini-9f3"],
  ["gmail_client_secret", "GOCSPX-legacy-client"],
  ["gmail_refresh_token", "1//legacy-refresh-token"],
];

function buildProductionCopy(file: string): void {
  fs.rmSync(file, { force: true });
  const db: Database.Database = new (require("better-sqlite3"))(file);
  db.pragma("foreign_keys = OFF");
  // Exactly the tables a live pre-v2 database carries — old column names
  // intact, no tenant columns, and the school dimension still present.
  db.exec(`
    CREATE TABLE case_types (id INTEGER PRIMARY KEY AUTOINCREMENT, organization_id INTEGER NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'general', config TEXT NOT NULL DEFAULT '{}', education_module INTEGER NOT NULL DEFAULT 0, auto_admit INTEGER NOT NULL DEFAULT 0, qualification_gate INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(organization_id, code));
    CREATE TABLE programmes (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, min_grade_points INTEGER);
    CREATE TABLE schools (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    CREATE TABLE staff_scopes (staff_id INTEGER NOT NULL, school_id INTEGER NOT NULL);
    CREATE TABLE staff_users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL, scope_mode TEXT NOT NULL DEFAULT 'all');
    CREATE TABLE applicants (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ref_number TEXT NOT NULL UNIQUE, email_address TEXT NOT NULL, thread_id TEXT NOT NULL,
      full_name TEXT, programme TEXT, intake TEXT, priority TEXT NOT NULL DEFAULT 'normal', lifecycle TEXT NOT NULL DEFAULT 'application_received',
      requirements_snapshot TEXT, admission_decision TEXT NOT NULL DEFAULT 'undecided', admission_route TEXT, admission_rules_frozen TEXT, admission_rules_frozen_at TEXT,
      decision_by TEXT, decision_reason TEXT, decision_at TEXT, req_result TEXT, routing TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (email_address, thread_id));
    CREATE TABLE templates (key TEXT PRIMARY KEY, name TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE ref_counters (year INTEGER PRIMARY KEY, last_seq INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, applicant_id INTEGER, at TEXT NOT NULL DEFAULT (datetime('now')), actor TEXT NOT NULL DEFAULT 'system', event TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '');
    CREATE TABLE decision_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, applicant_id INTEGER NOT NULL, triggering_email_id TEXT NOT NULL, computed_status TEXT NOT NULL, reasoning TEXT NOT NULL, auto_sent INTEGER NOT NULL DEFAULT 0, timestamp TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, applicant_id INTEGER NOT NULL, to_address TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, mode TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE requirement_rules (id INTEGER PRIMARY KEY AUTOINCREMENT, programme TEXT, system TEXT, min_grade_points INTEGER, mean_grade TEXT);
    CREATE TABLE admission_rules (id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT NOT NULL);
    CREATE TABLE admission_rule_nodes (id INTEGER PRIMARY KEY AUTOINCREMENT, rule_id INTEGER NOT NULL, kind TEXT NOT NULL);
    CREATE TABLE documents (id INTEGER PRIMARY KEY AUTOINCREMENT, applicant_id INTEGER NOT NULL, document_type TEXT NOT NULL, source_email_id TEXT NOT NULL, extraction_method TEXT NOT NULL, extracted_text TEXT NOT NULL, extracted_fields TEXT NOT NULL DEFAULT '{}', confidence TEXT NOT NULL, superseded_by INTEGER, duplicate_of INTEGER, received_at TEXT NOT NULL);
    CREATE TABLE emails (id INTEGER PRIMARY KEY AUTOINCREMENT, applicant_id INTEGER NOT NULL, message_id TEXT NOT NULL, thread_id TEXT NOT NULL, direction TEXT NOT NULL, from_addr TEXT NOT NULL, to_addr TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, category TEXT, auto INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL);
    CREATE TABLE processed_emails (email_id TEXT PRIMARY KEY, processed_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE intakes (name TEXT PRIMARY KEY, deadline TEXT);
    CREATE TABLE status_history (id INTEGER PRIMARY KEY AUTOINCREMENT, applicant_id INTEGER NOT NULL, from_status TEXT, to_status TEXT NOT NULL, at TEXT NOT NULL DEFAULT (datetime('now')), actor TEXT NOT NULL);
  `);
  db.prepare("INSERT INTO case_types (id, organization_id, code, name, category, education_module, auto_admit, qualification_gate) VALUES (1, 1, 'GENERAL', 'General', 'general', 0, 0, 1), (2, 1, 'LEGACY_FLOW', 'Legacy flow', 'legacy', 1, 1, 0)").run();
  db.prepare("INSERT INTO programmes (code, name, min_grade_points) VALUES ('LEGACY', 'Legacy catalogue entry', 325)").run();
  db.prepare("INSERT INTO schools (id, name) VALUES (1, 'North campus'), (2, 'South campus')").run();
  db.prepare("INSERT INTO staff_users (id, username, display_name, password_hash, role, scope_mode) VALUES (1, 'officer', 'Olive Officer', 'x', 'user', 'scoped'), (2, 'boss', 'Beatrice Boss', 'x', 'admin', 'all'), (3, 'clerk', 'Chris Clerk', 'x', 'user', 'none')").run();
  db.prepare("INSERT INTO staff_scopes (staff_id, school_id) VALUES (1, 1)").run();
  const insApp = db.prepare(`INSERT INTO applicants (id, ref_number, email_address, thread_id, full_name, programme, intake, lifecycle, requirements_snapshot, admission_decision, admission_route, admission_rules_frozen, admission_rules_frozen_at, decision_by, decision_reason, decision_at, req_result, routing, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2025-08-11 09:00:00', '2025-08-11 09:00:00')`);
  insApp.run(1, REF1, "amara@example.test", "t-1", "Amara Njoroge", "LEGACY", "September 2025", "completed", SNAPSHOT1, "auto_admitted", "auto", "[]", "2025-08-20 10:00:00", "auto", REASON1, "2025-08-20 10:00:00", "Green", "straight");
  insApp.run(2, REF2, "kofi@example.test", "t-2", "Kofi Mensah", "LEGACY", "September 2025", "awaiting_review", SNAPSHOT2, "not_admitted", "human", null, null, "officer", "Missing the request form.", "2025-08-21 11:00:00", "Red", "review");
  insApp.run(3, REF3, "rosa@example.test", "t-3", "Rosa Wambui", "LEGACY", "September 2025", "completed", SNAPSHOT2, "admitted_after_review", "human", null, null, "officer", "Approved after review.", "2025-08-22 12:00:00", "Green", "straight");
  db.prepare("INSERT INTO templates (key, name, subject, body) VALUES ('docs_request', 'Document request', 'Documents needed for {ref}', 'Please send the outstanding items.\n\n{institution}')").run();
  const insSet = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
  for (const [k, v] of SECRET_KEYS) insSet.run(k, v);
  insSet.run("from_name", "Legacy Workspace Desk");
  insSet.run("ref_prefix", "LW");
  insSet.run("institution_name", "Legacy Workspace Ltd");
  insSet.run("automation_mode", "auto");
  db.prepare("INSERT INTO ref_counters (year, last_seq) VALUES (2025, 125)").run();
  const insAudit = db.prepare("INSERT INTO audit_log (applicant_id, actor, event, detail) VALUES (?, ?, ?, ?)");
  for (const row of AUDIT_ROWS) insAudit.run(...row);
  db.prepare("INSERT INTO decision_logs (applicant_id, triggering_email_id, computed_status, reasoning, auto_sent) VALUES (1, 'm-1', 'Green', ?, 1)").run(DECISION_REASONING);
  db.prepare("INSERT INTO outbox (applicant_id, to_address, subject, body, mode) VALUES (2, 'kofi@example.test', 'Draft reply', 'Held body', 'queued')").run();
  db.prepare("INSERT INTO requirement_rules (programme, system, min_grade_points) VALUES ('LEGACY', 'legacy', 325)").run();
  db.prepare("INSERT INTO admission_rules (level) VALUES ('legacy')").run();
  db.prepare("INSERT INTO admission_rule_nodes (rule_id, kind) VALUES (1, 'condition')").run();
  db.prepare("INSERT INTO documents (applicant_id, document_type, source_email_id, extraction_method, extracted_text, confidence, received_at) VALUES (1, 'request_form', 'm-1', 'pdf_text', 'request form', 'high', '2025-08-11 09:10:00')").run();
  db.prepare("INSERT INTO emails (applicant_id, message_id, thread_id, direction, from_addr, to_addr, subject, body, category, auto, at) VALUES (1, 'm-1', 't-1', 'in', 'amara@example.test', 'intake@example.test', 'Request', 'Please help.', 'application', 0, '2025-08-11 09:00:00')").run();
  db.prepare("INSERT INTO processed_emails (email_id) VALUES ('m-1')").run();
  db.prepare("INSERT INTO intakes (name, deadline) VALUES ('September 2025', '2025-08-31T23:59:59Z'), ('January 2026', NULL)").run();
  db.prepare("INSERT INTO status_history (applicant_id, from_status, to_status, at, actor) VALUES (1, NULL, 'application_received', '2025-08-11 09:00:00', 'system')").run();
  db.close();
}

describe("PPR P0-7: the storage migration on a production-shaped legacy copy", () => {
  const file = path.join(os.tmpdir(), `ppr-p07-production-copy-${process.pid}.db`);
  let db: Database.Database;

  beforeAll(() => {
    buildProductionCopy(file);
    // THE migration: open the copy exactly like production boot would.
    db = openDb(file);
  });

  afterAll(() => {
    db?.close();
    fs.rmSync(file, { force: true });
  });

  const cols = (table: string): string[] => (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((c) => c.name);
  const tables = (): string[] => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);

  it("keeps every table and column name; renames only the declared legacy names", () => {
    // (1) Names kept — the old rows still answer their old column names.
    const row = db.prepare("SELECT ref_number, requirements_snapshot, case_type_code, legacy_outcome, outcome_route FROM applicants WHERE id = 1").get() as Record<string, unknown>;
    expect(row.ref_number).toBe(REF1);
    expect(row.legacy_outcome).toBe("auto_admitted");
    expect(row.outcome_route).toBe("auto");
    for (const t of ["applicants", "templates", "settings", "audit_log", "decision_logs", "outbox", "programmes", "staff_users", "ref_counters", "case_types", "documents", "emails", "status_history"]) {
      expect(tables(), t).toContain(t);
    }
    // The declared renames happened, and the old names are gone.
    expect(cols("applicants")).not.toContain("admission_decision");
    expect(cols("applicants")).not.toContain("admission_route");
    // C2: the column that held the case-type code is renamed, not reinterpreted.
    expect(cols("applicants")).toContain("case_type_code");
    expect(cols("applicants")).not.toContain("programme");
    expect(cols("evaluations")).toContain("case_type_code");
    expect(cols("evaluations")).not.toContain("programme");
    expect(db.prepare("SELECT case_type_code FROM applicants WHERE id = 1").get()).toEqual({ case_type_code: "LEGACY" });
    expect(cols("case_types")).toContain("legacy_module");
    expect(cols("case_types")).toContain("legacy_auto_decision");
    expect(cols("case_types")).not.toContain("education_module");
    expect(tables()).toContain("legacy_rule_sets");
    expect(tables()).toContain("legacy_rule_nodes");
    expect(tables()).not.toContain("admission_rules");
    // (2) Extension structures added — new COLUMNS on old tables…
    for (const c of ["case_config_frozen", "config_version_frozen", "queue", "followup_action", "case_type_id", "organization_id", "category", "outcome"]) {
      expect(cols("applicants"), c).toContain(c);
    }
    for (const c of ["terminology", "stages", "queues", "config_version", "default_reply_action", "evidence_gate"]) {
      expect(cols("case_types"), c).toContain(c);
    }
    // …including the draft-claim column the send path depends on:
    expect(cols("outbox")).toContain("claimed_at");
    expect(cols("outbox")).toContain("needs_approval");
    expect(cols("templates")).toContain("default_snapshot");
    expect(cols("staff_users")).toContain("case_type_scope_mode");
    // Columns the code reads on ordinary requests are added even when the
    // older release never had them — an upgrade must not fail on first query.
    expect(cols("staff_users")).toContain("active");
    expect(cols("case_types")).toContain("active");
    expect(cols("emails")).toEqual(expect.arrayContaining(["read", "labels", "organization_id", "channel", "attachments"]));
    expect(cols("documents")).toEqual(expect.arrayContaining(["sha256", "is_duplicate", "confidence_score"]));
    expect(cols("status_history")).toContain("reason");
    expect(cols("applicants")).toEqual(expect.arrayContaining(["triage", "phone"]));
    // …and new TABLES.
    for (const t of ["organizations", "secrets", "workflow_rules", "attachment_sets", "attachment_set_files", "organization_templates", "staff_permissions", "staff_case_type_scopes", "case_type_aliases"]) {
      expect(tables(), t).toContain(t);
    }
    expect(Number(db.pragma("user_version", { simple: true }))).toBe(2);
  });

  it("stamps existing rows into the migrated organization exactly once", () => {
    // No organization row existed: the migration creates one from the stored
    // institution name — existing customer data is preserved, and a NEW
    // installation still boots empty.
    const org = db.prepare("SELECT id, name, ref_prefix, from_name FROM organizations WHERE id = 1").get() as Record<string, unknown>;
    expect(org.name).toBe("Legacy Workspace Ltd");
    expect(org.from_name).toBe("Legacy Workspace Desk");
    // Every existing row now belongs to that tenant…
    expect((db.prepare("SELECT COUNT(*) AS n FROM applicants WHERE IFNULL(organization_id, 0) <> 1").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM staff_users WHERE IFNULL(organization_id, 0) <> 1").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM emails WHERE organization_id <> 1").get() as { n: number }).n).toBe(0);
    // …and the historical decision vocabulary is mapped ONCE, into the
    // generic outcome column, keeping the original text beside it.
    const outcomes = db.prepare("SELECT id, outcome, legacy_outcome FROM applicants ORDER BY id").all() as Array<{ id: number; outcome: string; legacy_outcome: string }>;
    expect(outcomes).toEqual([
      { id: 1, outcome: "auto_approved", legacy_outcome: "auto_admitted" },
      { id: 2, outcome: "not_approved", legacy_outcome: "not_admitted" },
      { id: 3, outcome: "approved_after_review", legacy_outcome: "admitted_after_review" },
    ]);
    // A migrated case type is draft-first, whatever the old system did; the
    // legacy flags survive under their new names for an administrator to read.
    const legacyFlow = db.prepare("SELECT default_reply_action, legacy_module, legacy_auto_decision, evidence_gate FROM case_types WHERE code = 'LEGACY_FLOW'").get() as Record<string, unknown>;
    expect(legacyFlow.default_reply_action).toBe("draft");
    expect(legacyFlow.legacy_module).toBe(1);
    expect(legacyFlow.legacy_auto_decision).toBe(1);
    expect(legacyFlow.evidence_gate).toBe(0); // the old gate value is preserved
    expect(db.prepare("SELECT value FROM settings WHERE key = 'generic_storage_v2'").get()).toBeTruthy();
  });

  it("moves secrets out of settings exactly once and migrates from_name to the org row", () => {
    const secrets = db.prepare("SELECT key, value, organization_id FROM secrets ORDER BY key").all() as Array<{ key: string; value: string; organization_id: number }>;
    expect(secrets.map((s) => s.key)).toEqual(SECRET_KEYS.map(([k]) => k).sort());
    for (const [key, value] of SECRET_KEYS) expect(secrets.find((s) => s.key === key)!.value).toBe(value);
    // The settings bag no longer carries them (it is exported to the UI)…
    for (const [key] of SECRET_KEYS) expect(db.prepare("SELECT value FROM settings WHERE key = ?").get(key)).toBeUndefined();
    expect(db.prepare("SELECT value FROM settings WHERE key = 'from_name'").get()).toBeUndefined();
    // …and a re-open neither duplicates nor resurrects anything.
    const again = openDb(file);
    try {
      expect((again.prepare("SELECT COUNT(*) AS n FROM secrets").get() as { n: number }).n).toBe(SECRET_KEYS.length);
      expect(again.prepare("SELECT value FROM settings WHERE key = 'from_name'").get()).toBeUndefined();
    } finally {
      again.close();
    }
  });

  it("never rewrites history: snapshots, logs and reference numbers are byte-identical", () => {
    const first = db.prepare("SELECT ref_number, requirements_snapshot, decision_by, decision_reason, decision_at, req_result, routing, lifecycle, created_at FROM applicants WHERE id = 1").get();
    expect(first).toEqual({
      ref_number: REF1, requirements_snapshot: SNAPSHOT1, decision_by: "auto", decision_reason: REASON1,
      decision_at: "2025-08-20 10:00:00", req_result: "Green", routing: "straight", lifecycle: "completed",
      created_at: "2025-08-11 09:00:00",
    });
    expect(db.prepare("SELECT reasoning, computed_status, auto_sent FROM decision_logs WHERE applicant_id = 1").get())
      .toEqual({ reasoning: DECISION_REASONING, computed_status: "Green", auto_sent: 1 });
    const audit = db.prepare("SELECT applicant_id, actor, event, detail FROM audit_log ORDER BY id").all();
    expect(audit).toEqual(AUDIT_ROWS.map(([applicant_id, actor, event, detail]) => ({ applicant_id, actor, event, detail })));
    expect((db.prepare("SELECT COUNT(*) AS n FROM status_history").get() as { n: number }).n).toBe(1);
    // The held draft and the processed-email claim survive too.
    expect(db.prepare("SELECT subject, body, mode FROM outbox WHERE applicant_id = 2").get()).toEqual({ subject: "Draft reply", body: "Held body", mode: "queued" });
    expect(db.prepare("SELECT email_id, organization_id FROM processed_emails").all()).toEqual([{ email_id: "m-1", organization_id: 1 }]);
  });

  it("drops the school dimension and NARROWS school-scoped staff to no access", () => {
    expect(tables()).not.toContain("schools");
    expect(tables()).not.toContain("staff_scopes");
    expect(cols("staff_users")).not.toContain("scope_mode");
    const repo = new Repo(db);
    const scoped = repo.getStaffByUsername("officer")!;
    const admin = repo.getStaffByUsername("boss")!;
    const neverScoped = repo.getStaffByUsername("clerk")!;
    // An officer who could only see one campus can see NO case types until an
    // administrator assigns some — the migration never widens access.
    expect(repo.visibleCaseTypesFor(scoped)).toEqual([]);
    expect(repo.caseTypeScopeModeFor(scoped.id)).toBe("none");
    // 'none' stayed 'none'…
    expect(repo.visibleCaseTypesFor(neverScoped)).toEqual([]);
    // …and an account that was never scoped keeps full visibility.
    expect(repo.caseTypeScopeModeFor(admin.id)).toBe("unscoped");
    expect(repo.visibleCaseTypesFor(admin)).toBeNull();
    // The migrated case types are still there and readable through the repo
    // (the `active` column the query needs was added by the migration), and no
    // scope rows were invented: an administrator assigns case types deliberately.
    expect(repo.listCaseTypes(1).map((t) => t.code).sort()).toEqual(["GENERAL", "LEGACY_FLOW"]);
    expect(repo.emailsForApplicant(1).map((e) => e.message_id)).toEqual(["m-1"]);
    expect(repo.statusHistory(1).map((h) => h.to_status)).toEqual(["application_received"]);
    repo.setLifecycle(1, "awaiting_review", "migration-test", "checking the upgraded schema");
    expect(repo.statusHistory(1).map((h) => h.reason).at(-1)).toBe("checking the upgraded schema");
    expect((db.prepare("SELECT COUNT(*) AS n FROM staff_case_type_scopes").get() as { n: number }).n).toBe(0);
  });

  it("scopes submission windows per tenant and keeps every deadline", () => {
    // The windows table used to be global: two tenants naming the same window
    // shared one deadline. The rebuild keeps the rows and their deadlines and
    // attributes them to the head office, where they all lived before.
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'intakes'").get() as { sql: string }).sql;
    expect(sql).toMatch(/PRIMARY KEY \(organization_id, name\)/);
    const repo = new Repo(db);
    expect(repo.listIntakes(1)).toEqual(["September 2025", "January 2026"]);
    expect(repo.intakeDeadline("September 2025", 1)).toBe("2025-08-31T23:59:59Z");
    expect(repo.intakeDeadline("January 2026", 1)).toBeNull();
    // A second tenant may hold the SAME window name with its own deadline…
    repo.addIntakeWithDeadline("September 2025", "2026-09-30T23:59:59Z", 2);
    expect(repo.intakeDeadline("September 2025", 2)).toBe("2026-09-30T23:59:59Z");
    expect(repo.intakeDeadline("September 2025", 1)).toBe("2025-08-31T23:59:59Z"); // untouched
    expect(repo.listIntakes(2)).toEqual(["September 2025"]);
    // …but a duplicate inside one tenant is still refused, and an update is an
    // update (never a second row).
    expect(() => db.prepare("INSERT INTO intakes (organization_id, name, deadline) VALUES (1, 'September 2025', NULL)").run()).toThrow(/UNIQUE/i);
    repo.addIntakeWithDeadline("September 2025", "2025-09-30T23:59:59Z", 1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM intakes WHERE organization_id = 1 AND name = 'September 2025'").get() as { n: number }).n).toBe(1);
    expect(repo.intakeDeadline("September 2025", 1)).toBe("2025-09-30T23:59:59Z");
    // Another tenant's windows are invisible here.
    expect(repo.listIntakes(3)).toEqual([]);
  });

  it("a migration that fails half-way leaves the original database intact", () => {
    // Build a copy whose rebuild cannot run: the reserved temporary table
    // already exists, so rebuildConstraint refuses. openDb wraps the whole
    // migration in one transaction, so nothing at all may survive.
    const broken = path.join(os.tmpdir(), `ppr-p07-broken-${process.pid}.db`);
    buildProductionCopy(broken);
    const raw: Database.Database = new (require("better-sqlite3"))(broken);
    raw.exec("CREATE TABLE applicants_tenant_migration (id INTEGER)");
    raw.close();
    expect(() => openDb(broken)).toThrow(/Reserved migration table already exists/);
    // The file is still the ORIGINAL legacy database: old column names, old
    // uniqueness, no marker, no tenant stamping, every row present.
    const after: Database.Database = new (require("better-sqlite3"))(broken, { readonly: true });
    const cols = (after.prepare("PRAGMA table_info(applicants)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("admission_decision");
    expect(cols).toContain("programme");
    expect(cols).not.toContain("case_type_code");
    expect((after.prepare("SELECT sql FROM sqlite_master WHERE name = 'applicants'").get() as { sql: string }).sql).toMatch(/UNIQUE \(email_address, thread_id\)/);
    expect(after.prepare("SELECT value FROM settings WHERE key = 'generic_storage_v2'").get()).toBeUndefined();
    expect((after.prepare("SELECT COUNT(*) AS n FROM applicants").get() as { n: number }).n).toBe(3);
    expect((after.prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n).toBe(3);
    // The migration never ran, so the tables it would have created are absent.
    const tables = (after.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
    expect(tables).not.toContain("secrets");
    expect(tables).not.toContain("workflow_rules");
    expect(tables).toContain("schools"); // the school dimension was never dropped
    expect(after.prepare("SELECT deadline FROM intakes WHERE name = 'September 2025'").get()).toEqual({ deadline: "2025-08-31T23:59:59Z" });
    expect(Number(after.pragma("user_version", { simple: true }))).not.toBe(2);
    after.close();
    fs.rmSync(broken, { force: true });
  });

  it("rebuilds the legacy uniqueness constraint per tenant", () => {
    const caseSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'applicants'").get() as { sql: string }).sql;
    expect(caseSql).toMatch(/UNIQUE \(organization_id, email_address, thread_id\)/);
    expect(caseSql).not.toMatch(/UNIQUE \(email_address, thread_id\)/);
    const processedSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'processed_emails'").get() as { sql: string }).sql;
    expect(processedSql).toMatch(/PRIMARY KEY \(organization_id, email_id\)/);
    // Row ids and the AUTOINCREMENT high-water mark survived the rebuild.
    expect((db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'applicants'").get() as { seq: number }).seq).toBeGreaterThanOrEqual(3);
    // A second tenant may hold the same contact email and thread…
    db.prepare("INSERT INTO organizations (id, name, ref_prefix) VALUES (2, 'Second Tenant', 'SEC')").run();
    expect(() => db.prepare("INSERT INTO applicants (ref_number, email_address, thread_id, organization_id) VALUES ('SEC-2025-000001', 'amara@example.test', 't-1', 2)").run()).not.toThrow();
    // …but a duplicate inside the SAME tenant is still refused.
    expect(() => db.prepare("INSERT INTO applicants (ref_number, email_address, thread_id, organization_id) VALUES ('LW-2025-000999', 'amara@example.test', 't-1', 1)").run())
      .toThrow(/UNIQUE/i);
    // The same message id can be claimed once per tenant.
    expect(() => db.prepare("INSERT INTO processed_emails (email_id, organization_id) VALUES ('m-1', 2)").run()).not.toThrow();
    expect(() => db.prepare("INSERT INTO processed_emails (email_id, organization_id) VALUES ('m-1', 2)").run()).toThrow(/UNIQUE/i);
  });

  it("the alias table arrives with installation-wide address uniqueness, idempotently", () => {
    // Phase D3 added inbound-address routing; an upgraded database gets the
    // table on open, and an address can only ever belong to one row.
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'case_type_aliases'").get() as { sql: string }).sql;
    expect(sql).toMatch(/address\s+TEXT NOT NULL UNIQUE/i);
    expect(sql).toMatch(/organization_id INTEGER NOT NULL REFERENCES organizations\(id\)/);
    db.prepare("INSERT INTO case_type_aliases (organization_id, case_type_id, address) VALUES (1, 1, 'billing@example.test')").run();
    expect(() => db.prepare("INSERT INTO case_type_aliases (organization_id, case_type_id, address) VALUES (1, 2, 'billing@example.test')").run()).toThrow(/UNIQUE/i);
    // A second open neither duplicates nor rebuilds it.
    const reopened = openDb(file);
    try {
      expect((reopened.prepare("SELECT COUNT(*) AS n FROM case_type_aliases").get() as { n: number }).n).toBe(1);
      expect((reopened.prepare("SELECT address, active FROM case_type_aliases").get())).toEqual({ address: "billing@example.test", active: 1 });
    } finally {
      reopened.close();
    }
  });

  it("one-shot markers hold on re-open: a deliberate setting is never re-stamped", () => {
    // The administrator renames the tenant, opts a case type into sending and
    // clears an outcome by hand…
    db.prepare("UPDATE organizations SET name = 'Renamed Workspace', from_name = 'Renamed Desk' WHERE id = 1").run();
    db.prepare("UPDATE case_types SET default_reply_action = 'auto' WHERE code = 'LEGACY_FLOW'").run();
    db.prepare("UPDATE applicants SET outcome = 'undecided' WHERE id = 1").run();
    const reopened = openDb(file);
    try {
      // …and a re-open changes none of it: the migration is one-shot.
      expect(reopened.prepare("SELECT name, from_name FROM organizations WHERE id = 1").get())
        .toEqual({ name: "Renamed Workspace", from_name: "Renamed Desk" });
      expect(reopened.prepare("SELECT default_reply_action FROM case_types WHERE code = 'LEGACY_FLOW'").get())
        .toEqual({ default_reply_action: "auto" });
      expect(reopened.prepare("SELECT outcome FROM applicants WHERE id = 1").get()).toEqual({ outcome: "undecided" });
      expect((reopened.prepare("SELECT COUNT(*) AS n FROM organizations").get() as { n: number }).n).toBe(2);
    } finally {
      reopened.close();
    }
  });

  it("refuses a database written by a newer version of the application", () => {
    const newer = path.join(os.tmpdir(), `ppr-p07-newer-${process.pid}.db`);
    fs.rmSync(newer, { force: true });
    const db2: Database.Database = new (require("better-sqlite3"))(newer);
    db2.pragma("user_version = 3");
    db2.close();
    expect(() => openDb(newer)).toThrow(/newer version/i);
    fs.rmSync(newer, { force: true });
  });
});
