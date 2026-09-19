/**
 * /db — SQLite schema + connection factory.
 *
 * v2 adds the case-management layer: reference numbers, full email history,
 * staff users/sessions, status history, audit log, notes, templates,
 * programme/intake-scoped requirements, SLAs, notifications.
 *
 * All SQL elsewhere lives in repo.ts; moving to PostgreSQL means rewriting
 * these two files only.
 */
import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS applicants (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_number     TEXT NOT NULL UNIQUE,
  email_address  TEXT NOT NULL,
  thread_id      TEXT NOT NULL,
  full_name      TEXT,
  phone          TEXT,
  programme      TEXT,
  intake         TEXT,
  priority       TEXT NOT NULL DEFAULT 'normal',
  assigned_to    INTEGER REFERENCES staff_users(id),
  lifecycle      TEXT NOT NULL DEFAULT 'application_received',
  triage         TEXT,
  sla_due_at     TEXT,
  sla_handled_at TEXT,
  escalated      INTEGER NOT NULL DEFAULT 0,
  requirements_snapshot TEXT,           -- frozen requirement set at first triage (feature 19)
  requirements_structured TEXT,         -- frozen structured entry-requirement blocks
  followup_rung  INTEGER NOT NULL DEFAULT 0,
  followup_next_at TEXT,
  followup_base_at TEXT,
  demo           INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (email_address, thread_id)
);
CREATE INDEX IF NOT EXISTS idx_applicants_ref ON applicants(ref_number);
CREATE INDEX IF NOT EXISTS idx_applicants_lifecycle ON applicants(lifecycle);

CREATE TABLE IF NOT EXISTS programmes (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  school TEXT NOT NULL DEFAULT '',
  entry_requirements TEXT NOT NULL DEFAULT '',
  owner_id INTEGER REFERENCES staff_users(id),
  level TEXT NOT NULL DEFAULT 'degree'   -- degree|diploma|certificate|masters|phd
);

-- Structured entry requirements: one row per (course, qualification system).
-- programme NULL + level = the university-wide defaults for that level.
-- Subject requirements are stored as JSON: [{subject, grade, alts[]}].
CREATE TABLE IF NOT EXISTS course_requirements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  programme TEXT,                     -- NULL = university-wide defaults
  level TEXT NOT NULL,                -- degree|diploma|certificate|masters|phd
  system TEXT NOT NULL,               -- KCSE|IGCSE|ALEVEL|IB|DIPLOMA|PREUNI|DEGREE
  enabled INTEGER NOT NULL DEFAULT 1,
  overall TEXT,                       -- KCSE mean grade (grade ladder)
  min_credits INTEGER,                -- IGCSE subjects at C or better
  min_principals INTEGER,             -- GCE A-Level / KACE principal passes
  min_subsidiaries INTEGER,
  min_points INTEGER,                 -- IB total points
  min_gpa REAL,                       -- Pre-University / diploma / IB Grade 12
  min_class TEXT,                     -- "Credit", "Second Class Upper"…
  subjects TEXT                       -- JSON SubjectRequirement[]
);

CREATE TABLE IF NOT EXISTS intakes (
  name     TEXT PRIMARY KEY,
  deadline TEXT                 -- application deadline; late arrivals are flagged, never auto-rejected
);

CREATE TABLE IF NOT EXISTS applicant_threads (
  applicant_id INTEGER NOT NULL REFERENCES applicants(id),
  thread_id    TEXT NOT NULL,
  linked_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (applicant_id, thread_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  applicant_id INTEGER NOT NULL REFERENCES applicants(id),
  title        TEXT NOT NULL,
  done         INTEGER NOT NULL DEFAULT 0,
  staff_id     INTEGER REFERENCES staff_users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  done_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_applicant ON tasks(applicant_id);

-- Per-category automation switches (feature 17/18): 'auto' | 'draft'.
CREATE TABLE IF NOT EXISTS automation_config (
  category TEXT PRIMARY KEY,
  mode     TEXT NOT NULL DEFAULT 'auto'
);

-- Requirement rules: programme/intake NULL means "applies to all".
-- Most specific rule wins (see Repo.resolveRequirements).
CREATE TABLE IF NOT EXISTS requirement_rules (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  programme        TEXT,
  intake           TEXT,
  document_type    TEXT NOT NULL,
  required         INTEGER NOT NULL DEFAULT 1,
  min_grade_points INTEGER,
  mean_grade       TEXT,
  subject_grades   TEXT,
  UNIQUE (programme, intake, document_type)
);

CREATE TABLE IF NOT EXISTS documents (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  applicant_id      INTEGER NOT NULL REFERENCES applicants(id),
  document_type     TEXT NOT NULL,
  source_email_id   TEXT NOT NULL,
  extraction_method TEXT NOT NULL,
  extracted_text    TEXT NOT NULL DEFAULT '',
  extracted_fields  TEXT NOT NULL DEFAULT '{}',
  confidence        TEXT NOT NULL,
  superseded_by     INTEGER REFERENCES documents(id),
  received_at       TEXT NOT NULL,
  sha256            TEXT,
  is_duplicate      INTEGER NOT NULL DEFAULT 0,
  duplicate_of      INTEGER REFERENCES documents(id),
  confidence_score  INTEGER NOT NULL DEFAULT 0,
  extraction_note   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_documents_applicant ON documents(applicant_id, document_type);
CREATE INDEX IF NOT EXISTS idx_documents_hash ON documents(sha256);

-- Round 19: poison-email isolation. Fetch/processing failures accumulate
-- attempts; after the retry budget the message is parked (dead = 1) and a
-- human is notified instead of the batch retrying it forever.
CREATE TABLE IF NOT EXISTS dead_letters (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id  TEXT NOT NULL UNIQUE,
  subject     TEXT NOT NULL DEFAULT '',
  from_addr   TEXT NOT NULL DEFAULT '',
  error       TEXT NOT NULL DEFAULT '',
  attempts    INTEGER NOT NULL DEFAULT 1,
  dead        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Round 19: Gemini results cached by content hash — the same bytes are never
-- paid for twice, and the cache lets the circuit breaker replay last-known
-- readings when the vision model is unavailable.
CREATE TABLE IF NOT EXISTS gemini_cache (
  sha256      TEXT PRIMARY KEY,
  result_json TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS flags (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  applicant_id INTEGER NOT NULL REFERENCES applicants(id),
  type         TEXT NOT NULL,
  detail       TEXT NOT NULL DEFAULT '',
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_flags_applicant ON flags(applicant_id);

CREATE TABLE IF NOT EXISTS emails (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  applicant_id INTEGER REFERENCES applicants(id),
  message_id   TEXT NOT NULL,
  thread_id    TEXT,
  direction    TEXT NOT NULL,          -- 'in' | 'out'
  from_addr    TEXT NOT NULL,
  to_addr      TEXT NOT NULL DEFAULT '',
  subject      TEXT NOT NULL DEFAULT '',
  body         TEXT NOT NULL DEFAULT '',
  category     TEXT,
  auto         INTEGER NOT NULL DEFAULT 0,
  channel      TEXT NOT NULL DEFAULT 'email',
  at           TEXT NOT NULL DEFAULT (datetime('now')),
  attachments  TEXT NOT NULL DEFAULT ''   -- JSON array of filenames that rode along (outgoing)
);
CREATE INDEX IF NOT EXISTS idx_emails_applicant ON emails(applicant_id, at);

CREATE TABLE IF NOT EXISTS status_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  applicant_id INTEGER NOT NULL REFERENCES applicants(id),
  from_status  TEXT,
  to_status    TEXT NOT NULL,
  actor        TEXT NOT NULL,          -- 'system' or a staff username
  reason       TEXT NOT NULL DEFAULT '',
  at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_status_history_applicant ON status_history(applicant_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  applicant_id INTEGER REFERENCES applicants(id),
  at           TEXT NOT NULL DEFAULT (datetime('now')),
  actor        TEXT NOT NULL DEFAULT 'system',
  event        TEXT NOT NULL,
  detail       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_audit_applicant ON audit_log(applicant_id, at);

CREATE TABLE IF NOT EXISTS notes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  applicant_id INTEGER NOT NULL REFERENCES applicants(id),
  staff_id     INTEGER REFERENCES staff_users(id),
  body         TEXT NOT NULL,
  at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notes_applicant ON notes(applicant_id);

CREATE TABLE IF NOT EXISTS staff_users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',      -- admin | user (round 18)
  active        INTEGER NOT NULL DEFAULT 1,
  demo          INTEGER NOT NULL DEFAULT 0,        -- 1 = seeded demo-dataset account
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  staff_id   INTEGER NOT NULL REFERENCES staff_users(id),
  csrf       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id     INTEGER REFERENCES staff_users(id),   -- NULL = broadcast to all
  applicant_id INTEGER REFERENCES applicants(id),
  kind         TEXT NOT NULL,
  message      TEXT NOT NULL,
  read         INTEGER NOT NULL DEFAULT 0,
  at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS templates (
  key        TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ref_counters (
  year     INTEGER PRIMARY KEY,
  last_seq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS decision_logs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  applicant_id        INTEGER NOT NULL REFERENCES applicants(id),
  triggering_email_id TEXT NOT NULL,
  computed_status     TEXT NOT NULL,
  reasoning           TEXT NOT NULL,
  auto_sent           INTEGER NOT NULL DEFAULT 0,
  timestamp           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_decision_logs_applicant ON decision_logs(applicant_id);

CREATE TABLE IF NOT EXISTS processed_emails (
  email_id     TEXT PRIMARY KEY,
  thread_id    TEXT NOT NULL,
  processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS outbox (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  applicant_id INTEGER NOT NULL REFERENCES applicants(id),
  to_address   TEXT NOT NULL,
  subject      TEXT NOT NULL,
  body         TEXT NOT NULL,
  mode         TEXT NOT NULL,          -- 'auto' | 'queued'
  template_key TEXT NOT NULL DEFAULT '',  -- which template rendered this draft
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ══ Admissions rules engine (round 18) ══════════════════════════════════════
-- Machine-evaluable requirement trees, versioned per (programme, system).
-- programme NULL = university-wide default for the level.

CREATE TABLE IF NOT EXISTS subject_catalogue (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  system TEXT NOT NULL,               -- which qualification system it belongs to
  name   TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (system, name)
);

CREATE TABLE IF NOT EXISTS admission_rules (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  programme  TEXT,                    -- NULL = university-wide default
  level      TEXT NOT NULL DEFAULT 'degree',
  system     TEXT NOT NULL,           -- KCSE|IGCSE|IB|ALEVEL|KACE|EACE|DIPLOMA|PROFCERT|DEGREE|OTHER
  version    INTEGER NOT NULL DEFAULT 1,
  status     TEXT NOT NULL DEFAULT 'draft',   -- draft|active|retired
  created_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (programme, level, system, version)
);

CREATE TABLE IF NOT EXISTS admission_rule_nodes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  set_id     INTEGER NOT NULL REFERENCES admission_rules(id) ON DELETE CASCADE,
  parent_id  INTEGER REFERENCES admission_rule_nodes(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,           -- 'group' | 'condition'
  logic      TEXT,                    -- AND|OR|NOT (groups)
  field      TEXT,                    -- mean_grade|subject|credits|… (conditions)
  subject    TEXT,
  comparator TEXT DEFAULT '>=',
  value      TEXT,
  position   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_rule_nodes_set ON admission_rule_nodes(set_id);

-- Every evaluation run is stored: reproducible from the frozen rule snapshot.
CREATE TABLE IF NOT EXISTS evaluations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  applicant_id INTEGER NOT NULL REFERENCES applicants(id),
  set_id       INTEGER,
  programme    TEXT,
  system       TEXT,
  set_version  INTEGER,
  result       TEXT NOT NULL,         -- passed|failed|missing_data|needs_verification
  routing      TEXT NOT NULL,         -- auto_admit|human_review|waiting_documents
  reason       TEXT NOT NULL DEFAULT '',
  reason_code  TEXT NOT NULL DEFAULT '',
  detail       TEXT NOT NULL DEFAULT '{}',  -- JSON EvaluationReport
  rule_snapshot TEXT NOT NULL DEFAULT '[]', -- frozen rules used (reproducibility)
  evaluated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_evaluations_applicant ON evaluations(applicant_id);
`;

export function openDb(file: string): Database.Database {
  if (file !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // Concurrent access is normal here (web server + cron CLIs like
  // retain/escalate/backup). Without this, the second writer gets an
  // instant SQLITE_BUSY instead of a 5s retry window.
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Pragmatic forward migration for databases created by older versions. */
function migrate(db: Database.Database): void {
  const addColumn = (table: string, column: string, type: string) => {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    } catch (e) {
      // "duplicate column name" is the expected no-op case. EVERYTHING else
      // (locks, corruption, wrong table) must surface loudly here, not as a
      // mystery "no such column" at query time.
      if (!/duplicate column name/i.test((e as Error).message)) throw e;
    }
  };
  addColumn("applicants", "requirements_snapshot", "TEXT");
  // OR-5: nationality feeds the deterministic document matrix (kenyan /
  // international / unknown). Never assumed — unknown adds no extra slots.
  addColumn("applicants", "nationality", "TEXT");
  addColumn("applicants", "followup_rung", "INTEGER NOT NULL DEFAULT 0");
  addColumn("applicants", "followup_next_at", "TEXT");
  // Base date the follow-up ladder was armed on; rungs are scheduled as
  // base + ladder[n] days so "3,7,10" means Day 3, Day 7, Day 10.
  addColumn("applicants", "followup_base_at", "TEXT");
  addColumn("emails", "channel", "TEXT NOT NULL DEFAULT 'email'");
  // Review fix: outgoing mail records WHICH FILES were attached, so the
  // case history can show them (a pack that went out invisible is as good
  // as a pack that never went out).
  addColumn("emails", "attachments", "TEXT NOT NULL DEFAULT ''");
  // Review fix: held drafts remember WHICH template rendered them, so the
  // staff approval send can honour that template's pack attachment.
  addColumn("outbox", "template_key", "TEXT NOT NULL DEFAULT ''");
  // Courses get an owner: the staff member responsible for handling them.
  addColumn("programmes", "owner_id", "INTEGER REFERENCES staff_users(id)");
  // Catalogue grouping (school) + official entry-requirement reference text.
  addColumn("programmes", "school", "TEXT NOT NULL DEFAULT ''");
  addColumn("programmes", "entry_requirements", "TEXT NOT NULL DEFAULT ''");
  // Whether outgoing mail rendered from this template carries the banner.
  addColumn("templates", "include_banner", "INTEGER NOT NULL DEFAULT 1");
  // Accounts seeded by the demo dataset are marked, so the UI can label them
  // and production accounts are never confused with sample ones.
  addColumn("staff_users", "demo", "INTEGER NOT NULL DEFAULT 0");
  addColumn("intakes", "deadline", "TEXT");
  // v5: requirement rules speak GRADES, not points. New columns carry the
  // published mean grade ("C+") and per-subject lines ("C+ in English and Maths").
  addColumn("requirement_rules", "mean_grade", "TEXT");
  addColumn("requirement_rules", "subject_grades", "TEXT");
  // Structured entry requirements (per qualification system) + their freeze.
  addColumn("applicants", "requirements_structured", "TEXT");
  addColumn("programmes", "level", "TEXT NOT NULL DEFAULT 'degree'");
  // Transfer applicants (credit from another institution) must also submit
  // the credit transfer form.
  addColumn("applicants", "transfer", "INTEGER NOT NULL DEFAULT 0");
  // Realm separation: seeded (mock) applicants are flagged so the live admin
  // dashboard never shows demo data, and demo accounts only see demo data.
  addColumn("applicants", "demo", "INTEGER NOT NULL DEFAULT 0");
  // Numeric PDF readability/confidence (0-100); auto-send requires >= 75.
  addColumn("documents", "confidence_score", "INTEGER NOT NULL DEFAULT 0");
  addColumn("documents", "extraction_note", "TEXT NOT NULL DEFAULT ''");
  // Round 18 — admissions engine: eligibility, routing and the admission
  // decision are stored as SEPARATE concepts (never one giant status field).
  addColumn("applicants", "req_result", "TEXT");
  addColumn("applicants", "routing", "TEXT");
  addColumn("applicants", "routing_reason", "TEXT");
  addColumn("applicants", "admission_rules_frozen", "TEXT");
  addColumn("applicants", "admission_decision", "TEXT NOT NULL DEFAULT 'undecided'");
  addColumn("applicants", "admission_route", "TEXT");
  addColumn("applicants", "decision_by", "TEXT");
  addColumn("applicants", "decision_reason", "TEXT");
  addColumn("applicants", "decision_at", "TEXT");
  // Round 18 — exactly two roles: admin and user. Legacy roles collapse into
  // 'user' (they keep their accounts; permissions are re-derived from role).
  db.exec("UPDATE staff_users SET role = 'user' WHERE role NOT IN ('admin','user')");
  // Migrate any legacy min-points rules into a best-effort grade equivalent
  // so old databases keep meaningful rules (points → the KCSE grade ladder).
  try {
    const legacy = db
      .prepare("SELECT id, min_grade_points FROM requirement_rules WHERE min_grade_points IS NOT NULL AND mean_grade IS NULL")
      .all() as Array<{ id: number; min_grade_points: number }>;
    const ptsToGrade = (p: number): string =>
      p >= 400 ? "A" : p >= 381 ? "A-" : p >= 353 ? "B+" : p >= 325 ? "B" : p >= 295 ? "B-" : p >= 265 ? "C+" : p >= 235 ? "C" : p >= 205 ? "C-" : p >= 175 ? "D+" : p >= 145 ? "D" : p >= 115 ? "D-" : "E";
    const upd = db.prepare("UPDATE requirement_rules SET mean_grade = ? WHERE id = ?");
    for (const r of legacy) upd.run(ptsToGrade(r.min_grade_points), r.id);
    if (legacy.length) db.exec("UPDATE requirement_rules SET min_grade_points = NULL");
  } catch {
    // best-effort: a fresh DB has nothing to migrate
  }
  // OR-6 — Master's ≠ PhD: the old single "postgrad" level splits into
  // "masters" (the university's existing postgraduate defaults) and "phd".
  // Every table that stores a course level is migrated; the UPDATEs are
  // idempotent so re-opening a modern database is a no-op.
  db.exec(`UPDATE programmes SET level = 'masters' WHERE level = 'postgrad'`);
  db.exec(`UPDATE admission_rules SET level = 'masters' WHERE level = 'postgrad'`);
  db.exec(`UPDATE course_requirements SET level = 'masters' WHERE level = 'postgrad'`);
  // Review fix: the applicant-portal OTP/session machinery had no product
  // surface left (link sign-in was removed); drop its tables outright.
  db.exec(`DROP TABLE IF EXISTS portal_otps`);
  db.exec(`DROP TABLE IF EXISTS portal_sessions`);
  // OR-8 — school × staff visibility scopes (one row per assigned school).
  db.exec(`CREATE TABLE IF NOT EXISTS staff_scopes (
    staff_id INTEGER NOT NULL REFERENCES staff_users(id),
    school   TEXT NOT NULL,
    PRIMARY KEY (staff_id, school)
  )`);
  // OR-7 — every template may optionally carry an official pack PDF set.
  addColumn("templates", "attach_pack", "TEXT NOT NULL DEFAULT 'none'");
  // The two historical pack sends become explicit flags. This defaulting
  // runs ONCE EVER (marker-guarded): re-running it on every open would
  // silently resurrect a pack a staff member deliberately switched off —
  // "none" is a legitimate choice, not an unset knob.
  const packDefaultsDone = db.prepare("SELECT value FROM settings WHERE key = 'pack_defaults_migrated'").get();
  if (!packDefaultsDone) {
    db.exec(`UPDATE templates SET attach_pack = 'application' WHERE key = 'docs_request' AND attach_pack = 'none'`);
    db.exec(`UPDATE templates SET attach_pack = 'admission' WHERE key = 'admission_letter' AND attach_pack = 'none'`);
    db.exec(`INSERT OR REPLACE INTO settings (key, value) VALUES ('pack_defaults_migrated', '1')`);
  }
  // OR-6 — schools get their own catalogue so a school exists even before
  // its first course, and can be renamed in one place.
  db.exec(`CREATE TABLE IF NOT EXISTS schools (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  )`);
  db.exec(`INSERT OR IGNORE INTO schools (name) SELECT DISTINCT school FROM programmes WHERE school <> ''`);
}
