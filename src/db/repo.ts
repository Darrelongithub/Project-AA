/**
 * /db — all queries live here. Nothing else in the codebase writes SQL.
 * v2: case management (ref numbers, email history, status history, audit
 * log, notes, staff/sessions, templates, settings, SLAs, notifications,
 * programme/intake-scoped requirements, search, dashboard stats).
 */
import * as crypto from "crypto";
import type { Database } from "better-sqlite3";
import type {
  AdmissionRuleSet,
  AdmissionSystem,
  ApplicantRow,
  Programme,
  Confidence,
  DeadLetter,
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
  RequirementRule,
  RequirementSetEntry,
  RuleNode,
  StaffUser,
  SystemBlock,
  CourseLevel,
} from "../types";
import { documentRequirementsFor, type ApplicantNationality, type ProgrammeLevel } from "../documents/matrix";
import type { VisionCacheStore } from "../extraction/gemini";
import { isValidCachedVision } from "../extraction/gemini";
import type { VisionExtraction } from "../types";

const nowIso = () => new Date().toISOString();

/** Query shape for {@link Repo.searchApplicants} — shared with the web layer. */
export interface ApplicantSearchQuery {
  q?: string;
  filter?: "all" | "awaiting_docs" | "human_review" | "complete" | "overdue";
  programme?: string;
  intake?: string;
  limit?: number;
  /** Realm scope: 0 = live only, 1 = demo only, undefined = all. */
  demo?: number;
  /** OR-8: school visibility scope. null/undefined = unscoped; an empty
   * list matches nothing. */
  schools?: string[] | null;
}

/** Per-staff workload + responsiveness metrics for the Team page. */
export interface StaffStatsRow {
  id: number;
  username: string;
  display_name: string;
  role: string;
  active: number;
  demo: number;
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

  /** How many staff accounts exist (drives the first-run setup gate). */
  staffCount(): number {
    return ((this.db.prepare("SELECT COUNT(*) AS n FROM staff_users").get() as { n: number }).n);
  }

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
        | "transfer"
        | "nationality"
        | "req_result"
        | "routing"
        | "routing_reason"
        | "admission_decision"
        | "admission_route"
        | "decision_by"
        | "decision_reason"
        | "decision_at"
      >
    >
  ): void {
    // Column names are interpolated into SQL — only ever from this allow-list,
    // never from caller-provided strings.
    const ALLOWED = new Set([
      "full_name", "phone", "programme", "intake", "priority", "assigned_to",
      "lifecycle", "triage", "sla_due_at", "sla_handled_at", "escalated",
      "transfer", "nationality", "req_result", "routing", "routing_reason",
      "admission_decision", "admission_route", "decision_by", "decision_reason",
      "decision_at",
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

  listProgrammes(): Programme[] {
    return this.db
      .prepare(
        `SELECT p.code, p.name, p.school, p.entry_requirements, p.owner_id, s.display_name AS owner_name, p.level
         FROM programmes p LEFT JOIN staff_users s ON s.id = p.owner_id
         ORDER BY p.school, p.code`
      )
      .all() as never[];
  }

  programmeByCode(code: string): Programme | undefined {
    return this.db
      .prepare(
        `SELECT p.code, p.name, p.school, p.entry_requirements, p.owner_id, s.display_name AS owner_name, p.level
         FROM programmes p LEFT JOIN staff_users s ON s.id = p.owner_id
         WHERE p.code = ? COLLATE NOCASE`
      )
      .get(code) as Programme | undefined;
  }

  /** Editable catalogue fields (name/school/entry requirements) — Configuration. */
  updateProgramme(code: string, fields: { name?: string; school?: string; entry_requirements?: string }): void {
    const cur = this.db.prepare("SELECT name, school, entry_requirements FROM programmes WHERE code = ?").get(code) as
      | { name: string; school: string; entry_requirements: string }
      | undefined;
    if (!cur) return;
    this.db
      .prepare("UPDATE programmes SET name = ?, school = ?, entry_requirements = ? WHERE code = ?")
      .run(
        fields.name?.trim() || cur.name,
        fields.school !== undefined ? fields.school.trim() || cur.school : cur.school,
        fields.entry_requirements !== undefined ? fields.entry_requirements.trim() : cur.entry_requirements,
        code
      );
  }

  /** Courses are worked by people: a new case lands with its course's owner. */
  ownerOfProgramme(code: string | null): number | null {
    if (!code) return null;
    // The join on active staff matters: a deactivated officer must never
    // receive freshly routed cases (or the notifications that come with them).
    const row = this.db
      .prepare(
        `SELECT p.owner_id FROM programmes p
         JOIN staff_users s ON s.id = p.owner_id AND s.active = 1
         WHERE p.code = ? COLLATE NOCASE`
      )
      .get(code) as { owner_id: number | null } | undefined;
    return row?.owner_id ?? null;
  }

  addProgramme(code: string, name: string, school = "", entry = "", level: CourseLevel = "degree"): void {
    this.db
      .prepare(
        `INSERT INTO programmes (code, name, school, entry_requirements, level) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(code) DO UPDATE SET name = excluded.name,
           school = CASE WHEN programmes.school = '' THEN excluded.school ELSE programmes.school END,
           entry_requirements = CASE WHEN programmes.entry_requirements = '' THEN excluded.entry_requirements ELSE programmes.entry_requirements END,
           level = excluded.level`
      )
      .run(code.toUpperCase(), name, school, entry, level);
  }

  /** Assign (or unassign, with null) the staff member who handles a course. */
  assignProgrammeOwner(code: string, staffId: number | null): void {
    this.db.prepare("UPDATE programmes SET owner_id = ? WHERE code = ?").run(staffId, code);
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
  private upsertRuleRow(programme: string | null, intake: string | null, documentType: string, required: boolean, meanGrade: string | null, subjectGrades: string | null): void {
    this.db
      .prepare("DELETE FROM requirement_rules WHERE programme IS ? AND intake IS ? AND document_type = ?")
      .run(programme, intake, documentType);
    this.db
      .prepare("INSERT INTO requirement_rules (programme, intake, document_type, required, mean_grade, subject_grades) VALUES (?,?,?,?,?,?)")
      .run(programme, intake, documentType, required ? 1 : 0, meanGrade, subjectGrades);
  }

  seedBaseRequirements(entries: RequirementSetEntry[]): void {
    const tx = this.db.transaction(() => {
      for (const e of entries) {
        this.upsertRuleRow(null, null, e.document_type, e.required, e.meanGrade ?? null, e.subjectGrades ?? null);
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
      meanGrade: r.mean_grade ?? null,
      subjectGrades: r.subject_grades ?? null,
    }));
  }

  upsertRule(rule: { programme: string | null; intake: string | null; document_type: DocType; required: boolean; meanGrade?: string | null; subjectGrades?: string | null }): void {
    // See seedBaseRequirements: ON CONFLICT cannot see NULL programme/intake,
    // so upsert is delete-then-insert with IS-matching.
    this.db.transaction(() => {
      this.upsertRuleRow(rule.programme, rule.intake, rule.document_type, rule.required, rule.meanGrade ?? null, rule.subjectGrades ?? null);
    })();
  }

  deleteRule(id: number): void {
    this.db.prepare("DELETE FROM requirement_rules WHERE id = ?").run(id);
  }

  // ── Structured entry requirements (per qualification system) ──────────────

  private rowToBlock(r: Record<string, unknown>): SystemBlock {
    let subjects: SystemBlock["subjects"] = [];
    if (typeof r.subjects === "string" && r.subjects) {
      try { subjects = JSON.parse(r.subjects) as NonNullable<SystemBlock["subjects"]>; } catch { subjects = []; }
    }
    return {
      system: String(r.system) as SystemBlock["system"],
      enabled: r.enabled === 1,
      overall: (r.overall as string | null) ?? null,
      minCredits: (r.min_credits as number | null) ?? null,
      minPrincipals: (r.min_principals as number | null) ?? null,
      minSubsidiaries: (r.min_subsidiaries as number | null) ?? null,
      minPoints: (r.min_points as number | null) ?? null,
      minGpa: (r.min_gpa as number | null) ?? null,
      minClass: (r.min_class as string | null) ?? null,
      subjects,
    };
  }

  listSystemBlocks(programme: string | null): Array<SystemBlock & { level: string }> {
    const rows = this.db
      .prepare("SELECT * FROM course_requirements WHERE programme IS ? ORDER BY system")
      .all(programme) as Array<Record<string, unknown>>;
    return rows.map((r) => ({ ...this.rowToBlock(r), level: String(r.level) }));
  }

  /** Delete-then-insert (NULL programme cannot take part in ON CONFLICT). */
  upsertSystemBlock(programme: string | null, level: CourseLevel, block: SystemBlock): void {
    this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM course_requirements WHERE programme IS ? AND level = ? AND system = ?")
        .run(programme, level, block.system);
      this.db
        .prepare(
          `INSERT INTO course_requirements
           (programme, level, system, enabled, overall, min_credits, min_principals, min_subsidiaries, min_points, min_gpa, min_class, subjects)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          programme, level, block.system, block.enabled ? 1 : 0,
          block.overall ?? null, block.minCredits ?? null, block.minPrincipals ?? null,
          block.minSubsidiaries ?? null, block.minPoints ?? null, block.minGpa ?? null,
          block.minClass ?? null, JSON.stringify(block.subjects ?? [])
        );
    })();
  }

  deleteSystemBlock(programme: string | null, system: string, level?: CourseLevel): void {
    if (programme === null) {
      this.db
        .prepare("DELETE FROM course_requirements WHERE programme IS NULL AND level = ? AND system = ?")
        .run(level ?? "degree", system);
    } else {
      this.db
        .prepare("DELETE FROM course_requirements WHERE programme IS ? AND system = ?")
        .run(programme, system);
    }
  }

  /**
   * Effective entry-requirement blocks for a course: the course's own block
   * for a system wins; otherwise the university-wide default for the course's
   * level applies. Unknown programmes fall back to the degree defaults.
   */
  resolveBlocks(programme: string | null): SystemBlock[] {
    const row = programme
      ? (this.db.prepare("SELECT level FROM programmes WHERE code = ?").get(programme.toUpperCase()) as { level?: string } | undefined)
      : undefined;
    const level = (row?.level ?? "degree") as CourseLevel;
    const base = this.listSystemBlocks(null).filter((b) => b.level === level);
    const course = programme ? this.listSystemBlocks(programme.toUpperCase()) : [];
    const merged = new Map<string, SystemBlock>();
    for (const b of base) merged.set(b.system, b);
    for (const b of course) merged.set(b.system, b);
    return [...merged.values()];
  }

  /** Structured blocks as they apply to THIS applicant (snapshot wins). */
  effectiveBlocks(a: ApplicantRow): SystemBlock[] {
    if (a.requirements_structured) {
      try {
        return JSON.parse(a.requirements_structured) as SystemBlock[];
      } catch {
        this.audit(a.id, "system", "structured_snapshot_corrupt",
          "frozen structured requirements failed to parse — fell back to live rules; human should verify");
      }
    }
    return this.resolveBlocks(a.programme);
  }

  /** Freeze the current structured blocks onto the applicant on first triage. */
  freezeStructuredSnapshot(a: ApplicantRow): void {
    if (a.requirements_structured) return;
    const blocks = this.resolveBlocks(a.programme);
    this.db
      .prepare("UPDATE applicants SET requirements_structured = ? WHERE id = ?")
      .run(JSON.stringify(blocks), a.id);
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
    return this.resolveRequirements(a.programme, a.intake, {
      transfer: a.transfer === 1,
      nationality: (a as { nationality?: string | null }).nationality ?? null,
    });
  }

  /** Freeze the current requirement set onto the applicant on first triage.
   * effectiveRequirements (not raw resolveRequirements) so applicant-level
   * additions — like the credit transfer form for transfer applicants — are
   * captured in the frozen set too. */
  freezeRequirementsSnapshot(a: ApplicantRow): void {
    if (a.requirements_snapshot) return;
    const snapshot = this.effectiveRequirements(a);
    this.db
      .prepare("UPDATE applicants SET requirements_snapshot = ? WHERE id = ?")
      .run(JSON.stringify(snapshot), a.id);
  }

  /**
   * OR-5: document requirements come from the DETERMINISTIC generator
   * (level × curriculum × nationality × route + KCPE constant), sourced from
   * the official application-form checklist. The legacy requirement_rules
   * table is no longer read — requirements are not staff-configurable.
   */
  resolveRequirements(
    programme: string | null,
    _intake: string | null,
    opts?: { transfer?: boolean; nationality?: string | null }
  ): RequirementSetEntry[] {
    const p = programme ? this.programmeByCode(programme) : undefined;
    // CourseLevel "postgrad" maps onto the matrix's "masters" tier (the
    // PhD tier applies only to programmes explicitly recorded as PhD).
    const rawLevel = (p?.level ?? "degree") as string;
    // legacy "postgrad" rows behave as masters until the migration rewrites them
    const level: ProgrammeLevel = rawLevel === "postgrad" ? "masters" : (rawLevel as ProgrammeLevel);
    const nationality: ApplicantNationality =
      opts?.nationality === "kenyan" || opts?.nationality === "international" ? opts.nationality : "unknown";
    return this.applyCourseDocOverrides(programme, documentRequirementsFor({
      level,
      route: opts?.transfer ? "transfer" : "fresh",
      nationality,
      programmeCode: programme,
    }).map((spec) => ({ document_type: spec.document_type, required: spec.required })));
  }

  /**
   * Round 3 — per-course document configuration. The generated matrix stays
   * the default; once a course is explicitly configured, REQUIRED entries
   * outside the configured set drop out and configured types missing from
   * the matrix are added as plain required entries. Conditional
   * (required:false) entries are never touched — they are asked for, never
   * assumed, exactly as before.
   */
  private applyCourseDocOverrides(programme: string | null, entries: RequirementSetEntry[]): RequirementSetEntry[] {
    if (!programme) return entries;
    const configured = this.courseDocConfig(programme);
    if (configured === null) return entries; // not configured → generated defaults
    const kept = entries.filter((e) => !e.required || configured.has(e.document_type));
    const known = new Set(entries.map((e) => e.document_type));
    const added: RequirementSetEntry[] = [...configured]
      .filter((t) => !known.has(t as DocType))
      .sort()
      .map((t) => ({ document_type: t as DocType, required: true }));
    return [...kept, ...added];
  }

  /**
   * The explicitly configured required document types for a course — or
   * null when the course is unconfigured (generated matrix defaults apply).
   */
  courseDocConfig(programme: string): Set<DocType> | null {
    const rows = this.db
      .prepare("SELECT document_type FROM course_doc_requirements WHERE programme = ?")
      .all(programme.toUpperCase()) as Array<{ document_type: string }>;
    if (rows.length === 0) return null;
    return new Set(rows.map((r) => r.document_type as DocType));
  }

  /** Save a course's configured required document types (replaces the set). */
  saveCourseDocConfig(programme: string, types: DocType[]): void {
    const code = programme.toUpperCase();
    this.db.prepare("DELETE FROM course_doc_requirements WHERE programme = ?").run(code);
    const ins = this.db.prepare("INSERT OR IGNORE INTO course_doc_requirements (programme, document_type) VALUES (?, ?)");
    for (const t of new Set(types)) ins.run(code, t);
  }

  /** Remove a course's configuration — it falls back to the matrix defaults. */
  deleteCourseDocConfig(programme: string): void {
    this.db.prepare("DELETE FROM course_doc_requirements WHERE programme = ?").run(programme.toUpperCase());
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
    confidence_score?: number;
    received_at: string;
    sha256?: string;
    is_duplicate?: boolean;
    duplicate_of?: number | null;
    extraction_note?: string;
  }): number {
    const res = this.db
      .prepare(
        `INSERT INTO documents
           (applicant_id, document_type, source_email_id, extraction_method,
            extracted_text, extracted_fields, confidence, confidence_score, received_at,
            sha256, is_duplicate, duplicate_of, extraction_note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        d.applicant_id,
        d.document_type,
        d.source_email_id,
        d.extraction_method,
        d.extracted_text,
        JSON.stringify(d.extracted_fields ?? {}),
        d.confidence,
        d.confidence_score ?? 0,
        d.received_at,
        d.sha256 ?? null,
        d.is_duplicate ? 1 : 0,
        d.duplicate_of ?? null,
        d.extraction_note ?? ""
      );
    return Number(res.lastInsertRowid);
  }

  /**
   * Re-score a document after cross-document consistency checks (confidence
   * v2): the score, tier and the human-readable note travel together.
   */
  updateDocumentConfidence(
    docId: number,
    patch: { confidence?: Confidence; confidence_score?: number; extraction_note?: string }
  ): void {
    const sets: string[] = [];
    const args: unknown[] = [];
    if (patch.confidence !== undefined) { sets.push("confidence = ?"); args.push(patch.confidence); }
    if (patch.confidence_score !== undefined) { sets.push("confidence_score = ?"); args.push(patch.confidence_score); }
    if (patch.extraction_note !== undefined) { sets.push("extraction_note = ?"); args.push(patch.extraction_note); }
    if (!sets.length) return;
    this.db.prepare(`UPDATE documents SET ${sets.join(", ")} WHERE id = ?`).run(...args, docId);
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
    // The row's JSON is OURS, but a corrupt DB must degrade one document —
    // never take down every listDocuments() call in the system.
    let extractedFields: Record<string, unknown> = {};
    try {
      extractedFields = JSON.parse(r.extracted_fields || "{}");
    } catch {
      extractedFields = {};
    }
    return {
      id: r.id,
      applicant_id: r.applicant_id,
      document_type: r.document_type,
      source_email_id: r.source_email_id,
      extraction_method: r.extraction_method,
      extracted_text: r.extracted_text,
      extracted_fields: extractedFields,
      confidence: r.confidence,
      confidence_score: r.confidence_score ?? 0,
      superseded_by: r.superseded_by,
      received_at: r.received_at,
      sha256: r.sha256 ?? undefined,
      is_duplicate: r.is_duplicate,
      duplicate_of: r.duplicate_of,
      extraction_note: r.extraction_note ?? "",
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

  insertEmail(e: Omit<EmailRecord, "id" | "attachments"> & { channel?: string; attachments?: string[] }): number {
    const res = this.db
      .prepare(
        `INSERT INTO emails (applicant_id, message_id, thread_id, direction, from_addr, to_addr, subject, body, category, auto, channel, at, attachments)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        e.at,
        e.attachments && e.attachments.length ? JSON.stringify(e.attachments) : ""
      );
    return Number(res.lastInsertRowid);
  }

  /** Parse the stored attachment list; tolerant of legacy empty rows. */
  parseAttachmentList(raw: string | null | undefined): string[] {
    if (!raw) return [];
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v.map((x) => String(x)) : [];
    } catch {
      return [];
    }
  }

  /** Active document count per applicant — ONE query for every export. */
  documentCountsByApplicant(): Map<number, number> {
    const rows = this.db
      .prepare(
        `SELECT applicant_id AS id, COUNT(*) AS n FROM documents WHERE superseded_by IS NULL AND is_duplicate = 0 GROUP BY applicant_id`
      )
      .all() as Array<{ id: number; n: number }>;
    return new Map(rows.map((r) => [r.id, r.n]));
  }

  /** Distinct active flag types per applicant — ONE query for every export. */
  activeFlagTypesByApplicant(): Map<number, string[]> {
    const rows = this.db
      .prepare(`SELECT applicant_id AS id, type FROM flags WHERE active = 1 ORDER BY applicant_id, type`)
      .all() as Array<{ id: number; type: string }>;
    const out = new Map<number, string[]>();
    for (const r of rows) {
      const list = out.get(r.id) ?? [];
      if (!list.includes(r.type)) list.push(r.type);
      out.set(r.id, list);
    }
    return out;
  }

  emailsForApplicant(applicantId: number): EmailRecord[] {
    return this.db
      .prepare("SELECT * FROM emails WHERE applicant_id = ? ORDER BY at, id")
      .all(applicantId) as EmailRecord[];
  }

  // ── Mail window (Gmail-style): conversations grouped by thread ────────────
  /** A thread key groups a conversation; emails without a thread_id form a
   *  singleton conversation keyed by their own id. */
  static threadKeySql(alias: string): string {
    return `COALESCE(NULLIF(${alias}.thread_id, ''), 'email-' || ${alias}.id)`;
  }

  /**
   * Conversation list for the mail window: one row per thread (the latest
   * email), with message count and unread count. Scoped by school, realm-
   * filtered by demo, optionally searched and limited to unread threads.
   * One aggregate query — no N+1.
   */
  /** Gmail folders. bin/spam are exclusive — a conversation there is hidden
   *  from every other folder until restored. */
  static MAIL_FOLDER_WHERE: Record<string, string> = {
    inbox: "agg.in_n > 0 AND agg.spam_n = 0 AND agg.bin_n = 0",
    starred: "agg.star_n > 0 AND agg.spam_n = 0 AND agg.bin_n = 0",
    important: "agg.imp_n > 0 AND agg.spam_n = 0 AND agg.bin_n = 0",
    sent: "agg.out_n > 0 AND agg.spam_n = 0 AND agg.bin_n = 0",
    all: "agg.spam_n = 0 AND agg.bin_n = 0",
    spam: "agg.spam_n > 0 AND agg.bin_n = 0",
    bin: "agg.bin_n > 0",
  };

  mailThreads(opts: {
    schools?: string[] | null; demo?: number; q?: string; unreadOnly?: boolean; limit?: number; folder?: string;
  }): Array<EmailRecord & { tkey: string; thread_n: number; unread_n: number; star_n: number; imp_n: number; a_name: string | null; a_email: string; ref_number: string; programme: string | null; lifecycle: string }> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.demo !== undefined) { where.push("a.demo = ?"); params.push(opts.demo); }
    const scope = this.scopePred("a", opts.schools);
    if (scope.sql) { where.push(scope.sql.replace(/^ AND /, "")); params.push(...scope.params); }
    if (opts.q) {
      const escaped = opts.q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
      const like = `%${escaped}%`;
      where.push(`(e.subject LIKE ? ESCAPE '\\' OR e.body LIKE ? ESCAPE '\\' OR a.full_name LIKE ? ESCAPE '\\' OR a.email_address LIKE ? ESCAPE '\\' OR a.ref_number LIKE ? ESCAPE '\\')`);
      params.push(like, like, like, like, like);
    }
    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
    const folder = Repo.MAIL_FOLDER_WHERE[opts.folder ?? "inbox"] ?? Repo.MAIL_FOLDER_WHERE.inbox;
    const unreadOnly = opts.unreadOnly ? " AND agg.unread_n > 0" : "";
    const sql = `
      WITH keyed AS (
        SELECT e.*, COALESCE(NULLIF(e.thread_id, ''), 'email-' || e.id) AS tkey,
               a.full_name AS a_name, a.email_address AS a_email, a.ref_number AS ref_number,
               a.programme AS programme, a.lifecycle AS lifecycle
        FROM emails e JOIN applicants a ON a.id = e.applicant_id
        ${whereSql}
      ),
      agg AS (
        SELECT tkey, MAX(id) AS last_id, MAX(at) AS last_at, COUNT(*) AS n,
               SUM(CASE WHEN direction = 'in' THEN 1 ELSE 0 END) AS in_n,
               SUM(CASE WHEN direction = 'out' THEN 1 ELSE 0 END) AS out_n,
               SUM(CASE WHEN direction = 'in' AND read = 0 THEN 1 ELSE 0 END) AS unread_n,
               SUM(CASE WHEN labels LIKE '%"starred"%' THEN 1 ELSE 0 END) AS star_n,
               SUM(CASE WHEN labels LIKE '%"important"%' THEN 1 ELSE 0 END) AS imp_n,
               SUM(CASE WHEN labels LIKE '%"spam"%' THEN 1 ELSE 0 END) AS spam_n,
               SUM(CASE WHEN labels LIKE '%"bin"%' THEN 1 ELSE 0 END) AS bin_n
        FROM keyed GROUP BY tkey
      )
      SELECT k.*, agg.n AS thread_n, agg.unread_n AS unread_n, agg.star_n AS star_n, agg.imp_n AS imp_n
      FROM agg JOIN keyed k ON k.id = agg.last_id
      WHERE ${folder}${unreadOnly}
      ORDER BY agg.last_at DESC, k.id DESC LIMIT ?`;
    params.push(opts.limit ?? 100);
    return this.db.prepare(sql).all(...params) as never[];
  }

  /** Every email in one conversation, oldest first. */
  emailsForThread(tkey: string): EmailRecord[] {
    return this.db
      .prepare(`SELECT e.* FROM emails e WHERE ${Repo.threadKeySql("e")} = ? ORDER BY e.at, e.id`)
      .all(tkey) as EmailRecord[];
  }

  /** Opening a conversation reads its incoming mail. */
  markThreadRead(tkey: string): void {
    this.db
      .prepare(`UPDATE emails SET read = 1 WHERE direction = 'in' AND ${Repo.threadKeySql("emails")} = ?`)
      .run(tkey);
  }

  /** Marking a conversation unread returns it to the Unread filter. */
  markThreadUnread(tkey: string): void {
    this.db
      .prepare(`UPDATE emails SET read = 0 WHERE direction = 'in' AND ${Repo.threadKeySql("emails")} = ?`)
      .run(tkey);
  }

  /** Sidebar counts per folder (conversations), one aggregate query. */
  mailFolderCounts(opts: { schools?: string[] | null; demo?: number }): Record<string, number> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.demo !== undefined) { where.push("a.demo = ?"); params.push(opts.demo); }
    const scope = this.scopePred("a", opts.schools);
    if (scope.sql) { where.push(scope.sql.replace(/^ AND /, "")); params.push(...scope.params); }
    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
    const row = this.db.prepare(`
      WITH keyed AS (
        SELECT e.direction, e.read, e.labels,
               COALESCE(NULLIF(e.thread_id, ''), 'email-' || e.id) AS tkey
        FROM emails e JOIN applicants a ON a.id = e.applicant_id
        ${whereSql}
      ),
      agg AS (
        SELECT tkey,
               SUM(CASE WHEN direction = 'in' THEN 1 ELSE 0 END) AS in_n,
               SUM(CASE WHEN direction = 'out' THEN 1 ELSE 0 END) AS out_n,
               SUM(CASE WHEN direction = 'in' AND read = 0 THEN 1 ELSE 0 END) AS unread_n,
               SUM(CASE WHEN labels LIKE '%"starred"%' THEN 1 ELSE 0 END) AS star_n,
               SUM(CASE WHEN labels LIKE '%"important"%' THEN 1 ELSE 0 END) AS imp_n,
               SUM(CASE WHEN labels LIKE '%"spam"%' THEN 1 ELSE 0 END) AS spam_n,
               SUM(CASE WHEN labels LIKE '%"bin"%' THEN 1 ELSE 0 END) AS bin_n
        FROM keyed GROUP BY tkey
      )
      SELECT
        SUM(CASE WHEN in_n > 0 AND spam_n = 0 AND bin_n = 0 THEN 1 ELSE 0 END) AS inbox,
        SUM(CASE WHEN in_n > 0 AND spam_n = 0 AND bin_n = 0 AND unread_n > 0 THEN 1 ELSE 0 END) AS unread,
        SUM(CASE WHEN star_n > 0 AND spam_n = 0 AND bin_n = 0 THEN 1 ELSE 0 END) AS starred,
        SUM(CASE WHEN imp_n > 0 AND spam_n = 0 AND bin_n = 0 THEN 1 ELSE 0 END) AS important,
        SUM(CASE WHEN out_n > 0 AND spam_n = 0 AND bin_n = 0 THEN 1 ELSE 0 END) AS sent,
        SUM(CASE WHEN spam_n = 0 AND bin_n = 0 THEN 1 ELSE 0 END) AS all_mail,
        SUM(CASE WHEN spam_n > 0 AND bin_n = 0 THEN 1 ELSE 0 END) AS spam,
        SUM(CASE WHEN bin_n > 0 THEN 1 ELSE 0 END) AS bin
      FROM agg`).get(...params) as Record<string, number>;
    return { inbox: row.inbox ?? 0, unread: row.unread ?? 0, starred: row.starred ?? 0, important: row.important ?? 0, sent: row.sent ?? 0, all: row.all_mail ?? 0, spam: row.spam ?? 0, bin: row.bin ?? 0 };
  }

  /**
   * Apply/remove a label on every message of a conversation (gmail semantics:
   * labels live on the conversation). Restore = strip bin AND spam so the
   * conversation lands back in Inbox/Sent exactly where it came from.
   */
  setThreadLabel(tkey: string, label: string, on: boolean): void {
    const rows = this.emailsForThread(tkey);
    const update = this.db.prepare("UPDATE emails SET labels = ? WHERE id = ?");
    for (const e of rows) {
      let arr: string[] = [];
      try { arr = JSON.parse(e.labels || "[]") as string[]; } catch { arr = []; }
      const set = new Set(arr.filter((x) => typeof x === "string"));
      if (label === "restore") { set.delete("bin"); set.delete("spam"); }
      else if (on) set.add(label);
      else set.delete(label);
      update.run(JSON.stringify([...set].sort()), e.id);
    }
  }

  /** Aggregate label state of a conversation (any message labelled = labelled). */
  threadLabelState(tkey: string): { starred: boolean; important: boolean; spam: boolean; bin: boolean } {
    const rows = this.emailsForThread(tkey);
    const has = (l: string) => rows.some((e) => (e.labels || "").includes(`"${l}"`));
    return { starred: has("starred"), important: has("important"), spam: has("spam"), bin: has("bin") };
  }

  // ── Staff users & sessions (features 31, 32) ─────────────────────────────

  createStaff(username: string, displayName: string, passwordHash: string, role: string, demo = false): void {
    this.db
      .prepare(
        "INSERT INTO staff_users (username, display_name, password_hash, role, demo) VALUES (?,?,?,?,?)"
      )
      .run(username, displayName, passwordHash, role, demo ? 1 : 0);
  }

  /** Rename an account (e.g. giving the demo admin a human name). */
  setStaffDisplayName(id: number, displayName: string): void {
    this.db.prepare("UPDATE staff_users SET display_name = ? WHERE id = ?").run(displayName, id);
  }

  getStaffByUsername(username: string): (StaffUser & { password_hash: string }) | undefined {
    return this.db
      .prepare("SELECT id, username, display_name, password_hash, role, active, demo FROM staff_users WHERE username = ?")
      .get(username) as never;
  }

  getStaff(id: number): StaffUser | undefined {
    return this.db
      .prepare("SELECT id, username, display_name, role, active, demo FROM staff_users WHERE id = ?")
      .get(id) as StaffUser | undefined;
  }

  listStaff(): StaffUser[] {
    return this.db
      .prepare("SELECT id, username, display_name, role, active, demo FROM staff_users ORDER BY id")
      .all() as StaffUser[];
  }

  setStaffUsername(id: number, username: string): void {
    this.db.prepare("UPDATE staff_users SET username = ? WHERE id = ?").run(username, id);
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
                u.display_name AS display_name, u.role AS role, u.active AS active, u.demo AS demo
         FROM sessions s JOIN staff_users u ON u.id = s.staff_id
         WHERE s.token = ?`
      )
      .get(token) as any;
    if (!row) return undefined;
    if (new Date(row.expires_at).getTime() < Date.now() || row.active !== 1) return undefined;
    return {
      csrf: row.csrf,
      staff: { id: row.id, username: row.username, display_name: row.display_name, role: row.role, active: row.active, demo: row.demo },
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

  getTemplate(key: string): { key: string; name: string; subject: string; body: string; include_banner: number; attach_pack: string } | undefined {
    return this.db.prepare("SELECT key, name, subject, body, include_banner, attach_pack FROM templates WHERE key = ?").get(key) as never;
  }

  listTemplates(): Array<{ key: string; name: string; subject: string; body: string; include_banner: number; attach_pack: string }> {
    return this.db.prepare("SELECT key, name, subject, body, include_banner, attach_pack FROM templates ORDER BY key").all() as never[];
  }

  /** OR-7: attachPack ("none" | "application" | "admission") controls which
   * official pack PDF set goes out with this template; undefined leaves the
   * stored flag untouched. */
  upsertTemplate(key: string, name: string, subject: string, body: string, includeBanner?: boolean, attachPack?: string): void {
    const pack = attachPack === undefined ? null : ["none", "application", "admission"].includes(attachPack) ? attachPack : "none";
    this.db
      .prepare(
        `INSERT INTO templates (key, name, subject, body, include_banner, attach_pack) VALUES (?,?,?,?,?,?)
         ON CONFLICT(key) DO UPDATE SET name = excluded.name, subject = excluded.subject, body = excluded.body,
           include_banner = COALESCE(?, templates.include_banner),
           attach_pack = COALESCE(?, templates.attach_pack), updated_at = datetime('now')`
      )
      .run(key, name, subject, body, includeBanner === undefined ? 1 : includeBanner ? 1 : 0, pack ?? "none",
        includeBanner === undefined ? null : includeBanner ? 1 : 0, pack);
  }

  setTemplateBanner(key: string, include: boolean): void {
    this.db.prepare("UPDATE templates SET include_banner = ? WHERE key = ?").run(include ? 1 : 0, key);
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

  /**
   * Realm separation: a notification about a demo applicant is only ever
   * shown to demo accounts, and vice versa (broadcasts without an applicant
   * are visible to everyone).
   */
  notificationsFor(staffId: number, limit = 50, demo?: number, schools?: string[] | null): Array<{ id: number; kind: string; message: string; read: number; at: string; applicant_id: number | null }> {
    const realmSql = demo === undefined ? "" : " AND (n.applicant_id IS NULL OR a.demo = ?)";
    // OR-8: scoped staff never see alerts about cases outside their schools
    // (broadcast alerts without an applicant stay visible to everyone).
    const scope = this.scopePred("a", schools);
    const scopeSql = scope.sql ? ` AND (n.applicant_id IS NULL OR 1=1${scope.sql})` : "";
    const params: unknown[] = demo === undefined ? [staffId, limit] : [staffId, demo, limit];
    return this.db
      .prepare(
        `SELECT n.id AS id, n.kind AS kind, n.message AS message, n.read AS read, n.at AS at, n.applicant_id AS applicant_id
         FROM notifications n LEFT JOIN applicants a ON a.id = n.applicant_id
         WHERE (n.staff_id IS NULL OR n.staff_id = ?)${realmSql}${scopeSql}
         ORDER BY n.id DESC LIMIT ?`
      )
      .all(demo === undefined ? [params[0], ...scope.params, params[1]] : [params[0], params[1], ...scope.params, params[2]]) as never[];
  }

  unreadCount(staffId: number, demo?: number): number {
    const realmSql = demo === undefined ? "" : " AND (n.applicant_id IS NULL OR a.demo = ?)";
    const params: unknown[] = demo === undefined ? [staffId] : [staffId, demo];
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM notifications n LEFT JOIN applicants a ON a.id = n.applicant_id
           WHERE (n.staff_id IS NULL OR n.staff_id = ?) AND n.read = 0${realmSql}`
        )
        .get(...params) as { n: number }
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

  /**
   * Atomically claim a message at the START of the pipeline: false means
   * another (concurrent) run already owns it — treat as skipped. Claiming
   * at the end instead let two concurrent runs of the same email both pass
   * the isProcessed gate and double-process (double drafts, double sends).
   * A mid-pipeline failure must unmarkProcessed() so retry can see it.
   */
  claimProcessed(emailId: string, threadId: string): boolean {
    const res = this.db
      .prepare("INSERT OR IGNORE INTO processed_emails (email_id, thread_id) VALUES (?, ?)")
      .run(emailId, threadId);
    return res.changes > 0;
  }

  /** Dead-letter retry: let the next poll see the message again. */
  unmarkProcessed(emailId: string): void {
    this.db.prepare("DELETE FROM processed_emails WHERE email_id = ?").run(emailId);
  }

  // ── Outbox / human queue ─────────────────────────────────────────────────

  addOutbox(o: { applicant_id: number; to_address: string; subject: string; body: string; mode: "auto" | "queued"; template_key?: string }): void {
    this.db
      .prepare("INSERT INTO outbox (applicant_id, to_address, subject, body, mode, template_key) VALUES (?, ?, ?, ?, ?, ?)")
      .run(o.applicant_id, o.to_address, o.subject, o.body, o.mode, o.template_key ?? "");
  }

  latestOutbox(applicantId: number): { subject: string; body: string; mode: string } | undefined {
    return this.db
      .prepare("SELECT subject, body, mode FROM outbox WHERE applicant_id = ? ORDER BY id DESC LIMIT 1")
      .get(applicantId) as never;
  }

  /** Direction of each applicant's most recent email — one query, for queues. */
  lastEmailDirections(ids: number[]): Map<number, "in" | "out"> {
    if (ids.length === 0) return new Map();
    const rows = this.db
      .prepare(
        `SELECT e.applicant_id AS applicant_id, e.direction AS direction FROM emails e
         JOIN (SELECT applicant_id, MAX(id) AS max_id FROM emails
               WHERE applicant_id IN (${ids.map(() => "?").join(",")}) GROUP BY applicant_id) m
           ON m.max_id = e.id`
      )
      .all(...ids) as Array<{ applicant_id: number; direction: "in" | "out" }>;
    return new Map(rows.map((r) => [r.applicant_id, r.direction]));
  }

  /** Human-readable reason from each applicant's LATEST evaluation — one query. */
  latestEvaluationReasons(ids: number[]): Map<number, string> {
    if (ids.length === 0) return new Map();
    const rows = this.db
      .prepare(
        `SELECT e.applicant_id AS applicant_id, e.reason AS reason FROM evaluations e
         JOIN (SELECT applicant_id, MAX(id) AS max_id FROM evaluations
               WHERE applicant_id IN (${ids.map(() => "?").join(",")}) GROUP BY applicant_id) m
           ON m.max_id = e.id`
      )
      .all(...ids) as Array<{ applicant_id: number; reason: string }>;
    const out = new Map<number, string>();
    for (const r of rows) if (r.reason) out.set(r.applicant_id, r.reason);
    return out;
  }

  /** Active document counts per applicant — one query, for queues. */
  docCounts(ids: number[]): Map<number, number> {
    if (ids.length === 0) return new Map();
    const rows = this.db
      .prepare(
        `SELECT applicant_id, COUNT(*) AS n FROM documents
         WHERE superseded_by IS NULL AND is_duplicate = 0 AND applicant_id IN (${ids.map(() => "?").join(",")})
         GROUP BY applicant_id`
      )
      .all(...ids) as Array<{ applicant_id: number; n: number }>;
    return new Map(rows.map((r) => [r.applicant_id, r.n]));
  }

  /** Latest QUEUED draft awaiting a human [Send]/[Edit]/[Discard] decision. */
  queuedOutbox(applicantId: number): { id: number; subject: string; body: string; template_key?: string } | undefined {
    return this.db
      .prepare("SELECT id, subject, body, template_key FROM outbox WHERE applicant_id = ? AND mode = 'queued' ORDER BY id DESC LIMIT 1")
      .get(applicantId) as never;
  }

  updateOutbox(id: number, subject: string, body: string): void {
    this.db.prepare("UPDATE outbox SET subject = ?, body = ? WHERE id = ?").run(subject, body, id);
  }

  /**
   * Atomically claim a held draft for sending. Two concurrent approvals (the
   * send is awaited in between!) both used to read the still-queued draft and
   * mail the same reply twice; the claim is the gate — only the first update
   * wins. Claims older than 10 minutes are re-claimable: a sender that died
   * mid-send must not strand the draft forever.
   */
  claimOutboxDraft(id: number, nowIso: string): boolean {
    const staleBefore = new Date(new Date(nowIso).getTime() - 10 * 60_000).toISOString();
    const res = this.db
      .prepare(`UPDATE outbox SET claimed_at = ? WHERE id = ? AND (claimed_at IS NULL OR claimed_at < ?)`)
      .run(nowIso, id, staleBefore);
    return res.changes > 0;
  }

  /** Send failed after the claim was taken — let the officer retry. */
  releaseOutboxDraft(id: number): void {
    this.db.prepare("UPDATE outbox SET claimed_at = NULL WHERE id = ?").run(id);
  }

  deleteOutbox(id: number): void {
    this.db.prepare("DELETE FROM outbox WHERE id = ?").run(id);
  }

  /**
   * Applicants who received an enquiry-style incoming email today (one SQL
   * query — the admissions page must not do one query per applicant).
   */
  enquiryApplicantIdsToday(startISO: string, schools?: string[] | null): Set<number> {
    const scope = this.scopePred("a", schools);
    const rows = this.db
      .prepare(
        `SELECT DISTINCT e.applicant_id AS id FROM emails e JOIN applicants a ON a.id = e.applicant_id
         WHERE e.direction = 'in' AND e.at >= ?
           AND e.category IN ('fee_enquiry','admission_enquiry','follow_up','complaint','other')${scope.sql}`
      )
      .all(startISO, ...scope.params) as Array<{ id: number }>;
    return new Set(rows.map((r) => r.id));
  }

  /** Counters for the Overview "Today" panel. */
  // ── Stage model (v5): every applicant sits in exactly one level ──────────
  // finished / unfinished / pending are the three buckets staff think in;
  // awaiting_review inside pending is the classic "human queue".

  stageCounts(demo?: number, schools?: string[] | null): {
    finished: number;
    unfinished: number;
    pending: number;
    enquiries: number;
    application_received: number;
    documents_received: number;
    documents_checked: number;
    awaiting_review: number;
    verification: number;
    completed: number;
    total: number;
  } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (demo !== undefined) { where.push("demo = ?"); params.push(demo); }
    const scope = this.scopePred("applicants", schools);
    if (scope.sql) { where.push(scope.sql.replace(/^ AND /, "")); params.push(...scope.params); }
    const rows = this.db
      .prepare(`SELECT lifecycle, COUNT(*) AS n FROM applicants${where.length ? " WHERE " + where.join(" AND ") : ""} GROUP BY lifecycle`)
      .all(...params) as Array<{
      lifecycle: string;
      n: number;
    }>;
    const by = new Map(rows.map((r) => [r.lifecycle, r.n]));
    const g = (k: string) => by.get(k) ?? 0;
    const total = rows.reduce((n, r) => n + r.n, 0);
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const enquiries = this.enquiryApplicantIdsToday(start.toISOString(), schools).size;
    return {
      finished: g("completed"),
      unfinished: g("application_received") + g("documents_received") + g("documents_checked"),
      pending: g("awaiting_review") + g("verification"),
      enquiries,
      application_received: g("application_received"),
      documents_received: g("documents_received"),
      documents_checked: g("documents_checked"),
      awaiting_review: g("awaiting_review"),
      verification: g("verification"),
      completed: g("completed"),
      total,
    };
  }

  /** Per-applicant "who approved/completed this file" attribution. */
  approverFor(applicantId: number): { actor: string; at: string } | undefined {
    return this.db
      .prepare(
        `SELECT actor, at FROM status_history WHERE applicant_id = ? AND to_status = 'completed' AND actor != 'system'
         ORDER BY id DESC LIMIT 1`
      )
      .get(applicantId) as { actor: string; at: string } | undefined;
  }

  todayStats(demo?: number, schools?: string[] | null): { emailsToday: number; docsToday: number; completedToday: number } {
    // date('now') is UTC — in UTC+3 the "today" counters would reset at 03:00
    // local. Compute THIS machine's local day boundaries instead.
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start.getTime() + 24 * 3600_000);
    const lo = start.toISOString();
    const hi = end.toISOString();
    const dp: unknown[] = demo === undefined ? [] : [demo];
    const scope = this.scopePred("a", schools);
    const pred = (demo === undefined ? "" : " AND a.demo = ?") + scope.sql;
    const one = (sql: string) => (this.db.prepare(sql).get(lo, hi, ...dp, ...scope.params) as { n: number }).n;
    return {
      emailsToday: one(`SELECT COUNT(*) AS n FROM emails e JOIN applicants a ON a.id = e.applicant_id WHERE e.direction = 'in' AND e.at >= ? AND e.at < ?${pred}`),
      docsToday: one(`SELECT COUNT(*) AS n FROM documents d JOIN applicants a ON a.id = d.applicant_id WHERE d.received_at >= ? AND d.received_at < ?${pred}`),
      completedToday: one(`SELECT COUNT(*) AS n FROM status_history h JOIN applicants a ON a.id = h.applicant_id WHERE h.to_status = 'completed' AND h.at >= ? AND h.at < ?${pred}`),
    };
  }

  /** The human work queue (feature 11): cases whose latest decision wasn't auto-resolved. */
  queueView(demo?: number, schools?: string[] | null): Array<ApplicantRow & { computed_status: string; reasoning: string; auto_sent: boolean; decided_at: string; flag_summary: string }> {
    const scope = this.scopePred("a", schools);
    const demoSql = (demo === undefined ? "" : " AND a.demo = ?") + scope.sql;
    const demoParams: unknown[] = demo === undefined ? [...scope.params] : [demo, ...scope.params];
    const rows = this.db
      .prepare(
        `SELECT a.*, d.computed_status, d.reasoning, d.auto_sent, d.timestamp AS decided_at
         FROM decision_logs d
         JOIN (SELECT applicant_id, MAX(id) AS max_id FROM decision_logs GROUP BY applicant_id) latest
           ON latest.max_id = d.id
         JOIN applicants a ON a.id = d.applicant_id
         WHERE (
             a.lifecycle NOT IN ('completed','verification')
             -- Completed files stay out of the review queue UNLESS something
             -- still needs a human: a held draft or an active blocking flag.
             OR EXISTS (SELECT 1 FROM flags f2 WHERE f2.applicant_id = a.id AND f2.active = 1 AND f2.type != 'duplicate_submission')
             OR EXISTS (SELECT 1 FROM outbox o2 WHERE o2.applicant_id = a.id AND o2.mode = 'queued')
           )
           AND (
             d.auto_sent = 0
             -- A case whose latest decision auto-sent still needs a human
             -- when a blocking flag is active or a draft is held for approval.
             OR EXISTS (SELECT 1 FROM flags f WHERE f.applicant_id = a.id AND f.active = 1 AND f.type != 'duplicate_submission')
             OR EXISTS (SELECT 1 FROM outbox o WHERE o.applicant_id = a.id AND o.mode = 'queued')
           )${demoSql}
         ORDER BY
           CASE a.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,
           d.id`
      )
      .all(...demoParams) as any[];
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
    if (opts.demo !== undefined) {
      where.push("demo = ?");
      params.push(opts.demo);
    }
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
    const scope = this.scopePred("applicants", opts.schools);
    if (scope.sql) {
      where.push(scope.sql.replace(/^ AND /, ""));
      params.push(...scope.params);
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

  dashboardStats(demo?: number, schools?: string[] | null): Record<string, number | string> {
    // Realm scope: every applicant-derived count filters by the caller's demo
    // flag so live admins never see seeded (mock) data and vice versa.
    // OR-8: school scope applies to every count too.
    const scope = this.scopePred("a", schools);
    const pred = (demo === undefined ? "" : " AND a.demo = ?") + scope.sql;
    const dp: unknown[] = demo === undefined ? [...scope.params] : [demo, ...scope.params];
    const one = (sql: string, p: unknown[] = []) => (this.db.prepare(sql).get(...p) as { n: number }).n;
    const applications = one(`SELECT COUNT(*) AS n FROM applicants a WHERE 1=1${pred}`, dp);
    const documents = one(
      `SELECT COUNT(*) AS n FROM documents d JOIN applicants a ON a.id = d.applicant_id WHERE d.is_duplicate = 0${pred}`,
      dp
    );
    const autoHandled = one(
      `SELECT COUNT(*) AS n FROM decision_logs d JOIN applicants a ON a.id = d.applicant_id WHERE d.auto_sent = 1${pred}`,
      dp
    );
    const humanReview = one(`SELECT COUNT(*) AS n FROM applicants a WHERE a.lifecycle = 'awaiting_review'${pred}`, dp);
    const incomplete = one(
      `SELECT COUNT(*) AS n FROM applicants a WHERE a.lifecycle IN ('application_received','documents_received') AND a.triage = 'Red'${pred}`,
      dp
    );
    const completed = one(`SELECT COUNT(*) AS n FROM applicants a WHERE a.lifecycle = 'completed'${pred}`, dp);
    const overdue = one(
      `SELECT COUNT(*) AS n FROM applicants a WHERE a.sla_due_at IS NOT NULL AND a.sla_handled_at IS NULL AND a.sla_due_at < ? AND a.lifecycle NOT IN ('completed','verification')${pred}`,
      [new Date().toISOString(), ...dp]
    );
    // Avg time from email receipt → automated decision (minutes), last 7 days.
    // (Previously had no date filter and silently averaged all-time.)
    const avgRow = this.db
      .prepare(
        `SELECT AVG((julianday(d.timestamp) - julianday(e.at)) * 24 * 60) AS m
         FROM decision_logs d
         JOIN applicants a ON a.id = d.applicant_id
         JOIN emails e ON e.message_id = d.triggering_email_id AND e.direction = 'in'
         WHERE d.auto_sent = 1 AND d.timestamp > datetime('now', '-7 days')${pred}`
      )
      .get(...dp) as { m: number | null };
    const avgResponseMin = avgRow?.m && avgRow.m > 0 ? Math.round(avgRow.m * 10) / 10 : 0;
    // Avg time from queue → first staff action (hours).
    const avgReview = this.db
      .prepare(
        `SELECT AVG((julianday(h.at) - julianday(d.timestamp)) * 24) AS h
         FROM status_history h
         JOIN applicants a ON a.id = h.applicant_id
         JOIN (SELECT applicant_id, MAX(id) AS max_id FROM decision_logs WHERE auto_sent = 0 GROUP BY applicant_id) dl
           ON dl.applicant_id = h.applicant_id
         JOIN decision_logs d ON d.id = dl.max_id
         WHERE h.actor <> 'system' AND h.at >= d.timestamp${pred}`
      )
      .get(...dp) as { h: number | null };
    const avgReviewHours = avgReview?.h && avgReview.h > 0 ? Math.round(avgReview.h * 10) / 10 : 0;
    return { applications, documents, autoHandled, humanReview, incomplete, completed, overdue, avgResponseMin, avgReviewHours };
  }

  /**
   * Most common MISSING required documents across OPEN (not completed, not
   * in verification) cases — scoped by realm + schools like every other
   * admin number. Each applicant counts once per missing type, judged by
   * the frozen requirement snapshot where present (else live rules), minus
   * their active (non-superseded) documents.
   */
  commonMissingDocs(demo?: number, schools?: string[] | null, limit = 5): Array<{ type: string; count: number }> {
    const counts = new Map<string, number>();
    for (const a of this.allApplicants(demo, schools)) {
      if (a.lifecycle === "completed" || a.lifecycle === "verification") continue;
      const required = new Set(
        this.effectiveRequirements(a).filter((e) => e.required).map((e) => e.document_type)
      );
      const have = new Set(
        this.listDocuments(a.id, { activeOnly: true }).map((d) => d.document_type)
      );
      for (const t of required) if (!have.has(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((x, y) => y.count - x.count)
      .slice(0, limit);
  }

  // ── Export (feature 38) ──────────────────────────────────────────────────

  allApplicants(demo?: number, schools?: string[] | null): ApplicantRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (demo !== undefined) { where.push("demo = ?"); params.push(demo); }
    const scope = this.scopePred("applicants", schools);
    if (scope.sql) { where.push(scope.sql.replace(/^ AND /, "")); params.push(...scope.params); }
    return this.db
      .prepare(`SELECT * FROM applicants${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY id`)
      .all(...params) as ApplicantRow[];
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
  staffStats(demo?: number): StaffStatsRow[] {
    const staff = this.listStaff();
    const demoSql = demo === undefined ? "" : " AND a.demo = ?";
    const dp: unknown[] = demo === undefined ? [] : [demo];
    const qAssigned = this.db.prepare(`SELECT COUNT(*) AS c FROM applicants a WHERE a.assigned_to = ?${demoSql}`);
    const qReceived = this.db.prepare(
      `SELECT COUNT(*) AS c FROM emails e
       JOIN applicants a ON a.id = e.applicant_id
       WHERE e.direction = 'in' AND a.assigned_to = ?${demoSql}`
    );
    const qSent = this.db.prepare(
      `SELECT COUNT(*) AS c FROM audit_log
       WHERE actor = ? AND event IN ('email_sent_manual','human_override')`
    );
    const qCompleted = this.db.prepare(
      `SELECT COUNT(DISTINCT h.applicant_id) AS c FROM status_history h
       JOIN applicants a ON a.id = h.applicant_id
       WHERE h.actor = ? AND h.to_status = 'completed'${demoSql}`
    );
    const qAvg = this.db.prepare(
      `SELECT AVG((julianday(o.at) - julianday(i.at)) * 1440.0) AS mins
       FROM emails i
       JOIN applicants a ON a.id = i.applicant_id
       JOIN emails o ON o.applicant_id = i.applicant_id AND o.direction = 'out'
         AND o.at = (SELECT MIN(o2.at) FROM emails o2
                     WHERE o2.applicant_id = i.applicant_id
                       AND o2.direction = 'out' AND o2.at > i.at)
       WHERE i.direction = 'in' AND a.assigned_to = ?${demoSql}`
    );
    return staff.map((s) => {
      const assigned = (qAssigned.get(s.id, ...dp) as { c: number }).c;
      const received = (qReceived.get(s.id, ...dp) as { c: number }).c;
      const sent = (qSent.get(s.username) as { c: number }).c;
      const completed = (qCompleted.get(s.username, ...dp) as { c: number }).c;
      const avg = qAvg.get(s.id, ...dp) as { mins: number | null };
      return {
        id: s.id,
        username: s.username,
        display_name: s.display_name,
        role: s.role,
        active: s.active,
        demo: s.demo ?? 0,
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

  /**
   * Optimistic rung claim for the follow-up ladder: advance rung + next_at in
   * ONE update guarded on the rung the sweeper READ. Two sweepers holding the
   * same stale due-list — one holds the row, one drafts a duplicate — used to
   * both write; with the claim, exactly one wins by definition of changes>0.
   */
  claimFollowupRung(applicantId: number, expectedRung: number, nextRung: number, nextAt: string | null): boolean {
    const res = this.db
      .prepare(
        `UPDATE applicants SET followup_rung = ?, followup_next_at = ?
         WHERE id = ? AND followup_rung = ?
           AND lifecycle IN ('application_received','documents_received')`
      )
      .run(nextRung, nextAt, applicantId, expectedRung);
    return res.changes > 0;
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

  unansweredCases(schools?: string[] | null): Array<{ applicant: ApplicantRow; lastInAt: string; hours: number }> {
    // Any outgoing email (automated or human) counts as "answered" — that is
    // the specified behavior (a factual auto-reply IS a reply). Batched into
    // one query; previously this ran one query per applicant (N+1).
    const rows = this.db
      .prepare(
        `SELECT a.id AS aid, MAX(e.at) AS last_in
         FROM applicants a
         JOIN emails e ON e.applicant_id = a.id AND e.direction = 'in'
         WHERE a.lifecycle NOT IN ('completed')${this.scopePred("a", schools).sql}
         GROUP BY a.id`
      )
      .all(...this.scopePred("a", schools).params) as Array<{ aid: number; last_in: string }>;
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

  // ── Analytics (features 28–31) ───────────────────────────────────────────

  categoryCounts(schools?: string[] | null): Array<{ category: string; n: number }> {
    const scope = this.scopePred("a", schools);
    return this.db
      .prepare(
        `SELECT coalesce(e.category,'other') AS category, COUNT(*) AS n
         FROM emails e JOIN applicants a ON a.id = e.applicant_id
         WHERE e.direction = 'in'${scope.sql} GROUP BY category ORDER BY n DESC`
      )
      .all(...scope.params) as never[];
  }

  accuracyStats(demo?: number, schools?: string[] | null): Record<string, number> {
    const scope = this.scopePred("a", schools);
    const dp: unknown[] = demo === undefined ? [...scope.params] : [demo, ...scope.params];
    const pred = (demo === undefined ? "" : " AND a.demo = ?") + scope.sql;
    const one = (sql: string) => (this.db.prepare(sql).get(...dp) as { n: number }).n;
    return {
      greenCases: one(`SELECT COUNT(*) AS n FROM decision_logs d JOIN applicants a ON a.id = d.applicant_id WHERE d.computed_status = 'Green'${pred}`),
      watcherCatches: one(`SELECT COUNT(*) AS n FROM audit_log l JOIN applicants a ON a.id = l.applicant_id WHERE l.event = 'watcher_downgrade'${pred}`),
      humanOverrides: one(`SELECT COUNT(*) AS n FROM audit_log l JOIN applicants a ON a.id = l.applicant_id WHERE l.event = 'human_override'${pred}`),
      sendErrors: one(`SELECT COUNT(*) AS n FROM audit_log l JOIN applicants a ON a.id = l.applicant_id WHERE l.event = 'send_failed'${pred}`),
      autoSends: one(`SELECT COUNT(*) AS n FROM emails e JOIN applicants a ON a.id = e.applicant_id WHERE e.direction = 'out' AND e.auto = 1${pred}`),
      humanSends: one(`SELECT COUNT(*) AS n FROM emails e JOIN applicants a ON a.id = e.applicant_id WHERE e.direction = 'out' AND e.auto = 0${pred}`),
      reopened: one(`SELECT COUNT(*) AS n FROM audit_log l JOIN applicants a ON a.id = l.applicant_id WHERE l.event = 'case_reopened'${pred}`),
    };
  }


  // ── Data retention (feature 38) ──────────────────────────────────────────

  /** Fully remove an applicant's data (used after archiving). */
  deleteApplicantFull(applicantId: number): void {
    const tx = this.db.transaction(() => {
      for (const t of ["documents", "flags", "emails", "notes", "tasks", "decision_logs", "status_history", "audit_log", "outbox", "applicant_threads", "notifications", "evaluations"]) {
        this.db.prepare(`DELETE FROM ${t} WHERE applicant_id = ?`).run(applicantId);
      }
      this.db.prepare("DELETE FROM applicants WHERE id = ?").run(applicantId);
    });
    tx();
  }

  // ═══ Admissions rules engine (round 18) ══════════════════════════════════

  // ── OR-8: visibility scoping — the ONLY place scope is decided ─────────

  /** The schools a staff member may see, or null = full visibility.
   * Admins are NEVER scoped; staff without assigned schools keep full
   * visibility (scoping is opt-in and reversible). */
  visibleSchoolsFor(staff: { id: number; role: string }): string[] | null {
    if (staff.role === "admin") return null;
    const rows = this.scopesFor(staff.id);
    return rows.length ? rows : null;
  }

  /** Would this staff member see this applicant anywhere in the console?
   * Scoped staff only see cases whose programme belongs to one of their
   * schools; a case with no programme is never shared with scoped staff. */
  applicantVisibleTo(staff: { id: number; role: string }, a: ApplicantRow): boolean {
    const scope = this.visibleSchoolsFor(staff);
    if (!scope) return true;
    if (!a.programme) return false;
    const school = this.programmeByCode(a.programme)?.school;
    return Boolean(school) && scope.includes(school as string);
  }

  /** SQL predicate restricting applicant rows to the given schools.
   * `schools === null/undefined` = unscoped; an EMPTY scoped list matches
   * nothing (never accidentally everything). */
  private scopePred(alias: string, schools?: string[] | null): { sql: string; params: string[] } {
    if (schools === undefined || schools === null) return { sql: "", params: [] };
    if (schools.length === 0) return { sql: " AND 0 = 1", params: [] };
    const marks = schools.map(() => "?").join(",");
    return {
      sql: ` AND EXISTS (SELECT 1 FROM programmes p WHERE p.code = ${alias}.programme AND p.school IN (${marks}))`,
      params: [...schools],
    };
  }

  // ── Subject catalogue (centrally managed, never duplicated per course) ──

  listSubjectCatalogue(system?: string): Array<{ id: number; system: string; name: string; active: number }> {
    const rows = system === undefined
      ? this.db.prepare("SELECT * FROM subject_catalogue ORDER BY system, name").all()
      : this.db.prepare("SELECT * FROM subject_catalogue WHERE system = ? ORDER BY name").all(system);
    return rows as never[];
  }

  /** OR-6: returns false when the subject already exists — callers must
   * refuse loudly; nothing is ever swallowed silently. */
  addCatalogueSubject(system: string, name: string): boolean {
    const res = this.db
      .prepare("INSERT OR IGNORE INTO subject_catalogue (system, name) VALUES (?, ?)")
      .run(system, name.trim());
    return res.changes > 0;
  }

  /** OR-6: rename a catalogue subject (keeps its active status). Returns
   * false when the new name already exists in that system. */
  renameCatalogueSubject(id: number, name: string): boolean {
    const row = this.db.prepare("SELECT system FROM subject_catalogue WHERE id = ?").get(id) as { system?: string } | undefined;
    if (!row?.system) return false;
    const clash = this.db
      .prepare("SELECT id FROM subject_catalogue WHERE system = ? AND name = ? AND id <> ?")
      .get(row.system, name.trim(), id);
    if (clash) return false;
    this.db.prepare("UPDATE subject_catalogue SET name = ? WHERE id = ?").run(name.trim(), id);
    return true;
  }

  setCatalogueActive(id: number, active: boolean): void {
    this.db.prepare("UPDATE subject_catalogue SET active = ? WHERE id = ?").run(active ? 1 : 0, id);
  }

  seedCatalogue(entries: Array<{ system: string; name: string }>): void {
    const tx = this.db.transaction(() => {
      for (const e of entries) this.addCatalogueSubject(e.system, e.name);
    });
    tx();
  }

  // ── Staff visibility scopes (OR-8: school × staff matrix) ───────────────

  scopesFor(staffId: number): string[] {
    const rows = this.db.prepare("SELECT school FROM staff_scopes WHERE staff_id = ? ORDER BY school").all(staffId) as Array<{ school: string }>;
    return rows.map((x) => x.school);
  }

  /** Replace a staff member's whole school set in ONE action. */
  setScopes(staffId: number, schools: string[]): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM staff_scopes WHERE staff_id = ?").run(staffId);
      const ins = this.db.prepare("INSERT OR IGNORE INTO staff_scopes (staff_id, school) VALUES (?, ?)");
      for (const s of new Set(schools.map((x) => x.trim()).filter(Boolean))) ins.run(staffId, s);
    });
    tx();
  }

  // ── Schools (OR-6: first-class, editable, shared with courses page) ─────

  /** Every school: the schools catalogue UNION the schools programmes use. */
  listSchools(): string[] {
    const rows = this.db
      .prepare("SELECT name FROM schools UNION SELECT DISTINCT school FROM programmes WHERE school <> '' ORDER BY name")
      .all() as Array<{ name: string }>;
    return rows.map((x) => x.name);
  }

  /** Add a school. Returns false when it already exists. */
  addSchool(name: string): boolean {
    const res = this.db.prepare("INSERT OR IGNORE INTO schools (name) VALUES (?)").run(name.trim());
    return res.changes > 0;
  }

  /** Rename a school, moving every course with it. Returns the number of
   * courses moved, or -1 when the target name already exists. */
  renameSchool(from: string, to: string): number {
    const clash =
      this.db.prepare("SELECT name FROM schools WHERE name = ?").get(to.trim()) ??
      this.db.prepare("SELECT school FROM programmes WHERE school = ?").get(to.trim());
    if (clash) return -1;
    const moved = this.db.prepare("UPDATE programmes SET school = ? WHERE school = ?").run(to.trim(), from).changes;
    this.db.prepare("UPDATE schools SET name = ? WHERE name = ?").run(to.trim(), from);
    return moved;
  }

  // ── Requirement sets (versioned trees per programme × system) ────────────

  private rowToSet(r: Record<string, unknown>): AdmissionRuleSet {
    return {
      id: r.id as number,
      programme: (r.programme as string | null) ?? null,
      level: (r.level ?? "degree") as CourseLevel,
      system: r.system as AdmissionSystem,
      version: r.version as number,
      status: r.status as AdmissionRuleSet["status"],
      created_by: r.created_by as string,
      created_at: r.created_at as string,
    };
  }

  listRuleSets(filter: { programme?: string | null; status?: string; system?: string } = {}): AdmissionRuleSet[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.programme !== undefined) {
      if (filter.programme === null) where.push("programme IS NULL");
      else { where.push("programme = ?"); params.push(filter.programme); }
    }
    if (filter.status) { where.push("status = ?"); params.push(filter.status); }
    if (filter.system) { where.push("system = ?"); params.push(filter.system); }
    const rows = this.db
      .prepare(`SELECT * FROM admission_rules ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY programme IS NULL, programme, system, version DESC`)
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToSet(r));
  }

  getRuleSet(id: number): AdmissionRuleSet | undefined {
    const r = this.db.prepare("SELECT * FROM admission_rules WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return this.rowToSet(r);
  }

  getRuleSetNodes(setId: number): RuleNode[] {
    const rows = this.db
      .prepare("SELECT * FROM admission_rule_nodes WHERE set_id = ? ORDER BY position, id")
      .all(setId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as number,
      set_id: r.set_id as number,
      parent_id: (r.parent_id as number | null) ?? null,
      kind: r.kind as RuleNode["kind"],
      logic: (r.logic as RuleNode["logic"]) ?? undefined,
      field: (r.field as RuleNode["field"]) ?? undefined,
      subject: (r.subject as string | null) ?? null,
      comparator: ">=",
      value: (r.value as string | null) ?? null,
      position: r.position as number,
    }));
  }

  /** Assemble the node rows of one set into a tree (children arrays). */
  getRuleTree(setId: number): RuleNode[] {
    const flat = this.getRuleSetNodes(setId);
    const byId = new Map<number, RuleNode>();
    for (const n of flat) byId.set(n.id!, { ...n, children: n.kind === "group" ? [] : undefined });
    const roots: RuleNode[] = [];
    for (const n of flat) {
      const node = byId.get(n.id!)!;
      const pid = n.parent_id;
      if (typeof pid === "number" && byId.has(pid)) byId.get(pid)!.children!.push(node);
      else roots.push(node);
    }
    return roots;
  }

  /**
   * The active requirement sets for a programme: course-specific sets win
   * per qualification system; otherwise the university-wide defaults for the
   * programme's level apply.
   */
  activeSetsForProgramme(programme: string | null): AdmissionRuleSet[] {
    const row = programme
      ? (this.db.prepare("SELECT level FROM programmes WHERE code = ?").get(programme.toUpperCase()) as { level?: string } | undefined)
      : undefined;
    const level = (row?.level ?? "degree") as CourseLevel;
    const base = this.listRuleSets({ programme: null, status: "active" }).filter((s) => s.level === level);
    const course = programme ? this.listRuleSets({ programme: programme.toUpperCase(), status: "active" }) : [];
    const merged = new Map<string, AdmissionRuleSet>();
    for (const s of base) merged.set(s.system, s);
    for (const s of course) merged.set(s.system, s);
    for (const s of merged.values()) s.nodes = this.getRuleTree(s.id);
    return [...merged.values()];
  }

  /** The draft set for editing ( programme | level | system ), if any. */
  getDraftSet(programme: string | null, level: CourseLevel, system: string): AdmissionRuleSet | undefined {
    const r = programme === null
      ? this.db.prepare("SELECT * FROM admission_rules WHERE programme IS NULL AND level = ? AND system = ? AND status = 'draft'").get(level, system)
      : this.db.prepare("SELECT * FROM admission_rules WHERE programme = ? AND level = ? AND system = ? AND status = 'draft'").get(programme, level, system);
    return r ? this.rowToSet(r as Record<string, unknown>) : undefined;
  }

  private copyNodes(fromSetId: number, toSetId: number): void {
    const flat = this.getRuleSetNodes(fromSetId);
    const idMap = new Map<number, number>();
    const insert = this.db.prepare(
      "INSERT INTO admission_rule_nodes (set_id, parent_id, kind, logic, field, subject, comparator, value, position) VALUES (?,?,?,?,?,?,?,?,?)"
    );
    // First pass: create rows with parent NULL; second pass: relink parents.
    for (const n of flat) {
      const res = insert.run(toSetId, null, n.kind, n.logic ?? null, n.field ?? null, n.subject ?? null, n.comparator ?? ">=", n.value ?? null, n.position ?? 0);
      idMap.set(n.id!, Number(res.lastInsertRowid));
    }
    const relink = this.db.prepare("UPDATE admission_rule_nodes SET parent_id = ? WHERE id = ?");
    for (const n of flat) {
      const pid = n.parent_id;
      const newParent = typeof pid === "number" ? idMap.get(pid) : undefined;
      const newSelf = idMap.get(n.id!);
      if (newParent !== undefined && newSelf !== undefined) relink.run(newParent, newSelf);
    }
  }

  /**
   * Get (or create) the editable draft for one route. Creating copies the
   * currently active rules so staff always edit a full, working set — the
   * ACTIVE set keeps judging applicants until the draft is activated.
   */
  ensureDraftSet(programme: string | null, level: CourseLevel, system: AdmissionSystem, user: string): AdmissionRuleSet {
    const existing = this.getDraftSet(programme, level, system);
    if (existing) return existing;
    const active = this.listRuleSets({ programme, status: "active", system }).find((s) => s.level === level);
    const nextVersion = active ? active.version + 1 : 1;
    const res = this.db
      .prepare("INSERT INTO admission_rules (programme, level, system, version, status, created_by) VALUES (?,?,?,?, 'draft', ?)")
      .run(programme, level, system, nextVersion, user);
    const id = Number(res.lastInsertRowid);
    if (active) this.copyNodes(active.id, id);
    return this.getRuleSet(id)!;
  }

  addRuleNode(setId: number, parentId: number | null, kind: "group" | "condition", logic?: "AND" | "OR" | "NOT"): number {
    const pos = (this.db
      .prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM admission_rule_nodes WHERE set_id = ? AND parent_id IS ?")
      .get(setId, parentId) as { p: number }).p;
    const res = this.db
      .prepare(
        "INSERT INTO admission_rule_nodes (set_id, parent_id, kind, logic, field, comparator, position) VALUES (?,?,?,?,?,?,?)"
      )
      .run(setId, parentId, kind, kind === "group" ? (logic ?? "AND") : null, kind === "condition" ? "mean_grade" : null, kind === "condition" ? ">=" : null, pos);
    return Number(res.lastInsertRowid);
  }

  updateRuleNode(nodeId: number, patch: Partial<Pick<RuleNode, "logic" | "field" | "subject" | "comparator" | "value">>): void {
    const cur = this.db.prepare("SELECT logic, field, subject, comparator, value FROM admission_rule_nodes WHERE id = ?").get(nodeId) as
      | { logic: string | null; field: string | null; subject: string | null; comparator: string; value: string | null }
      | undefined;
    if (!cur) return;
    this.db
      .prepare("UPDATE admission_rule_nodes SET logic = ?, field = ?, subject = ?, comparator = ?, value = ? WHERE id = ?")
      .run(
        patch.logic ?? cur.logic,
        patch.field ?? cur.field,
        patch.subject !== undefined ? patch.subject : cur.subject,
        patch.comparator ?? cur.comparator,
        patch.value !== undefined ? patch.value : cur.value,
        nodeId
      );
  }

  moveRuleNode(nodeId: number, parentId: number | null): void {
    this.db.prepare("UPDATE admission_rule_nodes SET parent_id = ? WHERE id = ?").run(parentId, nodeId);
  }

  deleteRuleNode(nodeId: number): void {
    // FK ON DELETE CASCADE handles descendants.
    this.db.prepare("DELETE FROM admission_rule_nodes WHERE id = ?").run(nodeId);
  }

  /** Activate a draft: it becomes the new version; the old active retires. */
  activateDraftSet(setId: number): AdmissionRuleSet | undefined {
    const set = this.getRuleSet(setId);
    if (!set || set.status !== "draft") return undefined;
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE admission_rules SET status = 'retired'
           WHERE status = 'active' AND system = ? AND level = ?
             AND (programme IS ?)`
        )
        .run(set.system, set.level, set.programme);
      this.db.prepare("UPDATE admission_rules SET status = 'active', created_at = datetime('now') WHERE id = ?").run(setId);
    });
    tx();
    return this.getRuleSet(setId);
  }

  discardDraftSet(setId: number): void {
    const set = this.getRuleSet(setId);
    if (!set || set.status !== "draft") return;
    this.db.prepare("DELETE FROM admission_rules WHERE id = ?").run(setId); // cascades nodes
  }

  /** Freeze the current rule sets onto the applicant on first evaluation. */
  freezeAdmissionSets(a: ApplicantRow): AdmissionRuleSet[] {
    if (a.admission_rules_frozen) {
      try {
        return JSON.parse(a.admission_rules_frozen) as AdmissionRuleSet[];
      } catch {
        this.audit(a.id, "system", "admission_rules_snapshot_corrupt", "frozen rule sets failed to parse — re-frozen from live rules; human should verify");
      }
    }
    const sets = this.activeSetsForProgramme(a.programme);
    this.db
      .prepare("UPDATE applicants SET admission_rules_frozen = ? WHERE id = ?")
      .run(JSON.stringify(sets), a.id);
    return sets;
  }

  // ── Evaluations ────────────────────────────────────────────────────────────

  insertEvaluation(row: {
    applicant_id: number;
    set_id: number | null;
    programme: string | null;
    system: string | null;
    set_version: number | null;
    result: string;
    routing: string;
    reason: string;
    reason_code: string;
    detail: string;
    rule_snapshot: string;
  }): number {
    const res = this.db
      .prepare(
        `INSERT INTO evaluations (applicant_id, set_id, programme, system, set_version, result, routing, reason, reason_code, detail, rule_snapshot)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(row.applicant_id, row.set_id, row.programme, row.system, row.set_version, row.result, row.routing, row.reason, row.reason_code, row.detail, row.rule_snapshot);
    return Number(res.lastInsertRowid);
  }

  latestEvaluation(applicantId: number): (import("../types").EvaluationReport & { id: number }) | null {
    const r = this.db
      .prepare("SELECT * FROM evaluations WHERE applicant_id = ? ORDER BY id DESC LIMIT 1")
      .get(applicantId) as Record<string, unknown> | undefined;
    if (!r) return null;
    try {
      const report = JSON.parse(String(r.detail)) as import("../types").EvaluationReport;
      return { ...report, id: r.id as number };
    } catch {
      return null;
    }
  }

  evaluationsForApplicant(applicantId: number): Array<{ id: number; result: string; routing: string; reason: string; evaluated_at: string; set_version: number | null; system: string | null }> {
    return this.db
      .prepare("SELECT id, result, routing, reason, evaluated_at, set_version, system FROM evaluations WHERE applicant_id = ? ORDER BY id DESC LIMIT 50")
      .all(applicantId) as never[];
  }

  // ── Vision cache (round 19) ──────────────────────────────────────────────
  // Gemini results cached by content SHA-256 so the same bytes are never paid
  // for twice; a dead vision model can replay the last-known reading instead
  // of failing the document.

  visionCacheGet(sha256: string): VisionExtraction | null {
    const r = this.db.prepare("SELECT result_json FROM gemini_cache WHERE sha256 = ?").get(sha256) as
      | { result_json: string }
      | undefined;
    if (!r) return null;
    try {
      const parsed = JSON.parse(r.result_json);
      // A corrupt/truncated cache row is a MISS, never trusted data.
      if (!isValidCachedVision(parsed)) {
        this.db.prepare("DELETE FROM gemini_cache WHERE sha256 = ?").run(sha256);
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  visionCacheSet(sha256: string, result: VisionExtraction): void {
    this.db
      .prepare(
        `INSERT INTO gemini_cache (sha256, result_json) VALUES (?, ?)
         ON CONFLICT(sha256) DO UPDATE SET result_json = excluded.result_json`
      )
      .run(sha256, JSON.stringify(result));
  }

  visionCallsToday(): number {
    const today = new Date().toISOString().slice(0, 10);
    const key = `gemini_calls_${today}`;
    const val = this.getSetting(key, "0");
    const n = Number(val);
    return Number.isFinite(n) ? n : 0;
  }

  noteVisionCall(): void {
    const today = new Date().toISOString().slice(0, 10);
    const key = `gemini_calls_${today}`;
    this.setSetting(key, String(this.visionCallsToday() + 1));
    // One counter row per day accumulates forever otherwise; drop the rest.
    this.db
      .prepare(`DELETE FROM settings WHERE key LIKE 'gemini_calls_%' AND key <> ?`)
      .run(key);
  }

  /** Adapter factory: hands the extraction layer a DB-backed cache store. */
  visionCacheStore(): VisionCacheStore {
    return {
      get: (sha) => this.visionCacheGet(sha),
      set: (sha, r) => this.visionCacheSet(sha, r),
      callsToday: () => this.visionCallsToday(),
      noteCall: () => this.noteVisionCall(),
    };
  }

  // ── Dead-letter queue (round 19) ─────────────────────────────────────────
  // Poison mail accumulates attempts here; after DEAD_LETTER_MAX_ATTEMPTS it
  // is parked (dead=1) and surfaced to a human instead of being retried
  // forever.

  deadLetterMaxAttempts(): number {
    const n = Number(this.getSetting("dead_letter_max_attempts", "5"));
    return Number.isFinite(n) && n > 0 ? n : 5;
  }

  recordDeadLetter(input: {
    message_id: string;
    subject: string;
    from_addr: string;
    error: string;
  }): { attempts: number; dead: boolean; id: number } {
    const existing = this.db
      .prepare("SELECT * FROM dead_letters WHERE message_id = ?")
      .get(input.message_id) as (DeadLetter & { dead: number }) | undefined;
    if (existing) {
      const attempts = existing.attempts + 1;
      const dead = attempts >= this.deadLetterMaxAttempts() ? 1 : existing.dead;
      this.db
        .prepare(
          `UPDATE dead_letters SET attempts = ?, error = ?, dead = ?, updated_at = datetime('now') WHERE id = ?`
        )
        .run(attempts, input.error, dead, existing.id);
      return { attempts, dead: dead === 1, id: existing.id };
    }
    const attempts = 1;
    const dead = attempts >= this.deadLetterMaxAttempts() ? 1 : 0;
    const res = this.db
      .prepare(
        `INSERT INTO dead_letters (message_id, subject, from_addr, error, attempts, dead)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(input.message_id, input.subject, input.from_addr, input.error, attempts, dead);
    return { attempts, dead: dead === 1, id: Number(res.lastInsertRowid) };
  }

  listDeadLetters(onlyDead = true): DeadLetter[] {
    const sql = onlyDead
      ? "SELECT * FROM dead_letters WHERE dead = 1 ORDER BY updated_at DESC"
      : "SELECT * FROM dead_letters ORDER BY updated_at DESC";
    return this.db.prepare(sql).all() as DeadLetter[];
  }

  /**
   * Park a message permanently (known-unprocessable, e.g. oversized mail):
   * no retry budget, straight to the human queue.
   */
  parkDeadLetter(input: {
    message_id: string;
    subject: string;
    from_addr: string;
    error: string;
  }): DeadLetter {
    const max = this.deadLetterMaxAttempts();
    this.db
      .prepare(
        `INSERT INTO dead_letters (message_id, subject, from_addr, error, attempts, dead)
         VALUES (?, ?, ?, ?, ?, 1)
         ON CONFLICT(message_id) DO UPDATE SET
           error = excluded.error, attempts = excluded.attempts, dead = 1, updated_at = datetime('now')`
      )
      .run(input.message_id, input.subject, input.from_addr, input.error, max);
    return this.db
      .prepare("SELECT * FROM dead_letters WHERE message_id = ?")
      .get(input.message_id) as DeadLetter;
  }

  /** Reset a parked letter so the next poll retries it. */
  resetDeadLetter(id: number): void {
    this.db
      .prepare(`UPDATE dead_letters SET dead = 0, attempts = 0, updated_at = datetime('now') WHERE id = ?`)
      .run(id);
  }

  removeDeadLetter(id: number): void {
    this.db.prepare("DELETE FROM dead_letters WHERE id = ?").run(id);
  }

  getDeadLetter(id: number): DeadLetter | undefined {
    return this.db.prepare("SELECT * FROM dead_letters WHERE id = ?").get(id) as DeadLetter | undefined;
  }

  clearDeadLetterByMessage(messageId: string): void {
    this.db.prepare("DELETE FROM dead_letters WHERE message_id = ?").run(messageId);
  }

  // ── Case routing helpers (round 19) ──────────────────────────────────────

  /**
   * Open cases for a programme that have NO human owner yet. When a course
   * owner changes, these can flow to the new owner automatically — but a
   * case somebody already picked up is never re-routed behind their back.
   */
  openUnassignedCasesForProgramme(programme: string, demo: 0 | 1): ApplicantRow[] {
    // Realm-scoped: an owner change in the live console must never re-route
    // demo cases (and vice versa) — programme codes are shared across realms.
    const rows = this.db
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
  openApplicantIds(): number[] {
    const rows = this.db
      .prepare(`SELECT id FROM applicants WHERE lifecycle <> 'completed' ORDER BY id`)
      .all() as Array<{ id: number }>;
    return rows.map((r) => r.id);
  }

  isDeadLetter(messageId: string): boolean {
    const r = this.db
      .prepare("SELECT dead FROM dead_letters WHERE message_id = ?")
      .get(messageId) as { dead: number } | undefined;
    return Boolean(r?.dead);
  }
}
