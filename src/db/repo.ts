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
  Organization,
  OrganizationTheme,
  CaseType,
  CaseConfigFrozen,
  DocumentDefinition,
  CaseOutcome,
  AttachmentSet,
  Permission,
} from "../types";
import { PERMISSIONS } from "../types";
import type { WorkflowRule } from "../rules/workflow";
import { documentRequirementsFor, fillSlots, type ApplicantNationality, type ProgrammeLevel } from "../documents/matrix";
import type { VisionCacheStore } from "../extraction/gemini";
import { isValidCachedVision } from "../extraction/gemini";
import type { VisionExtraction } from "../types";

const nowIso = () => new Date().toISOString();

/** PPR P0-1: the only keys that may live in the secrets store. */
export const SECRET_KEYS: readonly string[] = ["gemini_api_key", "gmail_client_secret", "gmail_refresh_token"];

/** PPR P1-2: the current six lifecycle stages / five queues are the EDUCATION
 * preset — data now, not a core assumption. Stage ids stay stable (they are
 * the values the lifecycle column has always stored). */
export const EDUCATION_STAGE_PRESET: Array<{ id: string; label: string }> = [
  { id: "application_received", label: "Application Received" },
  { id: "documents_received", label: "Documents Received" },
  { id: "documents_checked", label: "Documents Checked" },
  { id: "awaiting_review", label: "Awaiting Review" },
  { id: "verification", label: "Verification" },
  { id: "completed", label: "Completed" },
];
export const GENERIC_STAGE_PRESET: Array<{ id: string; label: string }> = [
  { id: "application_received", label: "Received" },
  { id: "documents_received", label: "Information received" },
  { id: "awaiting_review", label: "In review" },
  { id: "completed", label: "Completed" },
];
export const EDUCATION_QUEUE_PRESET: Array<{ id: string; label: string }> = [
  { id: "completed", label: "Completed / Verification" },
  { id: "waiting_documents", label: "Waiting for Documents" },
  { id: "human_review", label: "Human Review Required" },
  { id: "decision", label: "Admissions / Decision" },
  { id: "enquiries", label: "Enquiries & Communication" },
];
export const GENERIC_QUEUE_PRESET: Array<{ id: string; label: string }> = [
  { id: "new", label: "New" },
  { id: "in_progress", label: "In progress" },
  { id: "waiting", label: "Waiting" },
  { id: "done", label: "Done" },
];

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

type ScopeTag = string[] & { organizationId?: number; allSchools?: boolean };
/** A tagged scope meaning "every school, but only in this organization". */
function isAllSchools(s: string[] | null | undefined): boolean { return Boolean(s && (s as ScopeTag).allSchools); }
/** An explicit empty scope = deliberately no access. */
function isNoAccess(s: string[] | null | undefined): boolean { return Boolean(s && s.length === 0 && !isAllSchools(s)); }

export class Repo {
  constructor(public db: Database) {}

  // ── Organizations and generic case configuration ───────────────────────

  getOrganization(id: number): Organization | undefined {
    const row = this.db.prepare("SELECT id, name, logo, ref_prefix, theme, from_name, reply_to, locale, timezone FROM organizations WHERE id = ?").get(id) as
      | { id: number; name: string; logo: string | null; ref_prefix: string; theme: string; from_name: string | null; reply_to: string | null; locale: string | null; timezone: string | null }
      | undefined;
    if (!row) return undefined;
    let theme: OrganizationTheme = { primary: "#650019", accent: "#e18b9a" };
    try { theme = { ...theme, ...(JSON.parse(row.theme || "{}") as Partial<OrganizationTheme>) }; } catch { /* use safe defaults */ }
    return {
      id: row.id, name: row.name, logo: row.logo, ref_prefix: row.ref_prefix || (id === 1 ? "RU" : "ORG"), theme,
      from_name: row.from_name, reply_to: row.reply_to, locale: row.locale, timezone: row.timezone,
    };
  }

  /** Create a tenant with no inherited admissions content. */
  createOrganization(input: { name: string; logo?: string | null; refPrefix?: string; theme?: Partial<OrganizationTheme> }): Organization {
    const name = input.name.trim();
    if (!name) throw new Error("Organization name is required");
    const theme = {
      primary: input.theme?.primary ?? "#650019",
      accent: input.theme?.accent ?? "#e18b9a",
    };
    const prefix = (input.refPrefix ?? "ORG").trim().toUpperCase();
    if (!/^[A-Z]{1,8}$/.test(prefix)) throw new Error("Reference prefix must be 1–8 letters");
    const result = this.db.prepare("INSERT INTO organizations (name, logo, ref_prefix, theme) VALUES (?,?,?,?)")
      .run(name, input.logo ?? null, prefix, JSON.stringify(theme));
    return this.getOrganization(Number(result.lastInsertRowid))!;
  }

  listOrganizations(): Organization[] {
    return (this.db.prepare("SELECT id FROM organizations ORDER BY id").all() as Array<{ id: number }>)
      .map((r) => this.getOrganization(r.id)!).filter(Boolean);
  }

  organizationRefPrefix(organizationId = 1): string {
    return this.getOrganization(organizationId)?.ref_prefix || (organizationId === 1 ? "RU" : "ORG");
  }

  updateOrganization(id: number, patch: { name?: string; logo?: string | Buffer | null; refPrefix?: string; theme?: Partial<OrganizationTheme>; fromName?: string | null; replyTo?: string | null; locale?: string | null; timezone?: string | null }): void {
    const current = this.getOrganization(id);
    if (!current) return;
    const theme = { ...current.theme, ...(patch.theme ?? {}) };
    const logo = patch.logo === undefined ? current.logo : Buffer.isBuffer(patch.logo) ? `data:application/octet-stream;base64,${patch.logo.toString("base64")}` : patch.logo;
    const name = patch.name?.trim() || current.name;
    const refPrefix = patch.refPrefix === undefined ? current.ref_prefix : patch.refPrefix.trim().toUpperCase();
    if (!/^[A-Z]{1,8}$/.test(refPrefix)) throw new Error("Reference prefix must be 1–8 letters");
    const text = (v: string | null | undefined, prev: string | null | undefined): string | null =>
      v === undefined ? (prev ?? null) : v === null || v.trim() === "" ? null : v.trim().replace(/[\r\n]+/g, " ");
    this.db.prepare("UPDATE organizations SET name = ?, logo = ?, ref_prefix = ?, theme = ?, from_name = ?, reply_to = ?, locale = ?, timezone = ? WHERE id = ?")
      .run(name, logo, refPrefix, JSON.stringify(theme),
        text(patch.fromName, current.from_name), text(patch.replyTo, current.reply_to),
        text(patch.locale, current.locale), text(patch.timezone, current.timezone), id);
    if (id === 1 && patch.name !== undefined) {
      this.db.prepare("INSERT INTO settings (key, value) VALUES ('institution_name', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(name);
    }
  }

  createCaseType(organizationId: number, input: {
    code: string; name: string; category?: string; config?: Record<string, unknown>;
    /** PPR P0-2/P0-4: profile flags. New profiles are draft-first, no auto-decision. */
    educationModule?: boolean; defaultReplyAction?: string; qualificationGate?: boolean; autoAdmit?: boolean;
  }): CaseType {
    this.db.prepare(
      "INSERT INTO case_types (organization_id, code, name, category, config, education_module, default_reply_action, qualification_gate, auto_admit, stages, queues) " +
      "VALUES (?,?,?,?,?,?,?,?,?,?,?) " +
      "ON CONFLICT(organization_id, code) DO UPDATE SET name=excluded.name, category=excluded.category, config=excluded.config"
    ).run(
      organizationId, input.code.trim().toUpperCase(), input.name.trim(), input.category?.trim() || "general",
      JSON.stringify(input.config ?? {}),
      input.educationModule ? 1 : 0,
      input.defaultReplyAction ?? "draft",
      input.qualificationGate ? 1 : 0,
      input.autoAdmit ? 1 : 0,
      JSON.stringify(input.educationModule ? EDUCATION_STAGE_PRESET : GENERIC_STAGE_PRESET),
      JSON.stringify(input.educationModule ? EDUCATION_QUEUE_PRESET : GENERIC_QUEUE_PRESET),
    );
    return this.getCaseType(input.code, organizationId)!;
  }

  getCaseType(code: string, organizationId = 1): CaseType | undefined {
    const row = this.db.prepare("SELECT id, organization_id, code, name, category, config, active, education_module, terminology, stages, queues, config_version, default_reply_action, qualification_gate, auto_admit FROM case_types WHERE organization_id = ? AND code = ? COLLATE NOCASE")
      .get(organizationId, code.trim()) as (Omit<CaseType, "config" | "terminology" | "stages" | "queues"> & { config: string; terminology: string; stages: string; queues: string }) | undefined;
    return row ? this.rowToCaseType(row) : undefined;
  }

  private rowToCaseType(row: Omit<CaseType, "config" | "terminology" | "stages" | "queues"> & { config: string; terminology: string; stages: string; queues: string }): CaseType {
    let config: Record<string, unknown> = {};
    try { config = JSON.parse(row.config || "{}"); } catch { /* safe empty config */ }
    let terminology: Record<string, string> = {};
    try { terminology = JSON.parse(row.terminology || "{}"); } catch { /* safe empty */ }
    let stages: Array<{ id: string; label: string }> = [];
    try { stages = JSON.parse(row.stages || "[]"); } catch { /* safe empty */ }
    let queues: Array<{ id: string; label: string }> = [];
    try { queues = JSON.parse(row.queues || "[]"); } catch { /* safe empty */ }
    return { ...row, config, terminology, stages, queues };
  }

  listCaseTypes(organizationId = 1): CaseType[] {
    const rows = this.db.prepare("SELECT code FROM case_types WHERE organization_id = ? AND active = 1 ORDER BY code").all(organizationId) as Array<{ code: string }>;
    return rows.map((r) => this.getCaseType(r.code, organizationId)!).filter(Boolean);
  }

  /** Look a workflow profile up by its row id (any organization). */
  caseTypeById(id: number): CaseType | undefined {
    const row = this.db.prepare("SELECT organization_id, code FROM case_types WHERE id = ?").get(id) as { organization_id: number; code: string } | undefined;
    return row ? this.getCaseType(row.code, row.organization_id) : undefined;
  }

  listCases(organizationId?: number): ApplicantRow[] {
    // `0` is retained as the legacy live-realm selector used by the old
    // dashboard; organization ids are positive and use the canonical path.
    if (organizationId === 0) return this.allApplicants(0);
    const sql = organizationId === undefined
      ? "SELECT a.* FROM applicants a ORDER BY a.id"
      : "SELECT a.* FROM applicants a WHERE COALESCE(a.organization_id, 1) = ? ORDER BY a.id";
    return (organizationId === undefined ? this.db.prepare(sql).all() : this.db.prepare(sql).all(organizationId)) as ApplicantRow[];
  }

  getCase(id: number): ApplicantRow | undefined { return this.getApplicant(id); }

  listCasesForStaff(staff: { id: number; role: string; organization_id?: number | null }): ApplicantRow[] {
    return this.listCases(staff.organization_id ?? 1).filter((a) => this.caseTypeVisibleTo(staff, a) && this.applicantVisibleTo(staff, a));
  }

  caseTypeForCase(id: number): CaseType | undefined {
    const row = this.db.prepare("SELECT case_type_id FROM applicants WHERE id = ?").get(id) as { case_type_id?: number | null } | undefined;
    return row?.case_type_id ? this.getCaseTypeById(row.case_type_id) : undefined;
  }

  private getCaseTypeById(id: number): CaseType | undefined {
    const row = this.db.prepare("SELECT organization_id, code FROM case_types WHERE id = ?").get(id) as { organization_id: number; code: string } | undefined;
    return row ? this.getCaseType(row.code, row.organization_id) : undefined;
  }

  listDocumentDefinitions(caseTypeId: number): DocumentDefinition[] {
    type Row = Omit<DocumentDefinition, "required" | "blocking"> & { required: number; blocking: number };
    return (this.db.prepare("SELECT id, case_type_id, key, label, required, blocking, position FROM document_definitions WHERE case_type_id = ? ORDER BY position, id").all(caseTypeId) as Row[])
      .map((d) => ({ ...d, required: !!d.required, blocking: !!d.blocking }));
  }

  upsertDocumentDefinition(caseTypeId: number, input: { key: string; label: string; required?: boolean; blocking?: boolean; position?: number }): void {
    const key = input.key.trim().toLowerCase().replace(/[^a-z0-9_:-]+/g, "_");
    if (!key || !input.label.trim()) throw new Error("Document key and label are required");
    this.db.prepare(
      "INSERT INTO document_definitions (case_type_id, key, label, required, blocking, position) VALUES (?,?,?,?,?,?) " +
      "ON CONFLICT(case_type_id,key) DO UPDATE SET label=excluded.label, required=excluded.required, blocking=excluded.blocking, position=excluded.position"
    ).run(caseTypeId, key, input.label.trim(), input.required === false ? 0 : 1, input.blocking === false ? 0 : 1, input.position ?? 0);
    this.bumpCaseTypeConfigVersion(caseTypeId);
  }

  deleteDocumentDefinition(caseTypeId: number, key: string): void {
    this.db.prepare("DELETE FROM document_definitions WHERE case_type_id = ? AND key = ?").run(caseTypeId, key.trim().toLowerCase());
    this.bumpCaseTypeConfigVersion(caseTypeId);
  }

  updateCaseTypeRules(caseTypeId: number, nodes: RuleNode[]): void {
    const row = this.db.prepare("SELECT config FROM case_types WHERE id = ?").get(caseTypeId) as { config?: string } | undefined;
    let config: Record<string, unknown> = {};
    try { config = JSON.parse(row?.config || "{}"); } catch { /* replace corrupt config safely */ }
    config.rules = nodes;
    this.db.prepare("UPDATE case_types SET config = ? WHERE id = ?").run(JSON.stringify(config), caseTypeId);
    this.bumpCaseTypeConfigVersion(caseTypeId);
  }

  caseTypeRules(caseType: CaseType): RuleNode[] {
    const raw = caseType.config?.rules;
    return Array.isArray(raw) ? raw as RuleNode[] : [];
  }

  // ── PPR P0-3: configuration versioning + per-case freeze ─────────────────
  /** Publishing rules/documents for a profile bumps its configuration version. */
  bumpCaseTypeConfigVersion(caseTypeId: number): number {
    this.db.prepare("UPDATE case_types SET config_version = config_version + 1 WHERE id = ?").run(caseTypeId);
    return this.caseTypeConfigVersion(caseTypeId);
  }

  caseTypeConfigVersion(caseTypeId: number): number {
    const row = this.db.prepare("SELECT config_version FROM case_types WHERE id = ?").get(caseTypeId) as { config_version?: number } | undefined;
    return row?.config_version ?? 1;
  }

  /**
   * Freeze the exact profile configuration a case is opened under. Existing
   * snapshots are immutable — later edits never rewrite them (audit F6).
   */
  freezeCaseConfig(a: ApplicantRow): void {
    if (a.case_config_frozen) return;
    const caseType = this.caseTypeForCase(a.id);
    const frozen: CaseConfigFrozen = {
      config_version: caseType?.config_version ?? 1,
      rules: caseType ? this.caseTypeRules(caseType) : null,
      documents: caseType ? this.listDocumentDefinitions(caseType.id).map((d) => ({ key: d.key, label: d.label, required: d.required, blocking: d.blocking })) : null,
      frozen_at: nowIso(),
    };
    this.db.prepare("UPDATE applicants SET case_config_frozen = ?, config_version_frozen = ?, config_version_frozen_at = ? WHERE id = ?")
      .run(JSON.stringify(frozen), frozen.config_version, frozen.frozen_at, a.id);
  }

  /** The frozen configuration snapshot of a case (null for legacy rows). */
  caseConfigFrozen(a: ApplicantRow): CaseConfigFrozen | null {
    if (!a.case_config_frozen) return null;
    try { return JSON.parse(a.case_config_frozen) as CaseConfigFrozen; } catch { return null; }
  }

  /** Explicit, human-approved upgrade of a case to the profile's CURRENT
   * configuration version. Never happens implicitly (PPR P0-3). */
  reFreezeCaseConfig(a: ApplicantRow): CaseConfigFrozen {
    this.db.prepare("UPDATE applicants SET case_config_frozen = NULL WHERE id = ?").run(a.id);
    this.freezeCaseConfig({ ...a, case_config_frozen: null } as ApplicantRow);
    return this.caseConfigFrozen(this.getApplicant(a.id)!)!;
  }

  /** PPR P0-2: is this case an education-module case? */
  educationCaseFor(a: ApplicantRow): boolean {
    if (a.case_type_id) {
      const t = this.getCaseTypeById(a.case_type_id);
      return t ? t.education_module === 1 : false;
    }
    return (a.organization_id ?? 1) === 1;
  }

  /** PPR P0-2: does this organization run any education-module profile? */
  hasEducationModule(organizationId = 1): boolean {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM case_types WHERE organization_id = ? AND education_module = 1").get(organizationId) as { n: number };
    return row.n > 0;
  }

  // ── PPR P0-4: workflow rules (intake + response behaviour as data) ───────

  listWorkflowRules(organizationId = 1, opts: { caseTypeId?: number | null; kind?: "intake" | "response" } = {}): WorkflowRule[] {
    let sql = "SELECT * FROM workflow_rules WHERE organization_id = ?";
    const params: unknown[] = [organizationId];
    if (opts.caseTypeId !== undefined) {
      if (opts.caseTypeId === null) {
        sql += " AND case_type_id IS NULL";
      } else {
        sql += " AND (case_type_id = ? OR case_type_id IS NULL)";
        params.push(opts.caseTypeId);
      }
    }
    if (opts.kind) {
      sql += " AND kind = ?";
      params.push(opts.kind);
    }
    sql += " ORDER BY position, id";
    const rows = this.db.prepare(sql).all(...params) as Array<Omit<WorkflowRule, "conditions" | "action"> & { conditions: string; action: string }>;
    return rows.map((r) => {
      let conditions: WorkflowRule["conditions"] = [];
      let action: WorkflowRule["action"] = {};
      try { conditions = JSON.parse(r.conditions || "[]"); } catch { /* safe empty */ }
      try { action = JSON.parse(r.action || "{}"); } catch { /* safe empty */ }
      return { ...r, conditions, action };
    });
  }

  getWorkflowRule(id: number): WorkflowRule | undefined {
    const row = this.db.prepare("SELECT * FROM workflow_rules WHERE id = ?").get(id) as (Omit<WorkflowRule, "conditions" | "action"> & { conditions: string; action: string }) | undefined;
    if (!row) return undefined;
    let conditions: WorkflowRule["conditions"] = [];
    let action: WorkflowRule["action"] = {};
    try { conditions = JSON.parse(row.conditions || "[]"); } catch { /* safe empty */ }
    try { action = JSON.parse(row.action || "{}"); } catch { /* safe empty */ }
    return { ...row, conditions, action };
  }

  saveWorkflowRule(input: {
    id?: number; organizationId: number; caseTypeId?: number | null; kind?: "intake" | "response";
    name: string; position?: number; enabled?: boolean; conditions: WorkflowRule["conditions"]; action: WorkflowRule["action"];
  }): WorkflowRule {
    const name = input.name.trim();
    if (!name) throw new Error("Rule name is required");
    const kind = input.kind ?? "intake";
    if (input.id) {
      this.db.prepare(
        "UPDATE workflow_rules SET name = ?, kind = ?, case_type_id = ?, position = ?, enabled = ?, conditions = ?, action = ?, updated_at = datetime('now') WHERE id = ? AND organization_id = ?"
      ).run(name, kind, input.caseTypeId ?? null, input.position ?? 0, input.enabled === false ? 0 : 1,
        JSON.stringify(input.conditions ?? []), JSON.stringify(input.action ?? {}), input.id, input.organizationId);
    } else {
      const nextPos = input.position ?? ((this.db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM workflow_rules WHERE organization_id = ?").get(input.organizationId) as { p: number }).p);
      this.db.prepare(
        "INSERT INTO workflow_rules (organization_id, case_type_id, kind, name, position, enabled, conditions, action) VALUES (?,?,?,?,?,?,?,?)"
      ).run(input.organizationId, input.caseTypeId ?? null, kind, name, nextPos, input.enabled === false ? 0 : 1,
        JSON.stringify(input.conditions ?? []), JSON.stringify(input.action ?? {}));
    }
    const saved = this.db.prepare("SELECT id FROM workflow_rules WHERE organization_id = ? AND name = ? ORDER BY id DESC").get(input.organizationId, name) as { id: number };
    // Rule edits are configuration publishes (PPR P0-3).
    if (input.caseTypeId) this.bumpCaseTypeConfigVersion(input.caseTypeId);
    return this.listWorkflowRules(input.organizationId, {}).find((r) => r.id === saved.id)!;
  }

  deleteWorkflowRule(id: number, organizationId = 1): void {
    const row = this.db.prepare("SELECT case_type_id FROM workflow_rules WHERE id = ? AND organization_id = ?").get(id, organizationId) as { case_type_id: number | null } | undefined;
    this.db.prepare("DELETE FROM workflow_rules WHERE id = ? AND organization_id = ?").run(id, organizationId);
    if (row?.case_type_id) this.bumpCaseTypeConfigVersion(row.case_type_id);
  }

  /** PPR P0-4/P1: profile-level automation defaults (workflow profile card). */
  updateCaseTypeProfile(id: number, patch: { default_reply_action?: "auto" | "draft"; qualification_gate?: 0 | 1; auto_admit?: 0 | 1 }): void {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.default_reply_action !== undefined) { sets.push("default_reply_action = ?"); params.push(patch.default_reply_action); }
    if (patch.qualification_gate !== undefined) { sets.push("qualification_gate = ?"); params.push(patch.qualification_gate); }
    if (patch.auto_admit !== undefined) { sets.push("auto_admit = ?"); params.push(patch.auto_admit); }
    if (!sets.length) return;
    this.db.prepare(`UPDATE case_types SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
  }

  /** PPR P1-1/P1-2: profile vocabulary (five surface words) + stage/queue sets.
   *  Internal ids never move — only labels and membership are edited. */
  updateCaseTypeVocabulary(id: number, patch: {
    terminology?: Record<string, string>;
    stages?: Array<{ id: string; label: string; requires?: string[] }>;
    queues?: Array<{ id: string; label: string }>;
  }): void {
    const current = this.caseTypeById(id);
    if (!current) throw new Error("Unknown workflow profile");
    const terminology = patch.terminology ?? current.terminology;
    const stages = patch.stages ?? current.stages;
    const queues = patch.queues ?? current.queues;
    this.db.prepare("UPDATE case_types SET terminology = ?, stages = ?, queues = ? WHERE id = ?")
      .run(JSON.stringify(terminology), JSON.stringify(stages), JSON.stringify(queues), id);
    this.bumpCaseTypeConfigVersion(id);
  }

  // ── PPR P0-5: attachment sets (organization-owned groups of sendable files) ──

  listAttachmentSets(organizationId = 1): Array<AttachmentSet & { file_count: number; bytes: number }> {
    const rows = this.db.prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM attachment_set_files f WHERE f.set_id = s.id) AS file_count,
              (SELECT COALESCE(SUM(LENGTH(f.content)), 0) FROM attachment_set_files f WHERE f.set_id = s.id) AS bytes
       FROM attachment_sets s WHERE s.organization_id = ? ORDER BY s.position, s.id`
    ).all(organizationId) as never[];
    return rows as never[];
  }

  getAttachmentSet(id: number): AttachmentSet | undefined {
    return this.db.prepare("SELECT * FROM attachment_sets WHERE id = ?").get(id) as never;
  }

  attachmentSetByName(organizationId: number, name: string): AttachmentSet | undefined {
    return this.db.prepare("SELECT * FROM attachment_sets WHERE organization_id = ? AND name = ?").get(organizationId, name) as never;
  }

  createAttachmentSet(organizationId: number, name: string, description = ""): AttachmentSet {
    const clean = name.trim();
    if (!clean) throw new Error("Set name is required");
    const nextPos = (this.db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM attachment_sets WHERE organization_id = ?").get(organizationId) as { p: number }).p;
    this.db.prepare("INSERT INTO attachment_sets (organization_id, name, description, position) VALUES (?,?,?,?)").run(organizationId, clean, description.trim(), nextPos);
    return this.attachmentSetByName(organizationId, clean)!;
  }

  deleteAttachmentSet(id: number, organizationId = 1): void {
    this.db.prepare("DELETE FROM attachment_sets WHERE id = ? AND organization_id = ?").run(id, organizationId);
  }

  addAttachmentSetFile(setId: number, file: { filename: string; mime?: string; content: Buffer; provenance?: string }): number {
    const nextPos = (this.db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM attachment_set_files WHERE set_id = ?").get(setId) as { p: number }).p;
    this.db.prepare("INSERT INTO attachment_set_files (set_id, filename, mime, content, provenance, position) VALUES (?,?,?,?,?,?)")
      .run(setId, file.filename, file.mime ?? "application/pdf", file.content, file.provenance ?? "uploaded", nextPos);
    this.db.prepare("UPDATE attachment_sets SET updated_at = datetime('now') WHERE id = ?").run(setId);
    return (this.db.prepare("SELECT id FROM attachment_set_files WHERE set_id = ? ORDER BY id DESC LIMIT 1").get(setId) as { id: number }).id;
  }

  listAttachmentSetFiles(setId: number): Array<{ id: number; filename: string; mime: string; content: Buffer; provenance: string }> {
    return this.db.prepare("SELECT id, filename, mime, content, provenance FROM attachment_set_files WHERE set_id = ? ORDER BY position, id").all(setId) as never;
  }

  deleteAttachmentSetFile(id: number): void {
    this.db.prepare("DELETE FROM attachment_set_files WHERE id = ?").run(id);
  }

  /**
   * PPR P0-5: resolve an attachment reference to the exact files that ride
   * along. A reference is a set name owned by the organization (or `set:<id>`).
   * Only the sending organization's own sets resolve — there is no global or
   * bundled fallback (the migrated education profile's sets were seeded from
   * its own migration data at setup time).
   */
  attachmentSetFiles(organizationId: number, ref: string | null | undefined): { label: string; files: Array<{ filename: string; mimeType: string; content: Buffer }>; issues: string[] } {
    const issues: string[] = [];
    const label = (ref ?? "").trim();
    if (!label || label === "none") return { label: "none", files: [], issues };
    let set: AttachmentSet | undefined;
    if (label.startsWith("set:")) set = this.getAttachmentSet(Number(label.slice(4)));
    else set = this.attachmentSetByName(organizationId, label);
    if (!set || set.organization_id !== organizationId) {
      return { label, files: [], issues: [`Attachment set '${label}' does not exist for this organization`] };
    }
    const files = this.listAttachmentSetFiles(set.id)
      .filter((f) => f.content && f.filename)
      .map((f) => ({ filename: f.filename, mimeType: f.mime || "application/pdf", content: f.content }));
    if (!files.length) issues.push(`Attachment set '${set.name}' is empty`);
    return { label: set.name, files, issues };
  }

  listOrganizationDocumentAxes(organizationId = 1): Array<{ key: string; label: string; values: string[] }> {
    const rows = this.db.prepare("SELECT axis_key, label, values_json FROM organization_document_axes WHERE organization_id = ? ORDER BY axis_key").all(organizationId) as Array<{ axis_key: string; label: string; values_json: string }>;
    return rows.map((r) => {
      let values: string[] = [];
      try { values = JSON.parse(r.values_json) as string[]; } catch { /* safe empty axis */ }
      return { key: r.axis_key, label: r.label, values };
    });
  }

  replaceOrganizationDocumentAxes(organizationId: number, axes: Array<{ key: string; label: string; values: string[] }>): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM organization_document_axes WHERE organization_id = ?").run(organizationId);
      const insert = this.db.prepare("INSERT INTO organization_document_axes (organization_id, axis_key, label, values_json) VALUES (?,?,?,?)");
      for (const axis of axes) insert.run(organizationId, axis.key.trim(), axis.label.trim(), JSON.stringify([...new Set(axis.values.map((v) => v.trim()).filter(Boolean))]));
    })();
  }

  replaceDocumentDefinitions(caseTypeId: number, definitions: Array<{ key: string; label: string; required: boolean; blocking: boolean }>): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM document_definitions WHERE case_type_id = ?").run(caseTypeId);
      const insert = this.db.prepare("INSERT INTO document_definitions (case_type_id, key, label, required, blocking, position) VALUES (?,?,?,?,?,?)");
      definitions.forEach((d, position) => insert.run(caseTypeId, d.key.trim(), d.label.trim(), d.required ? 1 : 0, d.blocking ? 1 : 0, position));
    })();
    this.bumpCaseTypeConfigVersion(caseTypeId);
  }

  listEmailCategories(organizationId = 1): Array<{ id: number; organization_id: number; key: string; label: string; active: number }> {
    return this.db.prepare("SELECT id, organization_id, key, label, active FROM organization_categories WHERE organization_id = ? AND active = 1 ORDER BY id").all(organizationId) as never[];
  }

  addEmailCategory(organizationId: number, input: { key: string; label: string }): void {
    this.db.prepare("INSERT INTO organization_categories (organization_id, key, label) VALUES (?,?,?) ON CONFLICT(organization_id, key) DO UPDATE SET label=excluded.label, active=1")
      .run(organizationId, input.key.trim(), input.label.trim());
  }

  listOrganizationPackSlots(organizationId = 1): Array<{ organization_id: number; key: string; filename: string | null; mime: string | null; content: Buffer | null }> {
    const keys = [
      "application-form", "brochure-2026", "student-medical-form", "data-protection-form",
      "next-of-kin-form", "hostels-list", "fee-structure-2026", "sponsorship-form",
      "orientation-programme-2026", "credit-transfer-form",
      // Compatibility aliases for pre-WLR uploads; new UI writes concrete slots.
      "application", "admission", "brochure", "transfer",
    ];
    const rows = this.db.prepare("SELECT organization_id, key, filename, mime, content FROM organization_pack_slots WHERE organization_id = ? ORDER BY key").all(organizationId) as Array<{ organization_id: number; key: string; filename: string | null; mime: string | null; content: Buffer | null }>;
    const byKey = new Map(rows.map((r) => [r.key, r]));
    return keys.map((key) => byKey.get(key) ?? { organization_id: organizationId, key, filename: null, mime: null, content: null });
  }

  setOrganizationPackSlot(organizationId: number, key: string, file: { filename: string; mime: string; content: Buffer }): void {
    this.db.prepare("INSERT INTO organization_pack_slots (organization_id, key, filename, mime, content, updated_at) VALUES (?,?,?,?,?,datetime('now')) ON CONFLICT(organization_id,key) DO UPDATE SET filename=excluded.filename, mime=excluded.mime, content=excluded.content, updated_at=datetime('now')")
      .run(organizationId, key, file.filename, file.mime, file.content);
  }

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
    opts: { fullName?: string; refPrefix?: string; organizationId?: number; caseTypeCode?: string } = {}
  ): ApplicantRow {
    const addr = emailAddress.trim().toLowerCase();
    const organizationId = opts.organizationId ?? 1;
    const refPrefix = opts.refPrefix ?? this.organizationRefPrefix(organizationId);
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
      const ref = this.nextRefNumber(refPrefix, new Date().getFullYear());
      insert.run(ref, addr, threadId, opts.fullName ?? null);
      row = select.get(addr, threadId) as ApplicantRow;
      created = true;
    })();
    // The transaction ran synchronously; row is always set here.
    let applicant = row as ApplicantRow;
    const caseType = opts.caseTypeCode ? this.getCaseType(opts.caseTypeCode, organizationId) : this.getCaseType("GENERAL", organizationId);
    if (caseType && (!applicant.organization_id || !applicant.case_type_id)) {
      this.db.prepare("UPDATE applicants SET organization_id = ?, case_type_id = ? WHERE id = ?")
        .run(organizationId, caseType.id, applicant.id);
      applicant = this.getApplicant(applicant.id)!;
    }
    if (created) {
      this.audit(applicant.id, "system", "applicant_created", `Case ${applicant.ref_number} opened for ${addr}`);
    }
    return applicant;
  }

  /** Canonical generic entry point; Applicant terminology is retained only
   * in the compatibility implementation above. */
  createCase(input: { emailAddress: string; threadId: string; organizationId?: number; caseTypeCode?: string; fullName?: string; refPrefix?: string }): ApplicantRow {
    return this.getOrCreateApplicant(input.emailAddress, input.threadId, input);
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
        | "queue"
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
      "lifecycle", "triage", "queue", "sla_due_at", "sla_handled_at", "escalated",
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
    if (Object.prototype.hasOwnProperty.call(patch, "admission_decision")) {
      const decision = patch.admission_decision;
      const outcome = decision === "auto_admitted" ? "auto_approved" : decision === "admitted_after_review" ? "approved_after_review" : decision === "not_admitted" ? "not_approved" : "undecided";
      this.db.prepare("UPDATE applicants SET outcome = ? WHERE id = ?").run(outcome, id);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "programme")) {
      this.db.prepare("UPDATE applicants SET category = programme WHERE id = ?").run(id);
    }
  }

  updateCase(id: number, patch: { category?: string | null; outcome?: CaseOutcome; case_type_id?: number | null }): void {
    const allowed = Object.keys(patch);
    if (allowed.some((key) => !["category", "outcome", "case_type_id"].includes(key))) throw new Error("updateCase: refusing unknown column");
    if (patch.category !== undefined) this.db.prepare("UPDATE applicants SET category = ? WHERE id = ?").run(patch.category, id);
    if (patch.case_type_id !== undefined) this.db.prepare("UPDATE applicants SET case_type_id = ? WHERE id = ?").run(patch.case_type_id, id);
    if (patch.outcome !== undefined) {
      const legacy = patch.outcome === "auto_approved" ? "auto_admitted" : patch.outcome === "approved_after_review" ? "admitted_after_review" : patch.outcome === "not_approved" ? "not_admitted" : "undecided";
      this.db.prepare("UPDATE applicants SET outcome = ?, admission_decision = ?, updated_at = ? WHERE id = ?").run(patch.outcome, legacy, nowIso(), id);
    }
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
    const caseType = this.caseTypeForCase(a.id);
    // PPR P0-2: the education_module flag is the switch. A profile without
    // the module NEVER sees the academic document matrix (audit F1/E4); it
    // uses only organization-owned document slots. Untyped legacy cases of
    // the migrated Organization #1 keep the academic compatibility path.
    const education = caseType ? caseType.education_module === 1 : (a.organization_id ?? 1) === 1;
    if (!education) {
      return caseType
        ? this.listDocumentDefinitions(caseType.id).map((d) => ({
            document_type: d.key as DocType, required: d.required, blocking: d.blocking,
          }))
        : [];
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
  /** Conversations per mail-window page (round 9: All Mail is paginated, not capped). */
  static MAIL_PAGE_SIZE = 50;

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
    schools?: string[] | null; demo?: number; q?: string; unreadOnly?: boolean; page?: number; folder?: string;
  }): Array<EmailRecord & { tkey: string; thread_n: number; unread_n: number; star_n: number; imp_n: number; a_name: string | null; a_email: string | null; ref_number: string | null; programme: string | null; lifecycle: string | null }> {
    // Parked applicant-less mail has no school to match. It must not bypass
    // an explicitly empty staff scope and become a data leak in All Mail.
    if (isNoAccess(opts.schools)) return [];
    const where: string[] = [];
    const params: unknown[] = [];
    // Round 9: applicant rows are realm- and school-scoped through the join;
    // PARKED rows (applicant_id NULL — the intake hotword gate) carry no
    // school of their own, so they are visible to live accounts only.
    const demo = opts.demo ?? 0;
    const appConds: string[] = [];
    if (opts.demo !== undefined) { appConds.push("a.demo = ?"); params.push(opts.demo); }
    const scope = this.scopePred("a", opts.schools);
    if (scope.sql) { appConds.push(scope.sql.replace(/^ AND /, "")); params.push(...scope.params); }
    const appCondSql = appConds.length ? appConds.join(" AND ") : "1=1";
    // DEMO: parked (caseless) mail arrives on Organization #1's mailbox —
    // it is never shown inside another organization's workspace.
    const parkedOrgOk = ((opts.schools as ScopeTag | null | undefined)?.organizationId ?? 1) === 1 ? 1 : 0;
    where.push(`((e.applicant_id IS NOT NULL AND ${appCondSql}) OR (e.applicant_id IS NULL AND ${demo} = 0 AND ${parkedOrgOk} = 1))`);
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
        FROM emails e LEFT JOIN applicants a ON a.id = e.applicant_id
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
      ORDER BY agg.last_at DESC, k.id DESC
      LIMIT ${Repo.MAIL_PAGE_SIZE} OFFSET ${(Math.max(1, Math.floor(opts.page ?? 1)) - 1) * Repo.MAIL_PAGE_SIZE}`;
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
    if (isNoAccess(opts.schools)) {
      return Object.fromEntries(Object.keys(Repo.MAIL_FOLDER_WHERE).map((folder) => [folder, 0]));
    }
    const where: string[] = [];
    const params: unknown[] = [];
    // Round 9: same realm rule as mailThreads — parked (applicant-less)
    // mail counts for live accounts only.
    const demo = opts.demo ?? 0;
    const appConds: string[] = [];
    if (opts.demo !== undefined) { appConds.push("a.demo = ?"); params.push(opts.demo); }
    const scope = this.scopePred("a", opts.schools);
    if (scope.sql) { appConds.push(scope.sql.replace(/^ AND /, "")); params.push(...scope.params); }
    const appCondSql = appConds.length ? appConds.join(" AND ") : "1=1";
    // DEMO: parked (caseless) mail arrives on Organization #1's mailbox —
    // it is never shown inside another organization's workspace.
    const parkedOrgOk = ((opts.schools as ScopeTag | null | undefined)?.organizationId ?? 1) === 1 ? 1 : 0;
    where.push(`((e.applicant_id IS NOT NULL AND ${appCondSql}) OR (e.applicant_id IS NULL AND ${demo} = 0 AND ${parkedOrgOk} = 1))`);
    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
    const row = this.db.prepare(`
      WITH keyed AS (
        SELECT e.direction, e.read, e.labels,
               COALESCE(NULLIF(e.thread_id, ''), 'email-' || e.id) AS tkey
        FROM emails e LEFT JOIN applicants a ON a.id = e.applicant_id
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
        "INSERT INTO staff_users (username, display_name, password_hash, role, demo, organization_id) VALUES (?,?,?,?,?,?)"
      )
      .run(username, displayName, passwordHash, role, demo ? 1 : 0, 1);
  }

  createStaffAndReturn(username: string, displayName: string, passwordHash: string, role: "admin" | "user" = "user"): StaffUser {
    this.createStaff(username, displayName, passwordHash, role);
    return this.getStaffByUsername(username)!;
  }

  // ── PPR P1-8: fine-grained automation permissions ───────────────────────
  // The four actions that used to hide behind the admin/user role split are
  // distinct permissions now. Admins implicitly hold all four; other staff
  // hold exactly what is granted, defaulting to the two sending-related ones
  // (sending replies and approving automation were always staff work).

  permissionsFor(staffId: number): string[] {
    return (this.db.prepare("SELECT permission FROM staff_permissions WHERE staff_id = ?").all(staffId) as Array<{ permission: string }>).map((r) => r.permission);
  }

  setPermissions(staffId: number, permissions: string[]): void {
    this.db.prepare("DELETE FROM staff_permissions WHERE staff_id = ?").run(staffId);
    const insert = this.db.prepare("INSERT OR IGNORE INTO staff_permissions (staff_id, permission) VALUES (?, ?)");
    for (const p of permissions) {
      if (PERMISSIONS.includes(p as Permission)) insert.run(staffId, p);
    }
  }

  hasPermission(staffId: number, permission: Permission): boolean {
    const staff = this.getStaff(staffId);
    if (!staff) return false;
    if (staff.role === "admin") return true;
    const rows = this.db.prepare("SELECT COUNT(*) AS n FROM staff_permissions WHERE staff_id = ?").get(staffId) as { n: number };
    if (rows.n > 0) {
      return (this.db.prepare("SELECT 1 FROM staff_permissions WHERE staff_id = ? AND permission = ?").get(staffId, permission)) !== undefined;
    }
    // No explicit grants yet: the historical default — regular staff may
    // send replies and approve automation; publishing rules and recording
    // outcomes need an explicit grant.
    return permission === "send_automated" || permission === "approve_automation";
  }

  /** Rename an account (e.g. giving the demo admin a human name). */
  setStaffDisplayName(id: number, displayName: string): void {
    this.db.prepare("UPDATE staff_users SET display_name = ? WHERE id = ?").run(displayName, id);
  }

  getStaffByUsername(username: string): (StaffUser & { password_hash: string }) | undefined {
    return this.db
      .prepare("SELECT id, username, display_name, password_hash, role, active, demo, organization_id FROM staff_users WHERE username = ?")
      .get(username) as never;
  }

  getStaff(id: number): StaffUser | undefined {
    return this.db
      .prepare("SELECT id, username, display_name, role, active, demo, organization_id FROM staff_users WHERE id = ?")
      .get(id) as StaffUser | undefined;
  }

  listStaff(): StaffUser[] {
    return this.db
      .prepare("SELECT id, username, display_name, role, active, demo, organization_id FROM staff_users ORDER BY id")
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
                u.display_name AS display_name, u.role AS role, u.active AS active, u.demo AS demo,
                u.organization_id AS organization_id, u.active_organization_id AS active_organization_id
         FROM sessions s JOIN staff_users u ON u.id = s.staff_id
         WHERE s.token = ?`
      )
      .get(token) as any;
    if (!row) return undefined;
    if (new Date(row.expires_at).getTime() < Date.now() || row.active !== 1) return undefined;
    return {
      csrf: row.csrf,
      staff: (() => {
        const home = row.organization_id ?? null;
        const canSwitch = row.role === "admin" && (home === null || home === 1);
        const active = canSwitch && row.active_organization_id && this.getOrganization(row.active_organization_id) ? row.active_organization_id : home;
        return { id: row.id, username: row.username, display_name: row.display_name, role: row.role, active: row.active, demo: row.demo, organization_id: active, can_switch_org: canSwitch };
      })(),
    };
  }

  deleteSession(token: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
  }

  /**
   * One-time admin-issued password reset codes (forgot password).
   *
   * The code is shown exactly ONCE, in the issuing admin's response body
   * (never a URL — no history/referrer leakage), and travels out-of-band
   * to the member. It is valid until `expires_at`, is revoked the moment a
   * newer code is issued for the same member, and is consumed exactly once
   * by the public reset route.
   */
  issueResetCode(staffId: number, issuedBy: string, ttlMs = 30 * 60_000): string {
    // No 0/O/1/I — codes get read over the phone and typed from WhatsApp.
    const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    let code = "";
    for (;;) {
      code = Array.from(crypto.randomBytes(10)).map((b) => alphabet[b % alphabet.length]).join("");
      if (!this.db.prepare("SELECT 1 FROM password_reset_codes WHERE code = ?").get(code)) break;
    }
    const now = new Date().toISOString();
    this.db
      .transaction(() => {
        this.db
          .prepare("UPDATE password_reset_codes SET revoked_at = ? WHERE staff_id = ? AND used_at IS NULL AND revoked_at IS NULL")
          .run(now, staffId);
        this.db
          .prepare("INSERT INTO password_reset_codes (code, staff_id, issued_by, expires_at) VALUES (?,?,?,?)")
          .run(code, staffId, issuedBy, new Date(Date.now() + ttlMs).toISOString());
      })();
    return code;
  }

  /**
   * Atomically consume a code. Returns the member id it belongs to, or null
   * when the code is unknown, revoked, expired, or already used. The UPDATE
   * is the single point of claim, so two racing redemptions can't both win.
   */
  consumeResetCode(code: string): number | null {
    const trimmed = code.trim().toUpperCase();
    const now = new Date().toISOString();
    const r = this.db
      .prepare("UPDATE password_reset_codes SET used_at = ? WHERE code = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?")
      .run(now, trimmed, now);
    if (Number(r.changes) === 0) return null;
    const row = this.db.prepare("SELECT staff_id FROM password_reset_codes WHERE code = ?").get(trimmed) as { staff_id: number };
    return row.staff_id;
  }

  /** End every live session of a member (always run after their password changes). */
  purgeStaffSessions(staffId: number): number {
    const r = this.db.prepare("DELETE FROM sessions WHERE staff_id = ?").run(staffId);
    return Number(r.changes);
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

  getTemplate(key: string, organizationId = 1, caseTypeId?: number): { key: string; name: string; subject: string; body: string; include_banner: number; attach_pack: string; case_type_id: number } | undefined {
    // PPR P0-6 precedence: the profile's own row → organization-wide row →
    // the migrated education profile's legacy store. A template key is not a
    // closed enum — any key a profile needs can exist and shadow freely.
    const rows = this.db.prepare(
      "SELECT key, name, subject, body, include_banner, attach_pack, case_type_id FROM organization_templates WHERE organization_id = ? AND key = ?"
    ).all(organizationId, key) as never[];
    const typed = rows as Array<{ case_type_id: number }>;
    // case_type_id = 0 → organization-wide; > 0 → ONLY that profile's cases.
    // An explicit caseTypeId never picks up another profile's template.
    const scoped = caseTypeId !== undefined
      ? typed.find((r) => r.case_type_id === caseTypeId) ?? typed.find((r) => r.case_type_id === 0)
      : typed[0];
    if (scoped) return scoped as never;
    const legacy = this.db.prepare(
      "SELECT key, name, subject, body, include_banner, attach_pack, 0 AS case_type_id FROM templates WHERE key = ? AND COALESCE(organization_id, 1) = ?"
    ).get(key, organizationId) as never;
    return legacy ?? undefined;
  }

  listTemplates(organizationId = 1): Array<{ key: string; name: string; subject: string; body: string; include_banner: number; attach_pack: string; case_type_id: number }> {
    const owned = this.db.prepare("SELECT key, name, subject, body, include_banner, attach_pack, case_type_id FROM organization_templates WHERE organization_id = ? ORDER BY key").all(organizationId) as any[];
    const legacy = this.db.prepare("SELECT key, name, subject, body, include_banner, attach_pack, 0 AS case_type_id FROM templates WHERE COALESCE(organization_id, 1) = ? ORDER BY key").all(organizationId) as any[];
    const byKey = new Map([...legacy, ...owned].map((row: any) => [row.key, row]));
    return [...byKey.values()] as never[];
  }

  /** PPR P0-6: the profile's own default, captured when the template was
   *  created — "Reset to default" restores exactly this, never someone
   *  else's wording. */
  templateDefaultSnapshot(key: string, organizationId = 1): { name: string; subject: string; body: string; include_banner: number; attach_pack: string } | null {
    const row = (this.db.prepare("SELECT default_snapshot FROM organization_templates WHERE organization_id = ? AND key = ?").get(organizationId, key)
      ?? this.db.prepare("SELECT default_snapshot FROM templates WHERE key = ? AND COALESCE(organization_id, 1) = ?").get(key, organizationId)) as { default_snapshot: string | null } | undefined;
    if (!row?.default_snapshot) return null;
    try { return JSON.parse(row.default_snapshot); } catch { return null; }
  }

  /** OR-7: attachPack names one of the organization's attachment sets ("none"
   *  for no attachments). PPR P0-6: caseTypeId binds the template to one
   *  workflow profile (0 = organization-wide); the default snapshot is
   *  captured at creation and never rewritten by later edits. */
  upsertTemplate(key: string, name: string, subject: string, body: string, includeBanner?: boolean, attachPack?: string, organizationId = 1, caseTypeId = 0): void {
    // PPR P0-5 (E3 close): a template may attach NOTHING or one of the
    // organization's OWN attachment sets — validated here at the repo level,
    // not just in one route. Unknown refs fail loudly; nothing is silently
    // coerced, and no privileged pack vocabulary exists to abuse.
    let pack: string | null = null;
    if (attachPack !== undefined) {
      pack = attachPack.trim() || "none";
      if (pack !== "none") {
        const set = pack.startsWith("set:") ? this.getAttachmentSet(Number(pack.slice(4))) : this.attachmentSetByName(organizationId, pack);
        if (!set || set.organization_id !== organizationId) {
          throw new Error(`Unknown attachment set '${attachPack}' for organization ${organizationId}`);
        }
        pack = set.name;
      }
    }
    const bannerVal = includeBanner === undefined ? 1 : includeBanner ? 1 : 0;
    const snapshot = JSON.stringify({ name, subject, body, include_banner: bannerVal, attach_pack: pack ?? "none" });
    if (organizationId !== 1 || caseTypeId > 0) {
      const current = this.getTemplate(key, organizationId, caseTypeId);
      this.db.prepare(
        `INSERT INTO organization_templates (organization_id, key, name, subject, body, include_banner, attach_pack, case_type_id, default_snapshot) VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(organization_id, key) DO UPDATE SET name=excluded.name, subject=excluded.subject, body=excluded.body,
           include_banner=COALESCE(?, organization_templates.include_banner), attach_pack=COALESCE(?, organization_templates.attach_pack),
           case_type_id=excluded.case_type_id, updated_at=datetime('now')`
      ).run(organizationId, key, name, subject, body, includeBanner === undefined ? current?.include_banner ?? 1 : bannerVal,
        pack ?? current?.attach_pack ?? "none", caseTypeId, snapshot,
        includeBanner === undefined ? null : bannerVal, pack);
      return;
    }
    this.db.prepare(
      `INSERT INTO templates (key, organization_id, name, subject, body, include_banner, attach_pack, default_snapshot) VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(key) DO UPDATE SET organization_id = excluded.organization_id, name = excluded.name, subject = excluded.subject, body = excluded.body,
         include_banner = COALESCE(?, templates.include_banner), attach_pack = COALESCE(?, templates.attach_pack), updated_at = datetime('now')`
    ).run(key, organizationId, name, subject, body, bannerVal, pack ?? "none", snapshot,
      includeBanner === undefined ? null : bannerVal, pack);
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

  /** PPR P0-1: credentials never flow through ordinary settings. */
  getSecret(key: string, organizationId = 1): string {
    const row = this.db.prepare("SELECT value FROM secrets WHERE organization_id = ? AND key = ?").get(organizationId, key) as { value: string } | undefined;
    return row?.value ?? "";
  }

  setSecret(key: string, value: string, organizationId = 1): void {
    if (!SECRET_KEYS.includes(key)) throw new Error(`Unknown secret key: ${key}`);
    this.db
      .prepare("INSERT INTO secrets (organization_id, key, value, updated_at) VALUES (?,?,?,datetime('now')) ON CONFLICT(organization_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')")
      .run(organizationId, key, value);
  }

  deleteSecret(key: string, organizationId = 1): void {
    this.db.prepare("DELETE FROM secrets WHERE organization_id = ? AND key = ?").run(organizationId, key);
  }

  hasSecret(key: string, organizationId = 1): boolean {
    return this.db.prepare("SELECT 1 FROM secrets WHERE organization_id = ? AND key = ? AND value <> ''").get(organizationId, key) !== undefined;
  }

  allSettings(): Record<string, string> {
    const rows = this.db.prepare("SELECT key, value FROM settings").all() as Array<{ key: string; value: string }>;
    // Defense in depth: even if a secret key somehow reappears in settings,
    // a generic settings read must never return it (PPR P0-1).
    return Object.fromEntries(rows.filter((r) => !SECRET_KEYS.includes(r.key)).map((r) => [r.key, r.value]));
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

  unreadCount(staffId: number, demo?: number, schools?: string[] | null): number {
    if (isNoAccess(schools)) return 0;
    const realmSql = demo === undefined ? "" : " AND (n.applicant_id IS NULL OR a.demo = ?)";
    const scope = this.scopePred("a", schools);
    const scopeSql = scope.sql ? ` AND (n.applicant_id IS NULL OR 1=1${scope.sql})` : "";
    const params: unknown[] = demo === undefined
      ? [staffId, ...scope.params]
      : [staffId, demo, ...scope.params];
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM notifications n LEFT JOIN applicants a ON a.id = n.applicant_id
           WHERE (n.staff_id IS NULL OR n.staff_id = ?) AND n.read = 0${realmSql}${scopeSql}`
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

  addOutbox(o: { applicant_id: number; to_address: string; subject: string; body: string; mode: "auto" | "queued"; template_key?: string; needs_approval?: number }): void {
    this.db
      .prepare("INSERT INTO outbox (applicant_id, to_address, subject, body, mode, template_key, needs_approval) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(o.applicant_id, o.to_address, o.subject, o.body, o.mode, o.template_key ?? "", o.needs_approval ? 1 : 0);
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
  queuedOutbox(applicantId: number): { id: number; subject: string; body: string; template_key?: string; needs_approval?: number } | undefined {
    return this.db
      .prepare("SELECT id, subject, body, template_key, needs_approval FROM outbox WHERE applicant_id = ? AND mode = 'queued' ORDER BY id DESC LIMIT 1")
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
      // The SAME slot semantics as decide(): a generic academic upload fills
      // an academic slot (fillSlots), so the tile must not count as missing
      // a document the pipeline already considers present. A literal
      // type-set difference used to show complete files as short.
      const present = this.listDocuments(a.id, { activeOnly: true }).map((d) => d.document_type);
      const { missing } = fillSlots(this.effectiveRequirements(a), present);
      for (const m of missing) counts.set(m.document_type, (counts.get(m.document_type) ?? 0) + 1);
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

  findByEmailAny(emailAddress: string, organizationId?: number): ApplicantRow | undefined {
    // DEMO: an explicit organization never matches another tenant's contact.
    if (organizationId !== undefined) {
      return this.db
        .prepare("SELECT * FROM applicants WHERE email_address = ? AND COALESCE(organization_id, 1) = ? ORDER BY id LIMIT 1")
        .get(emailAddress.trim().toLowerCase(), organizationId) as ApplicantRow | undefined;
    }
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
  setFollowup(applicantId: number, rung: number, nextAt: string | null, baseAt?: string | null, action?: string): void {
    if (action !== undefined) {
      this.db
        .prepare("UPDATE applicants SET followup_rung = ?, followup_next_at = ?, followup_base_at = ?, followup_action = ?, updated_at = ? WHERE id = ?")
        .run(rung, nextAt, baseAt ?? null, action, nowIso(), applicantId);
    } else if (baseAt !== undefined) {
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
         WHERE e.direction = 'in'${scope.sql} GROUP BY e.category ORDER BY n DESC`
      )
      .all(...scope.params) as never[];
  }

  /** Round 10: the three current markings per case (applicants.triage),
   *  realm- and school-scoped like every other dashboard number. */
  triageCounts(demo?: number, schools?: string[] | null): { green: number; orange: number; red: number } {
    const scope = this.scopePred("a", schools);
    const dp: unknown[] = demo === undefined ? [...scope.params] : [demo, ...scope.params];
    const pred = (demo === undefined ? "" : " AND a.demo = ?") + scope.sql;
    const one = (sql: string) => (this.db.prepare(sql).get(...dp) as { n: number }).n;
    return {
      green: one(`SELECT COUNT(*) AS n FROM applicants a WHERE a.triage = 'Green'${pred}`),
      orange: one(`SELECT COUNT(*) AS n FROM applicants a WHERE a.triage = 'Orange'${pred}`),
      red: one(`SELECT COUNT(*) AS n FROM applicants a WHERE a.triage = 'Red'${pred}`),
    };
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

  /** The schools a staff member may see.
   *
   * null = deliberately unscoped/full visibility (the default), a non-empty
   * array = assigned schools, and [] = deliberately no access. Keeping the
   * last state in staff_users makes an empty scope real instead of silently
   * turning it into unrestricted access.
   */
  visibleSchoolsFor(staff: { id: number; role: string }): string[] | null {
    if (staff.role === "admin") return null;
    const rows = this.scopesFor(staff.id);
    if (rows.length) return rows;
    const mode = (this.db.prepare("SELECT scope_mode FROM staff_users WHERE id = ?").get(staff.id) as { scope_mode?: string } | undefined)?.scope_mode;
    return mode === "none" ? [] : null;
  }

  /** DEMO: the case-list scope for a staff member — their school scope
   *  (visibleSchoolsFor) PLUS their ACTIVE organization, so queues,
   *  dashboards, mail and search never mix tenants. Pass it anywhere a
   *  `schools` scope is accepted. */
  caseScopeFor(staff: { id: number; role: string; organization_id?: number | null }): string[] {
    const schools = this.visibleSchoolsFor(staff);
    return Object.assign(schools ? [...schools] : [], { organizationId: staff.organization_id ?? 1, allSchools: schools === null });
  }

  /** Switch an admin's active organization (the sidebar switcher). */
  setActiveOrganization(staffId: number, organizationId: number): void {
    if (!this.getOrganization(organizationId)) throw new Error("Unknown organization");
    this.db.prepare("UPDATE staff_users SET active_organization_id = ? WHERE id = ?").run(organizationId, staffId);
  }

  /** Would this staff member see this applicant anywhere in the console?
   * Scoped staff only see cases whose programme belongs to one of their
   * schools; a case with no programme is never shared with scoped staff. */
  applicantVisibleTo(staff: { id: number; role: string; organization_id?: number | null }, a: ApplicantRow): boolean {
    // DEMO: a case is only visible inside its own organization.
    if ((a.organization_id ?? 1) !== (staff.organization_id ?? 1)) return false;
    const scope = this.visibleSchoolsFor(staff);
    if (!scope) return true;
    if (!a.programme) return false;
    const school = this.programmeByCode(a.programme)?.school;
    return Boolean(school) && scope.includes(school as string);
  }

  /** SQL predicate restricting applicant rows to the given schools.
   * `schools === null/undefined` = full visibility; an EMPTY scoped list
   * matches nothing (never accidentally everything). */
  private scopePred(alias: string, schools?: string[] | null): { sql: string; params: string[] } {
    if (schools === undefined || schools === null) return { sql: "", params: [] };
    const org = (schools as ScopeTag).organizationId;
    const orgSql = org !== undefined ? ` AND COALESCE(${alias}.organization_id, 1) = ${Number(org)}` : "";
    if (isAllSchools(schools)) return { sql: orgSql, params: [] };
    if (schools.length === 0) return { sql: " AND 0 = 1", params: [] };
    const marks = schools.map(() => "?").join(",");
    return {
      sql: `${orgSql} AND EXISTS (SELECT 1 FROM programmes p WHERE p.code = ${alias}.programme AND p.school IN (${marks}))`,
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

  setCaseTypeScopes(staffId: number, caseTypes: string[]): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM staff_case_type_scopes WHERE staff_id = ?").run(staffId);
      const insert = this.db.prepare("INSERT OR IGNORE INTO staff_case_type_scopes (staff_id, case_type_code) VALUES (?,?)");
      for (const code of [...new Set(caseTypes.map((x) => x.trim().toUpperCase()).filter(Boolean))]) insert.run(staffId, code);
    })();
  }

  caseTypeScopesFor(staffId: number): string[] {
    const rows = this.db.prepare("SELECT case_type_code FROM staff_case_type_scopes WHERE staff_id = ? ORDER BY case_type_code").all(staffId) as Array<{ case_type_code: string }>;
    return rows.map((r) => r.case_type_code);
  }

  caseTypeVisibleTo(staff: { id: number; role: string; organization_id?: number | null }, a: ApplicantRow): boolean {
    if (staff.role === "admin") return true;
    const scopes = this.caseTypeScopesFor(staff.id);
    if (scopes.length === 0) return true;
    const code = a.case_type_id ? this.caseTypeForCase(a.id)?.code : (a.programme ?? null);
    return !!code && scopes.includes(code.toUpperCase());
  }

  /** Replace a staff member's whole school set in ONE action.
   * An empty set is an explicit no-access scope; use clearScopes() when an
   * administrator wants to restore full visibility. */
  setScopes(staffId: number, schools: string[]): void {
    const clean = [...new Set(schools.map((x) => x.trim()).filter(Boolean))];
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM staff_scopes WHERE staff_id = ?").run(staffId);
      this.db.prepare("UPDATE staff_users SET scope_mode = ? WHERE id = ?").run(clean.length ? "scoped" : "none", staffId);
      const ins = this.db.prepare("INSERT OR IGNORE INTO staff_scopes (staff_id, school) VALUES (?, ?)");
      for (const s of clean) ins.run(staffId, s);
    });
    tx();
  }

  /** Restore an officer's default full visibility explicitly. */
  clearScopes(staffId: number): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM staff_scopes WHERE staff_id = ?").run(staffId);
      this.db.prepare("UPDATE staff_users SET scope_mode = 'unscoped' WHERE id = ?").run(staffId);
    })();
  }

  scopeModeFor(staffId: number): "unscoped" | "scoped" | "none" {
    const row = this.db.prepare("SELECT scope_mode FROM staff_users WHERE id = ?").get(staffId) as { scope_mode?: string } | undefined;
    if (row?.scope_mode === "none" || row?.scope_mode === "scoped") return row.scope_mode;
    return "unscoped";
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

  /** The rule set that owns a node (any status), or undefined. */
  ruleNodeSet(nodeId: number): AdmissionRuleSet | undefined {
    const row = this.db
      .prepare("SELECT set_id FROM admission_rule_nodes WHERE id = ?")
      .get(nodeId) as { set_id: number } | undefined;
    return row ? this.getRuleSet(Number(row.set_id)) : undefined;
  }

  /**
   * True only when the node belongs to the DRAFT set for (programme, level,
   * system). The draft-flow routes must route writes through this: a raw
   * node id from a form body must not reach an ACTIVE or RETIRED set
   * (published rules change only via draft → activate) or another course's
   * set (a tampered or stale `node=` must never cross courses).
   */
  private nodeInDraftSet(nodeId: number, programme: string | null, level: CourseLevel, system: AdmissionSystem): boolean {
    const set = this.ruleNodeSet(nodeId);
    return (
      !!set &&
      set.status === "draft" &&
      (set.programme ?? null) === (programme ?? null) &&
      set.level === level &&
      set.system === system
    );
  }

  /** updateRuleNode, refused (false) unless the node is in the target's draft. */
  updateRuleNodeIfDraft(
    nodeId: number,
    programme: string | null,
    level: CourseLevel,
    system: AdmissionSystem,
    patch: Partial<Pick<RuleNode, "logic" | "field" | "subject" | "comparator" | "value">>
  ): boolean {
    if (!this.nodeInDraftSet(nodeId, programme, level, system)) return false;
    this.updateRuleNode(nodeId, patch);
    return true;
  }

  /** deleteRuleNode, refused (false) unless the node is in the target's draft. */
  deleteRuleNodeIfDraft(nodeId: number, programme: string | null, level: CourseLevel, system: AdmissionSystem): boolean {
    if (!this.nodeInDraftSet(nodeId, programme, level, system)) return false;
    this.deleteRuleNode(nodeId);
    return true;
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
    // E1: record WHEN the goalposts froze — audit/replay needs a real time,
    // and the FIRST freeze wins (a later corrupt re-parse must not move it).
    this.db
      .prepare("UPDATE applicants SET admission_rules_frozen = ?, admission_rules_frozen_at = COALESCE(admission_rules_frozen_at, ?) WHERE id = ?")
      .run(JSON.stringify(sets), new Date().toISOString(), a.id);
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
