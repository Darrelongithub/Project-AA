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
  RequirementSetEntry,
  RuleNode,
  StaffUser,
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
import { fillSlots } from "../documents/matrix";
import { validateRuleTree } from "../rules/caseType";
import type { VisionCacheStore } from "../extraction/gemini";
import { isValidCachedVision } from "../extraction/gemini";
import type { VisionExtraction } from "../types";
import { retentionDue } from "./retention";

const nowIso = () => new Date().toISOString();

/** PPR P0-1: the only keys that may live in the secrets store. */
export const SECRET_KEYS: readonly string[] = ["gemini_api_key", "gmail_client_secret", "gmail_refresh_token"];
export const GENERIC_STAGE_PRESET: Array<{ id: string; label: string }> = [
  { id: "application_received", label: "Received" },
  { id: "documents_received", label: "Information received" },
  { id: "awaiting_review", label: "In review" },
  { id: "completed", label: "Completed" },
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
  /** Case-type code filter. (The column was named `programme` before C2.) */
  caseTypeCode?: string;
  intake?: string;
  limit?: number;
  /** Realm scope: 0 = live only, 1 = demo only, undefined = all. */
  demo?: number;
  /** OR-8: case-type visibility scope. null/undefined = unscoped; an empty
   * list matches nothing. */
  caseTypes?: string[] | null;
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
  casesCompleted: number;
}

/** Existing audit/session/decision data assembled for the read-only admin console. */
export interface SecurityConsoleSnapshot {
  logins: Array<{ id: number; at: string; username: string; display_name: string; role: string }>;
  activeSessions: Array<{ username: string; display_name: string; role: string; created_at: string; expires_at: string }>;
  pipelineRuns: Array<{ id: number; applicant_id: number; timestamp: string; ref_number: string; case_type_code: string | null; triggering_email_id: string; computed_status: string; reasoning: string; auto_sent: number }>;
  errors: Array<{ id: number; applicant_id: number | null; at: string; actor: string; display_name: string; event: string; detail: string; ref_number: string | null; attempts: number | null; source: "audit" | "dead-letter" }>;
  integritySignals: Array<{ id: number; applicant_id: number; at: string; actor: string; display_name: string; event: string; detail: string; ref_number: string; latest_computed_status: string | null; latest_reasoning: string | null; latest_decision_at: string | null }>;
}

type ScopeTag = string[] & { organizationId?: number; allCaseTypes?: boolean };

export type ApplicantLookupSite =
  | "repo.create"
  | "repo.refreeze.requirements"
  | "repo.refreeze.result"
  | "pipeline.phone-enrichment"
  | "pipeline.requirements-case"
  | "pipeline.requirements"
  | "pipeline.human-review"
  | "pipeline.lifecycle"
  | "pipeline.result";

export class ApplicantNotFoundError extends Error {
  readonly code = "APPLICANT_NOT_FOUND" as const;

  constructor(readonly applicantId: number, readonly lookupSite: ApplicantLookupSite) {
    super(`Case ${applicantId} no longer exists at ${lookupSite}`);
    this.name = "ApplicantNotFoundError";
  }
}

export interface RetentionArchiveRecord {
  archived_at: string;
  retention_days: number;
  applicant: ApplicantRow;
  [section: string]: unknown;
}

/** A tagged scope meaning "every case type, but only in this organization". */
function isAllCaseTypes(s: string[] | null | undefined): boolean { return Boolean(s && (s as ScopeTag).allCaseTypes); }
/** An explicit empty scope = deliberately no access. */
function isNoAccess(s: string[] | null | undefined): boolean { return Boolean(s && s.length === 0 && !isAllCaseTypes(s)); }

export class Repo {
  constructor(public db: Database) {}

  primaryOrganizationId(): number {
    const id = Number(this.getSetting("primary_organization_id", "1"));
    if (!Number.isSafeInteger(id) || id < 1) throw new Error("Invalid primary organization setting");
    return id;
  }

  // ── Organizations and generic case configuration ───────────────────────

  getOrganization(id: number): Organization | undefined {
    const row = this.db.prepare("SELECT id, name, logo, ref_prefix, theme, from_name, reply_to, locale, timezone, inbound_address FROM organizations WHERE id = ?").get(id) as
      | { id: number; name: string; logo: string | null; ref_prefix: string; theme: string; from_name: string | null; reply_to: string | null; locale: string | null; timezone: string | null; inbound_address: string | null }
      | undefined;
    if (!row) return undefined;
    let theme: OrganizationTheme = { primary: "#3b1d5f", accent: "#9a78c7" };
    try { theme = { ...theme, ...(JSON.parse(row.theme || "{}") as Partial<OrganizationTheme>) }; } catch { /* use safe defaults */ }
    return {
      id: row.id, name: row.name, logo: row.logo, ref_prefix: row.ref_prefix || "ORG", theme,
      from_name: row.from_name, reply_to: row.reply_to, locale: row.locale, timezone: row.timezone,
      inbound_address: row.inbound_address,
    };
  }

  /** Create a tenant with no inherited case content. */
  createOrganization(input: { name: string; logo?: string | null; refPrefix?: string; theme?: Partial<OrganizationTheme> }): Organization {
    const name = input.name.trim();
    if (!name) throw new Error("Organization name is required");
    const theme = {
      primary: input.theme?.primary ?? "#3b1d5f",
      accent: input.theme?.accent ?? "#9a78c7",
    };
    const prefix = (input.refPrefix ?? "ORG").trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9]{0,7}$/.test(prefix)) throw new Error("Reference prefix must be 1–8 characters and start with a letter");
    const result = this.db.prepare("INSERT INTO organizations (name, logo, ref_prefix, theme) VALUES (?,?,?,?)")
      .run(name, input.logo ?? null, prefix, JSON.stringify(theme));
    return this.getOrganization(Number(result.lastInsertRowid))!;
  }

  /**
   * WHICH tenant does an inbound message belong to? Resolved from the address
   * it was delivered to (Delivered-To/To, any of several recipients), matched
   * against each organization's own inbound address.
   *
   * `matched: false` means the address named no tenant and this is a fallback:
   * the only organization when there is exactly one, otherwise the head office.
   * Callers surface that — silently filing another tenant's mail under
   * organization 1 is how cases end up in the wrong workspace.
   */
  organizationForInboundAddress(recipients: string | Array<string | null | undefined> | null | undefined): { organizationId: number; matched: boolean } | null {
    const addresses = ([] as Array<string | null | undefined>).concat(recipients ?? [])
      .flatMap((raw) => String(raw ?? "").split(/[,;\s]+/))
      .map((part) => part.replace(/^<|>$/g, "").trim().toLowerCase())
      .filter((part) => part.includes("@"));
    const rows = this.db.prepare("SELECT id, inbound_address FROM organizations").all() as Array<{ id: number; inbound_address: string | null }>;
    for (const address of addresses) {
      const hit = rows.find((row) => (row.inbound_address ?? "").toLowerCase() === address);
      if (hit) return { organizationId: hit.id, matched: true };
    }
    if (rows.length === 1) return { organizationId: rows[0].id, matched: false };
    if (rows.some((row) => row.id === 1)) return { organizationId: 1, matched: false };
    return rows.length ? { organizationId: rows[0].id, matched: false } : null;
  }

  listOrganizations(): Organization[] {
    return (this.db.prepare("SELECT id FROM organizations ORDER BY id").all() as Array<{ id: number }>)
      .map((r) => this.getOrganization(r.id)!).filter(Boolean);
  }

  organizationRefPrefix(organizationId = 1): string {
    return this.getOrganization(organizationId)?.ref_prefix || "ORG";
  }

  updateOrganization(id: number, patch: { name?: string; logo?: string | Buffer | null; refPrefix?: string; theme?: Partial<OrganizationTheme>; fromName?: string | null; replyTo?: string | null; locale?: string | null; timezone?: string | null; inboundAddress?: string | null }): void {
    const current = this.getOrganization(id);
    if (!current) return;
    const theme = { ...current.theme, ...(patch.theme ?? {}) };
    const logo = patch.logo === undefined ? current.logo : Buffer.isBuffer(patch.logo) ? `data:application/octet-stream;base64,${patch.logo.toString("base64")}` : patch.logo;
    const name = patch.name?.trim() || current.name;
    const refPrefix = patch.refPrefix === undefined ? current.ref_prefix : patch.refPrefix.trim().toUpperCase();
    if (!/^[A-Z]{1,8}$/.test(refPrefix)) throw new Error("Reference prefix must be 1–8 letters");
    const text = (v: string | null | undefined, prev: string | null | undefined): string | null =>
      v === undefined ? (prev ?? null) : v === null || v.trim() === "" ? null : v.trim().replace(/[\r\n]+/g, " ");
    const inbound = text(patch.inboundAddress, current.inbound_address)?.toLowerCase() ?? null;
    if (inbound && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(inbound)) throw new Error("Inbound address must be a valid email address");
    this.db.prepare("UPDATE organizations SET name = ?, logo = ?, ref_prefix = ?, theme = ?, from_name = ?, reply_to = ?, locale = ?, timezone = ?, inbound_address = ? WHERE id = ?")
      .run(name, logo, refPrefix, JSON.stringify(theme),
        text(patch.fromName, current.from_name), text(patch.replyTo, current.reply_to),
        text(patch.locale, current.locale), text(patch.timezone, current.timezone), inbound, id);
    if (id === 1 && patch.name !== undefined) {
      this.db.prepare("INSERT INTO settings (key, value) VALUES ('institution_name', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(name);
    }
  }

  createCaseType(organizationId: number, input: { code: string; name: string; category?: string; config?: Record<string, unknown>; defaultReplyAction?: string; evidenceGate?: boolean }): CaseType {
    if (!this.getOrganization(organizationId)) throw new Error("Unknown organization");
    const code = input.code.trim().toUpperCase();
    const name = input.name.trim();
    if (!/^[A-Z][A-Z0-9_:-]{0,63}$/.test(code) || !name || name.length > 200) throw new Error("A valid case-type code and name are required");
    if (input.config?.rules !== undefined) validateRuleTree(input.config.rules);
    this.db.prepare("INSERT INTO case_types (organization_id, code, name, category, config, default_reply_action, evidence_gate, stages, queues) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(organization_id,code) DO NOTHING")
      .run(organizationId, code, name, input.category?.trim() || "general", JSON.stringify(input.config ?? {}), input.defaultReplyAction ?? "draft", input.evidenceGate === false ? 0 : 1, JSON.stringify(GENERIC_STAGE_PRESET), JSON.stringify(GENERIC_QUEUE_PRESET));
    return this.getCaseType(code, organizationId)!;
  }

  getCaseType(code: string, organizationId = 1): CaseType | undefined {
    const row = this.db.prepare("SELECT id, organization_id, code, name, category, config, active, terminology, stages, queues, config_version, default_reply_action, evidence_gate FROM case_types WHERE organization_id = ? AND code = ? COLLATE NOCASE")
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
    validateRuleTree(nodes);
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
    try {
      const parsed: unknown = JSON.parse(a.case_config_frozen);
      if (!parsed || typeof parsed !== "object") throw new Error("not an object");
      return parsed as CaseConfigFrozen;
    } catch {
      throw new Error("Frozen case configuration is corrupt — repair the case explicitly before processing");
    }
  }

  /** Explicit, human-approved upgrade of a case to the profile's CURRENT
   * configuration version. Never happens implicitly (PPR P0-3). */
  reFreezeCaseConfig(a: ApplicantRow): CaseConfigFrozen {
    this.db.transaction(() => {
      this.db.prepare("UPDATE applicants SET case_config_frozen = NULL, requirements_snapshot = NULL WHERE id = ?").run(a.id);
      this.freezeCaseConfig({ ...a, case_config_frozen: null } as ApplicantRow);
      this.freezeRequirementsSnapshot(this.requireApplicant(a.id, "repo.refreeze.requirements"));
    })();
    const refreshed = this.requireApplicant(a.id, "repo.refreeze.result");
    const frozen = this.caseConfigFrozen(refreshed);
    if (!frozen) throw new Error(`Case ${a.id} has no configuration snapshot after re-freeze`);
    return frozen;
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
    // Saving a rule that already exists in this scope updates it: a repeated
    // POST (retry, double submit) must never duplicate a published rule.
    const duplicate = input.id ? undefined : this.db.prepare(
      "SELECT id FROM workflow_rules WHERE organization_id = ? AND COALESCE(case_type_id, -1) = ? AND kind = ? AND name = ?"
    ).get(input.organizationId, input.caseTypeId ?? null, kind, name) as { id: number } | undefined;
    const targetId = input.id ?? duplicate?.id;
    if (targetId) {
      this.db.prepare(
        "UPDATE workflow_rules SET name = ?, kind = ?, case_type_id = ?, position = ?, enabled = ?, conditions = ?, action = ?, updated_at = datetime('now') WHERE id = ? AND organization_id = ?"
      ).run(name, kind, input.caseTypeId ?? null, input.position ?? 0, input.enabled === false ? 0 : 1,
        JSON.stringify(input.conditions ?? []), JSON.stringify(input.action ?? {}), targetId, input.organizationId);
    } else {
      const nextPos = input.position ?? ((this.db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM workflow_rules WHERE organization_id = ?").get(input.organizationId) as { p: number }).p);
      this.db.prepare(
        "INSERT INTO workflow_rules (organization_id, case_type_id, kind, name, position, enabled, conditions, action) VALUES (?,?,?,?,?,?,?,?)"
      ).run(input.organizationId, input.caseTypeId ?? null, kind, name, nextPos, input.enabled === false ? 0 : 1,
        JSON.stringify(input.conditions ?? []), JSON.stringify(input.action ?? {}));
    }
    const savedId = targetId ?? Number((this.db.prepare("SELECT id FROM workflow_rules WHERE organization_id = ? AND name = ? AND kind = ? AND COALESCE(case_type_id, -1) = COALESCE (?, -1) ORDER BY id DESC")
      .get(input.organizationId, name, kind, input.caseTypeId ?? null) as { id: number } | undefined)?.id ?? 0);
    // Rule edits are configuration publishes (PPR P0-3).
    if (input.caseTypeId) this.bumpCaseTypeConfigVersion(input.caseTypeId);
    const saved = this.getWorkflowRule(savedId);
    if (!saved) throw new Error("Workflow rule could not be saved");
    return saved;
  }

  deleteWorkflowRule(id: number, organizationId = 1): void {
    const row = this.db.prepare("SELECT case_type_id FROM workflow_rules WHERE id = ? AND organization_id = ?").get(id, organizationId) as { case_type_id: number | null } | undefined;
    this.db.prepare("DELETE FROM workflow_rules WHERE id = ? AND organization_id = ?").run(id, organizationId);
    if (row?.case_type_id) this.bumpCaseTypeConfigVersion(row.case_type_id);
  }

  updateCaseTypeProfile(id: number, patch: { default_reply_action?: "auto" | "draft"; evidence_gate?: 0 | 1 }): void {
    if (!this.caseTypeById(id)) throw new Error("Unknown case type");
    if (patch.default_reply_action !== undefined) this.db.prepare("UPDATE case_types SET default_reply_action = ? WHERE id = ?").run(patch.default_reply_action, id);
    if (patch.evidence_gate !== undefined) this.db.prepare("UPDATE case_types SET evidence_gate = ? WHERE id = ?").run(patch.evidence_gate, id);
    this.bumpCaseTypeConfigVersion(id);
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
   * bundled fallback (earlier installations seeded their sets from
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

  /** Retire a label without deleting history: messages already carrying it
   *  keep it, and Gemini stops being offered it. */
  setEmailCategoryActive(organizationId: number, key: string, active: boolean): void {
    this.db.prepare("UPDATE organization_categories SET active = ? WHERE organization_id = ? AND key = ?")
      .run(active ? 1 : 0, organizationId, key.trim());
  }

  /** Change the staff-facing label while keeping the machine key stable. */
  updateEmailCategoryLabel(organizationId: number, key: string, label: string): boolean {
    const cleanLabel = label.trim();
    if (!cleanLabel) throw new Error("email category label cannot be blank");
    const result = this.db.prepare("UPDATE organization_categories SET label = ? WHERE organization_id = ? AND key = ? AND active = 1")
      .run(cleanLabel, organizationId, key.trim());
    return result.changes === 1;
  }

  addEmailCategory(organizationId: number, input: { key: string; label: string }): void {
    this.db.prepare("INSERT INTO organization_categories (organization_id, key, label) VALUES (?,?,?) ON CONFLICT(organization_id, key) DO UPDATE SET label=excluded.label, active=1")
      .run(organizationId, input.key.trim(), input.label.trim());
  }

  listOrganizationPackSlots(organizationId = 1): Array<{ organization_id: number; key: string; filename: string | null; mime: string | null; content: Buffer | null }> {
    return this.db.prepare("SELECT organization_id,key,filename,mime,content FROM organization_pack_slots WHERE organization_id = ? ORDER BY key").all(organizationId) as Array<{ organization_id: number; key: string; filename: string | null; mime: string | null; content: Buffer | null }>;
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

  getOrCreateApplicant(emailAddress: string, threadId: string, opts: { fullName?: string; refPrefix?: string; organizationId?: number; caseTypeCode?: string } = {}): ApplicantRow {
    const addr = emailAddress.trim().toLowerCase();
    const organizationId = opts.organizationId ?? this.primaryOrganizationId();
    if (!this.getOrganization(organizationId)) throw new Error("Unknown organization — complete setup first");
    const type = opts.caseTypeCode ? this.getCaseType(opts.caseTypeCode, organizationId) : undefined;
    if (opts.caseTypeCode && !type) throw new Error("Unknown case type for this organization");
    return this.db.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM applicants WHERE organization_id = ? AND email_address = ? AND thread_id = ?").get(organizationId, addr, threadId) as ApplicantRow | undefined;
      if (existing) return existing;
      const ref = this.nextRefNumber(opts.refPrefix ?? this.organizationRefPrefix(organizationId), new Date().getFullYear());
      const created = this.db.prepare("INSERT INTO applicants (ref_number,email_address,thread_id,full_name,organization_id,case_type_id,case_type_code,category) VALUES (?,?,?,?,?,?,?,?)").run(ref, addr, threadId, opts.fullName ?? null, organizationId, type?.id ?? null, type?.code ?? null, type?.category ?? null);
      const row = this.requireApplicant(Number(created.lastInsertRowid), "repo.create");
      this.audit(row.id, "system", "case_created", `Case ${row.ref_number} opened for ${addr}`);
      return row;
    })();
  }


  /** Canonical generic entry point; Applicant terminology is retained only
   * in the compatibility implementation above. */
  createCase(input: { emailAddress: string; threadId: string; organizationId?: number; caseTypeCode?: string; fullName?: string; refPrefix?: string }): ApplicantRow {
    return this.getOrCreateApplicant(input.emailAddress, input.threadId, input);
  }

  getApplicant(id: number): ApplicantRow | undefined {
    return this.db.prepare("SELECT * FROM applicants WHERE id = ?").get(id) as ApplicantRow | undefined;
  }

  /** Re-read a case at a critical boundary and fail with typed context if it vanished. */
  requireApplicant(id: number, lookupSite: ApplicantLookupSite): ApplicantRow {
    const applicant = this.getApplicant(id);
    if (!applicant) throw new ApplicantNotFoundError(id, lookupSite);
    return applicant;
  }

  updateApplicant(
    id: number,
    patch: Partial<
      Pick<
        ApplicantRow,
        | "full_name"
        | "phone"
        | "case_type_code"
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
    // Column names are interpolated into SQL — only ever from this allow-list,
    // never from caller-provided strings.
    const ALLOWED = new Set([
      "full_name", "phone", "case_type_code", "intake", "priority", "assigned_to",
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
    this.db.prepare(`UPDATE applicants SET ${setSql}, updated_at = ? WHERE id = ?`).run(...vals, nowIso(), id);
    if (Object.prototype.hasOwnProperty.call(patch, "case_type_code")) {
      // `category` is the case type's OWN grouping, which is what createCase and
      // updateCase stamp onto the row. Copying the code into it here made one
      // column mean two different things depending on which path wrote it, so
      // anything that groups or filters by category saw a case-type code (or
      // nothing at all) — the same "two cases at once" defect that keeping
      // case_type_id and case_type_code coherent exists to prevent.
      this.db
        .prepare(
          `UPDATE applicants SET category = (
             SELECT ct.category FROM case_types ct
              WHERE ct.code = applicants.case_type_code AND ct.organization_id = applicants.organization_id
           ) WHERE id = ?`
        )
        .run(id);
    }
  }

  updateCase(id: number, patch: { category?: string | null; case_type_id?: number | null }): void {
    if (Object.keys(patch).some((key) => !["category", "case_type_id"].includes(key))) throw new Error("updateCase: refusing unknown column");
    const current = this.getCase(id);
    if (!current) throw new Error("Unknown case");
    if (patch.case_type_id != null && this.caseTypeById(patch.case_type_id)?.organization_id !== current.organization_id) throw new Error("Case type belongs to another organization");
    this.db.transaction(() => {
      if (patch.category !== undefined) this.db.prepare("UPDATE applicants SET category = ? WHERE id = ?").run(patch.category,id);
      if (patch.case_type_id !== undefined) {
        this.db.prepare("UPDATE applicants SET case_type_id = ? WHERE id = ?").run(patch.case_type_id,id);
        // Keep the denormalised columns coherent with the type: the code and
        // the category are read all over the console, and a case whose
        // case_type_id and case_type_code disagreed would be two cases at once.
        const type = patch.case_type_id === null ? undefined : this.caseTypeById(patch.case_type_id);
        this.db.prepare("UPDATE applicants SET case_type_code = ?, category = ?, updated_at = ? WHERE id = ?")
          .run(type?.code ?? null, type?.category ?? null, nowIso(), id);
      }
    })();
  }

  /** The only runtime path for a human-recorded case outcome. Outcome,
   * provenance, lifecycle, SLA acknowledgement and audit are committed as one
   * typed decision so generic patch methods cannot create an unattributed
   * decision. Automatic outcomes are deliberately not supported by this path. */
  recordHumanOutcome(
    id: number,
    decision: { outcome: Exclude<CaseOutcome, "auto_approved">; actor: string; reason: string }
  ): void {
    const actor = decision.actor.trim();
    const reason = decision.reason.trim();
    if (!actor) throw new Error("A decision actor is required");
    if (!reason || reason.length > 2000) throw new Error("A human outcome requires a reason of 1–2000 characters");
    if (!["approved_after_review", "not_approved", "undecided"].includes(String(decision.outcome))) {
      throw new Error("Invalid human outcome");
    }

    const decidedAt = nowIso();
    this.db.transaction(() => {
      const current = this.getApplicant(id);
      if (!current) throw new Error("Unknown case");
      this.db.prepare(
        `UPDATE applicants
         SET outcome = ?, outcome_route = 'human', decision_by = ?, decision_reason = ?, decision_at = ?, updated_at = ?
         WHERE id = ?`
      ).run(decision.outcome, actor, reason, decidedAt, decidedAt, id);
      if (current.sla_due_at && !current.sla_handled_at) {
        this.updateApplicant(id, { sla_handled_at: decidedAt });
      }
      this.setLifecycle(id, decision.outcome === "undecided" ? "awaiting_review" : "completed", actor, reason);
      this.audit(id, actor, "human_outcome_recorded", `${decision.outcome}: ${reason}`);
    })();
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

  audit(applicantId: number | null, actor: string, event: string, detail = ""): number {
    const result = this.db
      .prepare("INSERT INTO audit_log (applicant_id, actor, event, detail) VALUES (?,?,?,?)")
      .run(applicantId, actor, event, detail);
    return Number(result.lastInsertRowid);
  }

  /** Attach pre-routing audit rows (written before a case exists) to the case
   *  that the intake rules subsequently opened. Updating the foreign key keeps
   *  their original audit ids/timestamps, so the case history preserves the
   *  true classifier-before-routing order. Parked mail leaves these rows
   *  case-less and searchable in the global audit log by message_id. */
  attachAuditRowsToApplicant(auditIds: number[], applicantId: number): void {
    const ids = [...new Set(auditIds)].filter((id) => Number.isSafeInteger(id) && id > 0);
    if (!ids.length) return;
    this.db
      .prepare(`UPDATE audit_log SET applicant_id = ? WHERE applicant_id IS NULL AND id IN (${ids.map(() => "?").join(",")})`)
      .run(applicantId, ...ids);
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

  /**
   * Read-only security-console view assembled from existing records. Every
   * tenant-bearing query is constrained to both the acting organization and
   * the existing live/demo realm. System-level service configuration is read
   * separately by the page; this method never exposes credentials or tokens.
   */
  securityConsoleSnapshot(organizationId: number, demo: 0 | 1): SecurityConsoleSnapshot {
    const logins = this.db.prepare(
      `SELECT al.id, al.at, s.username, s.display_name, s.role
       FROM audit_log al
       JOIN staff_users s ON s.username = al.actor COLLATE NOCASE
       WHERE al.event = 'staff_login'
         AND COALESCE(s.organization_id, 1) = ? AND COALESCE(s.demo, 0) = ?
       ORDER BY al.id DESC LIMIT 20`
    ).all(organizationId, demo) as SecurityConsoleSnapshot["logins"];

    const activeSessions = this.db.prepare(
      `SELECT s.username, s.display_name, s.role, se.created_at, se.expires_at
       FROM sessions se
       JOIN staff_users s ON s.id = se.staff_id
       WHERE COALESCE(s.organization_id, 1) = ? AND COALESCE(s.demo, 0) = ?
         AND s.active = 1 AND se.expires_at > ?
       ORDER BY se.created_at DESC LIMIT 20`
    ).all(organizationId, demo, nowIso()) as SecurityConsoleSnapshot["activeSessions"];

    const pipelineRuns = this.db.prepare(
      `SELECT d.id, a.id AS applicant_id, d.timestamp, a.ref_number, a.case_type_code, d.triggering_email_id,
              d.computed_status, d.reasoning, d.auto_sent
       FROM decision_logs d
       JOIN applicants a ON a.id = d.applicant_id
       WHERE COALESCE(a.organization_id, 1) = ? AND COALESCE(a.demo, 0) = ?
       ORDER BY d.id DESC LIMIT 20`
    ).all(organizationId, demo) as SecurityConsoleSnapshot["pipelineRuns"];

    const auditErrors = this.db.prepare(
      `SELECT al.id, a.id AS applicant_id, al.at, al.actor,
              CASE WHEN al.event = 'process_crash' THEN 'Shared runtime' ELSE COALESCE(s.display_name, al.actor) END AS display_name,
              al.event, al.detail, a.ref_number, NULL AS attempts, 'audit' AS source
       FROM audit_log al
       LEFT JOIN applicants a ON a.id = al.applicant_id
       LEFT JOIN staff_users s ON s.username = al.actor COLLATE NOCASE
       WHERE al.event IN (
           'send_failed', 'email_not_delivered', 'followup_send_failed',
           'gmail_sync_failed', 'gmail_test_failed', 'gemini_test_failed', 'server_error', 'process_crash'
         )
         AND (
           (a.id IS NOT NULL AND COALESCE(a.organization_id, 1) = ? AND COALESCE(a.demo, 0) = ?)
           OR (al.applicant_id IS NULL AND s.id IS NOT NULL
               AND COALESCE(s.organization_id, 1) = ? AND COALESCE(s.demo, 0) = ?)
           OR (al.applicant_id IS NULL AND al.event = 'process_crash' AND al.actor = 'system')
         )
       ORDER BY al.id DESC LIMIT 40`
    ).all(organizationId, demo, organizationId, demo) as SecurityConsoleSnapshot["errors"];

    // Dead letters do not carry a tenant column. Include only failures that
    // already have a persisted email/case link; unknown-tenant fetch failures
    // are intentionally not attributed to any organization.
    const deadLetterErrors = this.db.prepare(
      `SELECT d.id, a.id AS applicant_id, d.updated_at AS at, 'ingestion' AS actor, 'Mail pipeline' AS display_name,
              'ingestion_dead_letter' AS event, d.error AS detail, a.ref_number,
              d.attempts, 'dead-letter' AS source
       FROM dead_letters d
       JOIN emails e ON e.message_id = d.message_id
       JOIN applicants a ON a.id = e.applicant_id
       WHERE COALESCE(a.organization_id, 1) = ? AND COALESCE(a.demo, 0) = ?
         AND e.organization_id = ?
       ORDER BY d.updated_at DESC, d.id DESC LIMIT 40`
    ).all(organizationId, demo, organizationId) as SecurityConsoleSnapshot["errors"];
    const utcMillis = (value: string): number => Date.parse(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
    const errors = [...auditErrors, ...deadLetterErrors]
      .sort((a, b) => utcMillis(b.at) - utcMillis(a.at))
      .slice(0, 20);

    const integritySignals = this.db.prepare(
      `SELECT al.id, a.id AS applicant_id, al.at, al.actor, COALESCE(s.display_name, al.actor) AS display_name,
              al.event, al.detail, a.ref_number,
              d.computed_status AS latest_computed_status,
              d.reasoning AS latest_reasoning,
              d.timestamp AS latest_decision_at
       FROM audit_log al
       JOIN applicants a ON a.id = al.applicant_id
       LEFT JOIN staff_users s ON s.username = al.actor COLLATE NOCASE
       LEFT JOIN decision_logs d ON d.id = (
         SELECT d2.id FROM decision_logs d2
         WHERE d2.applicant_id = a.id AND datetime(d2.timestamp) <= datetime(al.at)
         ORDER BY d2.id DESC LIMIT 1
       )
       WHERE COALESCE(a.organization_id, 1) = ? AND COALESCE(a.demo, 0) = ?
         AND (
           al.event IN ('human_outcome_recorded', 'human_override', 'case_type_changed', 'case_config_upgraded')
           OR (al.event = 'status_changed' AND al.actor <> 'system')
         )
       ORDER BY al.id DESC LIMIT 20`
    ).all(organizationId, demo) as SecurityConsoleSnapshot["integritySignals"];

    return { logins, activeSessions, pipelineRuns, errors, integritySignals };
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

  addProgramme(code: string, name: string, school = "", entry = "", level = "general"): void {
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

  // ── Phase D3 (Q7 step 2): inbound address -> case type ───────────────────

  /** Every candidate spelling of a recipient header value: the address as
   *  written, and (Q9, PROVISIONAL) its plus-addressing base. Lower-cased and
   *  trimmed, display names and angle brackets stripped. */
  aliasKeyCandidates(raw: string): string[] {
    const addresses = String(raw ?? "")
      .split(/[,;\s]+/)
      .map((part) => part.replace(/^<|>$/g, "").trim().toLowerCase())
      .filter((part) => part.includes("@"));
    const candidates = new Set<string>();
    for (const address of addresses) {
      candidates.add(address);
      const plus = address.indexOf("+");
      if (plus > 0 && plus < address.indexOf("@")) candidates.add(`${address.slice(0, plus)}@${address.slice(address.indexOf("@") + 1)}`);
    }
    return [...candidates];
  }

  listCaseTypeAliases(organizationId: number, opts: { includeRetired?: boolean } = {}): Array<{ id: number; organization_id: number; case_type_id: number; address: string; active: number; case_type_code: string | null }> {
    return this.db.prepare(
      `SELECT a.id, a.organization_id, a.case_type_id, a.address, a.active, t.code AS case_type_code
         FROM case_type_aliases a LEFT JOIN case_types t ON t.id = a.case_type_id
        WHERE a.organization_id = ?${opts.includeRetired ? "" : " AND a.active = 1"}
        ORDER BY a.address`
    ).all(organizationId) as never[];
  }

  /**
   * Claim an inbound address for one of THIS organization's case types.
   * Addresses are unique installation-wide, so an address another organization
   * already holds is refused rather than silently shared.
   */
  addCaseTypeAlias(organizationId: number, caseTypeId: number, address: string): { ok: true; address: string } | { ok: false; reason: string } {
    const normalized = address.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) return { ok: false, reason: "that is not a valid email address" };
    const type = this.caseTypeById(caseTypeId);
    if (!type || type.organization_id !== organizationId) return { ok: false, reason: "unknown case type for this organization" };
    const existing = this.db.prepare("SELECT organization_id FROM case_type_aliases WHERE address = ?").get(normalized) as { organization_id: number } | undefined;
    if (existing && existing.organization_id !== organizationId) {
      return { ok: false, reason: "that address is already used by another organization — an address can only belong to one tenant" };
    }
    this.db.prepare(
      `INSERT INTO case_type_aliases (organization_id, case_type_id, address, active) VALUES (?,?,?,1)
       ON CONFLICT(address) DO UPDATE SET organization_id = excluded.organization_id, case_type_id = excluded.case_type_id, active = 1`
    ).run(organizationId, caseTypeId, normalized);
    return { ok: true, address: normalized };
  }

  /** Retiring keeps the row (history, and the address stays reserved for this
   *  tenant) but stops it routing anything. */
  retireCaseTypeAlias(organizationId: number, address: string): boolean {
    const normalized = address.trim().toLowerCase();
    const row = this.db.prepare("SELECT id FROM case_type_aliases WHERE organization_id = ? AND address = ?").get(organizationId, normalized) as { id: number } | undefined;
    if (!row) return false;
    this.db.prepare("UPDATE case_type_aliases SET active = 0 WHERE id = ?").run(row.id);
    return true;
  }

  /**
   * Which case type do the addresses this message was delivered to select?
   * Only this tenant's own ACTIVE aliases are considered — an alias belonging
   * to another organization can never route this tenant's mail. Two aliases
   * pointing at different case types are AMBIGUOUS: the caller must not guess.
   */
  resolveInboundAlias(
    organizationId: number,
    recipients: string | Array<string | null | undefined> | null | undefined
  ): { status: "match"; caseTypeId: number; caseTypeCode: string; alias: string }
    | { status: "ambiguous"; aliases: Array<{ alias: string; caseTypeCode: string | null }> }
    | { status: "none" } {
    const candidates = ([] as Array<string | null | undefined>).concat(recipients ?? []).flatMap((raw) => this.aliasKeyCandidates(String(raw ?? "")));
    if (candidates.length === 0) return { status: "none" };
    const rows = this.db.prepare(
      `SELECT a.address, a.case_type_id, t.code AS case_type_code
         FROM case_type_aliases a LEFT JOIN case_types t ON t.id = a.case_type_id
        WHERE a.organization_id = ? AND a.active = 1`
    ).all(organizationId) as Array<{ address: string; case_type_id: number; case_type_code: string | null }>;
    const hits = rows.filter((row) => candidates.includes(row.address));
    if (hits.length === 0) return { status: "none" };
    const distinct = [...new Set(hits.map((h) => h.case_type_id))];
    if (distinct.length > 1) {
      return { status: "ambiguous", aliases: hits.map((h) => ({ alias: h.address, caseTypeCode: h.case_type_code })) };
    }
    return { status: "match", caseTypeId: hits[0].case_type_id, caseTypeCode: hits[0].case_type_code ?? "", alias: hits[0].address };
  }

  /**
   * Inbound messages for labelling (Phase D1), most recent first, for ONE
   * organization only. Parked (case-less) mail is included on purpose: the
   * messages a classifier must learn to refuse are part of the measurement.
   */
  labelableMessages(organizationId: number, limit: number): Array<{ id: string; subject: string; body: string; category: string | null; from_addr: string; at: string }> {
    return this.db.prepare(
      // The ORDER BY is qualified: an unqualified "id" resolves to the
      // message_id alias and would sort alphabetically, not newest-first.
      `SELECT message_id AS id, subject, body, category, from_addr, at
         FROM emails
        WHERE organization_id = ? AND direction = 'in'
        ORDER BY emails.id DESC
        LIMIT ?`
    ).all(organizationId, Math.max(1, Math.floor(limit))) as never[];
  }

  /** Submission windows are tenant data: the same name in two organizations is
   *  two different windows with two different deadlines. */
  listIntakes(organizationId = 1): string[] {
    return (this.db.prepare("SELECT name FROM intakes WHERE organization_id = ? ORDER BY rowid").all(organizationId) as Array<{ name: string }>).map((r) => r.name);
  }

  addIntake(name: string, organizationId = 1): void {
    this.db.prepare("INSERT OR IGNORE INTO intakes (organization_id, name) VALUES (?,?)").run(organizationId, name);
  }

  effectiveRequirements(a: ApplicantRow): RequirementSetEntry[] {
    if (a.requirements_snapshot) {
      try { const snapshot: unknown = JSON.parse(a.requirements_snapshot); if (!Array.isArray(snapshot)) throw new Error("Invalid document snapshot"); return snapshot as RequirementSetEntry[]; }
      catch { throw new Error("Frozen document requirements are corrupt — restore or explicitly re-freeze this case before processing"); }
    }
    const frozen = this.caseConfigFrozen(a);
    const type = this.caseTypeForCase(a.id);
    const definitions = frozen?.documents ?? (type ? this.listDocumentDefinitions(type.id) : []);
    return definitions.map((definition) => ({ document_type: definition.key, label: definition.label, required: definition.required, blocking: definition.blocking }));
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

  resolveRequirements(code: string | null, _intake: string | null, organizationId = 1): RequirementSetEntry[] {
    const type = code ? this.getCaseType(code, organizationId) : undefined;
    return type ? this.listDocumentDefinitions(type.id).map((definition) => ({ document_type: definition.key, label: definition.label, required: definition.required, blocking: definition.blocking })) : [];
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
        `INSERT INTO emails (organization_id, applicant_id, message_id, thread_id, direction, from_addr, to_addr, subject, body, category, auto, channel, at, attachments)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        e.applicant_id ? this.getApplicant(e.applicant_id)?.organization_id ?? this.primaryOrganizationId() : e.organization_id ?? this.primaryOrganizationId(),
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
   * email), with message count and unread count. Scoped by case type, realm-
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
    caseTypes?: string[] | null; demo?: number; q?: string; unreadOnly?: boolean; page?: number; folder?: string;
  }): Array<EmailRecord & { tkey: string; thread_n: number; unread_n: number; star_n: number; imp_n: number; a_name: string | null; a_email: string | null; ref_number: string | null; case_type_code: string | null; lifecycle: string | null }> {
    // Parked case-less mail has no case type to match. It must not bypass
    // an explicitly empty staff scope and become a data leak in All Mail.
    if (isNoAccess(opts.caseTypes)) return [];
    const where: string[] = [];
    const params: unknown[] = [];
    // Round 9: case rows are realm- and case-type-scoped through the join;
    // PARKED rows (applicant_id NULL — the intake hotword gate) carry no
    // case type of their own, so they are visible to live accounts only.
    const demo = opts.demo ?? 0;
    const appConds: string[] = [];
    if (opts.demo !== undefined) { appConds.push("a.demo = ?"); params.push(opts.demo); }
    const scope = this.scopePred("a", opts.caseTypes);
    if (scope.sql) { appConds.push(scope.sql.replace(/^ AND /, "")); params.push(...scope.params); }
    const appCondSql = appConds.length ? appConds.join(" AND ") : "1=1";
    // DEMO: parked (caseless) mail arrives on Organization #1's mailbox —
    // it is never shown inside another organization's workspace.
    const organizationId = (opts.caseTypes as ScopeTag | null | undefined)?.organizationId;
    const parked = organizationId === undefined ? "1=1" : "e.organization_id = ?";
    if (organizationId !== undefined) params.push(organizationId);
    where.push(`((e.applicant_id IS NOT NULL AND ${appCondSql}) OR (e.applicant_id IS NULL AND ${demo} = 0 AND ${parked}))`);
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
               a.case_type_code AS case_type_code, a.lifecycle AS lifecycle
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
  emailsForThread(tkey: string, organizationId = this.primaryOrganizationId()): EmailRecord[] {
    return this.db
      .prepare(`SELECT e.* FROM emails e WHERE ${Repo.threadKeySql("e")} = ? AND e.organization_id = ? ORDER BY e.at, e.id`)
      .all(tkey, organizationId) as EmailRecord[];
  }

  /** Opening a conversation reads its incoming mail. */
  markThreadRead(tkey: string, organizationId = this.primaryOrganizationId()): void {
    this.db
      .prepare(`UPDATE emails SET read = 1 WHERE direction = 'in' AND ${Repo.threadKeySql("emails")} = ? AND organization_id = ?`)
      .run(tkey, organizationId);
  }

  /** Marking a conversation unread returns it to the Unread filter. */
  markThreadUnread(tkey: string, organizationId = this.primaryOrganizationId()): void {
    this.db
      .prepare(`UPDATE emails SET read = 0 WHERE direction = 'in' AND ${Repo.threadKeySql("emails")} = ? AND organization_id = ?`)
      .run(tkey, organizationId);
  }

  /** Sidebar counts per folder (conversations), one aggregate query. */
  mailFolderCounts(opts: { caseTypes?: string[] | null; demo?: number }): Record<string, number> {
    if (isNoAccess(opts.caseTypes)) {
      return Object.fromEntries(Object.keys(Repo.MAIL_FOLDER_WHERE).map((folder) => [folder, 0]));
    }
    const where: string[] = [];
    const params: unknown[] = [];
    // Round 9: same realm rule as mailThreads — parked (applicant-less)
    // mail counts for live accounts only.
    const demo = opts.demo ?? 0;
    const appConds: string[] = [];
    if (opts.demo !== undefined) { appConds.push("a.demo = ?"); params.push(opts.demo); }
    const scope = this.scopePred("a", opts.caseTypes);
    if (scope.sql) { appConds.push(scope.sql.replace(/^ AND /, "")); params.push(...scope.params); }
    const appCondSql = appConds.length ? appConds.join(" AND ") : "1=1";
    // DEMO: parked (caseless) mail arrives on Organization #1's mailbox —
    // it is never shown inside another organization's workspace.
    const organizationId = (opts.caseTypes as ScopeTag | null | undefined)?.organizationId;
    const parked = organizationId === undefined ? "1=1" : "e.organization_id = ?";
    if (organizationId !== undefined) params.push(organizationId);
    where.push(`((e.applicant_id IS NOT NULL AND ${appCondSql}) OR (e.applicant_id IS NULL AND ${demo} = 0 AND ${parked}))`);
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
  setThreadLabel(tkey: string, label: string, on: boolean, organizationId = this.primaryOrganizationId()): void {
    const rows = this.emailsForThread(tkey, organizationId);
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
  threadLabelState(tkey: string, organizationId = this.primaryOrganizationId()): { starred: boolean; important: boolean; spam: boolean; bin: boolean } {
    const rows = this.emailsForThread(tkey, organizationId);
    const has = (l: string) => rows.some((e) => (e.labels || "").includes(`"${l}"`));
    return { starred: has("starred"), important: has("important"), spam: has("spam"), bin: has("bin") };
  }

  // ── Staff users & sessions (features 31, 32) ─────────────────────────────

  /**
   * H-2: the account belongs to a REAL tenant — never a hard-coded one.
   * `organizationId` defaults to 1 for the first-run admin (the only case
   * where no tenant exists yet), but every staff-adding route passes the
   * acting administrator's own organization.
   */
  createStaff(username: string, displayName: string, passwordHash: string, role: string, demo = false, organizationId = 1): void {
    this.db
      .prepare(
        "INSERT INTO staff_users (username, display_name, password_hash, role, demo, organization_id) VALUES (?,?,?,?,?,?)"
      )
      .run(username, displayName, passwordHash, role, demo ? 1 : 0, organizationId);
  }

  createStaffAndReturn(
    username: string,
    displayName: string,
    passwordHash: string,
    role: "admin" | "user" = "user",
    organizationId = 1
  ): StaffUser {
    this.createStaff(username, displayName, passwordHash, role, false, organizationId);
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

  /**
   * M-2: usernames have one canonical case (lowercase, see util/username.ts)
   * and are matched case-insensitively, so an account created before the rule
   * still resolves whichever way it is typed.
   */
  getStaffByUsername(username: string): (StaffUser & { password_hash: string }) | undefined {
    return this.db
      .prepare("SELECT id, username, display_name, password_hash, role, active, demo, organization_id FROM staff_users WHERE username = ? COLLATE NOCASE")
      .get(username) as never;
  }

  getStaff(id: number): StaffUser | undefined {
    return this.db
      .prepare("SELECT id, username, display_name, role, active, demo, organization_id FROM staff_users WHERE id = ?")
      .get(id) as StaffUser | undefined;
  }

  listStaff(organizationId?: number): StaffUser[] {
    const sql = organizationId === undefined
      ? "SELECT id, username, display_name, role, active, demo, organization_id FROM staff_users ORDER BY id"
      : "SELECT id, username, display_name, role, active, demo, organization_id FROM staff_users WHERE COALESCE(organization_id, 1) = ? ORDER BY id";
    return (organizationId === undefined
      ? this.db.prepare(sql).all()
      : this.db.prepare(sql).all(organizationId)) as StaffUser[];
  }

  /**
   * H-3: cross-tenant guard. Resolve a staff id ONLY when the account belongs
   * to the acting administrator's organization — the single entry point every
   * /staff/* route uses before acting on a target id.
   */
  staffInOrganization(staffId: number, organizationId: number): StaffUser | undefined {
    const staff = this.getStaff(staffId);
    if (!staff) return undefined;
    return (staff.organization_id ?? 1) === organizationId ? staff : undefined;
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
    // the shared legacy store. A template key is not a
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
    const current = this.getTemplate(key, organizationId, caseTypeId);
    // All new writes use the organization-owned store, including organization
    // 1. A legacy fallback may still supply `current` while an old database is
    // transitioning; preserve its original default snapshot on that first
    // modern write rather than redefining the administrator's edit as default.
    const priorDefault = this.templateDefaultSnapshot(key, organizationId);
    const initialSnapshot = priorDefault ? JSON.stringify(priorDefault) : snapshot;
    this.db.prepare(
      `INSERT INTO organization_templates (organization_id, key, name, subject, body, include_banner, attach_pack, case_type_id, default_snapshot) VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(organization_id, key) DO UPDATE SET name=excluded.name, subject=excluded.subject, body=excluded.body,
         include_banner=COALESCE(?, organization_templates.include_banner), attach_pack=COALESCE(?, organization_templates.attach_pack),
         case_type_id=excluded.case_type_id, updated_at=datetime('now')`
    ).run(organizationId, key, name, subject, body, includeBanner === undefined ? current?.include_banner ?? 1 : bannerVal,
      pack ?? current?.attach_pack ?? "none", caseTypeId, initialSnapshot,
      includeBanner === undefined ? null : bannerVal, pack);
  }

  setTemplateBanner(key: string, include: boolean, organizationId = 1): void {
    const current = this.getTemplate(key, organizationId);
    if (!current) return;
    this.upsertTemplate(
      current.key,
      current.name,
      current.subject,
      current.body,
      include,
      current.attach_pack,
      organizationId,
      current.case_type_id
    );
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
  notificationsFor(staffId: number, limit = 50, demo?: number, caseTypes?: string[] | null): Array<{ id: number; kind: string; message: string; read: number; at: string; applicant_id: number | null }> {
    const realmSql = demo === undefined ? "" : " AND (n.applicant_id IS NULL OR a.demo = ?)";
    // OR-8: scoped staff never see alerts about cases outside their caseTypes
    // (broadcast alerts without an applicant stay visible to everyone).
    const scope = this.scopePred("a", caseTypes);
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

  unreadCount(staffId: number, demo?: number, caseTypes?: string[] | null): number {
    if (isNoAccess(caseTypes)) return 0;
    const realmSql = demo === undefined ? "" : " AND (n.applicant_id IS NULL OR a.demo = ?)";
    const scope = this.scopePred("a", caseTypes);
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

  /**
   * Open cases nobody has handled yet.
   *
   * Without a window, a case qualifies once its own SLA clock has run out.
   * With `escalationHours` — the Settings `escalation_hours` value — the window
   * replaces that test: a case is escalated once it has been open this long,
   * so "respond within 4 h" and "raise it after 8 h" stay two independent
   * numbers the office can set. Before the window was applied here, the setting
   * only appeared inside the audit text and every value behaved like 0.
   *
   * `created_at` is written by SQLite as 'YYYY-MM-DD HH:MM:SS', a different
   * shape from the ISO stamps Node writes, so the age test compares julianday()
   * values instead of strings (see src/db/retention.ts for the same trap).
   */
  overdueCases(escalationHours = 0): ApplicantRow[] {
    const now = new Date().toISOString();
    const window = Number.isFinite(escalationHours) && escalationHours > 0 ? escalationHours : 0;
    if (!window) {
      return this.db
        .prepare(
          `SELECT * FROM applicants
           WHERE sla_due_at IS NOT NULL AND sla_handled_at IS NULL AND escalated = 0
             AND sla_due_at < ? AND lifecycle IN ('awaiting_review','documents_received','application_received')`
        )
        .all(now) as ApplicantRow[];
    }
    return this.db
      .prepare(
        `SELECT * FROM applicants
         WHERE sla_due_at IS NOT NULL AND sla_handled_at IS NULL AND escalated = 0
           AND julianday(?) - julianday(created_at) >= ?
           AND lifecycle IN ('awaiting_review','documents_received','application_received')`
      )
      .all(now, window / 24) as ApplicantRow[];
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
   * query — the case page must not do one query per applicant).
   *
   * The list is exactly the `EmailCategory` values that describe a question
   * rather than a submission, so it must stay inside that vocabulary: it used
   * to name `case_enquiry` (no such category exists) while leaving out
   * `general_enquiry`, which is the label ordinary enquiries are filed under —
   * so the Awaiting-review tile ignored nearly every enquiry it was built to
   * catch.
   */
  enquiryApplicantIdsToday(startISO: string, caseTypes?: string[] | null): Set<number> {
    const scope = this.scopePred("a", caseTypes);
    const rows = this.db
      .prepare(
        `SELECT DISTINCT e.applicant_id AS id FROM emails e JOIN applicants a ON a.id = e.applicant_id
         WHERE e.direction = 'in' AND e.at >= ?
           AND e.category IN ('general_enquiry','fee_enquiry','follow_up','complaint','other')${scope.sql}`
      )
      .all(startISO, ...scope.params) as Array<{ id: number }>;
    return new Set(rows.map((r) => r.id));
  }

  // ── Stage model (v5): every applicant sits in exactly one level ──────────
  // finished / unfinished / pending are the three buckets staff think in;
  // awaiting_review inside pending is the classic "human queue".

  stageCounts(demo?: number, caseTypes?: string[] | null): {
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
    const scope = this.scopePred("applicants", caseTypes);
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
    const enquiries = this.enquiryApplicantIdsToday(start.toISOString(), caseTypes).size;
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

  /** Counters for the Overview "Today" panel. */
  todayStats(demo?: number, caseTypes?: string[] | null): { emailsToday: number; docsToday: number; completedToday: number } {
    // date('now') is UTC — in UTC+3 the "today" counters would reset at 03:00
    // local. Compute THIS machine's local day boundaries instead.
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start.getTime() + 24 * 3600_000);
    const lo = start.toISOString();
    const hi = end.toISOString();
    const dp: unknown[] = demo === undefined ? [] : [demo];
    const scope = this.scopePred("a", caseTypes);
    const pred = (demo === undefined ? "" : " AND a.demo = ?") + scope.sql;
    const one = (sql: string) => (this.db.prepare(sql).get(lo, hi, ...dp, ...scope.params) as { n: number }).n;
    // The window compares INSTANTS through julianday(), never as text:
    // emails.at and documents.received_at are ISO stamps written by Node, while
    // status_history.at comes from SQLite's `datetime('now')` default
    // ("2026-05-01 08:00:00"). Compared as strings that row sorts before every
    // ISO bound (a space is below 'T' at position 11), so today's completions
    // fell outside today and the counter stuck at zero — the same trap
    // src/db/retention.ts documents for the retention sweep.
    const duringToday = (column: string) =>
      `julianday(${column}) >= julianday(?) AND julianday(${column}) < julianday(?)`;
    return {
      emailsToday: one(`SELECT COUNT(*) AS n FROM emails e JOIN applicants a ON a.id = e.applicant_id WHERE e.direction = 'in' AND ${duringToday("e.at")}${pred}`),
      docsToday: one(`SELECT COUNT(*) AS n FROM documents d JOIN applicants a ON a.id = d.applicant_id WHERE ${duringToday("d.received_at")}${pred}`),
      completedToday: one(`SELECT COUNT(*) AS n FROM status_history h JOIN applicants a ON a.id = h.applicant_id WHERE h.to_status = 'completed' AND ${duringToday("h.at")}${pred}`),
    };
  }

  /** The human work queue (feature 11): cases whose latest decision wasn't auto-resolved. */
  queueView(demo?: number, caseTypes?: string[] | null): Array<ApplicantRow & { computed_status: string; reasoning: string; auto_sent: boolean; decided_at: string; flag_summary: string }> {
    const scope = this.scopePred("a", caseTypes);
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
    if (opts.caseTypeCode) {
      where.push("case_type_code = ?");
      params.push(opts.caseTypeCode);
    }
    if (opts.intake) {
      where.push("intake = ?");
      params.push(opts.intake);
    }
    const scope = this.scopePred("applicants", opts.caseTypes);
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

  dashboardStats(demo?: number, caseTypes?: string[] | null): Record<string, number | string> {
    // Realm scope: every applicant-derived count filters by the caller's demo
    // flag so live admins never see seeded (mock) data and vice versa.
    // OR-8: the case-type scope applies to every count too.
    const scope = this.scopePred("a", caseTypes);
    const pred = (demo === undefined ? "" : " AND a.demo = ?") + scope.sql;
    const dp: unknown[] = demo === undefined ? [...scope.params] : [demo, ...scope.params];
    const one = (sql: string, p: unknown[] = []) => (this.db.prepare(sql).get(...p) as { n: number }).n;
    const applications = one(`SELECT COUNT(*) AS n FROM applicants a WHERE 1=1${pred}`, dp);
    // M-4: superseded documents are inactive everywhere else (case view,
    // CSV) — the dashboard must not count them either.
    const documents = one(
      `SELECT COUNT(*) AS n FROM documents d JOIN applicants a ON a.id = d.applicant_id WHERE d.is_duplicate = 0 AND d.superseded_by IS NULL${pred}`,
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
   * in verification) cases — scoped by realm + caseTypes like every other
   * admin number. Each applicant counts once per missing type, judged by
   * the frozen requirement snapshot where present (else live rules), minus
   * their active (non-superseded) documents.
   */
  commonMissingDocs(demo?: number, caseTypes?: string[] | null, limit = 5): Array<{ type: string; count: number }> {
    const counts = new Map<string, number>();
    for (const a of this.allApplicants(demo, caseTypes)) {
      if (a.lifecycle === "completed" || a.lifecycle === "verification") continue;
      // The SAME slot semantics as decide(): fillSlots decides what counts as
      // present, so the tile must not count as missing a document the pipeline
      // already considers received. A literal type-set difference used to show
      // complete files as short.
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

  allApplicants(demo?: number, caseTypes?: string[] | null): ApplicantRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (demo !== undefined) { where.push("demo = ?"); params.push(demo); }
    const scope = this.scopePred("applicants", caseTypes);
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

  /**
   * May this category's automated reply go out by itself?
   *
   * Two switches, both off by default:
   *  1. the global `automation_mode` — while it is `draft`, EVERY automated
   *     reply waits for a human whatever any rule or case type says;
   *  2. an explicit per-category ALLOWLIST. A category sends only when it was
   *     deliberately added (`mode = 'auto'`); an empty allowlist means nothing
   *     is ever sent automatically. This used to be a blocklist, so switching
   *     the global mode to `auto` released every category at once.
   */
  automationMode(category: string): "auto" | "draft" {
    if (!this.automationAllowedGlobally()) return "draft";
    const row = this.db.prepare("SELECT mode FROM automation_config WHERE category = ?").get(category) as { mode: string } | undefined;
    return row?.mode === "auto" ? "auto" : "draft";
  }

  /** The single global switch: is automated sending released at all? */
  automationAllowedGlobally(): boolean {
    return this.getSetting("automation_mode", "draft") !== "draft";
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
   * - casesCompleted: distinct cases they moved to "completed"
   */
  staffStats(demo?: number, organizationId?: number): StaffStatsRow[] {
    const staff = this.listStaff(organizationId);
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
        casesCompleted: completed,
      };
    });
  }

  // ── Intakes with deadlines (features 20, 21) ─────────────────────────────

  listIntakeRows(organizationId = 1): Array<{ name: string; deadline: string | null }> {
    return this.db.prepare("SELECT name, deadline FROM intakes WHERE organization_id = ? ORDER BY rowid").all(organizationId) as never[];
  }

  addIntakeWithDeadline(name: string, deadline: string | null, organizationId = 1): void {
    this.db
      .prepare("INSERT INTO intakes (organization_id, name, deadline) VALUES (?, ?, ?) ON CONFLICT(organization_id, name) DO UPDATE SET deadline = excluded.deadline")
      .run(organizationId, name, deadline);
  }

  intakeDeadline(intake: string | null, organizationId = 1): string | null {
    if (!intake) return null;
    const row = this.db.prepare("SELECT deadline FROM intakes WHERE organization_id = ? AND name = ?").get(organizationId, intake) as { deadline: string | null } | undefined;
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

  unansweredCases(caseTypes?: string[] | null): Array<{ applicant: ApplicantRow; lastInAt: string; hours: number }> {
    // Any outgoing email (automated or human) counts as "answered" — that is
    // the specified behavior (a factual auto-reply IS a reply). Batched into
    // one query; previously this ran one query per applicant (N+1).
    const rows = this.db
      .prepare(
        `SELECT a.id AS aid, MAX(e.at) AS last_in
         FROM applicants a
         JOIN emails e ON e.applicant_id = a.id AND e.direction = 'in'
         WHERE a.lifecycle NOT IN ('completed')${this.scopePred("a", caseTypes).sql}
         GROUP BY a.id`
      )
      .all(...this.scopePred("a", caseTypes).params) as Array<{ aid: number; last_in: string }>;
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

  categoryCounts(caseTypes?: string[] | null): Array<{ category: string; n: number }> {
    const scope = this.scopePred("a", caseTypes);
    return this.db
      .prepare(
        `SELECT coalesce(e.category,'other') AS category, COUNT(*) AS n
         FROM emails e JOIN applicants a ON a.id = e.applicant_id
         WHERE e.direction = 'in'${scope.sql} GROUP BY e.category ORDER BY n DESC`
      )
      .all(...scope.params) as never[];
  }

  /** Round 10: the three current markings per case (applicants.triage),
   *  realm- and case-type-scoped like every other dashboard number. */
  triageCounts(demo?: number, caseTypes?: string[] | null): { green: number; orange: number; red: number } {
    const scope = this.scopePred("a", caseTypes);
    const dp: unknown[] = demo === undefined ? [...scope.params] : [demo, ...scope.params];
    const pred = (demo === undefined ? "" : " AND a.demo = ?") + scope.sql;
    const one = (sql: string) => (this.db.prepare(sql).get(...dp) as { n: number }).n;
    return {
      green: one(`SELECT COUNT(*) AS n FROM applicants a WHERE a.triage = 'Green'${pred}`),
      orange: one(`SELECT COUNT(*) AS n FROM applicants a WHERE a.triage = 'Orange'${pred}`),
      red: one(`SELECT COUNT(*) AS n FROM applicants a WHERE a.triage = 'Red'${pred}`),
    };
  }

  accuracyStats(demo?: number, caseTypes?: string[] | null): Record<string, number> {
    const scope = this.scopePred("a", caseTypes);
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

  /**
   * Build a complete archive snapshot and delete its live rows under one
   * IMMEDIATE transaction. The writer must persist/verify the snapshot before
   * returning; a thrown file/encryption error rolls the database transaction
   * back. Re-checking the lifecycle and cutoff here prevents a stale candidate
   * list from deleting a case changed while the sweep was in progress.
   */
  archiveAndDeleteDueApplicant(
    applicantId: number,
    cutoffIso: string,
    retentionDays: number,
    writeArchive: (record: RetentionArchiveRecord) => void,
  ): string | undefined {
    const tx = this.db.transaction(() => {
      const applicant = this.getApplicant(applicantId);
      if (!applicant || applicant.lifecycle !== "completed" || !retentionDue(applicant.updated_at, cutoffIso)) {
        return undefined;
      }
      const record: RetentionArchiveRecord = {
        archived_at: nowIso(),
        retention_days: retentionDays,
        applicant,
        documents: this.listDocuments(applicantId, { activeOnly: false }),
        emails: this.emailsForApplicant(applicantId),
        flags: this.activeFlags(applicantId),
        notes: this.notesForApplicant(applicantId),
        status_history: this.statusHistory(applicantId),
        decision_logs: this.decisionLogs(applicantId),
        audit: this.auditForApplicant(applicantId),
      };
      writeArchive(record);
      this.deleteApplicantFull(applicantId);
      return applicant.ref_number;
    });
    return tx.immediate();
  }

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

  // ═══ Evidence rules engine (round 18) ══════════════════════════════════

  // ── OR-8: visibility scoping — the ONLY place scope is decided ─────────

  /** The case types a staff member may see.
   *
   * null = deliberately unscoped/full visibility (the default), a non-empty
   * array = assigned case types, and [] = deliberately no access. Keeping the
   * last state in staff_users makes an empty scope real instead of silently
   * turning it into unrestricted access.
   */
  visibleCaseTypesFor(staff: { id: number; role: string }): string[] | null {
    if (staff.role === "admin") return null;
    const rows = this.caseTypeScopesFor(staff.id);
    if (rows.length) return rows;
    return this.caseTypeScopeModeFor(staff.id) === "none" ? [] : null;
  }

  /** The case-list scope for a staff member — their case-type scope
   *  (visibleCaseTypesFor) PLUS their organization, so queues, dashboards,
   *  mail and search never mix tenants. Pass it anywhere a `caseTypes` scope
   *  is accepted. */
  caseScopeFor(staff: { id: number; role: string; organization_id?: number | null }): string[] {
    const caseTypes = this.visibleCaseTypesFor(staff);
    return Object.assign(caseTypes ? [...caseTypes] : [], { organizationId: staff.organization_id ?? 1, allCaseTypes: caseTypes === null });
  }

  /** Switch an admin's active organization (the sidebar switcher). */
  setActiveOrganization(staffId: number, organizationId: number): void {
    if (!this.getOrganization(organizationId)) throw new Error("Unknown organization");
    this.db.prepare("UPDATE staff_users SET active_organization_id = ? WHERE id = ?").run(organizationId, staffId);
  }

  /** Would this staff member see this case anywhere in the console? A case is
   * only visible inside its own organization, and scoped staff only see the
   * case types assigned to them; a case with no case type is never shared with
   * scoped staff. */
  applicantVisibleTo(staff: { id: number; role: string; organization_id?: number | null }, a: ApplicantRow): boolean {
    return this.caseTypeVisibleTo(staff, a);
  }

  /** SQL predicate restricting case rows to the given case-type codes.
   * `caseTypes === null/undefined` = full visibility; an EMPTY scoped list
   * matches nothing (never accidentally everything); a case with no case type
   * is never shared with scoped staff. */
  private scopePred(alias: string, caseTypes?: string[] | null): { sql: string; params: string[] } {
    if (caseTypes === undefined || caseTypes === null) return { sql: "", params: [] };
    const org = (caseTypes as ScopeTag).organizationId;
    const orgSql = org !== undefined ? ` AND COALESCE(${alias}.organization_id, 1) = ${Number(org)}` : "";
    if (isAllCaseTypes(caseTypes)) return { sql: orgSql, params: [] };
    if (caseTypes.length === 0) return { sql: " AND 0 = 1", params: [] };
    const marks = caseTypes.map(() => "?").join(",");
    return {
      sql: `${orgSql} AND EXISTS (SELECT 1 FROM case_types ct WHERE ct.id = ${alias}.case_type_id AND UPPER(ct.code) IN (${marks}))`,
      params: caseTypes.map((code) => code.toUpperCase()),
    };
  }

  // ── Staff visibility scopes (OR-8: case type × staff matrix) ────────────


  /** Replace a staff member's whole case-type set in ONE action. An empty set
   * is an explicit no-access scope; use clearCaseTypeScopes() to restore full
   * visibility. */
  setCaseTypeScopes(staffId: number, caseTypes: string[]): void {
    const clean = [...new Set(caseTypes.map((x) => x.trim().toUpperCase()).filter(Boolean))];
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM staff_case_type_scopes WHERE staff_id = ?").run(staffId);
      this.db.prepare("UPDATE staff_users SET case_type_scope_mode = ? WHERE id = ?").run(clean.length ? "scoped" : "none", staffId);
      const insert = this.db.prepare("INSERT OR IGNORE INTO staff_case_type_scopes (staff_id, case_type_code) VALUES (?,?)");
      for (const code of clean) insert.run(staffId, code);
    })();
  }

  /** Restore an officer's default full visibility explicitly. */
  clearCaseTypeScopes(staffId: number): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM staff_case_type_scopes WHERE staff_id = ?").run(staffId);
      this.db.prepare("UPDATE staff_users SET case_type_scope_mode = 'unscoped' WHERE id = ?").run(staffId);
    })();
  }

  caseTypeScopeModeFor(staffId: number): "unscoped" | "scoped" | "none" {
    const row = this.db.prepare("SELECT case_type_scope_mode FROM staff_users WHERE id = ?").get(staffId) as { case_type_scope_mode?: string } | undefined;
    if (row?.case_type_scope_mode === "none" || row?.case_type_scope_mode === "scoped") return row.case_type_scope_mode;
    return "unscoped";
  }

  caseTypeScopesFor(staffId: number): string[] {
    const rows = this.db.prepare("SELECT case_type_code FROM staff_case_type_scopes WHERE staff_id = ? ORDER BY case_type_code").all(staffId) as Array<{ case_type_code: string }>;
    return rows.map((r) => r.case_type_code);
  }

  /** Row-level twin of scopePred. */
  caseTypeVisibleTo(staff: { id: number; role: string; organization_id?: number | null }, a: ApplicantRow): boolean {
    if ((a.organization_id ?? 1) !== (staff.organization_id ?? 1)) return false;
    const scope = this.visibleCaseTypesFor(staff);
    if (!scope) return true;
    if (!a.case_type_id) return false;
    const code = this.caseTypeForCase(a.id)?.code;
    return Boolean(code) && scope.map((x) => x.toUpperCase()).includes(String(code).toUpperCase());
  }







  // ── Evaluations ────────────────────────────────────────────────────────────

  insertEvaluation(row: {
    applicant_id: number;
    set_id: number | null;
    /** The case type this evaluation ran against (column renamed by C2). */
    case_type_code: string | null;
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
        `INSERT INTO evaluations (applicant_id, set_id, case_type_code, system, set_version, result, routing, reason, reason_code, detail, rule_snapshot)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(row.applicant_id, row.set_id, row.case_type_code, row.system, row.set_version, row.result, row.routing, row.reason, row.reason_code, row.detail, row.rule_snapshot);
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
   * Open cases of one case type that have NO human owner yet. When ownership
   * changes these can flow to the new owner automatically — but a case somebody
   * already picked up is never re-routed behind their back.
   */
  openUnassignedCasesForCaseType(caseTypeCode: string, demo: 0 | 1): ApplicantRow[] {
    // Realm-scoped: an ownership change in the live console must never re-route
    // demo cases (and vice versa) — case-type codes are shared across realms.
    const rows = this.db
      .prepare(
        `SELECT * FROM applicants
         WHERE case_type_code = ? AND assigned_to IS NULL AND lifecycle <> 'completed'
           AND IFNULL(demo, 0) = ?
         ORDER BY id`
      )
      .all(caseTypeCode, demo) as ApplicantRow[];
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
