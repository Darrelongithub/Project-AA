/**
 * /db/repo — case types, document definitions, rule trees and workflow rules. Extracted verbatim from the Repo god class;
 * every function takes the Repo as its first argument and the Repo
 * facade in ../repo.ts delegates to it (same API, same behaviour).
 */
import { WorkflowRule } from "../../rules/workflow";
import { ApplicantRow, CaseConfigFrozen, CaseType, DocumentDefinition, RuleNode, normalizeProfileReplyAction } from "../../types";
import type { Repo } from "../repo";
import { EDUCATION_QUEUE_PRESET, EDUCATION_STAGE_PRESET, GENERIC_QUEUE_PRESET, GENERIC_STAGE_PRESET, nowIso } from "./shared";

/**
 * Raw `case_types` row as it comes out of SQLite: JSON columns are still
 * strings and `default_reply_action` is free TEXT (legacy/foreign values
 * possible) — rowToCaseType parses + normalizes it into a CaseType.
 */
type CaseTypeRow = Omit<CaseType, "config" | "terminology" | "stages" | "queues" | "default_reply_action"> & {
  config: string; terminology: string; stages: string; queues: string; default_reply_action: unknown;
};


export function createCaseType(repo: Repo, organizationId: number, input: {
  code: string; name: string; category?: string; config?: Record<string, unknown>;
  /** PPR P0-2/P0-4: profile flags. New profiles are draft-first, no auto-decision. */
  educationModule?: boolean; defaultReplyAction?: string; qualificationGate?: boolean; autoAdmit?: boolean;
}): CaseType {
  repo.db.prepare(
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
  return repo.getCaseType(input.code, organizationId)!;
}


export function getCaseType(repo: Repo, code: string, organizationId = 1): CaseType | undefined {
  const row = repo.db.prepare("SELECT id, organization_id, code, name, category, config, active, education_module, terminology, stages, queues, config_version, default_reply_action, qualification_gate, auto_admit FROM case_types WHERE organization_id = ? AND code = ? COLLATE NOCASE")
    .get(organizationId, code.trim()) as CaseTypeRow | undefined;
  return row ? rowToCaseType(repo, row) : undefined;
}


function rowToCaseType(_repo: Repo, row: CaseTypeRow): CaseType {
  let config: Record<string, unknown> = {};
  try { config = JSON.parse(row.config || "{}"); } catch { /* safe empty config */ }
  let terminology: Record<string, string> = {};
  try { terminology = JSON.parse(row.terminology || "{}"); } catch { /* safe empty */ }
  let stages: Array<{ id: string; label: string }> = [];
  try { stages = JSON.parse(row.stages || "[]"); } catch { /* safe empty */ }
  let queues: Array<{ id: string; label: string }> = [];
  try { queues = JSON.parse(row.queues || "[]"); } catch { /* safe empty */ }
  // The column is free TEXT: legacy/foreign values coerce to the safe
  // "draft" posture here, at the single read boundary for profiles.
  const default_reply_action = normalizeProfileReplyAction(row.default_reply_action);
  return { ...row, config, terminology, stages, queues, default_reply_action };
}


export function listCaseTypes(repo: Repo, organizationId = 1): CaseType[] {
  const rows = repo.db.prepare("SELECT code FROM case_types WHERE organization_id = ? AND active = 1 ORDER BY code").all(organizationId) as Array<{ code: string }>;
  return rows.map((r) => repo.getCaseType(r.code, organizationId)!).filter(Boolean);
}


/** Look a workflow profile up by its row id (any organization). */
export function caseTypeById(repo: Repo, id: number): CaseType | undefined {
  const row = repo.db.prepare("SELECT organization_id, code FROM case_types WHERE id = ?").get(id) as { organization_id: number; code: string } | undefined;
  return row ? repo.getCaseType(row.code, row.organization_id) : undefined;
}


export function caseTypeForCase(repo: Repo, id: number): CaseType | undefined {
  const row = repo.db.prepare("SELECT case_type_id FROM applicants WHERE id = ?").get(id) as { case_type_id?: number | null } | undefined;
  return row?.case_type_id ? getCaseTypeById(repo, row.case_type_id) : undefined;
}


function getCaseTypeById(repo: Repo, id: number): CaseType | undefined {
  const row = repo.db.prepare("SELECT organization_id, code FROM case_types WHERE id = ?").get(id) as { organization_id: number; code: string } | undefined;
  return row ? repo.getCaseType(row.code, row.organization_id) : undefined;
}


export function listDocumentDefinitions(repo: Repo, caseTypeId: number): DocumentDefinition[] {
  type Row = Omit<DocumentDefinition, "required" | "blocking"> & { required: number; blocking: number };
  return (repo.db.prepare("SELECT id, case_type_id, key, label, required, blocking, position FROM document_definitions WHERE case_type_id = ? ORDER BY position, id").all(caseTypeId) as Row[])
    .map((d) => ({ ...d, required: !!d.required, blocking: !!d.blocking }));
}


export function upsertDocumentDefinition(repo: Repo, caseTypeId: number, input: { key: string; label: string; required?: boolean; blocking?: boolean; position?: number }): void {
  const key = input.key.trim().toLowerCase().replace(/[^a-z0-9_:-]+/g, "_");
  if (!key || !input.label.trim()) throw new Error("Document key and label are required");
  repo.db.prepare(
    "INSERT INTO document_definitions (case_type_id, key, label, required, blocking, position) VALUES (?,?,?,?,?,?) " +
    "ON CONFLICT(case_type_id,key) DO UPDATE SET label=excluded.label, required=excluded.required, blocking=excluded.blocking, position=excluded.position"
  ).run(caseTypeId, key, input.label.trim(), input.required === false ? 0 : 1, input.blocking === false ? 0 : 1, input.position ?? 0);
  repo.bumpCaseTypeConfigVersion(caseTypeId);
}


export function deleteDocumentDefinition(repo: Repo, caseTypeId: number, key: string): void {
  repo.db.prepare("DELETE FROM document_definitions WHERE case_type_id = ? AND key = ?").run(caseTypeId, key.trim().toLowerCase());
  repo.bumpCaseTypeConfigVersion(caseTypeId);
}


export function updateCaseTypeRules(repo: Repo, caseTypeId: number, nodes: RuleNode[]): void {
  const row = repo.db.prepare("SELECT config FROM case_types WHERE id = ?").get(caseTypeId) as { config?: string } | undefined;
  let config: Record<string, unknown> = {};
  try { config = JSON.parse(row?.config || "{}"); } catch { /* replace corrupt config safely */ }
  config.rules = nodes;
  repo.db.prepare("UPDATE case_types SET config = ? WHERE id = ?").run(JSON.stringify(config), caseTypeId);
  repo.bumpCaseTypeConfigVersion(caseTypeId);
}


export function caseTypeRules(_repo: Repo, caseType: CaseType): RuleNode[] {
  const raw = caseType.config?.rules;
  return Array.isArray(raw) ? raw as RuleNode[] : [];
}


// ── PPR P0-3: configuration versioning + per-case freeze ─────────────────
/** Publishing rules/documents for a profile bumps its configuration version. */
export function bumpCaseTypeConfigVersion(repo: Repo, caseTypeId: number): number {
  repo.db.prepare("UPDATE case_types SET config_version = config_version + 1 WHERE id = ?").run(caseTypeId);
  return repo.caseTypeConfigVersion(caseTypeId);
}


export function caseTypeConfigVersion(repo: Repo, caseTypeId: number): number {
  const row = repo.db.prepare("SELECT config_version FROM case_types WHERE id = ?").get(caseTypeId) as { config_version?: number } | undefined;
  return row?.config_version ?? 1;
}


/**
 * Freeze the exact profile configuration a case is opened under. Existing
 * snapshots are immutable — later edits never rewrite them (audit F6).
 */
export function freezeCaseConfig(repo: Repo, a: ApplicantRow): void {
  if (a.case_config_frozen) return;
  const caseType = repo.caseTypeForCase(a.id);
  const frozen: CaseConfigFrozen = {
    config_version: caseType?.config_version ?? 1,
    rules: caseType ? repo.caseTypeRules(caseType) : null,
    documents: caseType ? repo.listDocumentDefinitions(caseType.id).map((d) => ({ key: d.key, label: d.label, required: d.required, blocking: d.blocking })) : null,
    frozen_at: nowIso(),
  };
  repo.db.prepare("UPDATE applicants SET case_config_frozen = ?, config_version_frozen = ?, config_version_frozen_at = ? WHERE id = ?")
    .run(JSON.stringify(frozen), frozen.config_version, frozen.frozen_at, a.id);
}


/** The frozen configuration snapshot of a case (null for legacy rows). */
export function caseConfigFrozen(_repo: Repo, a: ApplicantRow): CaseConfigFrozen | null {
  if (!a.case_config_frozen) return null;
  try { return JSON.parse(a.case_config_frozen) as CaseConfigFrozen; } catch { return null; }
}


/** Explicit, human-approved upgrade of a case to the profile's CURRENT
 * configuration version. Never happens implicitly (PPR P0-3). */
export function reFreezeCaseConfig(repo: Repo, a: ApplicantRow): CaseConfigFrozen {
  repo.db.prepare("UPDATE applicants SET case_config_frozen = NULL WHERE id = ?").run(a.id);
  repo.freezeCaseConfig({ ...a, case_config_frozen: null } as ApplicantRow);
  const refrozen = repo.caseConfigFrozen(repo.requireApplicant(a.id));
  if (!refrozen) throw new Error(`reFreezeCaseConfig: frozen config missing for case ${a.id} immediately after freeze`);
  return refrozen;
}


/** PPR P0-2: is this case an education-module case? */
export function educationCaseFor(repo: Repo, a: ApplicantRow): boolean {
  if (a.case_type_id) {
    const t = getCaseTypeById(repo, a.case_type_id);
    return t ? t.education_module === 1 : false;
  }
  return (a.organization_id ?? 1) === 1;
}


/** PPR P0-2: does this organization run any education-module profile? */
export function hasEducationModule(repo: Repo, organizationId = 1): boolean {
  const row = repo.db.prepare("SELECT COUNT(*) AS n FROM case_types WHERE organization_id = ? AND education_module = 1").get(organizationId) as { n: number };
  return row.n > 0;
}


// ── PPR P0-4: workflow rules (intake + response behaviour as data) ───────
export function listWorkflowRules(repo: Repo, organizationId = 1, opts: { caseTypeId?: number | null; kind?: "intake" | "response" } = {}): WorkflowRule[] {
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
  const rows = repo.db.prepare(sql).all(...params) as Array<Omit<WorkflowRule, "conditions" | "action"> & { conditions: string; action: string }>;
  return rows.map((r) => {
    let conditions: WorkflowRule["conditions"] = [];
    let action: WorkflowRule["action"] = {};
    try { conditions = JSON.parse(r.conditions || "[]"); } catch { /* safe empty */ }
    try { action = JSON.parse(r.action || "{}"); } catch { /* safe empty */ }
    return { ...r, conditions, action };
  });
}


export function getWorkflowRule(repo: Repo, id: number): WorkflowRule | undefined {
  const row = repo.db.prepare("SELECT * FROM workflow_rules WHERE id = ?").get(id) as (Omit<WorkflowRule, "conditions" | "action"> & { conditions: string; action: string }) | undefined;
  if (!row) return undefined;
  let conditions: WorkflowRule["conditions"] = [];
  let action: WorkflowRule["action"] = {};
  try { conditions = JSON.parse(row.conditions || "[]"); } catch { /* safe empty */ }
  try { action = JSON.parse(row.action || "{}"); } catch { /* safe empty */ }
  return { ...row, conditions, action };
}


export function saveWorkflowRule(repo: Repo, input: {
  id?: number; organizationId: number; caseTypeId?: number | null; kind?: "intake" | "response";
  name: string; position?: number; enabled?: boolean; conditions: WorkflowRule["conditions"]; action: WorkflowRule["action"];
}): WorkflowRule {
  const name = input.name.trim();
  if (!name) throw new Error("Rule name is required");
  const kind = input.kind ?? "intake";
  if (input.id) {
    repo.db.prepare(
      "UPDATE workflow_rules SET name = ?, kind = ?, case_type_id = ?, position = ?, enabled = ?, conditions = ?, action = ?, updated_at = datetime('now') WHERE id = ? AND organization_id = ?"
    ).run(name, kind, input.caseTypeId ?? null, input.position ?? 0, input.enabled === false ? 0 : 1,
      JSON.stringify(input.conditions ?? []), JSON.stringify(input.action ?? {}), input.id, input.organizationId);
  } else {
    const nextPos = input.position ?? ((repo.db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM workflow_rules WHERE organization_id = ?").get(input.organizationId) as { p: number }).p);
    repo.db.prepare(
      "INSERT INTO workflow_rules (organization_id, case_type_id, kind, name, position, enabled, conditions, action) VALUES (?,?,?,?,?,?,?,?)"
    ).run(input.organizationId, input.caseTypeId ?? null, kind, name, nextPos, input.enabled === false ? 0 : 1,
      JSON.stringify(input.conditions ?? []), JSON.stringify(input.action ?? {}));
  }
  const saved = repo.db.prepare("SELECT id FROM workflow_rules WHERE organization_id = ? AND name = ? ORDER BY id DESC").get(input.organizationId, name) as { id: number };
  // Rule edits are configuration publishes (PPR P0-3).
  if (input.caseTypeId) repo.bumpCaseTypeConfigVersion(input.caseTypeId);
  return repo.listWorkflowRules(input.organizationId, {}).find((r) => r.id === saved.id)!;
}


export function deleteWorkflowRule(repo: Repo, id: number, organizationId = 1): void {
  const row = repo.db.prepare("SELECT case_type_id FROM workflow_rules WHERE id = ? AND organization_id = ?").get(id, organizationId) as { case_type_id: number | null } | undefined;
  repo.db.prepare("DELETE FROM workflow_rules WHERE id = ? AND organization_id = ?").run(id, organizationId);
  if (row?.case_type_id) repo.bumpCaseTypeConfigVersion(row.case_type_id);
}


/** PPR P0-4/P1: profile-level automation defaults (workflow profile card). */
export function updateCaseTypeProfile(repo: Repo, id: number, patch: { default_reply_action?: "auto" | "draft"; qualification_gate?: 0 | 1; auto_admit?: 0 | 1 }): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.default_reply_action !== undefined) { sets.push("default_reply_action = ?"); params.push(patch.default_reply_action); }
  if (patch.qualification_gate !== undefined) { sets.push("qualification_gate = ?"); params.push(patch.qualification_gate); }
  if (patch.auto_admit !== undefined) { sets.push("auto_admit = ?"); params.push(patch.auto_admit); }
  if (!sets.length) return;
  repo.db.prepare(`UPDATE case_types SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
}


/** PPR P1-1/P1-2: profile vocabulary (five surface words) + stage/queue sets.
 *  Internal ids never move — only labels and membership are edited. */
export function updateCaseTypeVocabulary(repo: Repo, id: number, patch: {
  terminology?: Record<string, string>;
  stages?: Array<{ id: string; label: string; requires?: string[] }>;
  queues?: Array<{ id: string; label: string }>;
}): void {
  const current = repo.caseTypeById(id);
  if (!current) throw new Error("Unknown workflow profile");
  const terminology = patch.terminology ?? current.terminology;
  const stages = patch.stages ?? current.stages;
  const queues = patch.queues ?? current.queues;
  repo.db.prepare("UPDATE case_types SET terminology = ?, stages = ?, queues = ? WHERE id = ?")
    .run(JSON.stringify(terminology), JSON.stringify(stages), JSON.stringify(queues), id);
  repo.bumpCaseTypeConfigVersion(id);
}
