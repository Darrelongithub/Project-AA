/**
 * /db/repo — cases/applicants, decisions, lifecycle, audit, notes and tasks. Extracted verbatim from the Repo god class;
 * every function takes the Repo as its first argument and the Repo
 * facade in ../repo.ts delegates to it (same API, same behaviour).
 */
import { Decision, autoDecisionsAllowed } from "../../decisions";
import { ApplicantRow, DecisionLogEntry, EmailCategory, LifecycleStage } from "../../types";
import type { Repo } from "../repo";
import { nowIso } from "./shared";

export function listCases(repo: Repo, organizationId?: number): ApplicantRow[] {
  // `0` is retained as the legacy live-realm selector used by the old
  // dashboard; organization ids are positive and use the canonical path.
  if (organizationId === 0) return repo.allApplicants(0);
  const sql = organizationId === undefined
    ? "SELECT a.* FROM applicants a ORDER BY a.id"
    : "SELECT a.* FROM applicants a WHERE COALESCE(a.organization_id, 1) = ? ORDER BY a.id";
  return (organizationId === undefined ? repo.db.prepare(sql).all() : repo.db.prepare(sql).all(organizationId)) as ApplicantRow[];
}


export function getCase(repo: Repo, id: number): ApplicantRow | undefined { return repo.getApplicant(id); }


export function listCasesForStaff(repo: Repo, staff: { id: number; role: string; organization_id?: number | null }): ApplicantRow[] {
  return repo.listCases(staff.organization_id ?? 1).filter((a) => repo.caseTypeVisibleTo(staff, a) && repo.applicantVisibleTo(staff, a));
}


// ── Reference numbers (feature 1) ────────────────────────────────────────
export function nextRefNumber(repo: Repo, prefix: string, year: number): string {
  const tx = repo.db.transaction(() => {
    repo.db
      .prepare("INSERT OR IGNORE INTO ref_counters (year, last_seq) VALUES (?, 0)")
      .run(year);
    repo.db.prepare("UPDATE ref_counters SET last_seq = last_seq + 1 WHERE year = ?").run(year);
    const { last_seq } = repo.db
      .prepare("SELECT last_seq FROM ref_counters WHERE year = ?")
      .get(year) as { last_seq: number };
    return `${prefix}-${year}-${String(last_seq).padStart(6, "0")}`;
  });
  return tx();
}


export function findByRef(repo: Repo, ref: string): ApplicantRow | undefined {
  return repo.db
    .prepare("SELECT * FROM applicants WHERE ref_number = ? COLLATE NOCASE")
    .get(ref.trim()) as ApplicantRow | undefined;
}


export function getOrCreateApplicant(repo: Repo, 
  emailAddress: string,
  threadId: string,
  opts: { fullName?: string; refPrefix?: string; organizationId?: number; caseTypeCode?: string } = {}
): ApplicantRow {
  const addr = emailAddress.trim().toLowerCase();
  const organizationId = opts.organizationId ?? 1;
  const refPrefix = opts.refPrefix ?? repo.organizationRefPrefix(organizationId);
  // Check-then-insert WITHOUT a transaction races: two parallel first emails
  // from the same sender can both miss the row and one dies on
  // UNIQUE(email_address, thread_id). Insert-or-ignore inside a transaction,
  // then read whatever won.
  const insert = repo.db.prepare(
    `INSERT OR IGNORE INTO applicants (ref_number, email_address, thread_id, full_name)
     VALUES (?, ?, ?, ?)`
  );
  const select = repo.db.prepare(
    "SELECT * FROM applicants WHERE email_address = ? AND thread_id = ?"
  );
  let row: ApplicantRow | undefined;
  let created = false;
  repo.db.transaction(() => {
    const existing = select.get(addr, threadId) as ApplicantRow | undefined;
    if (existing) {
      row = existing;
      return;
    }
    const ref = repo.nextRefNumber(refPrefix, new Date().getFullYear());
    insert.run(ref, addr, threadId, opts.fullName ?? null);
    row = select.get(addr, threadId) as ApplicantRow;
    created = true;
  })();
  // The transaction ran synchronously; row is always set here.
  let applicant = row as ApplicantRow;
  const caseType = opts.caseTypeCode ? repo.getCaseType(opts.caseTypeCode, organizationId) : repo.getCaseType("GENERAL", organizationId);
  if (caseType && (!applicant.organization_id || !applicant.case_type_id)) {
    repo.db.prepare("UPDATE applicants SET organization_id = ?, case_type_id = ? WHERE id = ?")
      .run(organizationId, caseType.id, applicant.id);
    applicant = repo.requireApplicant(applicant.id);
  }
  if (created) {
    repo.audit(applicant.id, "system", "applicant_created", `Case ${applicant.ref_number} opened for ${addr}`);
  }
  return applicant;
}


/** Canonical generic entry point; Applicant terminology is retained only
 * in the compatibility implementation above. */
export function createCase(repo: Repo, input: { emailAddress: string; threadId: string; organizationId?: number; caseTypeCode?: string; fullName?: string; refPrefix?: string }): ApplicantRow {
  return repo.getOrCreateApplicant(input.emailAddress, input.threadId, input);
}


export function getApplicant(repo: Repo, id: number): ApplicantRow | undefined {
  return repo.db.prepare("SELECT * FROM applicants WHERE id = ?").get(id) as ApplicantRow | undefined;
}

/** Typed error: a caller needed an applicant row that is not in the store. */
export class ApplicantNotFoundError extends Error {
  readonly applicantId: number;
  constructor(applicantId: number) {
    super(`applicant ${applicantId} not found (it may have been deleted mid-operation)`);
    this.name = "ApplicantNotFoundError";
    this.applicantId = applicantId;
  }
}

/** getApplicant that throws ApplicantNotFoundError instead of returning undefined. */
export function requireApplicant(repo: Repo, id: number): ApplicantRow {
  const row = getApplicant(repo, id);
  if (!row) throw new ApplicantNotFoundError(id);
  return row;
}


export function updateApplicant(repo: Repo, 
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
      | "queue"
      | "sla_due_at"
      | "sla_handled_at"
      | "escalated"
      | "transfer"
      | "nationality"
      | "req_result"
      | "routing"
      | "routing_reason"
    >
  >
): void {
  // Column names are interpolated into SQL — only ever from repo allow-list,
  // never from caller-provided strings.
  // Decision columns (outcome/admission_decision/admission_route/decision_by/
  // decision_reason/decision_at) are DELIBERATELY absent: outcomes travel
  // only through recordDecision with a genuine Decision (see src/decisions.ts).
  if (
    Object.prototype.hasOwnProperty.call(patch, "admission_decision") ||
    Object.prototype.hasOwnProperty.call(patch, "admission_route") ||
    Object.prototype.hasOwnProperty.call(patch, "decision_by") ||
    Object.prototype.hasOwnProperty.call(patch, "decision_reason") ||
    Object.prototype.hasOwnProperty.call(patch, "decision_at")
  ) {
    throw new Error("updateApplicant: refusing outcome write — use recordDecision with a Decision");
  }
  const ALLOWED = new Set([
    "full_name", "phone", "programme", "intake", "priority", "assigned_to",
    "lifecycle", "triage", "queue", "sla_due_at", "sla_handled_at", "escalated",
    "transfer", "nationality", "req_result", "routing", "routing_reason",
  ]);
  const keys = Object.keys(patch) as Array<keyof typeof patch>;
  if (keys.length === 0) return;
  for (const k of keys) {
    if (!ALLOWED.has(k)) throw new Error(`updateApplicant: refusing unknown column "${k}"`);
  }
  const setSql = keys.map((k) => `${k} = ?`).join(", ");
  const vals = keys.map((k) => patch[k] ?? null);
  repo.db.prepare(`UPDATE applicants SET ${setSql}, updated_at = ? WHERE id = ?`).run(...vals, nowIso(), id);
  if (Object.prototype.hasOwnProperty.call(patch, "programme")) {
    repo.db.prepare("UPDATE applicants SET category = programme WHERE id = ?").run(id);
  }
}


/**
 * THE outcome writer: records a case outcome from a genuine Decision only.
 * Forged/plain-object outcomes throw, and automated decisions throw unless
 * the organization's policy flags allow them (autoDecisionsAllowed — the
 * single enforcement point). Writes both the generic `outcome` and the
 * legacy admissions-vocabulary mirror columns.
 */
export function recordDecision(repo: Repo, id: number, decision: Decision): void {
  if (!Decision.isGenuine(decision)) {
    throw new Error("recordDecision: refusing outcome — not a genuine Decision (use Decision.auto()/Decision.human())");
  }
  if (decision.source === "rules-auto" && !autoDecisionsAllowed(repo, id)) {
    throw new Error("recordDecision: refusing automated decision — organization policy flags do not allow auto-decisions");
  }
  const at = nowIso();
  repo.db.prepare("UPDATE applicants SET outcome = ?, admission_decision = ?, admission_route = ?, decision_by = ?, decision_reason = ?, decision_at = ?, updated_at = ? WHERE id = ?")
    .run(decision.outcome, decision.legacyDecision(), decision.route(), decision.decidedBy, decision.reasoning, at, at, id);
}


export function updateCase(repo: Repo, id: number, patch: { category?: string | null; outcome?: Decision; case_type_id?: number | null }): void {
  const allowed = Object.keys(patch);
  if (allowed.some((key) => !["category", "outcome", "case_type_id"].includes(key))) throw new Error("updateCase: refusing unknown column");
  if (patch.category !== undefined) repo.db.prepare("UPDATE applicants SET category = ? WHERE id = ?").run(patch.category, id);
  if (patch.case_type_id !== undefined) repo.db.prepare("UPDATE applicants SET case_type_id = ? WHERE id = ?").run(patch.case_type_id, id);
  // Outcomes travel only as a genuine Decision (provenance + policy gate).
  if (patch.outcome !== undefined) repo.recordDecision(id, patch.outcome);
}


// ── Lifecycle + status history (features 15, 16) ─────────────────────────
export function setLifecycle(repo: Repo, id: number, to: LifecycleStage, actor: string, reason: string): void {
  const current = repo.getApplicant(id);
  if (!current || current.lifecycle === to) return;
  repo.db
    .prepare("INSERT INTO status_history (applicant_id, from_status, to_status, actor, reason) VALUES (?,?,?,?,?)")
    .run(id, current.lifecycle, to, actor, reason);
  repo.updateApplicant(id, { lifecycle: to });
  repo.audit(id, actor, "status_changed", `${current.lifecycle} → ${to}: ${reason}`);
}


export function statusHistory(repo: Repo, applicantId: number): Array<{ from_status: string; to_status: string; actor: string; reason: string; at: string }> {
  return repo.db
    .prepare("SELECT from_status, to_status, actor, reason, at FROM status_history WHERE applicant_id = ? ORDER BY id")
    .all(applicantId) as never[];
}


// ── Audit log (feature 17) ───────────────────────────────────────────────
export function audit(repo: Repo, applicantId: number | null, actor: string, event: string, detail = ""): void {
  repo.db
    .prepare("INSERT INTO audit_log (applicant_id, actor, event, detail) VALUES (?,?,?,?)")
    .run(applicantId, actor, event, detail);
}


export function auditForApplicant(repo: Repo, applicantId: number): Array<{ at: string; actor: string; event: string; detail: string }> {
  return repo.db
    .prepare("SELECT at, actor, event, detail FROM audit_log WHERE applicant_id = ? ORDER BY id DESC LIMIT 200")
    .all(applicantId) as never[];
}


/** Most recent audit rows, newest first (CSV export). */
export function recentAudit(repo: Repo, limit: number): Array<{ at: string; actor: string; event: string; detail: string; applicant_id: number | null }> {
  return repo.db
    .prepare("SELECT at, actor, event, detail, applicant_id FROM audit_log ORDER BY id DESC LIMIT ?")
    .all(limit) as never[];
}


// ── Notes (feature 34) ───────────────────────────────────────────────────
export function addNote(repo: Repo, applicantId: number, staffId: number | null, body: string): void {
  repo.db.prepare("INSERT INTO notes (applicant_id, staff_id, body) VALUES (?,?,?)").run(applicantId, staffId, body);
}


export function notesForApplicant(repo: Repo, applicantId: number): Array<{ id: number; body: string; at: string; display_name: string | null }> {
  return repo.db
    .prepare(
      `SELECT n.id, n.body, n.at, u.display_name FROM notes n
       LEFT JOIN staff_users u ON u.id = n.staff_id
       WHERE n.applicant_id = ? ORDER BY n.id DESC`
    )
    .all(applicantId) as never[];
}


// ── SLA / escalation (features 28, 29) ───────────────────────────────────
export function escalate(repo: Repo, id: number): void {
  repo.updateApplicant(id, { priority: "urgent", escalated: 1 });
}


export function overdueCases(repo: Repo): ApplicantRow[] {
  const now = new Date().toISOString();
  return repo.db
    .prepare(
      `SELECT * FROM applicants
       WHERE sla_due_at IS NOT NULL AND sla_handled_at IS NULL AND escalated = 0
         AND sla_due_at < ? AND lifecycle IN ('awaiting_review','documents_received','application_received')`
    )
    .all(now) as ApplicantRow[];
}


// ── Decision logs ────────────────────────────────────────────────────────
export function insertDecisionLog(repo: Repo, l: {
  applicant_id: number;
  triggering_email_id: string;
  computed_status: string;
  reasoning: string;
  auto_sent: boolean;
}): number {
  const res = repo.db
    .prepare(
      `INSERT INTO decision_logs (applicant_id, triggering_email_id, computed_status, reasoning, auto_sent)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(l.applicant_id, l.triggering_email_id, l.computed_status, l.reasoning, l.auto_sent ? 1 : 0);
  return Number(res.lastInsertRowid);
}


export function decisionLogs(repo: Repo, applicantId?: number): DecisionLogEntry[] {
  const rows = (
    applicantId === undefined
      ? repo.db.prepare("SELECT * FROM decision_logs ORDER BY id").all()
      : repo.db.prepare("SELECT * FROM decision_logs WHERE applicant_id = ? ORDER BY id").all(applicantId)
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


/** Per-applicant "who approved/completed this file" attribution. */
export function approverFor(repo: Repo, applicantId: number): { actor: string; at: string } | undefined {
  return repo.db
    .prepare(
      `SELECT actor, at FROM status_history WHERE applicant_id = ? AND to_status = 'completed' AND actor != 'system'
       ORDER BY id DESC LIMIT 1`
    )
    .get(applicantId) as { actor: string; at: string } | undefined;
}


// ═══════════════════════════ v3 additions ═══════════════════════════════
// ── Conversation reconstruction (feature 4): one applicant may span many
//    threads (phones, forwards, new subjects). The applicant record is the
//    source of truth; threads are linked to it. ──────────────────────────
export function findByEmailAny(repo: Repo, emailAddress: string, organizationId?: number): ApplicantRow | undefined {
  // DEMO: an explicit organization never matches another tenant's contact.
  if (organizationId !== undefined) {
    return repo.db
      .prepare("SELECT * FROM applicants WHERE email_address = ? AND COALESCE(organization_id, 1) = ? ORDER BY id LIMIT 1")
      .get(emailAddress.trim().toLowerCase(), organizationId) as ApplicantRow | undefined;
  }
  return repo.db
    .prepare("SELECT * FROM applicants WHERE email_address = ? ORDER BY id LIMIT 1")
    .get(emailAddress.trim().toLowerCase()) as ApplicantRow | undefined;
}


export function linkThread(repo: Repo, applicantId: number, threadId: string): void {
  repo.db
    .prepare("INSERT OR IGNORE INTO applicant_threads (applicant_id, thread_id) VALUES (?, ?)")
    .run(applicantId, threadId);
}


export function threadsForApplicant(repo: Repo, applicantId: number): string[] {
  const rows = repo.db
    .prepare("SELECT thread_id FROM applicant_threads WHERE applicant_id = ? ORDER BY rowid")
    .all(applicantId) as Array<{ thread_id: string }>;
  return rows.map((r) => r.thread_id);
}


// ── Tasks (feature 25) ───────────────────────────────────────────────────
export function addTask(repo: Repo, applicantId: number, title: string, staffId: number | null): void {
  repo.db.prepare("INSERT INTO tasks (applicant_id, title, staff_id) VALUES (?,?,?)").run(applicantId, title, staffId);
}


export function listTasks(repo: Repo, applicantId: number): Array<{ id: number; title: string; done: number; display_name: string | null; created_at: string; done_at: string | null }> {
  return repo.db
    .prepare(
      `SELECT t.id, t.title, t.done, t.created_at, t.done_at, u.display_name
       FROM tasks t LEFT JOIN staff_users u ON u.id = t.staff_id
       WHERE t.applicant_id = ? ORDER BY t.done, t.id`
    )
    .all(applicantId) as never[];
}


export function toggleTask(repo: Repo, taskId: number, done: boolean): void {
  repo.db
    .prepare("UPDATE tasks SET done = ?, done_at = ? WHERE id = ?")
    .run(done ? 1 : 0, done ? new Date().toISOString() : null, taskId);
}


/**
 * Re-categorise the latest incoming email of a case (used when triage put
 * an email in the wrong bucket). Returns false when the case has no
 * incoming email yet. The caller is responsible for the audit entry.
 */
export function updateLatestEmailCategory(repo: Repo, applicantId: number, category: EmailCategory): boolean {
  const info = repo.db
    .prepare(
      `UPDATE emails SET category = ?
       WHERE id = (SELECT id FROM emails WHERE applicant_id = ? AND direction = 'in' ORDER BY at DESC, id DESC LIMIT 1)`
    )
    .run(category, applicantId);
  return info.changes > 0;
}


// ── Data retention (feature 38) ──────────────────────────────────────────
/** Fully remove an applicant's data (used after archiving). */
export function deleteApplicantFull(repo: Repo, applicantId: number): void {
  const tx = repo.db.transaction(() => {
    for (const t of ["documents", "flags", "emails", "notes", "tasks", "decision_logs", "status_history", "audit_log", "outbox", "applicant_threads", "notifications", "evaluations"]) {
      repo.db.prepare(`DELETE FROM ${t} WHERE applicant_id = ?`).run(applicantId);
    }
    repo.db.prepare("DELETE FROM applicants WHERE id = ?").run(applicantId);
  });
  tx();
}


// ── Case routing helpers (round 19) ──────────────────────────────────────
/**
 * Open cases for a programme that have NO human owner yet. When a course
 * owner changes, these can flow to the new owner automatically — but a
 * case somebody already picked up is never re-routed behind their back.
 */
export function openUnassignedCasesForProgramme(repo: Repo, programme: string, demo: 0 | 1): ApplicantRow[] {
  // Realm-scoped: an owner change in the live console must never re-route
  // demo cases (and vice versa) — programme codes are shared across realms.
  const rows = repo.db
    .prepare(
      `SELECT * FROM applicants
       WHERE programme = ? AND assigned_to IS NULL AND lifecycle <> 'completed'
         AND IFNULL(demo, 0) = ?
       ORDER BY id`
    )
    .all(programme, demo) as ApplicantRow[];
  return rows;
}


/** Every open case (any programme, any realm) — for bulk re-evaluation. */
export function openApplicantIds(repo: Repo): number[] {
  const rows = repo.db
    .prepare(`SELECT id FROM applicants WHERE lifecycle <> 'completed' ORDER BY id`)
    .all() as Array<{ id: number }>;
  return rows.map((r) => r.id);
}
