/** SQLite schema and transactional, data-preserving forward migrations. */
import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import legacyStorage from "../../migrations/legacy-storage.json";
import { markDatabaseActive } from "./activity";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS applicants (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_number     TEXT NOT NULL UNIQUE,
  email_address  TEXT NOT NULL,
  thread_id      TEXT NOT NULL,
  full_name      TEXT,
  phone          TEXT,
  case_type_code TEXT,
  intake         TEXT,
  priority       TEXT NOT NULL DEFAULT 'normal',
  assigned_to    INTEGER REFERENCES staff_users(id),
  lifecycle      TEXT NOT NULL DEFAULT 'application_received',
  triage         TEXT,
  sla_due_at     TEXT,
  sla_handled_at TEXT,
  escalated      INTEGER NOT NULL DEFAULT 0,
  requirements_snapshot TEXT,
  requirements_structured TEXT,
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
  UNIQUE (organization_id, email_address, thread_id)
);
CREATE INDEX IF NOT EXISTS idx_applicants_ref ON applicants(ref_number);
CREATE INDEX IF NOT EXISTS idx_applicants_lifecycle ON applicants(lifecycle);

CREATE TABLE IF NOT EXISTS programmes (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  school TEXT NOT NULL DEFAULT '',
  entry_requirements TEXT NOT NULL DEFAULT '',
  owner_id INTEGER REFERENCES staff_users(id),
  level TEXT NOT NULL DEFAULT 'general'
);


CREATE TABLE IF NOT EXISTS intakes (
  organization_id INTEGER NOT NULL DEFAULT 1,
  name     TEXT NOT NULL,
  deadline TEXT,
  PRIMARY KEY (organization_id, name)
);

-- Phase D3 (Q7 step 2): inbound address -> case type. An address is unique
-- across the whole installation, never just within a tenant: the same mailbox
-- address must not be claimable by two organizations.
CREATE TABLE IF NOT EXISTS case_type_aliases (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  case_type_id    INTEGER NOT NULL REFERENCES case_types(id),
  address         TEXT NOT NULL UNIQUE,
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_case_type_aliases_org ON case_type_aliases(organization_id, active);

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

CREATE TABLE IF NOT EXISTS automation_config (
  category TEXT PRIMARY KEY,
  mode     TEXT NOT NULL DEFAULT 'auto'
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
  organization_id INTEGER NOT NULL DEFAULT 1,
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  applicant_id INTEGER REFERENCES applicants(id),
  message_id   TEXT NOT NULL,
  thread_id    TEXT,
  direction    TEXT NOT NULL,
  from_addr    TEXT NOT NULL,
  to_addr      TEXT NOT NULL DEFAULT '',
  subject      TEXT NOT NULL DEFAULT '',
  body         TEXT NOT NULL DEFAULT '',
  category     TEXT,
  auto         INTEGER NOT NULL DEFAULT 0,
  channel      TEXT NOT NULL DEFAULT 'email',
  at           TEXT NOT NULL DEFAULT (datetime('now')),
  attachments  TEXT NOT NULL DEFAULT '',
  read         INTEGER NOT NULL DEFAULT 0,
  labels       TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_emails_applicant ON emails(applicant_id, at);

CREATE TABLE IF NOT EXISTS status_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  applicant_id INTEGER NOT NULL REFERENCES applicants(id),
  from_status  TEXT,
  to_status    TEXT NOT NULL,
  actor        TEXT NOT NULL,
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
  role          TEXT NOT NULL DEFAULT 'user',
  case_type_scope_mode TEXT NOT NULL DEFAULT 'unscoped',
  active        INTEGER NOT NULL DEFAULT 1,
  demo          INTEGER NOT NULL DEFAULT 0,
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
  staff_id     INTEGER REFERENCES staff_users(id),
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
  organization_id INTEGER NOT NULL DEFAULT 1,
  email_id     TEXT NOT NULL,
  thread_id    TEXT NOT NULL,
  processed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (organization_id, email_id)
);

CREATE TABLE IF NOT EXISTS outbox (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  applicant_id INTEGER NOT NULL REFERENCES applicants(id),
  to_address   TEXT NOT NULL,
  subject      TEXT NOT NULL,
  body         TEXT NOT NULL,
  mode         TEXT NOT NULL,
  template_key TEXT NOT NULL DEFAULT '',
  needs_approval INTEGER NOT NULL DEFAULT 0,
  claimed_at   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_outbox_applicant ON outbox(applicant_id, mode);



CREATE TABLE IF NOT EXISTS course_doc_requirements (
  programme      TEXT NOT NULL,
  document_type  TEXT NOT NULL,
  PRIMARY KEY (programme, document_type)
);



CREATE TABLE IF NOT EXISTS evaluations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  applicant_id INTEGER NOT NULL REFERENCES applicants(id),
  set_id       INTEGER,
  case_type_code TEXT,
  system       TEXT,
  set_version  INTEGER,
  result       TEXT NOT NULL,
  routing      TEXT NOT NULL,
  reason       TEXT NOT NULL DEFAULT '',
  reason_code  TEXT NOT NULL DEFAULT '',
  detail       TEXT NOT NULL DEFAULT '{}',
  rule_snapshot TEXT NOT NULL DEFAULT '[]',
  evaluated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_evaluations_applicant ON evaluations(applicant_id);

CREATE TABLE IF NOT EXISTS organizations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  -- Public ingest budget for this tenant (Phase 18). Nullable on purpose: no
  -- value means "follow the installation default", so an upgraded database
  -- behaves exactly as it did before the column existed.
  webhook_rate_limit_per_minute TEXT,
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
  terminology TEXT NOT NULL DEFAULT '{}',
  stages TEXT NOT NULL DEFAULT '[]',
  queues TEXT NOT NULL DEFAULT '[]',
  config_version INTEGER NOT NULL DEFAULT 1,
  default_reply_action TEXT NOT NULL DEFAULT 'draft',
  -- Profile evidence-gate preference; it cannot waive the mandatory Green,
  -- fully-qualified requirement for automated mail. Matches ADDITIONS and
  -- createCaseType (on by default).
  evidence_gate INTEGER NOT NULL DEFAULT 1,
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
CREATE TABLE IF NOT EXISTS secrets (
  organization_id INTEGER NOT NULL DEFAULT 1,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (organization_id, key)
);
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

CREATE TABLE IF NOT EXISTS staff_permissions (
  staff_id INTEGER NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  granted_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (staff_id, permission)
);

-- Phase 18: the public webhook surface. The credential itself lives in the
-- secrets store (key webhook_ingest_key) and is deliberately NOT stored in
-- either table below — a delivery log that carried the key would leak it to
-- anyone who can read the log. webhook_claims is the idempotency ledger (one
-- row per organization + external_id); webhook_deliveries is the newest-first
-- record of what arrived and what became of it, for the tenant's own diagnosis.
CREATE TABLE IF NOT EXISTS webhook_claims (
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  external_id     TEXT NOT NULL,
  applicant_id    INTEGER REFERENCES applicants(id),
  ref_number      TEXT NOT NULL DEFAULT '',
  claimed_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (organization_id, external_id)
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  received_at     TEXT NOT NULL,
  outcome         TEXT NOT NULL,
  status_code     INTEGER NOT NULL,
  external_id     TEXT NOT NULL DEFAULT '',
  sender_email    TEXT NOT NULL DEFAULT '',
  case_type_code  TEXT NOT NULL DEFAULT '',
  ref_number      TEXT NOT NULL DEFAULT '',
  applicant_id    INTEGER REFERENCES applicants(id),
  detail          TEXT NOT NULL DEFAULT '',
  payload_bytes   INTEGER NOT NULL DEFAULT 0,
  metadata        TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_recent ON webhook_deliveries(organization_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_case ON webhook_deliveries(applicant_id);`;

const ADDITIONS: Array<[string, string, string]> = [["applicants", "requirements_snapshot", "TEXT"], ["applicants", "nationality", "TEXT"], ["applicants", "followup_rung", "INTEGER NOT NULL DEFAULT 0"], ["applicants", "followup_next_at", "TEXT"], ["applicants", "followup_base_at", "TEXT"], ["applicants", "followup_action", "TEXT NOT NULL DEFAULT 'hold'"], ["emails", "channel", "TEXT NOT NULL DEFAULT 'email'"], ["emails", "attachments", "TEXT NOT NULL DEFAULT ''"], ["outbox", "template_key", "TEXT NOT NULL DEFAULT ''"], ["outbox", "needs_approval", "INTEGER NOT NULL DEFAULT 0"], ["outbox", "claimed_at", "TEXT"], ["programmes", "owner_id", "INTEGER REFERENCES staff_users(id)"], ["programmes", "school", "TEXT NOT NULL DEFAULT ''"], ["programmes", "entry_requirements", "TEXT NOT NULL DEFAULT ''"], ["templates", "include_banner", "INTEGER NOT NULL DEFAULT 1"], ["templates", "organization_id", "INTEGER"], ["staff_users", "demo", "INTEGER NOT NULL DEFAULT 0"], ["staff_users", "organization_id", "INTEGER"], ["staff_users", "active_organization_id", "INTEGER"], ["organizations", "ref_prefix", "TEXT NOT NULL DEFAULT 'ORG'"], ["organizations", "from_name", "TEXT"], ["organizations", "reply_to", "TEXT"], ["organizations", "locale", "TEXT"], ["organizations", "timezone", "TEXT"], ["organizations", "inbound_address", "TEXT"], ["organizations", "webhook_rate_limit_per_minute", "TEXT"], ["case_types", "terminology", "TEXT NOT NULL DEFAULT '{}'"], ["case_types", "stages", "TEXT NOT NULL DEFAULT '[]'"], ["case_types", "queues", "TEXT NOT NULL DEFAULT '[]'"], ["case_types", "config_version", "INTEGER NOT NULL DEFAULT 1"], ["case_types", "default_reply_action", "TEXT NOT NULL DEFAULT 'draft'"], ["applicants", "case_config_frozen", "TEXT"], ["applicants", "config_version_frozen", "INTEGER"], ["applicants", "config_version_frozen_at", "TEXT"], ["applicants", "queue", "TEXT"], ["intakes", "deadline", "TEXT"], ["applicants", "requirements_structured", "TEXT"], ["programmes", "level", "TEXT NOT NULL DEFAULT 'general'"], ["applicants", "transfer", "INTEGER NOT NULL DEFAULT 0"], ["applicants", "demo", "INTEGER NOT NULL DEFAULT 0"], ["applicants", "organization_id", "INTEGER"], ["applicants", "case_type_id", "INTEGER"], ["applicants", "category", "TEXT"], ["applicants", "outcome", "TEXT NOT NULL DEFAULT 'undecided'"], ["documents", "confidence_score", "INTEGER NOT NULL DEFAULT 0"], ["documents", "extraction_note", "TEXT NOT NULL DEFAULT ''"], ["applicants", "req_result", "TEXT"], ["applicants", "routing", "TEXT"], ["applicants", "routing_reason", "TEXT"], ["applicants", "decision_by", "TEXT"], ["applicants", "decision_reason", "TEXT"], ["applicants", "decision_at", "TEXT"], ["templates", "attach_pack", "TEXT NOT NULL DEFAULT 'none'"], ["templates", "default_snapshot", "TEXT"], ["organization_templates", "case_type_id", "INTEGER NOT NULL DEFAULT 0"], ["organization_templates", "default_snapshot", "TEXT"], ["applicants", "outcome_route", "TEXT"], ["case_types", "evidence_gate", "INTEGER NOT NULL DEFAULT 1"], ["emails", "organization_id", "INTEGER NOT NULL DEFAULT 1"], ["processed_emails", "organization_id", "INTEGER NOT NULL DEFAULT 1"], ["staff_users", "case_type_scope_mode", "TEXT NOT NULL DEFAULT 'unscoped'"], ["applicants", "case_type_code", "TEXT"], ["evaluations", "case_type_code", "TEXT"], ["intakes", "organization_id", "INTEGER NOT NULL DEFAULT 1"],
  // Columns the running code reads on ordinary requests. A database created by
  // an older release may lack any of them: CREATE TABLE IF NOT EXISTS never
  // adds a column to a table that already exists, so each one is declared here
  // too — otherwise an upgrade opens fine and then fails on the first query
  // (this is how the missing outbox.claimed_at column shipped).
  ["staff_users", "active", "INTEGER NOT NULL DEFAULT 1"],
  ["case_types", "active", "INTEGER NOT NULL DEFAULT 1"],
  ["emails", "read", "INTEGER NOT NULL DEFAULT 0"],
  ["emails", "labels", "TEXT NOT NULL DEFAULT '[]'"],
  ["documents", "sha256", "TEXT"],
  ["documents", "is_duplicate", "INTEGER NOT NULL DEFAULT 0"],
  ["status_history", "reason", "TEXT NOT NULL DEFAULT ''"],
  ["applicants", "triage", "TEXT"],
  ["applicants", "phone", "TEXT"]];

/**
 * SCHEMA carries tables and indexes in one string, and an index may reference
 * a column that ADDITIONS only creates on an UPGRADED database. migrate()
 * therefore runs the tables first, adds whatever columns are missing, and only
 * then creates the indexes — otherwise an upgrade dies on the first index that
 * references a new column (a fresh database never noticed: its tables are
 * created complete).
 */
const SCHEMA_STATEMENTS = SCHEMA.split(/;\s*\n/).map((statement) => statement.trim()).filter(Boolean);
const isIndexStatement = (statement: string): boolean => /^CREATE (?:UNIQUE )?INDEX/i.test(statement);
export const SCHEMA_TABLES = SCHEMA_STATEMENTS.filter((statement) => !isIndexStatement(statement)).map((statement) => `${statement};`).join("\n");
export const SCHEMA_INDEXES = SCHEMA_STATEMENTS.filter(isIndexStatement).map((statement) => `${statement};`).join("\n");

function columns(db: Database.Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((column) => column.name));
}
/**
 * A view stores no rows of its own, but SQLite re-parses every view in the
 * schema each time a table is dropped, renamed or rebuilt. `DROP TABLE`
 * itself succeeds, so the failure surfaces on the NEXT schema statement — for
 * example the `ALTER TABLE ... RENAME TO applicants` at the end of
 * rebuildConstraint — as `error in view cases: no such table: main.applicants`
 * on a database an older release left with the compatibility view and the
 * pre-tenant `UNIQUE (email_address, thread_id)` constraint.
 *
 * suspendViews() therefore lifts every view out of the schema before migrate()
 * starts touching tables, and resumeViews() puts them back afterwards. Views
 * carry no data, so the round trip cannot lose anything; a view whose backing
 * table this release retires on purpose (dropObsolete) is left dropped rather
 * than aborting an upgrade.
 */
function suspendViews(db: Database.Database): Array<{ name: string; sql: string }> {
  const views = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'view' AND sql IS NOT NULL ORDER BY rowid").all() as Array<{ name: string; sql: string }>;
  for (const view of views) db.exec(`DROP VIEW "${view.name.replace(/"/g, '""')}"`);
  return views;
}
function resumeViews(db: Database.Database, views: Array<{ name: string; sql: string }>): void {
  for (const view of views) {
    // migrate() may have installed its own definition for this name (the `cases`
    // compatibility view); never let an older copy overwrite it.
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(view.name)) continue;
    try {
      db.exec(view.sql);
    } catch {
      // The view read a table this release retired deliberately; a definition
      // that cannot resolve is of no use to anyone, so it stays dropped.
    }
  }
}
/**
 * The `cases` object is a read alias over `applicants`, recreated on every boot
 * so it always matches the current column list. A legacy database that still
 * keeps its own TABLE under that name is refused instead of being silently
 * shadowed: the rows in it would otherwise stay invisible to the application.
 */
function installCasesView(db: Database.Database): void {
  const existing = db.prepare("SELECT type FROM sqlite_master WHERE name = 'cases'").get() as { type: string } | undefined;
  if (existing && existing.type !== "view") {
    throw new Error("A legacy table named 'cases' is blocking the compatibility view; merge it into 'applicants' before upgrading");
  }
  if (existing) db.exec("DROP VIEW cases");
  db.exec("CREATE VIEW cases AS SELECT a.* FROM applicants a");
}
/** Rebuild only a known obsolete uniqueness constraint, preserving custom columns,
 * indexes, triggers, row IDs and the AUTOINCREMENT high-water mark. Foreign keys
 * are disabled by openDb before this transaction, then checked before commit. */
function rebuildConstraint(db: Database.Database, table: string, definition: string): void {
  const objects = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index','trigger') AND sql IS NOT NULL").all(table) as Array<{ sql: string }>;
  const names = (db.prepare(`PRAGMA table_xinfo("${table}")`).all() as Array<{ name: string; hidden: number }>).filter((column) => !column.hidden).map((column) => `"${column.name.replace(/"/g, '""')}"`).join(",");
  const sequenceExists = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'").get();
  const sequence = sequenceExists ? db.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").get(table) as { seq: number } | undefined : undefined;
  const temporary = `${table}_tenant_migration`;
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(temporary)) throw new Error(`Reserved migration table already exists: ${temporary}`);
  const create = definition.replace(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|\w+)/i, `CREATE TABLE "${temporary}"`);
  db.exec(create);
  db.exec(`INSERT INTO "${temporary}" (${names}) SELECT ${names} FROM "${table}"`);
  db.exec(`DROP TABLE "${table}"`);
  db.exec(`ALTER TABLE "${temporary}" RENAME TO "${table}"`);
  for (const object of objects) db.exec(object.sql);
  if (sequence) db.prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?").run(sequence.seq, table);
}
/** Drop what the generic model replaced: the school catalogue and the
 * school × staff scope matrix. Visibility scope is now the case type, so an
 * officer who was school-scoped becomes NO-ACCESS (never wider than before)
 * until an administrator assigns case types. */
function dropObsolete(db: Database.Database): void {
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((table) => table.name));
  if (tables.has("staff_users") && columns(db, "staff_users").has("scope_mode")) {
    db.exec("UPDATE staff_users SET case_type_scope_mode = 'none' WHERE scope_mode IN ('none','scoped') AND case_type_scope_mode = 'unscoped'");
    db.exec("ALTER TABLE staff_users DROP COLUMN scope_mode");
  }
  for (const table of ["staff_scopes", "schools"]) if (tables.has(table)) db.exec(`DROP TABLE "${table}"`);
}

function tenantConstraints(db: Database.Database): void {
  const caseSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'applicants'").get() as { sql: string }).sql;
  const obsolete = /UNIQUE\s*\(\s*"?email_address"?\s*,\s*"?thread_id"?\s*\)/i;
  if (obsolete.test(caseSql)) rebuildConstraint(db, "applicants", caseSql.replace(obsolete, "UNIQUE (organization_id, email_address, thread_id)"));
  // Submission windows used to be global (name PRIMARY KEY), so two tenants
  // naming the same window shared one deadline. Rebuild per tenant, preserving
  // the existing rows and their deadlines (they are attributed to the head
  // office, which is where every window lived before).
  const intakesRow = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'intakes'").get() as { sql: string } | undefined;
  const intakesSql = intakesRow?.sql;
  const globalIntakes = /"?name"?\s+TEXT\s+PRIMARY KEY/i;
  if (intakesSql && globalIntakes.test(intakesSql)) {
    // ADDITIONS has normally added organization_id by now; declaring it again
    // here would fail the rebuild with "duplicate column name".
    const withTenantColumn = /organization_id/i.test(intakesSql)
      ? intakesSql
      : intakesSql.replace(/\)\s*$/, ", organization_id INTEGER NOT NULL DEFAULT 1)");
    rebuildConstraint(
      db,
      "intakes",
      withTenantColumn.replace(globalIntakes, "name TEXT NOT NULL").replace(/\)\s*$/, ", PRIMARY KEY (organization_id, name))")
    );
  }
  const processedSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'processed_emails'").get() as { sql: string }).sql;
  const singleKey = /("?email_id"?\s+TEXT)\s+PRIMARY KEY/i;
  if (singleKey.test(processedSql)) rebuildConstraint(db, "processed_emails", processedSql.replace(singleKey, "$1 NOT NULL").replace(/\)\s*$/, ", PRIMARY KEY (organization_id, email_id))"));
}

export const LEGACY_TEMPLATE_MIGRATION_MARKER = "organization_templates_v1";

/**
 * Copy legacy shared-template rows into the organization-owned store without
 * deleting or rewriting their source rows. Existing organization rows win, so
 * an administrator's newer edit is never replaced by an older fallback.
 *
 * The marker prevents a deliberately deleted/changed organization row from
 * being resurrected on every boot. If a legacy row refers to an organization
 * that does not exist yet, it remains readable through the fallback and the
 * marker is withheld so a later boot can finish the copy after that tenant is
 * restored.
 */
function migrateLegacyTemplates(db: Database.Database): void {
  if (db.prepare("SELECT 1 FROM settings WHERE key = ?").get(LEGACY_TEMPLATE_MIGRATION_MARKER)) return;

  db.exec(`
    INSERT OR IGNORE INTO organization_templates (
      organization_id, key, name, subject, body, include_banner,
      attach_pack, case_type_id, default_snapshot, updated_at
    )
    SELECT COALESCE(t.organization_id, 1), t.key, t.name, t.subject, t.body,
           t.include_banner, t.attach_pack, 0, t.default_snapshot, t.updated_at
      FROM templates t
      JOIN organizations o ON o.id = COALESCE(t.organization_id, 1)
  `);

  const unresolved = db.prepare(
    `SELECT COUNT(*) AS n
       FROM templates t
       LEFT JOIN organizations o ON o.id = COALESCE(t.organization_id, 1)
      WHERE o.id IS NULL`
  ).get() as { n: number };
  if (unresolved.n === 0) {
    db.prepare("INSERT INTO settings (key, value) VALUES (?, '1')").run(LEGACY_TEMPLATE_MIGRATION_MARKER);
  }
}

function migrate(db: Database.Database): void {
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((table) => table.name));
  // Legacy storage names are rewritten while views are still attached, so SQLite
  // updates any view text that mentions the renamed table or column.
  for (const [from, to] of Object.entries(legacyStorage.tables)) if (tables.has(from) && !tables.has(to)) db.exec(`ALTER TABLE "${from}" RENAME TO "${to}"`);
  for (const [table, mapping] of Object.entries(legacyStorage.columns)) {
    const existing = columns(db, table);
    for (const [from, to] of Object.entries(mapping)) if (existing.has(from) && !existing.has(to)) db.exec(`ALTER TABLE "${table}" RENAME COLUMN "${from}" TO "${to}"`);
  }
  // Everything from here on creates, rebuilds or replaces tables, so the views
  // go first (see suspendViews) — otherwise a database left with the old
  // `cases` view aborts the whole migration on the applicants rebuild. The base
  // schema is also bootstrapped before any constraint rebuild: a fresh database
  // has to own the `applicants` table before tenantConstraints() can rewrite its
  // uniqueness constraint and before the compatibility view is recreated.
  const suspendedViews = suspendViews(db);
  db.exec(SCHEMA_TABLES);
  for (const [table, name, definition] of ADDITIONS) if (!columns(db, table).has(name)) db.exec(`ALTER TABLE "${table}" ADD COLUMN "${name}" ${definition}`);
  db.exec(SCHEMA_INDEXES);
  db.exec("UPDATE emails SET organization_id = (SELECT COALESCE(organization_id,1) FROM applicants WHERE id = emails.applicant_id) WHERE applicant_id IS NOT NULL");
  dropObsolete(db);
  tenantConstraints(db);
  const marker = db.prepare("SELECT 1 FROM settings WHERE key = 'generic_storage_v2'").get();
  if (!marker) {
    if (columns(db, "applicants").has("legacy_outcome")) {
      for (const [from, to] of Object.entries(legacyStorage.outcomes)) db.prepare("UPDATE applicants SET outcome = ? WHERE legacy_outcome = ? AND outcome = 'undecided'").run(to, from);
    }
    if (columns(db, "case_types").has("legacy_module")) db.exec("UPDATE case_types SET default_reply_action = 'draft' WHERE legacy_module = 1");
    // Existing customer data is preserved; new installations remain empty.
    const existingData = (db.prepare("SELECT (SELECT COUNT(*) FROM applicants) + (SELECT COUNT(*) FROM staff_users) AS n").get() as { n: number }).n;
    if (existingData && !db.prepare("SELECT 1 FROM organizations WHERE id = 1").get()) {
      const name = (db.prepare("SELECT value FROM settings WHERE key = 'institution_name'").get() as { value: string } | undefined)?.value || "Imported workspace";
      db.prepare("INSERT INTO organizations (id, name) VALUES (1, ?)").run(name);
    }
    db.exec("UPDATE applicants SET organization_id = 1 WHERE organization_id IS NULL");
    db.exec("UPDATE staff_users SET organization_id = 1 WHERE organization_id IS NULL");
    db.exec("INSERT INTO settings (key, value) VALUES ('generic_storage_v2', '1')");
  }
  const fromName = db.prepare("SELECT value FROM settings WHERE key = 'from_name'").get() as { value: string } | undefined;
  if (fromName && db.prepare("SELECT 1 FROM organizations WHERE id = 1").get()) {
    db.prepare("UPDATE organizations SET from_name = COALESCE(from_name, ?) WHERE id = 1").run(fromName.value);
    db.exec("DELETE FROM settings WHERE key = 'from_name'");
  }
  // Move secrets out of the settings export without overwriting stored keys.
  for (const key of ["gemini_api_key", "gmail_client_secret", "gmail_refresh_token"]) {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    if (row) { db.prepare("INSERT OR IGNORE INTO secrets (organization_id,key,value) VALUES (1,?,?)").run(key,row.value); db.prepare("DELETE FROM settings WHERE key = ?").run(key); }
  }
  // Non-destructive template migration: the old table stays in place as a
  // read fallback until a separately approved cleanup removes it.
  migrateLegacyTemplates(db);
  db.exec("CREATE INDEX IF NOT EXISTS idx_outbox_applicant ON outbox(applicant_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_cases_org_email ON applicants(organization_id,email_address)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_emails_org_thread ON emails(organization_id,thread_id)");
  installCasesView(db);
  resumeViews(db, suspendedViews);
  db.pragma("user_version = 2");
}
export function openDb(file: string): Database.Database {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const releaseActivity = markDatabaseActive(file);
  let db: Database.Database;
  try {
    db = new Database(file);
  } catch (error) {
    releaseActivity();
    throw error;
  }
  const originalClose = db.close.bind(db);
  try {
    Object.defineProperty(db, "close", {
      configurable: true,
      value: () => {
        originalClose();
        releaseActivity();
      },
    });
  } catch (error) {
    try { originalClose(); } finally { releaseActivity(); }
    throw error;
  }
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = OFF");
    db.pragma("busy_timeout = 5000");
    if (Number(db.pragma("user_version", { simple: true })) > 2) throw new Error("Database was created by a newer version of the application");
    const existingViolations = new Set((db.pragma("foreign_key_check") as unknown[]).map((row) => JSON.stringify(row)));
    db.transaction(() => {
      migrate(db);
      const introduced = (db.pragma("foreign_key_check") as unknown[]).filter((row) => !existingViolations.has(JSON.stringify(row)));
      if (introduced.length) throw new Error(`Migration would introduce ${introduced.length} foreign-key violations; no changes saved`);
    })();
    db.pragma("foreign_keys = ON");
    return db;
  } catch (error) { db.close(); throw error; }
}
