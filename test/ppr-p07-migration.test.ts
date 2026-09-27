/**
 * PPR P0-7 acceptance: the schema/data migration is TESTED on a
 * production-shaped COPY of the real Riara instance (reference numbers,
 * KCSE-era programmes, frozen requirement snapshots, admission decisions,
 * audit + decision logs, education template wording, pack defaults, legacy
 * secrets sitting in the settings bag) — with before/after evidence for
 * every invariant:
 *
 *   1. table/column NAMES are kept (extension columns only),
 *   2. extension/profile-id structures are added,
 *   3. existing rows are stamped as the migrated education profile, version 1,
 *   4. one-shot markers never re-run (a deliberate off stays off),
 *   5. secrets leave the settings bag exactly once,
 *   6. historical cases are never silently rewritten (snapshots, logs,
 *      reference numbers, decisions byte-identical),
 *   7. pack defaults are stamped once and never resurrected.
 *
 * The written plan lives in MIGRATION.md at the repository root.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { openDb } from "../src/db/db";
import type Database from "better-sqlite3";

// ── The production-shaped pre-migration copy ─────────────────────────────
// Values below are the "BEFORE" evidence: every one of them is asserted to
// survive the migration unchanged (or to change in exactly the declared way).

const REF1 = "RU-2025-000123";
const REF2 = "RU-2025-000124";
const SNAPSHOT1 = JSON.stringify([
  { document_type: "kcse_cert", required: true, blocking: true },
  { document_type: "birth_cert", required: true, blocking: true },
]);
const REASON1 = "Mean grade B+ (332 points) — cleared under Regulation 4.2.";
const AUDIT_ROWS: Array<[number, string, string, string]> = [
  [1, "system", "applicant_created", `Case ${REF1} opened for amara@example.test`],
  [1, "kamau", "admitted_after_review", REASON1],
  [2, "system", "requirements_checked", "verdict=Red; missing=kcse_cert"],
];
const DECISION_REASONING = "- [kcse_cert] verified (high confidence)\n- [mean_grade] B+ >= B — pass";
const SNAPSHOT2 = JSON.stringify([{ document_type: "kcse_cert", required: true, blocking: true }]);
const SECRET_KEYS: Array<[string, string]> = [
  ["gemini_api_key", "sk-legacy-gemini-9f3"],
  ["gmail_client_secret", "GOCSPX-legacy-client"],
  ["gmail_refresh_token", "1//legacy-refresh-token"],
];

function buildProductionCopy(file: string): void {
  fs.rmSync(file, { force: true });
  const db: Database.Database = new (require("better-sqlite3"))(file);
  db.pragma("foreign_keys = OFF");
  // Exactly the tables a live pre-PPR Riara database carries — old column
  // names intact, no PPR extension columns anywhere.
  db.exec(`
    CREATE TABLE organizations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, theme TEXT, logo TEXT, tagline TEXT);
    CREATE TABLE case_types (id INTEGER PRIMARY KEY AUTOINCREMENT, organization_id INTEGER NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'general', config TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(organization_id, code));
    CREATE TABLE programmes (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, min_grade_points INTEGER);
    CREATE TABLE staff_users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL);
    CREATE TABLE applicants (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ref_number TEXT NOT NULL UNIQUE, email_address TEXT NOT NULL, thread_id TEXT NOT NULL,
      full_name TEXT, programme TEXT, intake TEXT, priority TEXT NOT NULL DEFAULT 'normal', lifecycle TEXT NOT NULL DEFAULT 'application_received',
      requirements_snapshot TEXT, admission_decision TEXT NOT NULL DEFAULT 'undecided', decision_by TEXT, decision_reason TEXT, decision_at TEXT,
      req_result TEXT, routing TEXT, outcome TEXT NOT NULL DEFAULT 'undecided', organization_id INTEGER, case_type_id INTEGER, category TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (email_address, thread_id));
    CREATE TABLE templates (key TEXT PRIMARY KEY, name TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE ref_counters (year INTEGER PRIMARY KEY, last_seq INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, applicant_id INTEGER, at TEXT NOT NULL DEFAULT (datetime('now')), actor TEXT NOT NULL DEFAULT 'system', event TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '');
    CREATE TABLE decision_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, applicant_id INTEGER NOT NULL, triggering_email_id TEXT NOT NULL, computed_status TEXT NOT NULL, reasoning TEXT NOT NULL, auto_sent INTEGER NOT NULL DEFAULT 0, timestamp TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, applicant_id INTEGER NOT NULL, to_address TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, mode TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE requirement_rules (id INTEGER PRIMARY KEY AUTOINCREMENT, programme TEXT, system TEXT, min_grade_points INTEGER, mean_grade TEXT);
    CREATE TABLE admission_rules (id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT NOT NULL);
    CREATE TABLE documents (id INTEGER PRIMARY KEY AUTOINCREMENT, applicant_id INTEGER NOT NULL, document_type TEXT NOT NULL, source_email_id TEXT NOT NULL, extraction_method TEXT NOT NULL, extracted_text TEXT NOT NULL, extracted_fields TEXT NOT NULL DEFAULT '{}', confidence TEXT NOT NULL, superseded_by INTEGER, sha256 TEXT, is_duplicate INTEGER NOT NULL DEFAULT 0, duplicate_of INTEGER, received_at TEXT NOT NULL);
    CREATE TABLE emails (id INTEGER PRIMARY KEY AUTOINCREMENT, applicant_id INTEGER NOT NULL, message_id TEXT NOT NULL, thread_id TEXT NOT NULL, direction TEXT NOT NULL, from_addr TEXT NOT NULL, to_addr TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, category TEXT, auto INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL);
    CREATE TABLE status_history (id INTEGER PRIMARY KEY AUTOINCREMENT, applicant_id INTEGER NOT NULL, from_status TEXT, to_status TEXT NOT NULL, at TEXT NOT NULL, actor TEXT NOT NULL, note TEXT);
  `);
  db.prepare("INSERT INTO organizations (id, name) VALUES (1, 'Riara University')").run();
  db.prepare("INSERT INTO case_types (id, organization_id, code, name, category) VALUES (1, 1, 'GENERAL', 'General', 'general'), (2, 1, 'BCS', 'Bachelor of Computer Science', 'BCS')").run();
  db.prepare("INSERT INTO programmes (code, name, min_grade_points) VALUES ('BCS', 'Bachelor of Computer Science', 325)").run();
  db.prepare("INSERT INTO staff_users (id, username, display_name, password_hash, role) VALUES (1, 'kamau', 'Kamau Wanjiru', 'x', 'officer'), (2, 'admin', 'Administrator', 'x', 'admin')").run();
  const insApp = db.prepare(`INSERT INTO applicants (id, ref_number, email_address, thread_id, full_name, programme, intake, lifecycle, requirements_snapshot, admission_decision, decision_by, decision_reason, decision_at, req_result, routing, outcome, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2025-08-11 09:00:00', '2025-08-11 09:00:00')`);
  insApp.run(1, REF1, "amara@example.test", "t-1", "Amara Njoroge", "BCS", "September 2025", "completed", SNAPSHOT1, "auto_admitted", "auto", REASON1, "2025-08-20 10:00:00", "Green", "straight", "auto_approved");
  insApp.run(2, REF2, "kofi@example.test", "t-2", "Kofi Mensah", "BCS", "September 2025", "awaiting_review", SNAPSHOT2, "not_admitted", "kamau", "Missing KCSE certificate.", "2025-08-21 11:00:00", "Red", "review", "not_approved");
  const insTpl = db.prepare("INSERT INTO templates (key, name, subject, body) VALUES (?, ?, ?, ?)");
  insTpl.run("docs_request", "Document request", "Documents needed for {ref}", "…\n\nKind regards,\n{institution} — Admissions Office");
  insTpl.run("admission_letter", "Admission letter", "Your place at {institution}", "Dear {name}, you have been admitted.\n\n{institution} — Admissions Office");
  const insSet = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
  for (const [k, v] of SECRET_KEYS) insSet.run(k, v);
  insSet.run("from_name", "Riara University Admissions");
  insSet.run("ref_prefix", "RU");
  insSet.run("institution_name", "Riara University");
  db.prepare("INSERT INTO ref_counters (year, last_seq) VALUES (2025, 124)").run();
  const insAudit = db.prepare("INSERT INTO audit_log (applicant_id, actor, event, detail) VALUES (?, ?, ?, ?)");
  for (const row of AUDIT_ROWS) insAudit.run(...row);
  db.prepare("INSERT INTO decision_logs (applicant_id, triggering_email_id, computed_status, reasoning, auto_sent) VALUES (1, 'm-1', 'Green', ?, 1)").run(DECISION_REASONING);
  db.prepare("INSERT INTO outbox (applicant_id, to_address, subject, body, mode) VALUES (2, 'kofi@example.test', 'Draft reply', 'Held body', 'queued')").run();
  db.prepare("INSERT INTO requirement_rules (programme, system, min_grade_points) VALUES ('BCS', 'KCSE', 325)").run();
  db.prepare("INSERT INTO admission_rules (level) VALUES ('postgrad')").run();
  db.close();
}

describe("PPR P0-7: migration tested on a production-shaped Riara copy", () => {
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

  it("keeps every table and column name; adds extension/profile-id structures", () => {
    // (1) Names kept — the old columns still answer their old names.
    const row = db.prepare("SELECT ref_number, admission_decision, requirements_snapshot, programme, outcome FROM applicants WHERE id = 1").get() as Record<string, unknown>;
    expect(row.ref_number).toBe(REF1);
    const tableNames = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
    for (const t of ["applicants", "templates", "settings", "audit_log", "decision_logs", "outbox", "programmes", "staff_users", "ref_counters", "case_types", "organizations"]) {
      expect(tableNames).toContain(t);
    }
    // (2) Extension structures added — new COLUMNS on old tables…
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
    for (const c of ["case_config_frozen", "config_version_frozen", "queue", "followup_action", "case_type_id", "organization_id", "category"]) {
      expect(cols("applicants")).toContain(c);
    }
    for (const c of ["education_module", "terminology", "stages", "queues", "config_version", "default_reply_action", "qualification_gate", "auto_admit"]) {
      expect(cols("case_types")).toContain(c);
    }
    expect(cols("outbox")).toContain("needs_approval");
    expect(cols("templates")).toContain("default_snapshot");
    // …and new TABLES.
    for (const t of ["secrets", "workflow_rules", "attachment_sets", "attachment_set_files", "organization_templates", "staff_permissions"]) {
      expect(tableNames).toContain(t);
    }
  });

  it("stamps existing rows as the migrated education profile, version 1", () => {
    // Profile stamping: the programme-derived + GENERAL types become the
    // education module with the PRESERVED legacy automation posture
    // (invariant f: only the migrated Riara profile keeps auto-reply/auto-admit
    // semantics explicitly — qualification-gated, never an auto decision).
    for (const id of [1, 2]) {
      const ct = db.prepare("SELECT education_module, qualification_gate, default_reply_action, auto_admit, config_version FROM case_types WHERE id = ?").get(id) as Record<string, unknown>;
      expect(ct.education_module).toBe(1);
      expect(ct.qualification_gate).toBe(1);
      expect(ct.default_reply_action).toBe("send"); // preserved legacy setting
      expect(ct.auto_admit).toBe(0); // never an auto decision
      expect(ct.config_version).toBe(1); // migrated profile version 1
    }
    // Case stamping: every historical case is frozen as "opened under version
    // 1" and profile-bound (organization + case type stamped).
    for (const id of [1, 2]) {
      const a = db.prepare("SELECT config_version_frozen, organization_id, case_type_id, category FROM applicants WHERE id = ?").get(id) as Record<string, unknown>;
      expect(a.config_version_frozen).toBe(1);
      expect(a.organization_id).toBe(1);
      expect(a.case_type_id).toBeGreaterThan(0);
      expect(a.category).toBe("BCS"); // category projected from the legacy programme
    }
  });

  it("moves secrets out of settings exactly once and migrates from_name to the org row", () => {
    const keys = (db.prepare("SELECT key FROM settings").all() as Array<{ key: string }>).map((r) => r.key);
    for (const [k, v] of SECRET_KEYS) {
      expect(keys).not.toContain(k); // gone from the generic settings bag
      const secret = db.prepare("SELECT value FROM secrets WHERE organization_id = 1 AND key = ?").get(k) as { value: string } | undefined;
      expect(secret?.value).toBe(v); // value preserved in the secrets store
    }
    // from_name becomes real data on the organization row (P1-5), the
    // settings key is dropped only after the value is safe.
    const org = db.prepare("SELECT from_name, ref_prefix FROM organizations WHERE id = 1").get() as { from_name: string; ref_prefix: string };
    expect(org.from_name).toBe("Riara University Admissions");
    expect(keys).not.toContain("from_name");
    // Reference numbers keep their prefix and sequence — nothing renumbered.
    expect(org.ref_prefix).toBe("RU");
    expect((db.prepare("SELECT last_seq FROM ref_counters WHERE year = 2025").get() as { last_seq: number }).last_seq).toBe(124);
  });

  it("never rewrites history: snapshots, logs, reference numbers and decisions are byte-identical", () => {
    const a1 = db.prepare("SELECT ref_number, requirements_snapshot, admission_decision, decision_by, decision_reason, decision_at, outcome FROM applicants WHERE id = 1").get() as Record<string, unknown>;
    expect(a1.ref_number).toBe(REF1);
    expect(a1.requirements_snapshot).toBe(SNAPSHOT1); // frozen set untouched
    expect(a1.admission_decision).toBe("auto_admitted"); // historical decision untouched
    expect(a1.decision_reason).toBe(REASON1);
    expect(a1.outcome).toBe("auto_approved");
    const a2 = db.prepare("SELECT requirements_snapshot, admission_decision FROM applicants WHERE id = 2").get() as Record<string, unknown>;
    expect(a2.requirements_snapshot).toBe(SNAPSHOT2);
    expect(a2.admission_decision).toBe("not_admitted");
    // Audit text and decision-log reasoning are never edited or renumbered.
    const audits = db.prepare("SELECT applicant_id, actor, event, detail FROM audit_log ORDER BY id").all() as Array<[unknown]>;
    expect(audits.length).toBe(AUDIT_ROWS.length);
    AUDIT_ROWS.forEach(([, actor, event, detail], i) => {
      expect((audits[i] as unknown as { actor: string }).actor).toBe(actor);
      expect((audits[i] as unknown as { event: string }).event).toBe(event);
      expect((audits[i] as unknown as { detail: string }).detail).toBe(detail);
    });
    const dec = db.prepare("SELECT reasoning, computed_status, auto_sent FROM decision_logs WHERE id = 1").get() as Record<string, unknown>;
    expect(dec.reasoning).toBe(DECISION_REASONING);
    expect(dec.computed_status).toBe("Green");
  });

  it("one-shot markers hold on re-open: a deliberate off stays off, pack defaults never resurrect", () => {
    // The first migration stamped pack defaults once (docs_request →
    // application, admission_letter → admission) and set both markers.
    expect((db.prepare("SELECT attach_pack FROM templates WHERE key = 'docs_request'").get() as { attach_pack: string }).attach_pack).toBe("application");
    expect((db.prepare("SELECT attach_pack FROM templates WHERE key = 'admission_letter'").get() as { attach_pack: string }).attach_pack).toBe("admission");
    for (const marker of ["pack_defaults_migrated", "education_profiles_stamped"]) {
      expect((db.prepare("SELECT value FROM settings WHERE key = ?").get(marker) as { value: string }).value).toBe("1");
    }

    // Staff make deliberate post-migration choices…
    db.prepare("UPDATE case_types SET education_module = 0 WHERE id = 2").run();
    db.prepare("UPDATE templates SET attach_pack = 'none' WHERE key = 'docs_request'").run();
    const auditCount = (db.prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n;
    db.close();

    // …and a re-open (every production restart) NEVER re-runs the stamps.
    db = openDb(file);
    expect((db.prepare("SELECT education_module FROM case_types WHERE id = 2").get() as { education_module: number }).education_module).toBe(0);
    expect((db.prepare("SELECT attach_pack FROM templates WHERE key = 'docs_request'").get() as { attach_pack: string }).attach_pack).toBe("none");
    // No re-stamped history, no new audit rows, snapshots still frozen.
    expect((db.prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n).toBe(auditCount);
    expect((db.prepare("SELECT requirements_snapshot FROM applicants WHERE id = 1").get() as { requirements_snapshot: string }).requirements_snapshot).toBe(SNAPSHOT1);
    // Secrets stay out of settings.
    expect(db.prepare("SELECT 1 FROM settings WHERE key = 'gemini_api_key'").get()).toBeUndefined();
  });

  it("legacy points rules and levels convert once, without touching history", () => {
    // min-grade-points → the KCSE grade ladder (best-effort conversion).
    const rule = db.prepare("SELECT min_grade_points, mean_grade FROM requirement_rules WHERE id = 1").get() as { min_grade_points: number | null; mean_grade: string };
    expect(rule.mean_grade).toBe("B"); // 325 points = B
    expect(rule.min_grade_points).toBeNull();
    // postgrad → masters (masters ≠ PhD).
    expect((db.prepare("SELECT level FROM admission_rules WHERE id = 1").get() as { level: string }).level).toBe("masters");
  });
});
