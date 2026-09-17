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
  followup_rung  INTEGER NOT NULL DEFAULT 0,
  followup_next_at TEXT,
  followup_base_at TEXT,
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
  owner_id INTEGER REFERENCES staff_users(id)
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

-- Applicant portal: one-time codes + short-lived sessions (feature 35).
CREATE TABLE IF NOT EXISTS portal_otps (
  applicant_id INTEGER NOT NULL REFERENCES applicants(id),
  code         TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS portal_sessions (
  token        TEXT PRIMARY KEY,
  applicant_id INTEGER NOT NULL REFERENCES applicants(id),
  expires_at   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
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
  duplicate_of      INTEGER REFERENCES documents(id)
);
CREATE INDEX IF NOT EXISTS idx_documents_applicant ON documents(applicant_id, document_type);
CREATE INDEX IF NOT EXISTS idx_documents_hash ON documents(sha256);

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
  at           TEXT NOT NULL DEFAULT (datetime('now'))
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
  role          TEXT NOT NULL DEFAULT 'officer',   -- admin | manager | officer
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
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
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
  addColumn("applicants", "followup_rung", "INTEGER NOT NULL DEFAULT 0");
  addColumn("applicants", "followup_next_at", "TEXT");
  // Base date the follow-up ladder was armed on; rungs are scheduled as
  // base + ladder[n] days so "3,7,10" means Day 3, Day 7, Day 10.
  addColumn("applicants", "followup_base_at", "TEXT");
  addColumn("emails", "channel", "TEXT NOT NULL DEFAULT 'email'");
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
  // Wrong OTP guesses are counted; the code burns after too many failures.
  addColumn("portal_otps", "attempts", "INTEGER NOT NULL DEFAULT 0");
}
