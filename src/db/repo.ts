/**
 * /db — all queries live here. Nothing else in the codebase writes SQL.
 * v2: case management (ref numbers, email history, status history, audit
 * log, notes, staff/sessions, templates, settings, SLAs, notifications,
 * programme/intake-scoped requirements, search, dashboard stats).
 */
import * as crypto from "crypto";
import type { Database } from "better-sqlite3";
import type {
  ApplicantRow,
  Classification,
  Confidence,
  DecisionLogEntry,
  DerivedFlag,
  DocType,
  DocumentRecord,
  EmailCategory,
  EmailRecord,
  ExtractionMethod,
  ExtractedFields,
  Flag,
  LifecycleStage,
  Priority,
  RequirementRule,
  RequirementSetEntry,
  StaffUser,
} from "../types";

const nowIso = () => new Date().toISOString();

/** Query shape for {@link Repo.searchApplicants} — shared with the web layer. */
export interface ApplicantSearchQuery {
  q?: string;
  filter?: "all" | "awaiting_docs" | "human_review" | "complete" | "overdue";
  programme?: string;
  intake?: string;
  limit?: number;
}

/** Per-staff workload + responsiveness metrics for the Team page. */
export interface StaffStatsRow {
  id: number;
  username: string;
  display_name: string;
  role: string;
  active: number;
  assignedCases: number;
  emailsReceived: number;
  emailsSent: number;
  avgResponseMinutes: number | null;
  admissionsCompleted: number;
}

export class Repo {
  constructor(public db: Database) {}

  // ── Reference numbers (feature 1) ────────────────────────────────────────

  nextRefNumber(prefix: string, year: number): string {
    const tx = this.db.transaction(() => {
      this.db
        .prepare("INSERT OR IGNORE INTO ref_counters (year, last_seq) VALUES (?, 0)")
        .run(year);
      this.db.prepare("UPDATE ref_counters SET last_seq = last_seq + 1 WHERE year = ?").run(year);
      const { last_seq } = this.db
        .prepare("SELECT last_seq FROM ref_counters WHERE year = ?")
        .get(year) as { last_seq: number };
      return `${prefix}-${year}-${String(last_seq).padStart(6, "0")}`;
    });
    return tx();
  }

  findByRef(ref: string): ApplicantRow | undefined {
    return this.db
      .prepare("SELECT * FROM applicants WHERE ref_number = ? COLLATE NOCASE")
      .get(ref.trim()) as ApplicantRow | undefined;
  }

  // ── Applicants ───────────────────────────────────────────────────────────

  getOrCreateApplicant(
    emailAddress: string,
    threadId: string,
    opts: { fullName?: string; refPrefix?: string } = {}
  ): ApplicantRow {
    const addr = emailAddress.trim().toLowerCase();
    // Check-then-insert WITHOUT a transaction races: two parallel first emails
    // from the same sender can both miss the row and one dies on
    // UNIQUE(email_address, thread_id). Insert-or-ignore inside a transaction,
    // then read whatever won.
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO applicants (ref_number, email_address, thread_id, full_name)
       VALUES (?, ?, ?, ?)`
    );
    const select = this.db.prepare(
      "SELECT * FROM applicants WHERE email_address = ? AND thread_id = ?"
    );
    let row: ApplicantRow | undefined;
    let created = false;
    this.db.transaction(() => {
      const existing = select.get(addr, threadId) as ApplicantRow | undefined;
      if (existing) {
        row = existing;
        return;
      }
      const ref = this.nextRefNumber(opts.refPrefix ?? "RU", new Date().getFullYear());
      insert.run(ref, addr, threadId, opts.fullName ?? null);
      row = select.get(addr, threadId) as ApplicantRow;
      created = true;
    })();
    // The transaction ran synchronously; row is always set here.
    const applicant = row as ApplicantRow;
    if (created) {
      this.audit(applicant.id, "system", "applicant_created", `Case ${applicant.ref_number} opened for ${addr}`);
    }
    return applicant;
  }

  getApplicant(id: number): ApplicantRow | undefined {
    return this.db.prepare("SELECT * FROM applicants WHERE id = ?").get(id) as ApplicantRow | undefined;
  }

  updateApplicant(
    id: number,
    patch: Partial<
      Pick<
        ApplicantRow,
        | "full_name"
        | "phone"
        | "programme"
        | "intake"
        | "priority"
        | "assigned_to"
        | "lifecycle"
        | "triage"
        | "sla_due_at"
        | "sla_handled_at"
        | "escalated"
      >
    >
  ): void {
    // Column names are interpolated into SQL — only ever from this allow-list,
    // never from caller-provided strings.
    const ALLOWED = new Set([
      "full_name", "phone", "programme", "intake", "priority", "assigned_to",
      "lifecycle", "triage", "sla_due_at", "sla_handled_at", "escalated",
    ]);
    const keys = Object.keys(patch) as Array<keyof typeof patch>;
    if (keys.length === 0) return;
    for (const k of keys) {
      if (!ALLOWED.has(k)) throw new Error(`updateApplicant: refusing unknown column "${k}"`);
    }
    const setSql = keys.map((k) => `${k} = ?`).join(", ");
    const vals = keys.map((k) => patch[k] ?? null);
    this.db.prepare(`UPDATE applicants SET ${setSql}, updated_at = ? WHERE id = ?`).run(...vals, nowIso(), id);
  }

  // ── Lifecycle + status history (features 15, 16) ─────────────────────────

  setLifecycle(id: number, to: LifecycleStage, actor: string, reason: string): void {
    const current = this.getApplicant(id);
    if (!current || current.lifecycle === to) return;
    this.db
      .prepare("INSERT INTO status_history (applicant_id, from_status, to_status, actor, reason) VALUES (?,?,?,?,?)")
      .run(id, current.lifecycle, to, actor, reason);
    this.updateApplicant(id, { lifecycle: to });
    this.audit(id, actor, "status_changed", `${current.lifecycle} → ${to}: ${reason}`);
  }

  statusHistory(applicantId: number): Array<{ from_status: string; to_status: string; actor: string; reason: string; at: string }> {
    return this.db
      .prepare("SELECT from_status, to_status, actor, reason, at FROM status_history WHERE applicant_id = ? ORDER BY id")
      .all(applicantId) as never[];
  }

  // ── Audit log (feature 17) ───────────────────────────────────────────────

  audit(applicantId: number | null, actor: string, event: string, detail = ""): void {
    this.db
      .prepare("INSERT INTO audit_log (applicant_id, actor, event, detail) VALUES (?,?,?,?)")
      .run(applicantId, actor, event, detail);
  }

  auditForApplicant(applicantId: number): Array<{ at: string; actor: string; event: string; detail: string }> {
    return this.db
      .prepare("SELECT at, actor, event, detail FROM audit_log WHERE applicant_id = ? ORDER BY id DESC LIMIT 200")
      .all(applicantId) as never[];
  }

  /** Most recent audit rows, newest first (CSV export). */
  recentAudit(limit: number): Array<{ at: string; actor: string; event: string; detail: string; applicant_id: number | null }> {
    return this.db
      .prepare("SELECT at, actor, event, detail, applicant_id FROM audit_log ORDER BY id DESC LIMIT ?")
      .all(limit) as never[];
  }

  // ── Programmes & intakes ─────────────────────────────────────────────────

  listProgrammes(): Array<{ code: string; name: string }> {
    return this.db.prepare("SELECT code, name FROM programmes ORDER BY code").all() as never[];
  }

  addProgramme(code: string, name: string): void {
    this.db
      .prepare("INSERT INTO programmes (code, name) VALUES (?, ?) ON CONFLICT(code) DO UPDATE SET name = excluded.name")
      .run(code.toUpperCase(), name);
  }

  listIntakes(): string[] {
    return (this.db.prepare("SELECT name FROM intakes ORDER BY rowid").all() as Array<{ name: string }>).map((r) => r.name);
  }

  addIntake(name: string): void {
    this.db.prepare("INSERT OR IGNORE INTO intakes (name) VALUES (?)").run(name);
  }

  // ── Requirements (features 8, 36, 37) ────────────────────────────────────

  /**
   * SQLite treats NULLs as DISTINCT in UNIQUE constraints, so
   * `ON CONFLICT(programme, intake, document_type)` can never fire for base
   * rules (programme=NULL, intake=NULL) — every "upsert" silently inserted a
   * duplicate. Rules are therefore upserted as delete-then-insert matched
   * with `IS`, which treats NULL as equal to NULL.
   */
  private upsertRuleRow(programme: string | null, intake: string | null, documentType: string, required: boolean, minGradePoints: number | null): void {
    this.db
      .prepare("DELETE FROM requirement_rules WHERE programme IS ? AND intake IS ? AND document_type = ?")
      .run(programme, intake, documentType);
    this.db
      .prepare("INSERT INTO requirement_rules (programme, intake, document_type, required, min_grade_points) VALUES (?,?,?,?,?)")
      .run(programme, intake, documentType, required ? 1 : 0, minGradePoints);
  }

  seedBaseRequirements(entries: RequirementSetEntry[]): void {
    const tx = this.db.transaction(() => {
      for (const e of entries) {
        this.upsertRuleRow(null, null, e.document_type, e.required, e.minGradePoints ?? null);
      }
    });
    tx();
  }

  /** Remove duplicate rule rows left behind by the old NULL-broken upsert. Idempotent. */
  dedupeRules(): number {
    const res = this.db
      .prepare(
        `DELETE FROM requirement_rules
         WHERE id NOT IN (
           SELECT MAX(id) FROM requirement_rules
           GROUP BY coalesce(programme,''), coalesce(intake,''), document_type
         )`
      )
      .run();
    return res.changes;
  }

  listRules(): RequirementRule[] {
    const rows = this.db
      .prepare("SELECT * FROM requirement_rules ORDER BY programme IS NULL DESC, intake IS NULL DESC, rowid")
      .all() as any[];
    return rows.map((r) => ({
      id: r.id,
      programme: r.programme,
      intake: r.intake,
      document_type: r.document_type,
      required: r.required === 1,
      minGradePoints: r.min_grade_points,
    }));
  }

  upsertRule(rule: { programme: string | null; intake: string | null; document_type: DocType; required: boolean; minGradePoints: number | null }): void {
    // See seedBaseRequirements: ON CONFLICT cannot see NULL programme/intake,
    // so upsert is delete-then-insert with IS-matching.
    this.db.transaction(() => {
      this.upsertRuleRow(rule.programme, rule.intake, rule.document_type, rule.required, rule.minGradePoints);
    })();
  }

  deleteRule(id: number): void {
    this.db.prepare("DELETE FROM requirement_rules WHERE id = ?").run(id);
  }

  /**
   * Resolve the effective requirement set for an applicant.
   * Specificity ladder: base → intake-only → programme-only → programme+intake.
   * More specific rules override (or add to) less specific ones.
   */
  /**
   * Requirement set as it applies to THIS applicant (feature 19): if a
   * snapshot was frozen when the file was first triaged, that snapshot wins —
   * applicants are judged by the rules that were in force when they applied,
   * not by rules that changed afterwards.
   */
  effectiveRequirements(a: ApplicantRow): RequirementSetEntry[] {
    if (a.requirements_snapshot) {
      try {
        return JSON.parse(a.requirements_snapshot) as RequirementSetEntry[];
      } catch {
        // Corrupt snapshot: falling back to LIVE rules silently would re-judge
        // this applicant by rules that changed after they applied — the exact
        // thing the snapshot exists to prevent. Make it visible.
        this.audit(
          a.id,
          "system",
          "requirements_snapshot_corrupt",
          "frozen requirement snapshot failed to parse — fell back to live rules; human should verify"
        );
      }
    }
    return this.resolveRequirements(a.programme, a.intake);
  }

  /** Freeze the current requirement set onto the applicant on first triage. */
  freezeRequirementsSnapshot(a: ApplicantRow): void {
    if (a.requirements_snapshot) return;
    const snapshot = this.resolveRequirements(a.programme, a.intake);
    this.db
      .prepare("UPDATE applicants SET requirements_snapshot = ? WHERE id = ?")
      .run(JSON.stringify(snapshot), a.id);
  }

  resolveRequirements(programme: string | null, intake: string | null): RequirementSetEntry[] {
    const rows = this.db
      .prepare("SELECT programme, intake, document_type, required, min_grade_points FROM requirement_rules")
      .all() as any[];
    const ladder = [
      (r: any) => r.programme === null && r.intake === null,
      (r: any) => r.programme === null && r.intake !== null && r.intake === intake,
      (r: any) => r.programme !== null && r.programme === programme && r.intake === null,
      (r: any) => r.programme !== null && r.programme === programme && r.intake !== null && r.intake === intake,
    ];
    const merged = new Map<string, RequirementSetEntry>();
    for (const matches of ladder) {
      for (const r of rows) {
        if (!matches(r)) continue;
        merged.set(r.document_type, {
          document_type: r.document_type,
          required: r.required === 1,
          minGradePoints: r.min_grade_points,
        });
      }
    }
    return [...merged.values()];
  }

  // ── Documents (features 5, 6, 9, 22) ─────────────────────────────────────

  insertDocument(d: {
    applicant_id: number;
    document_type: DocType;
    source_email_id: string;
    extraction_method: ExtractionMethod;
    extracted_text: string;
    extracted_fields: ExtractedFields;
    confidence: Confidence;
    received_at: string;
    sha256?: string;
    is_duplicate?: boolean;
    duplicate_of?: number | null;
  }): number {
    const res = this.db
      .prepare(
        `INSERT INTO documents
           (applicant_id, document_type, source_email_id, extraction_method,
            extracted_text, extracted_fields, confidence, received_at,
            sha256, is_duplicate, duplicate_of)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        d.applicant_id,
        d.document_type,
        d.source_email_id,
        d.extraction_method,
        d.extracted_text,
        JSON.stringify(d.extracted_fields ?? {}),
        d.confidence,
        d.received_at,
        d.sha256 ?? null,
        d.is_duplicate ? 1 : 0,
        d.duplicate_of ?? null
      );
    return Number(res.lastInsertRowid);
  }

  /** Active (non-superseded, non-duplicate) documents for an applicant. */
  findDuplicate(applicantId: number, sha256: string): DocumentRecord | undefined {
    return this.db
      .prepare(
        `SELECT * FROM documents
         WHERE applicant_id = ? AND sha256 = ? AND is_duplicate = 0
         ORDER BY id LIMIT 1`
      )
      .get(applicantId, sha256) as DocumentRecord | undefined;
  }

  supersedeOlder(applicantId: number, docType: DocType, newId: number): number {
    const res = this.db
      .prepare(
        `UPDATE documents
         SET superseded_by = ?
         WHERE applicant_id = ? AND document_type = ? AND id <> ?
           AND superseded_by IS NULL AND is_duplicate = 0`
      )
      .run(newId, applicantId, docType, newId);
    return res.changes;
  }

  private rowToDocument(r: any): DocumentRecord {
    return {
      id: r.id,
      applicant_id: r.applicant_id,
      document_type: r.document_type,
      source_email_id: r.source_email_id,
      extraction_method: r.extraction_method,
      extracted_text: r.extracted_text,
      extracted_fields: JSON.parse(r.extracted_fields || "{}"),
      confidence: r.confidence,
      superseded_by: r.superseded_by,
      received_at: r.received_at,
      sha256: r.sha256 ?? undefined,
      is_duplicate: r.is_duplicate,
      duplicate_of: r.duplicate_of,
    };
  }

  listDocuments(applicantId: number, opts: { activeOnly?: boolean } = {}): DocumentRecord[] {
    const { activeOnly = true } = opts;
    const sql = activeOnly
      ? "SELECT * FROM documents WHERE applicant_id = ? AND superseded_by IS NULL AND is_duplicate = 0 ORDER BY id"
      : "SELECT * FROM documents WHERE applicant_id = ? ORDER BY id";
    return (this.db.prepare(sql).all(applicantId) as any[]).map((r) => this.rowToDocument(r));
  }

  countSuperseded(applicantId: number): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM documents WHERE applicant_id = ? AND superseded_by IS NOT NULL")
        .get(applicantId) as { n: number }
    ).n;
  }

  countDuplicates(applicantId: number): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM documents WHERE applicant_id = ? AND is_duplicate = 1")
        .get(applicantId) as { n: number }
    ).n;
  }

  // ── Flags ────────────────────────────────────────────────────────────────

  syncFlags(applicantId: number, derived: DerivedFlag[]): void {
    const key = (t: string, d: string) => `${t}::${d}`;
    const tx = this.db.transaction(() => {
      const existing = this.db
        .prepare("SELECT id, type, detail FROM flags WHERE applicant_id = ? AND active = 1")
        .all(applicantId) as Array<{ id: number; type: string; detail: string }>;
      const derivedKeys = new Set(derived.map((f) => key(f.type, f.detail)));
      const existingKeys = new Set(existing.map((r) => key(r.type, r.detail)));
      const deactivate = this.db.prepare("UPDATE flags SET active = 0 WHERE id = ?");
      const insert = this.db.prepare("INSERT INTO flags (applicant_id, type, detail, active) VALUES (?, ?, ?, 1)");
      for (const row of existing) {
        if (!derivedKeys.has(key(row.type, row.detail))) deactivate.run(row.id);
      }
      for (const f of derived) {
        if (!existingKeys.has(key(f.type, f.detail))) insert.run(applicantId, f.type, f.detail);
      }
    });
    tx();
  }

  activeFlags(applicantId: number): Flag[] {
    return this.db
      .prepare("SELECT * FROM flags WHERE applicant_id = ? AND active = 1 ORDER BY id")
      .all(applicantId) as Flag[];
  }

  // ── Email history (feature 4) ────────────────────────────────────────────

  insertEmail(e: Omit<EmailRecord, "id"> & { channel?: string }): number {
    const res = this.db
      .prepare(
        `INSERT INTO emails (applicant_id, message_id, thread_id, direction, from_addr, to_addr, subject, body, category, auto, channel, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        e.applicant_id,
        e.message_id,
        e.thread_id,
        e.direction,
        e.from_addr,
        e.to_addr,
        e.subject,
        e.body,
        e.category,
        e.auto,
        e.channel ?? "email",
        e.at
      );
    return Number(res.lastInsertRowid);
  }

  emailsForApplicant(applicantId: number): EmailRecord[] {
    return this.db
      .prepare("SELECT * FROM emails WHERE applicant_id = ? ORDER BY at, id")
      .all(applicantId) as EmailRecord[];
  }

  // ── Staff users & sessions (features 31, 32) ─────────────────────────────

  createStaff(username: string, displayName: string, passwordHash: string, role: string): void {
    this.db
      .prepare(
        "INSERT INTO staff_users (username, display_name, password_hash, role) VALUES (?,?,?,?)"
      )
      .run(username, displayName, passwordHash, role);
  }

  getStaffByUsername(username: string): (StaffUser & { password_hash: string }) | undefined {
    return this.db
      .prepare("SELECT id, username, display_name, password_hash, role, active FROM staff_users WHERE username = ?")
      .get(username) as never;
  }

  getStaff(id: number): StaffUser | undefined {
    return this.db
      .prepare("SELECT id, username, display_name, role, active FROM staff_users WHERE id = ?")
      .get(id) as StaffUser | undefined;
  }

  listStaff(): StaffUser[] {
    return this.db
      .prepare("SELECT id, username, display_name, role, active FROM staff_users ORDER BY id")
      .all() as StaffUser[];
  }

  setStaffPassword(id: number, passwordHash: string): void {
    this.db.prepare("UPDATE staff_users SET password_hash = ? WHERE id = ?").run(passwordHash, id);
  }

  setStaffActive(id: number, active: boolean): void {
    this.db.prepare("UPDATE staff_users SET active = ? WHERE id = ?").run(active ? 1 : 0, id);
  }

  createSession(staffId: number): { token: string; csrf: string; expiresAt: string } {
    // Expired rows were previously only purged at boot; purge on every login so
    // the table can't grow without bound on a long-running server.
    this.purgeExpiredSessions();
    const token = crypto.randomBytes(32).toString("hex");
    const csrf = crypto.randomBytes(16).toString("hex");
    const expiresAt = new Date(Date.now() + 8 * 3600_000).toISOString();
    this.db
      .prepare("INSERT INTO sessions (token, staff_id, csrf, expires_at) VALUES (?,?,?,?)")
      .run(token, staffId, csrf, expiresAt);
    return { token, csrf, expiresAt };
  }

  getSession(token: string): { staff: StaffUser; csrf: string } | undefined {
    const row = this.db
      .prepare(
        `SELECT s.csrf AS csrf, s.expires_at AS expires_at, u.id AS id, u.username AS username,
                u.display_name AS display_name, u.role AS role, u.active AS active
         FROM sessions s JOIN staff_users u ON u.id = s.staff_id
         WHERE s.token = ?`
      )
      .get(token) as any;
    if (!row) return undefined;
    if (new Date(row.expires_at).getTime() < Date.now() || row.active !== 1) return undefined;
    return {
      csrf: row.csrf,
      staff: { id: row.id, username: row.username, display_name: row.display_name, role: row.role, active: row.active },
    };
  }

  deleteSession(token: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
  }

  purgeExpiredSessions(): void {
    this.db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(new Date().toISOString());
  }

  // ── Notes (feature 34) ───────────────────────────────────────────────────

  addNote(applicantId: number, staffId: number | null, body: string): void {
    this.db.prepare("INSERT INTO notes (applicant_id, staff_id, body) VALUES (?,?,?)").run(applicantId, staffId, body);
  }

  notesForApplicant(applicantId: number): Array<{ id: number; body: string; at: string; display_name: string | null }> {
    return this.db
      .prepare(
        `SELECT n.id, n.body, n.at, u.display_name FROM notes n
         LEFT JOIN staff_users u ON u.id = n.staff_id
         WHERE n.applicant_id = ? ORDER BY n.id DESC`
      )
      .all(applicantId) as never[];
  }

  // ── Templates (feature 35) ───────────────────────────────────────────────

  getTemplate(key: string): { key: string; name: string; subject: string; body: string } | undefined {
    return this.db.prepare("SELECT key, name, subject, body FROM templates WHERE key = ?").get(key) as never;
  }

  listTemplates(): Array<{ key: string; name: string; subject: string; body: string }> {
    return this.db.prepare("SELECT key, name, subject, body FROM templates ORDER BY key").all() as never[];
  }

  upsertTemplate(key: string, name: string, subject: string, body: string): void {
    this.db
      .prepare(
        `INSERT INTO templates (key, name, subject, body) VALUES (?,?,?,?)
         ON CONFLICT(key) DO UPDATE SET name = excluded.name, subject = excluded.subject, body = excluded.body, updated_at = datetime('now')`
      )
      .run(key, name, subject, body);
  }

  // ── Settings ─────────────────────────────────────────────────────────────

  getSetting(key: string, fallback: string): string {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? row.value : fallback;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  allSettings(): Record<string, string> {
    const rows = this.db.prepare("SELECT key, value FROM settings").all() as Array<{ key: string; value: string }>;
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  // ── Notifications (feature 39) ───────────────────────────────────────────

  notify(kind: string, message: string, applicantId: number | null, staffId: number | null = null): void {
    this.db
      .prepare("INSERT INTO notifications (staff_id, applicant_id, kind, message) VALUES (?,?,?,?)")
      .run(staffId, applicantId, kind, message);
  }

  notificationsFor(staffId: number, limit = 50): Array<{ id: number; kind: string; message: string; read: number; at: string; applicant_id: number | null }> {
    return this.db
      .prepare(
        `SELECT id, kind, message, read, at, applicant_id FROM notifications
         WHERE staff_id IS NULL OR staff_id = ?
         ORDER BY id DESC LIMIT ?`
      )
      .all(staffId, limit) as never[];
  }

  unreadCount(staffId: number): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM notifications WHERE (staff_id IS NULL OR staff_id = ?) AND read = 0")
        .get(staffId) as { n: number }
    ).n;
  }

  markNotificationsRead(staffId: number): void {
    this.db.prepare("UPDATE notifications SET read = 1 WHERE staff_id IS NULL OR staff_id = ?").run(staffId);
  }

  // ── SLA / escalation (features 28, 29) ───────────────────────────────────

  escalate(id: number): void {
    this.updateApplicant(id, { priority: "urgent", escalated: 1 });
  }

  overdueCases(): ApplicantRow[] {
    const now = new Date().toISOString();
    return this.db
      .prepare(
        `SELECT * FROM applicants
         WHERE sla_due_at IS NOT NULL AND sla_handled_at IS NULL AND escalated = 0
           AND sla_due_at < ? AND lifecycle IN ('awaiting_review','documents_received','application_received')`
      )
      .all(now) as ApplicantRow[];
  }

  // ── Decision logs ────────────────────────────────────────────────────────

  insertDecisionLog(l: {
    applicant_id: number;
    triggering_email_id: string;
    computed_status: string;
    reasoning: string;
    auto_sent: boolean;
  }): number {
    const res = this.db
      .prepare(
        `INSERT INTO decision_logs (applicant_id, triggering_email_id, computed_status, reasoning, auto_sent)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(l.applicant_id, l.triggering_email_id, l.computed_status, l.reasoning, l.auto_sent ? 1 : 0);
    return Number(res.lastInsertRowid);
  }

  decisionLogs(applicantId?: number): DecisionLogEntry[] {
    const rows = (
      applicantId === undefined
        ? this.db.prepare("SELECT * FROM decision_logs ORDER BY id").all()
        : this.db.prepare("SELECT * FROM decision_logs WHERE applicant_id = ? ORDER BY id").all(applicantId)
    ) as any[];
    return rows.map((r) => ({
      id: r.id,
      applicant_id: r.applicant_id,
      triggering_email_id: r.triggering_email_id,
      computed_status: r.computed_status,
      reasoning: r.reasoning,
      auto_sent: r.auto_sent === 1,
      timestamp: r.timestamp,
    }));
  }

  // ── Idempotency ──────────────────────────────────────────────────────────

  isProcessed(emailId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM processed_emails WHERE email_id = ?").get(emailId);
  }

  markProcessed(emailId: string, threadId: string): void {
    this.db.prepare("INSERT OR IGNORE INTO processed_emails (email_id, thread_id) VALUES (?, ?)").run(emailId, threadId);
  }

  // ── Outbox / human queue ─────────────────────────────────────────────────

  addOutbox(o: { applicant_id: number; to_address: string; subject: string; body: string; mode: "auto" | "queued" }): void {
    this.db
      .prepare("INSERT INTO outbox (applicant_id, to_address, subject, body, mode) VALUES (?, ?, ?, ?, ?)")
      .run(o.applicant_id, o.to_address, o.subject, o.body, o.mode);
  }

  latestOutbox(applicantId: number): { subject: string; body: string; mode: string } | undefined {
    return this.db
      .prepare("SELECT subject, body, mode FROM outbox WHERE applicant_id = ? ORDER BY id DESC LIMIT 1")
      .get(applicantId) as never;
  }

  /** Latest QUEUED draft awaiting a human [Send]/[Edit]/[Discard] decision. */
  queuedOutbox(applicantId: number): { id: number; subject: string; body: string } | undefined {
    return this.db
      .prepare("SELECT id, subject, body FROM outbox WHERE applicant_id = ? AND mode = 'queued' ORDER BY id DESC LIMIT 1")
      .get(applicantId) as never;
  }

  updateOutbox(id: number, subject: string, body: string): void {
    this.db.prepare("UPDATE outbox SET subject = ?, body = ? WHERE id = ?").run(subject, body, id);
  }

  deleteOutbox(id: number): void {
    this.db.prepare("DELETE FROM outbox WHERE id = ?").run(id);
  }

  /** Counters for the Command Center's "TODAY" strip. */
  todayStats(): { emailsToday: number; docsToday: number; completedToday: number } {
    // date('now') is UTC — in UTC+3 the "today" counters would reset at 03:00
    // local. Compute THIS machine's local day boundaries instead.
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start.getTime() + 24 * 3600_000);
    const lo = start.toISOString();
    const hi = end.toISOString();
    const one = (sql: string) => (this.db.prepare(sql).get(lo, hi) as { n: number }).n;
    return {
      emailsToday: one("SELECT COUNT(*) AS n FROM emails WHERE direction = 'in' AND at >= ? AND at < ?"),
      docsToday: one("SELECT COUNT(*) AS n FROM documents WHERE received_at >= ? AND received_at < ?"),
      completedToday: one("SELECT COUNT(*) AS n FROM status_history WHERE to_status = 'completed' AND at >= ? AND at < ?"),
    };
  }

  /** The human work queue (feature 11): cases whose latest decision wasn't auto-resolved. */
  queueView(): Array<ApplicantRow & { computed_status: string; reasoning: string; auto_sent: boolean; decided_at: string; flag_summary: string }> {
    const rows = this.db
      .prepare(
        `SELECT a.*, d.computed_status, d.reasoning, d.auto_sent, d.timestamp AS decided_at
         FROM decision_logs d
         JOIN (SELECT applicant_id, MAX(id) AS max_id FROM decision_logs GROUP BY applicant_id) latest
           ON latest.max_id = d.id
         JOIN applicants a ON a.id = d.applicant_id
         WHERE a.lifecycle NOT IN ('completed','verification')
           AND (
             d.auto_sent = 0
             -- A case whose latest decision auto-sent still needs a human
             -- when a blocking flag is active or a draft is held for approval.
             OR EXISTS (SELECT 1 FROM flags f WHERE f.applicant_id = a.id AND f.active = 1 AND f.type != 'duplicate_submission')
             OR EXISTS (SELECT 1 FROM outbox o WHERE o.applicant_id = a.id AND o.mode = 'queued')
           )
         ORDER BY
           CASE a.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,
           d.id`
      )
      .all() as any[];
    // Flags for the whole page in ONE query (was: one query per row — the
    // queue page and CSV export fired hundreds of statements).
    const flagMap = new Map<number, string>();
    if (rows.length > 0) {
      const flagRows = this.db
        .prepare(
          `SELECT applicant_id, group_concat(DISTINCT type) AS types
           FROM flags
           WHERE active = 1 AND type != 'duplicate_submission' AND applicant_id IN (${rows.map(() => "?").join(",")})
           GROUP BY applicant_id`
        )
        .all(...rows.map((r) => r.id)) as Array<{ applicant_id: number; types: string }>;
      for (const f of flagRows) flagMap.set(f.applicant_id, f.types);
    }
    return rows.map((r) => ({
      ...r,
      auto_sent: r.auto_sent === 1,
      flag_summary: flagMap.get(r.id) ?? "",
    }));
  }

  // ── Search & filters (features 18, 19) ───────────────────────────────────

  searchApplicants(opts: ApplicantSearchQuery): ApplicantRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.q) {
      // Phone matching: compare against the raw column, the digits-only form,
      // and the domestic form (leading 254 shown as 0) so "0700111" finds
      // "+254700111222".
      where.push(
        `(ref_number LIKE ? ESCAPE '\\' OR full_name LIKE ? ESCAPE '\\' OR email_address LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\'
          OR replace(replace(replace(coalesce(phone,''),'+',''),' ',''),'-','') LIKE ? ESCAPE '\\'
          OR (CASE WHEN replace(replace(replace(coalesce(phone,''),'+',''),' ',''),'-','') LIKE '254%'
                   THEN '0' || substr(replace(replace(replace(coalesce(phone,''),'+',''),' ',''),'-',''), 4)
                   ELSE replace(replace(replace(coalesce(phone,''),'+',''),' ',''),'-','')
              END) LIKE ? ESCAPE '\\')`
      );
      // Escape LIKE wildcards — a user-typed "%" must match a literal "%",
      // not the whole table.
      const escaped = opts.q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
      const like = `%${escaped}%`;
      params.push(like, like, like, like, like, like);
    }
    if (opts.programme) {
      where.push("programme = ?");
      params.push(opts.programme);
    }
    if (opts.intake) {
      where.push("intake = ?");
      params.push(opts.intake);
    }
    const now = new Date().toISOString();
    switch (opts.filter) {
      case "awaiting_docs":
        where.push("lifecycle IN ('application_received','documents_received') AND triage = 'Red'");
        break;
      case "human_review":
        where.push("lifecycle = 'awaiting_review'");
        break;
      case "complete":
        where.push("lifecycle IN ('documents_checked','verification','completed')");
        break;
      case "overdue":
        where.push("sla_due_at IS NOT NULL AND sla_handled_at IS NULL AND sla_due_at < ?");
        params.push(now);
        break;
    }
    const sql = `SELECT * FROM applicants ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`;
    params.push(opts.limit ?? 200);
    return this.db.prepare(sql).all(...params) as ApplicantRow[];
  }

  // ── Dashboard analytics (feature 30) ─────────────────────────────────────

  dashboardStats(): Record<string, number | string> {
    const one = (sql: string, p: unknown[] = []) => (this.db.prepare(sql).get(...p) as { n: number }).n;
    const applications = one("SELECT COUNT(*) AS n FROM applicants");
    const documents = one("SELECT COUNT(*) AS n FROM documents WHERE is_duplicate = 0");
    const autoHandled = one("SELECT COUNT(*) AS n FROM decision_logs WHERE auto_sent = 1");
    const humanReview = one("SELECT COUNT(*) AS n FROM applicants WHERE lifecycle = 'awaiting_review'");
    const incomplete = one(
      "SELECT COUNT(*) AS n FROM applicants WHERE lifecycle IN ('application_received','documents_received') AND triage = 'Red'"
    );
    const completed = one("SELECT COUNT(*) AS n FROM applicants WHERE lifecycle = 'completed'");
    const overdue = one(
      "SELECT COUNT(*) AS n FROM applicants WHERE sla_due_at IS NOT NULL AND sla_handled_at IS NULL AND sla_due_at < ? AND lifecycle NOT IN ('completed','verification')",
      [new Date().toISOString()]
    );
    // Avg time from email receipt → automated decision (minutes), last 7 days.
    // (Previously had no date filter and silently averaged all-time.)
    const avgRow = this.db
      .prepare(
        `SELECT AVG((julianday(d.timestamp) - julianday(e.at)) * 24 * 60) AS m
         FROM decision_logs d
         JOIN emails e ON e.message_id = d.triggering_email_id AND e.direction = 'in'
         WHERE d.auto_sent = 1 AND d.timestamp > datetime('now', '-7 days')`
      )
      .get() as { m: number | null };
    const avgResponseMin = avgRow?.m && avgRow.m > 0 ? Math.round(avgRow.m * 10) / 10 : 0;
    // Avg time from queue → first staff action (hours).
    const avgReview = this.db
      .prepare(
        `SELECT AVG((julianday(h.at) - julianday(d.timestamp)) * 24) AS h
         FROM status_history h
         JOIN (SELECT applicant_id, MAX(id) AS max_id FROM decision_logs WHERE auto_sent = 0 GROUP BY applicant_id) dl
           ON dl.applicant_id = h.applicant_id
         JOIN decision_logs d ON d.id = dl.max_id
         WHERE h.actor <> 'system' AND h.at >= d.timestamp`
      )
      .get() as { h: number | null };
    const avgReviewHours = avgReview?.h && avgReview.h > 0 ? Math.round(avgReview.h * 10) / 10 : 0;
    return { applications, documents, autoHandled, humanReview, incomplete, completed, overdue, avgResponseMin, avgReviewHours };
  }

  // ── Export (feature 38) ──────────────────────────────────────────────────

  allApplicants(): ApplicantRow[] {
    return this.db.prepare("SELECT * FROM applicants ORDER BY id").all() as ApplicantRow[];
  }

  // ═══════════════════════════ v3 additions ═══════════════════════════════

  // ── Conversation reconstruction (feature 4): one applicant may span many
  //    threads (phones, forwards, new subjects). The applicant record is the
  //    source of truth; threads are linked to it. ──────────────────────────

  findByEmailAny(emailAddress: string): ApplicantRow | undefined {
    return this.db
      .prepare("SELECT * FROM applicants WHERE email_address = ? ORDER BY id LIMIT 1")
      .get(emailAddress.trim().toLowerCase()) as ApplicantRow | undefined;
  }

  linkThread(applicantId: number, threadId: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO applicant_threads (applicant_id, thread_id) VALUES (?, ?)")
      .run(applicantId, threadId);
  }

  threadsForApplicant(applicantId: number): string[] {
    const rows = this.db
      .prepare("SELECT thread_id FROM applicant_threads WHERE applicant_id = ? ORDER BY rowid")
      .all(applicantId) as Array<{ thread_id: string }>;
    return rows.map((r) => r.thread_id);
  }

  // ── Tasks (feature 25) ───────────────────────────────────────────────────

  addTask(applicantId: number, title: string, staffId: number | null): void {
    this.db.prepare("INSERT INTO tasks (applicant_id, title, staff_id) VALUES (?,?,?)").run(applicantId, title, staffId);
  }

  listTasks(applicantId: number): Array<{ id: number; title: string; done: number; display_name: string | null; created_at: string; done_at: string | null }> {
    return this.db
      .prepare(
        `SELECT t.id, t.title, t.done, t.created_at, t.done_at, u.display_name
         FROM tasks t LEFT JOIN staff_users u ON u.id = t.staff_id
         WHERE t.applicant_id = ? ORDER BY t.done, t.id`
      )
      .all(applicantId) as never[];
  }

  toggleTask(taskId: number, done: boolean): void {
    this.db
      .prepare("UPDATE tasks SET done = ?, done_at = ? WHERE id = ?")
      .run(done ? 1 : 0, done ? new Date().toISOString() : null, taskId);
  }

  // ── Automation config (features 17, 18) ──────────────────────────────────

  automationMode(category: string): "auto" | "draft" {
    const globalDraft = this.getSetting("automation_mode", "auto") === "draft";
    if (globalDraft) return "draft";
    const row = this.db.prepare("SELECT mode FROM automation_config WHERE category = ?").get(category) as { mode: string } | undefined;
    return row?.mode === "draft" ? "draft" : "auto";
  }

  setAutomationMode(category: string, mode: "auto" | "draft"): void {
    this.db
      .prepare(
        "INSERT INTO automation_config (category, mode) VALUES (?, ?) ON CONFLICT(category) DO UPDATE SET mode = excluded.mode"
      )
      .run(category, mode);
  }

  allAutomationConfig(): Array<{ category: string; mode: string }> {
    return this.db.prepare("SELECT category, mode FROM automation_config ORDER BY category").all() as never[];
  }

  /**
   * Re-categorise the latest incoming email of a case (used when triage put
   * an email in the wrong bucket). Returns false when the case has no
   * incoming email yet. The caller is responsible for the audit entry.
   */
  updateLatestEmailCategory(applicantId: number, category: EmailCategory): boolean {
    const info = this.db
      .prepare(
        `UPDATE emails SET category = ?
         WHERE id = (SELECT id FROM emails WHERE applicant_id = ? AND direction = 'in' ORDER BY at DESC, id DESC LIMIT 1)`
      )
      .run(category, applicantId);
    return info.changes > 0;
  }

  /**
   * Listener stats: one row per staff member.
   * - emailsReceived: incoming mail on cases currently assigned to them
   * - emailsSent: replies they personally approved/sent (audit trail)
   * - avgResponseMinutes: mean gap between an incoming email and the next
   *   outgoing reply on their assigned cases
   * - admissionsCompleted: distinct cases they moved to "completed"
   */
  staffStats(): StaffStatsRow[] {
    const staff = this.listStaff();
    const qAssigned = this.db.prepare("SELECT COUNT(*) AS c FROM applicants WHERE assigned_to = ?");
    const qReceived = this.db.prepare(
      `SELECT COUNT(*) AS c FROM emails e
       JOIN applicants a ON a.id = e.applicant_id
       WHERE e.direction = 'in' AND a.assigned_to = ?`
    );
    const qSent = this.db.prepare(
      `SELECT COUNT(*) AS c FROM audit_log
       WHERE actor = ? AND event IN ('email_sent_manual','human_override')`
    );
    const qCompleted = this.db.prepare(
      `SELECT COUNT(DISTINCT applicant_id) AS c FROM status_history
       WHERE actor = ? AND to_status = 'completed'`
    );
    const qAvg = this.db.prepare(
      `SELECT AVG((julianday(o.at) - julianday(i.at)) * 1440.0) AS mins
       FROM emails i
       JOIN applicants a ON a.id = i.applicant_id
       JOIN emails o ON o.applicant_id = i.applicant_id AND o.direction = 'out'
         AND o.at = (SELECT MIN(o2.at) FROM emails o2
                     WHERE o2.applicant_id = i.applicant_id
                       AND o2.direction = 'out' AND o2.at > i.at)
       WHERE i.direction = 'in' AND a.assigned_to = ?`
    );
    return staff.map((s) => {
      const assigned = (qAssigned.get(s.id) as { c: number }).c;
      const received = (qReceived.get(s.id) as { c: number }).c;
      const sent = (qSent.get(s.username) as { c: number }).c;
      const completed = (qCompleted.get(s.username) as { c: number }).c;
      const avg = qAvg.get(s.id) as { mins: number | null };
      return {
        id: s.id,
        username: s.username,
        display_name: s.display_name,
        role: s.role,
        active: s.active,
        assignedCases: assigned,
        emailsReceived: received,
        emailsSent: sent,
        avgResponseMinutes: avg.mins === null || avg.mins === undefined ? null : Math.round(avg.mins),
        admissionsCompleted: completed,
      };
    });
  }

  // ── Intakes with deadlines (features 20, 21) ─────────────────────────────

  listIntakeRows(): Array<{ name: string; deadline: string | null }> {
    return this.db.prepare("SELECT name, deadline FROM intakes ORDER BY rowid").all() as never[];
  }

  addIntakeWithDeadline(name: string, deadline: string | null): void {
    this.db
      .prepare("INSERT INTO intakes (name, deadline) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET deadline = excluded.deadline")
      .run(name, deadline);
  }

  setIntakeDeadline(name: string, deadline: string | null): void {
    this.db.prepare("UPDATE intakes SET deadline = ? WHERE name = ?").run(deadline, name);
  }

  intakeDeadline(intake: string | null): string | null {
    if (!intake) return null;
    const row = this.db.prepare("SELECT deadline FROM intakes WHERE name = ?").get(intake) as { deadline: string | null } | undefined;
    return row?.deadline ?? null;
  }

  // ── Automatic follow-ups (feature 13) ────────────────────────────────────

  /**
   * @param baseAt when set, (re)arms the ladder base date — rung N fires at
   * base + ladder[N] days, so "3,7,10" means Day 3 / Day 7 / Day 10 from the
   * first notice, not stacked intervals.
   */
  setFollowup(applicantId: number, rung: number, nextAt: string | null, baseAt?: string | null): void {
    if (baseAt !== undefined) {
      this.db
        .prepare("UPDATE applicants SET followup_rung = ?, followup_next_at = ?, followup_base_at = ?, updated_at = ? WHERE id = ?")
        .run(rung, nextAt, baseAt, nowIso(), applicantId);
    } else {
      this.db
        .prepare("UPDATE applicants SET followup_rung = ?, followup_next_at = ?, updated_at = ? WHERE id = ?")
        .run(rung, nextAt, nowIso(), applicantId);
    }
  }

  dueFollowUps(now: string): ApplicantRow[] {
    return this.db
      .prepare(
        `SELECT * FROM applicants
         WHERE followup_next_at IS NOT NULL AND followup_next_at <= ?
           AND lifecycle IN ('application_received','documents_received')`
      )
      .all(now) as ApplicantRow[];
  }

  // ── Unanswered email detection (feature 1) ───────────────────────────────

  unansweredCases(): Array<{ applicant: ApplicantRow; lastInAt: string; hours: number }> {
    // Any outgoing email (automated or human) counts as "answered" — that is
    // the specified behavior (a factual auto-reply IS a reply). Batched into
    // one query; previously this ran one query per applicant (N+1).
    const rows = this.db
      .prepare(
        `SELECT a.id AS aid, MAX(e.at) AS last_in
         FROM applicants a
         JOIN emails e ON e.applicant_id = a.id AND e.direction = 'in'
         WHERE a.lifecycle NOT IN ('completed')
         GROUP BY a.id`
      )
      .all() as Array<{ aid: number; last_in: string }>;
    if (rows.length === 0) return [];
    const replies = this.db
      .prepare(
        `SELECT applicant_id, MAX(at) AS last_out
         FROM emails
         WHERE direction = 'out' AND applicant_id IN (${rows.map(() => "?").join(",")})
         GROUP BY applicant_id`
      )
      .all(...rows.map((r) => r.aid)) as Array<{ applicant_id: number; last_out: string }>;
    const lastOut = new Map(replies.map((r) => [r.applicant_id, r.last_out]));
    const out: Array<{ applicant: ApplicantRow; lastInAt: string; hours: number }> = [];
    const now = Date.now();
    for (const r of rows) {
      const outAt = lastOut.get(r.aid);
      if (outAt && outAt >= r.last_in) continue;
      const a = this.getApplicant(r.aid);
      if (!a) continue;
      out.push({ applicant: a, lastInAt: r.last_in, hours: Math.max(0, Math.round((now - new Date(r.last_in).getTime()) / 3600_000)) });
    }
    return out.sort((x, y) => y.hours - x.hours);
  }

  // ── Portal OTP + sessions (features 12, 35) ──────────────────────────────

  createOtp(applicantId: number): string {
    // Math.random() is a predictable PRNG — never for auth codes.
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    this.db.prepare("DELETE FROM portal_otps WHERE applicant_id = ?").run(applicantId);
    this.db
      .prepare("INSERT INTO portal_otps (applicant_id, code, expires_at, attempts) VALUES (?,?,?,0)")
      .run(applicantId, code, new Date(Date.now() + 10 * 60_000).toISOString());
    return code;
  }

  /** Max wrong guesses before a code burns (rate limiting alone is per-IP). */
  private static readonly OTP_MAX_ATTEMPTS = 5;

  consumeOtp(applicantId: number, code: string): boolean {
    const row = this.db
      .prepare("SELECT code, expires_at, attempts FROM portal_otps WHERE applicant_id = ?")
      .get(applicantId) as { code: string; expires_at: string; attempts: number } | undefined;
    if (!row) return false;
    if (new Date(row.expires_at).getTime() < Date.now()) {
      this.db.prepare("DELETE FROM portal_otps WHERE applicant_id = ?").run(applicantId);
      return false;
    }
    if (row.attempts >= Repo.OTP_MAX_ATTEMPTS) {
      // Too many wrong guesses — the code is dead; request a new one.
      this.db.prepare("DELETE FROM portal_otps WHERE applicant_id = ?").run(applicantId);
      return false;
    }
    // Timing-safe compare; codes are equal-length by construction.
    const a = Buffer.from(String(code).trim().padEnd(6, "\0"));
    const b = Buffer.from(row.code.padEnd(6, "\0"));
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!ok) {
      this.db
        .prepare("UPDATE portal_otps SET attempts = attempts + 1 WHERE applicant_id = ?")
        .run(applicantId);
      return false;
    }
    this.db.prepare("DELETE FROM portal_otps WHERE applicant_id = ?").run(applicantId);
    return true;
  }

  createPortalSession(applicantId: number): string {
    const token = crypto.randomBytes(24).toString("hex");
    this.db
      .prepare("INSERT INTO portal_sessions (token, applicant_id, expires_at) VALUES (?,?,?)")
      .run(token, applicantId, new Date(Date.now() + 30 * 60_000).toISOString());
    return token;
  }

  getPortalSession(token: string): ApplicantRow | undefined {
    const row = this.db
      .prepare("SELECT applicant_id, expires_at FROM portal_sessions WHERE token = ?")
      .get(token) as { applicant_id: number; expires_at: string } | undefined;
    if (!row) return undefined;
    if (new Date(row.expires_at).getTime() < Date.now()) return undefined;
    return this.getApplicant(row.applicant_id);
  }

  deletePortalSession(token: string): void {
    this.db.prepare("DELETE FROM portal_sessions WHERE token = ?").run(token);
  }

  // ── Analytics (features 28–31) ───────────────────────────────────────────

  categoryCounts(): Array<{ category: string; n: number }> {
    return this.db
      .prepare(
        `SELECT coalesce(category,'other') AS category, COUNT(*) AS n
         FROM emails WHERE direction = 'in' GROUP BY category ORDER BY n DESC`
      )
      .all() as never[];
  }

  accuracyStats(): Record<string, number> {
    const one = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      greenCases: one("SELECT COUNT(*) AS n FROM decision_logs WHERE computed_status = 'Green'"),
      watcherCatches: one("SELECT COUNT(*) AS n FROM audit_log WHERE event = 'watcher_downgrade'"),
      humanOverrides: one("SELECT COUNT(*) AS n FROM audit_log WHERE event = 'human_override'"),
      sendErrors: one("SELECT COUNT(*) AS n FROM audit_log WHERE event = 'send_failed'"),
      autoSends: one("SELECT COUNT(*) AS n FROM emails WHERE direction = 'out' AND auto = 1"),
      humanSends: one("SELECT COUNT(*) AS n FROM emails WHERE direction = 'out' AND auto = 0"),
      reopened: one("SELECT COUNT(*) AS n FROM audit_log WHERE event = 'case_reopened'"),
    };
  }

  // ── Data retention (feature 38) ──────────────────────────────────────────

  /** Fully remove an applicant's data (used after archiving). */
  deleteApplicantFull(applicantId: number): void {
    const tx = this.db.transaction(() => {
      for (const t of ["documents", "flags", "emails", "notes", "tasks", "decision_logs", "status_history", "audit_log", "outbox", "applicant_threads", "portal_otps", "portal_sessions", "notifications"]) {
        this.db.prepare(`DELETE FROM ${t} WHERE applicant_id = ?`).run(applicantId);
      }
      this.db.prepare("DELETE FROM applicants WHERE id = ?").run(applicantId);
    });
    tx();
  }
}
