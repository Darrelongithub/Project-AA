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
  organization_id INTEGER,
  case_type_id    INTEGER,
  category       TEXT,
  outcome        TEXT NOT NULL DEFAULT 'undecided',
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
  system TEXT NOT NULL,               -- national-secondary|o-level|alevel|ib|diploma|preuni|degree
  enabled INTEGER NOT NULL DEFAULT 1,
  overall TEXT,                       -- national-secondary mean grade (grade ladder)
  min_credits INTEGER,                -- o-level subjects at C or better
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
  attachments  TEXT NOT NULL DEFAULT '',  -- JSON array of filenames that rode along (outgoing)
  read         INTEGER NOT NULL DEFAULT 0, -- mail window: incoming mail arrives unread
  labels       TEXT NOT NULL DEFAULT '[]' -- JSON array: starred | important | spam | bin (gmail folders)
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
  -- unscoped = full visibility, scoped = the rows below, none = no access
  scope_mode    TEXT NOT NULL DEFAULT 'unscoped',
  active        INTEGER NOT NULL DEFAULT 1,
  demo          INTEGER NOT NULL DEFAULT 0,        -- 1 = seeded demo-dataset account
  organization_id INTEGER,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  staff_id   INTEGER NOT NULL REFERENCES staff_users(id),
  csrf       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

-- One-time admin-issued password reset codes (forgot password).
-- A code is valid until expires_at, is revoked by a newer issue for the
-- same member (revoked_at), and is consumed exactly once (used_at).
CREATE TABLE IF NOT EXISTS password_reset_codes (
  code        TEXT PRIMARY KEY,
  staff_id    INTEGER NOT NULL REFERENCES staff_users(id),
  issued_by   TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  revoked_at  TEXT
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
  organization_id INTEGER,
  name       TEXT NOT NULL,
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  default_snapshot TEXT,
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
  -- PPR P1-3: a draft awaiting APPROVAL may only be released by a holder of
  -- the "Approve automation" permission; an ordinary draft is officer work.
  needs_approval INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Queue listings run EXISTS (SELECT 1 FROM outbox WHERE applicant_id = …)
-- per rendered applicant row; without this index each one is a full scan.
CREATE INDEX IF NOT EXISTS idx_outbox_applicant ON outbox(applicant_id, mode);

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

-- Per-course document checklist (round 3). A row = a document type that is
-- required for that course. Presence of ANY row for a programme means the
-- course has been explicitly configured; an EMPTY configuration is not
-- storable (it is indistinguishable from "unconfigured" and safely falls
-- back to the generated matrix defaults — the conservative direction, since
-- it never requires FEWER documents than the official checklist).
CREATE TABLE IF NOT EXISTS course_doc_requirements (
  programme      TEXT NOT NULL,
  document_type  TEXT NOT NULL,
  PRIMARY KEY (programme, document_type)
);

CREATE TABLE IF NOT EXISTS admission_rules (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  programme  TEXT,                    -- NULL = university-wide default
  level      TEXT NOT NULL DEFAULT 'degree',
  system     TEXT NOT NULL,           -- secondary|o-level|ib|alevel|kace|eace|diploma|profcert|degree|other
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

-- ══ General intake engine ═══════════════════════════════════════════════════
-- Organization is the tenant boundary for configuration and data ownership.
CREATE TABLE IF NOT EXISTS organizations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  logo TEXT,
  ref_prefix TEXT NOT NULL DEFAULT 'ORG',
  theme TEXT NOT NULL DEFAULT '{"primary":"#334155","accent":"#0f766e"}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS case_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  config TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1,
  -- PPR P0-2: workflow-profile flags. education_module switches every
  -- academic code path (grade engine, document matrix, admissions UI) off
  -- for the profile's cases. New profiles are draft-first with no
  -- auto-decision; the migrated academic profile keeps its legacy posture.
  education_module INTEGER NOT NULL DEFAULT 0,
  terminology TEXT NOT NULL DEFAULT '{}',
  stages TEXT NOT NULL DEFAULT '[]',
  queues TEXT NOT NULL DEFAULT '[]',
  config_version INTEGER NOT NULL DEFAULT 1,
  default_reply_action TEXT NOT NULL DEFAULT 'draft',
  qualification_gate INTEGER NOT NULL DEFAULT 0,
  auto_admit INTEGER NOT NULL DEFAULT 0,
  UNIQUE (organization_id, code)
);
CREATE TABLE IF NOT EXISTS organization_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (organization_id, key)
);
CREATE TABLE IF NOT EXISTS organization_document_axes (
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  axis_key TEXT NOT NULL,
  label TEXT NOT NULL,
  values_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (organization_id, axis_key)
);
CREATE TABLE IF NOT EXISTS document_definitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_type_id INTEGER NOT NULL REFERENCES case_types(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  required INTEGER NOT NULL DEFAULT 1,
  blocking INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  UNIQUE (case_type_id, key)
);
CREATE TABLE IF NOT EXISTS organization_templates (
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  include_banner INTEGER NOT NULL DEFAULT 1,
  attach_pack TEXT NOT NULL DEFAULT 'none',
  -- PPR P0-6: profile binding (0 = organization-wide; a template key belongs
  -- to at most one profile) + the profile's OWN default, captured at
  -- creation, that "Reset to default" restores. Templates are no longer a
  -- closed enum — any key a profile needs can exist.
  case_type_id INTEGER NOT NULL DEFAULT 0,
  default_snapshot TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (organization_id, key)
);
CREATE TABLE IF NOT EXISTS organization_pack_slots (
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  filename TEXT,
  mime TEXT,
  content BLOB,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (organization_id, key)
);
CREATE TABLE IF NOT EXISTS staff_case_type_scopes (
  staff_id INTEGER NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  case_type_code TEXT NOT NULL,
  PRIMARY KEY (staff_id, case_type_code)
);
-- PPR P0-1: credentials live in their own store. A generic settings read or
-- settings export can never return these values; only explicit getSecret
-- callers (the Gmail/Gemini connectors) can.
CREATE TABLE IF NOT EXISTS secrets (
  organization_id INTEGER NOT NULL DEFAULT 1,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (organization_id, key)
);
-- PPR P0-4: intake and response behaviour as stored rules. A rule row is
-- trigger (conditions) + actions (create/attach/ignore/review, stage, queue,
-- priority, assignment, reply mode, template, attachment set, SLA, follow-up,
-- audit code, fallback). case_type_id NULL = org-wide scope for the migrated
-- legacy/education profiles; a rule with a case type applies only to it.
CREATE TABLE IF NOT EXISTS workflow_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  case_type_id INTEGER REFERENCES case_types(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'intake',
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  conditions TEXT NOT NULL DEFAULT '[]',
  action TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_workflow_rules_scope ON workflow_rules(organization_id, case_type_id, kind, position);

-- PPR P0-5: attachment sets — named groups of files an organization sends
-- with replies. Sets replace the hardcoded application/admission packs; the
-- migrated education profile's sets are seeded from its own migration data.
-- There is no privileged "pack channel": a template or rule attaches exactly
-- the set it names, and only sets owned by the sending organization resolve.
CREATE TABLE IF NOT EXISTS attachment_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (organization_id, name)
);
CREATE TABLE IF NOT EXISTS attachment_set_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  set_id INTEGER NOT NULL REFERENCES attachment_sets(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT 'application/pdf',
  content BLOB NOT NULL,
  provenance TEXT NOT NULL DEFAULT 'uploaded',
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_attachment_set_files ON attachment_set_files(set_id, position);

-- PPR P1-8: fine-grained automation permissions. The four actions that used
-- to hide behind the admin/user role split are now distinct permissions:
-- publish workflow rules, send automated reply, approve automation, record
-- outcome. Admins implicitly hold all four; other staff hold exactly what
-- is granted (defaults give regular staff the two sending-related ones).
CREATE TABLE IF NOT EXISTS staff_permissions (
  staff_id INTEGER NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  granted_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (staff_id, permission)
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
  // OR-5: nationality feeds the deterministic document matrix (kenyan /
  // international / unknown). Never assumed — unknown adds no extra slots.
  addColumn("applicants", "nationality", "TEXT");
  addColumn("applicants", "followup_rung", "INTEGER NOT NULL DEFAULT 0");
  addColumn("applicants", "followup_next_at", "TEXT");
  // Base date the follow-up ladder was armed on; rungs are scheduled as
  // base + ladder[n] days so "3,7,10" means Day 3, Day 7, Day 10.
  addColumn("applicants", "followup_base_at", "TEXT");
  // PPR P1-3: per-case follow-up ladder response action (send/draft/approve/
  // hold/none) resolved from the rule that armed the ladder — default "hold"
  // keeps migrated education behaviour. Extension column; names untouched.
  addColumn("applicants", "followup_action", "TEXT NOT NULL DEFAULT 'hold'");
  addColumn("emails", "channel", "TEXT NOT NULL DEFAULT 'email'");
  // Review fix: outgoing mail records WHICH FILES were attached, so the
  // case history can show them (a pack that went out invisible is as good
  // as a pack that never went out).
  addColumn("emails", "attachments", "TEXT NOT NULL DEFAULT ''");
  // Review fix: held drafts remember WHICH template rendered them, so the
  // staff approval send can honour that template's pack attachment.
  addColumn("outbox", "template_key", "TEXT NOT NULL DEFAULT ''");
  addColumn("outbox", "needs_approval", "INTEGER NOT NULL DEFAULT 0");
  // Courses get an owner: the staff member responsible for handling them.
  addColumn("programmes", "owner_id", "INTEGER REFERENCES staff_users(id)");
  // Catalogue grouping (school) + official entry-requirement reference text.
  addColumn("programmes", "school", "TEXT NOT NULL DEFAULT ''");
  addColumn("programmes", "entry_requirements", "TEXT NOT NULL DEFAULT ''");
  // Whether outgoing mail rendered from this template carries the banner.
  addColumn("templates", "include_banner", "INTEGER NOT NULL DEFAULT 1");
  addColumn("templates", "organization_id", "INTEGER");
  // Accounts seeded by the demo dataset are marked, so the UI can label them
  // and production accounts are never confused with sample ones.
  addColumn("staff_users", "demo", "INTEGER NOT NULL DEFAULT 0");
  addColumn("staff_users", "organization_id", "INTEGER");
  // DEMO: the organization an installation-owner admin is currently viewing
  // (sidebar switcher). NULL = their home organization.
  addColumn("staff_users", "active_organization_id", "INTEGER");
  // OR-8: distinguish an intentionally empty/no-access scope from an
  // unscoped officer (full visibility). Without this marker, deleting the
  // last school made the empty-list SQL branch unreachable.
  addColumn("staff_users", "scope_mode", "TEXT NOT NULL DEFAULT 'unscoped'");
  addColumn("organizations", "ref_prefix", "TEXT NOT NULL DEFAULT 'ORG'");
  // PPR P0-1/P1-5: organization-owned sender identity and locale. The old
  // `from_name` settings key implied it shaped outgoing mail; it never did.
  // It becomes real data on the organization row and is wired into MIME.
  addColumn("organizations", "from_name", "TEXT");
  addColumn("organizations", "reply_to", "TEXT");
  addColumn("organizations", "locale", "TEXT");
  addColumn("organizations", "timezone", "TEXT");
  // PPR P0-2/P0-3: workflow-profile flags on case types and the frozen
  // per-case configuration snapshot (the exact rule/document-set version a
  // case was opened under — later edits never rewrite its meaning).
  addColumn("case_types", "education_module", "INTEGER NOT NULL DEFAULT 0");
  addColumn("case_types", "terminology", "TEXT NOT NULL DEFAULT '{}'");
  addColumn("case_types", "stages", "TEXT NOT NULL DEFAULT '[]'");
  addColumn("case_types", "queues", "TEXT NOT NULL DEFAULT '[]'");
  addColumn("case_types", "config_version", "INTEGER NOT NULL DEFAULT 1");
  addColumn("case_types", "default_reply_action", "TEXT NOT NULL DEFAULT 'draft'");
  addColumn("case_types", "qualification_gate", "INTEGER NOT NULL DEFAULT 0");
  addColumn("case_types", "auto_admit", "INTEGER NOT NULL DEFAULT 0");
  addColumn("applicants", "case_config_frozen", "TEXT");
  addColumn("applicants", "config_version_frozen", "INTEGER");
  addColumn("applicants", "config_version_frozen_at", "TEXT");
  // PPR P0-4/P1-2: rule-assigned queue (generic workflows). Education queue
  // placement keeps deriving through queueOf; this column is the rule's
  // explicit assignment when one is configured.
  addColumn("applicants", "queue", "TEXT");
  // Stamp the migrated academic profiles (Organization #1's programme-derived
  // case types + GENERAL) as education-module profiles with today's exact
  // automation posture: qualification-gated sends, never an auto decision.
  // Marker-guarded ONCE EVER: after the stamp the flags belong to staff —
  // an admin may deliberately switch the module off and it must stay off.
  const eduStamped = db.prepare("SELECT value FROM settings WHERE key = 'education_profiles_stamped'").get();
  if (!eduStamped) {
    db.exec(`UPDATE case_types SET education_module = 1, qualification_gate = 1, default_reply_action = 'send'
      WHERE organization_id = 1 AND (code = 'GENERAL' OR code IN (SELECT code FROM programmes))`);
    db.exec(`INSERT OR REPLACE INTO settings (key, value) VALUES ('education_profiles_stamped', '1')`);
  }
  // M-3: the stamp above shipped with auto_admit = 0, which silently disabled
  // the migrated profile's provisional-admission behaviour. Restore the
  // preserved legacy posture ONE TIME for the profiles stamped as the
  // education module (new organizations' profiles are never touched — their
  // education_module is 0 or they were created after this marker).
  const autoAdmitRestored = db.prepare("SELECT value FROM settings WHERE key = 'education_auto_admit_restored_v1'").get();
  if (!autoAdmitRestored) {
    db.exec("UPDATE case_types SET auto_admit = 1 WHERE organization_id = 1 AND education_module = 1");
    db.exec("INSERT OR REPLACE INTO settings (key, value) VALUES ('education_auto_admit_restored_v1', '1')");
  }
  // M-2: usernames have exactly one canonical case (lowercase). Fold any
  // historical mixed-case rows once; lookups are case-insensitive (COLLATE
  // NOCASE) so a member who still types their old spelling can sign in.
  db.exec("UPDATE staff_users SET username = lower(username) WHERE username <> lower(username)");
  // PPR P0-7: legacy rows are stamped with their migrated education profile —
  // programme-derived type where the row names a programme, otherwise the
  // GENERAL education profile. Idempotent (only NULL rows are touched), so a
  // later admin re-assignment is never overwritten and nothing re-runs.
  db.exec(`UPDATE applicants SET case_type_id = (SELECT id FROM case_types WHERE organization_id = 1 AND code = applicants.programme)
    WHERE case_type_id IS NULL AND programme IS NOT NULL`);
  db.exec(`UPDATE applicants SET case_type_id = (SELECT id FROM case_types WHERE organization_id = 1 AND code = 'GENERAL')
    WHERE case_type_id IS NULL AND organization_id = 1`);
  // Existing cases are stamped as "opened under the configuration that
  // shipped with this database" — version 1, frozen now, never re-scored.
  db.exec(`UPDATE applicants SET config_version_frozen = 1, config_version_frozen_at = COALESCE(config_version_frozen_at, created_at)
    WHERE config_version_frozen IS NULL`);
  // PPR P0-1: move credentials out of the settings bag exactly once. Values
  // are copied to the secrets store and then removed from settings, so no
  // generic settings read/export can leak them again.
  for (const key of ["gemini_api_key", "gmail_client_secret", "gmail_refresh_token"]) {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    if (row) {
      const exists = db.prepare("SELECT 1 FROM secrets WHERE organization_id = 1 AND key = ?").get(key);
      if (!exists) db.prepare("INSERT INTO secrets (organization_id, key, value) VALUES (1, ?, ?)").run(key, row.value);
      db.prepare("DELETE FROM settings WHERE key = ?").run(key);
    }
  }
  {
    const fromName = db.prepare("SELECT value FROM settings WHERE key = 'from_name'").get() as { value: string } | undefined;
    if (fromName?.value?.trim()) {
      const res = db.prepare("UPDATE organizations SET from_name = ? WHERE id = 1 AND (from_name IS NULL OR from_name = '')").run(fromName.value.trim());
      // Only drop the legacy key once the value is safely on the org row
      // (org row may not exist yet on a fresh boot — seed migrates it then).
      if (res.changes > 0) db.prepare("DELETE FROM settings WHERE key = 'from_name'").run();
    }
  }
  // Organization #1 is the migrated academic tenant. Preserve a valid legacy
  // prefix once, then keep all future reference reads on the organization row;
  // every new tenant starts with the neutral ORG prefix.
  const legacyRef = (db.prepare("SELECT value FROM settings WHERE key = 'ref_prefix'").get() as { value?: string } | undefined)?.value?.trim().toUpperCase();
  const migratedRef = legacyRef && /^[A-Z]{1,8}$/.test(legacyRef) ? legacyRef : "RU";
  db.prepare("UPDATE organizations SET ref_prefix = ? WHERE id = 1 AND (ref_prefix IS NULL OR ref_prefix = 'ORG')").run(migratedRef);
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
  // Generalization vocabulary. Legacy applicant rows remain intact and are
  // associated with organization 1/case types during seed migration.
  addColumn("applicants", "organization_id", "INTEGER");
  addColumn("applicants", "case_type_id", "INTEGER");
  addColumn("applicants", "category", "TEXT");
  addColumn("applicants", "outcome", "TEXT NOT NULL DEFAULT 'undecided'");
  db.exec("UPDATE applicants SET organization_id = 1 WHERE organization_id IS NULL");
  db.exec("UPDATE applicants SET category = programme WHERE category IS NULL AND programme IS NOT NULL");
  // Numeric PDF readability/confidence (0-100); auto-send requires >= 75.
  addColumn("documents", "confidence_score", "INTEGER NOT NULL DEFAULT 0");
  addColumn("documents", "extraction_note", "TEXT NOT NULL DEFAULT ''");
  // Round 18 — admissions engine: eligibility, routing and the admission
  // decision are stored as SEPARATE concepts (never one giant status field).
  addColumn("applicants", "req_result", "TEXT");
  addColumn("applicants", "routing", "TEXT");
  addColumn("applicants", "routing_reason", "TEXT");
  addColumn("applicants", "admission_rules_frozen", "TEXT");
  addColumn("applicants", "admission_rules_frozen_at", "TEXT");
  addColumn("applicants", "admission_decision", "TEXT NOT NULL DEFAULT 'undecided'");
  db.exec(`UPDATE applicants SET outcome = CASE admission_decision
    WHEN 'auto_admitted' THEN 'auto_approved'
    WHEN 'admitted_after_review' THEN 'approved_after_review'
    WHEN 'not_admitted' THEN 'not_approved'
    ELSE 'undecided' END`);
  addColumn("applicants", "admission_route", "TEXT");
  addColumn("applicants", "decision_by", "TEXT");
  addColumn("applicants", "decision_reason", "TEXT");
  addColumn("applicants", "decision_at", "TEXT");
  // Round 18 — exactly two roles: admin and user. Legacy roles collapse into
  // 'user' (they keep their accounts; permissions are re-derived from role).
  db.exec("UPDATE staff_users SET role = 'user' WHERE role NOT IN ('admin','user')");
  // Migrate any legacy min-points rules into a best-effort grade equivalent
  // so old databases keep meaningful rules (points → the national grade ladder).
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
  // PPR P0-6: profile binding + per-template default snapshot (Reset target).
  addColumn("templates", "default_snapshot", "TEXT");
  addColumn("organization_templates", "case_type_id", "INTEGER NOT NULL DEFAULT 0");
  addColumn("organization_templates", "default_snapshot", "TEXT");
  // The two historical pack sends become explicit flags. This defaulting
  // runs ONCE EVER (marker-guarded): re-running it on every open would
  // silently resurrect a pack a staff member deliberately switched off —
  // "none" is a legitimate choice, not an unset knob.
  // Mail window (Gmail-style): incoming mail arrives unread. Existing rows were
  // already worked in the case views, so backfill them as read; only rows that
  // arrive from now on start unread. PRAGMA-guarded = safe on fresh databases.
  const emailCols = db.prepare("PRAGMA table_info(emails)").all() as Array<{ name: string }>;
  if (!emailCols.some((c) => c.name === "read")) {
    db.exec(`ALTER TABLE emails ADD COLUMN read INTEGER NOT NULL DEFAULT 0`);
    db.exec(`UPDATE emails SET read = 1`);
  }
  // Gmail folders: conversation labels (starred/important/spam/bin). Default
  // '[]' — history needs no backfill; labels are opt-in from the mail window.
  if (!emailCols.some((c) => c.name === "labels")) {
    db.exec(`ALTER TABLE emails ADD COLUMN labels TEXT NOT NULL DEFAULT '[]'`);
  }
  // Held-draft send claims: approving a draft claims it atomically BEFORE the
  // await'd send, so two concurrent approvals can never mail the same reply
  // twice. Stale claims (>10 min, sender died mid-send) become re-claimable.
  const outboxCols = db.prepare("PRAGMA table_info(outbox)").all() as Array<{ name: string }>;
  if (!outboxCols.some((c) => c.name === "claimed_at")) {
    db.exec(`ALTER TABLE outbox ADD COLUMN claimed_at TEXT`);
  }
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
  // Phase 6: operational metrics — additive daily counters, no existing
  // table is touched. Day buckets are UTC (see flushMetrics).
  db.exec(`CREATE TABLE IF NOT EXISTS metric_daily (
    day TEXT NOT NULL,
    name TEXT NOT NULL,
    n INTEGER NOT NULL DEFAULT 0,
    sum REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (day, name)
  )`);
  // Phase 12: persisted unhandled exceptions for the admin security
  // console. Purely additive (new table + index, nothing existing
  // touched). organization_id NULL = unattributable — never shown in
  // any org's console (same isolation rule as the other console data).
  db.exec(`CREATE TABLE IF NOT EXISTS error_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL DEFAULT (datetime('now')),
    source TEXT NOT NULL,
    applicant_id INTEGER REFERENCES applicants(id),
    organization_id INTEGER,
    actor TEXT NOT NULL DEFAULT '',
    request TEXT NOT NULL DEFAULT '',
    message TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT ''
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_error_events_org ON error_events(organization_id, at)`);
  // Compatibility projection: old admissions callers still read applicants,
  // while generic callers can use cases/outcome/category without losing rows.
  db.exec(`CREATE VIEW IF NOT EXISTS cases AS
    SELECT a.*, COALESCE(ct.category, a.programme) AS category,
      CASE a.admission_decision
        WHEN 'auto_admitted' THEN 'auto_approved'
        WHEN 'admitted_after_review' THEN 'approved_after_review'
        WHEN 'not_admitted' THEN 'not_approved'
        ELSE 'undecided'
      END AS outcome,
      COALESCE(a.organization_id, 1) AS organization_id
    FROM applicants a LEFT JOIN case_types ct ON ct.id = a.case_type_id`);
}
