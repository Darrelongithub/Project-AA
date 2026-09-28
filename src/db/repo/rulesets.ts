/**
 * /db/repo — admission rule sets and evaluation records. Extracted verbatim from the Repo god class;
 * every function takes the Repo as its first argument and the Repo
 * facade in ../repo.ts delegates to it (same API, same behaviour).
 */
import { AdmissionRuleSet, AdmissionSystem, ApplicantRow, CourseLevel, RuleNode } from "../../types";
import type { Repo } from "../repo";

// ── Requirement sets (versioned trees per programme × system) ────────────
function rowToSet(_repo: Repo, r: Record<string, unknown>): AdmissionRuleSet {
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


export function listRuleSets(repo: Repo, filter: { programme?: string | null; status?: string; system?: string } = {}): AdmissionRuleSet[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.programme !== undefined) {
    if (filter.programme === null) where.push("programme IS NULL");
    else { where.push("programme = ?"); params.push(filter.programme); }
  }
  if (filter.status) { where.push("status = ?"); params.push(filter.status); }
  if (filter.system) { where.push("system = ?"); params.push(filter.system); }
  const rows = repo.db
    .prepare(`SELECT * FROM admission_rules ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY programme IS NULL, programme, system, version DESC`)
    .all(...params) as Array<Record<string, unknown>>;
  return rows.map((r) => rowToSet(repo, r));
}


export function getRuleSet(repo: Repo, id: number): AdmissionRuleSet | undefined {
  const r = repo.db.prepare("SELECT * FROM admission_rules WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!r) return undefined;
  return rowToSet(repo, r);
}


export function getRuleSetNodes(repo: Repo, setId: number): RuleNode[] {
  const rows = repo.db
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
export function getRuleTree(repo: Repo, setId: number): RuleNode[] {
  const flat = repo.getRuleSetNodes(setId);
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
export function activeSetsForProgramme(repo: Repo, programme: string | null): AdmissionRuleSet[] {
  const row = programme
    ? (repo.db.prepare("SELECT level FROM programmes WHERE code = ?").get(programme.toUpperCase()) as { level?: string } | undefined)
    : undefined;
  const level = (row?.level ?? "degree") as CourseLevel;
  const base = repo.listRuleSets({ programme: null, status: "active" }).filter((s) => s.level === level);
  const course = programme ? repo.listRuleSets({ programme: programme.toUpperCase(), status: "active" }) : [];
  const merged = new Map<string, AdmissionRuleSet>();
  for (const s of base) merged.set(s.system, s);
  for (const s of course) merged.set(s.system, s);
  for (const s of merged.values()) s.nodes = repo.getRuleTree(s.id);
  return [...merged.values()];
}


/** The draft set for editing ( programme | level | system ), if any. */
export function getDraftSet(repo: Repo, programme: string | null, level: CourseLevel, system: string): AdmissionRuleSet | undefined {
  const r = programme === null
    ? repo.db.prepare("SELECT * FROM admission_rules WHERE programme IS NULL AND level = ? AND system = ? AND status = 'draft'").get(level, system)
    : repo.db.prepare("SELECT * FROM admission_rules WHERE programme = ? AND level = ? AND system = ? AND status = 'draft'").get(programme, level, system);
  return r ? rowToSet(repo, r as Record<string, unknown>) : undefined;
}


function copyNodes(repo: Repo, fromSetId: number, toSetId: number): void {
  const flat = repo.getRuleSetNodes(fromSetId);
  const idMap = new Map<number, number>();
  const insert = repo.db.prepare(
    "INSERT INTO admission_rule_nodes (set_id, parent_id, kind, logic, field, subject, comparator, value, position) VALUES (?,?,?,?,?,?,?,?,?)"
  );
  // First pass: create rows with parent NULL; second pass: relink parents.
  for (const n of flat) {
    const res = insert.run(toSetId, null, n.kind, n.logic ?? null, n.field ?? null, n.subject ?? null, n.comparator ?? ">=", n.value ?? null, n.position ?? 0);
    idMap.set(n.id!, Number(res.lastInsertRowid));
  }
  const relink = repo.db.prepare("UPDATE admission_rule_nodes SET parent_id = ? WHERE id = ?");
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
export function ensureDraftSet(repo: Repo, programme: string | null, level: CourseLevel, system: AdmissionSystem, user: string): AdmissionRuleSet {
  const existing = repo.getDraftSet(programme, level, system);
  if (existing) return existing;
  const active = repo.listRuleSets({ programme, status: "active", system }).find((s) => s.level === level);
  const nextVersion = active ? active.version + 1 : 1;
  const res = repo.db
    .prepare("INSERT INTO admission_rules (programme, level, system, version, status, created_by) VALUES (?,?,?,?, 'draft', ?)")
    .run(programme, level, system, nextVersion, user);
  const id = Number(res.lastInsertRowid);
  if (active) copyNodes(repo, active.id, id);
  return repo.getRuleSet(id)!;
}


export function addRuleNode(repo: Repo, setId: number, parentId: number | null, kind: "group" | "condition", logic?: "AND" | "OR" | "NOT"): number {
  const pos = (repo.db
    .prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM admission_rule_nodes WHERE set_id = ? AND parent_id IS ?")
    .get(setId, parentId) as { p: number }).p;
  const res = repo.db
    .prepare(
      "INSERT INTO admission_rule_nodes (set_id, parent_id, kind, logic, field, comparator, position) VALUES (?,?,?,?,?,?,?)"
    )
    .run(setId, parentId, kind, kind === "group" ? (logic ?? "AND") : null, kind === "condition" ? "mean_grade" : null, kind === "condition" ? ">=" : null, pos);
  return Number(res.lastInsertRowid);
}


export function updateRuleNode(repo: Repo, nodeId: number, patch: Partial<Pick<RuleNode, "logic" | "field" | "subject" | "comparator" | "value">>): void {
  const cur = repo.db.prepare("SELECT logic, field, subject, comparator, value FROM admission_rule_nodes WHERE id = ?").get(nodeId) as
    | { logic: string | null; field: string | null; subject: string | null; comparator: string; value: string | null }
    | undefined;
  if (!cur) return;
  repo.db
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


export function moveRuleNode(repo: Repo, nodeId: number, parentId: number | null): void {
  repo.db.prepare("UPDATE admission_rule_nodes SET parent_id = ? WHERE id = ?").run(parentId, nodeId);
}


export function deleteRuleNode(repo: Repo, nodeId: number): void {
  // FK ON DELETE CASCADE handles descendants.
  repo.db.prepare("DELETE FROM admission_rule_nodes WHERE id = ?").run(nodeId);
}


/** The rule set that owns a node (any status), or undefined. */
export function ruleNodeSet(repo: Repo, nodeId: number): AdmissionRuleSet | undefined {
  const row = repo.db
    .prepare("SELECT set_id FROM admission_rule_nodes WHERE id = ?")
    .get(nodeId) as { set_id: number } | undefined;
  return row ? repo.getRuleSet(Number(row.set_id)) : undefined;
}


/**
 * True only when the node belongs to the DRAFT set for (programme, level,
 * system). The draft-flow routes must route writes through this: a raw
 * node id from a form body must not reach an ACTIVE or RETIRED set
 * (published rules change only via draft → activate) or another course's
 * set (a tampered or stale `node=` must never cross courses).
 */
function nodeInDraftSet(repo: Repo, nodeId: number, programme: string | null, level: CourseLevel, system: AdmissionSystem): boolean {
  const set = repo.ruleNodeSet(nodeId);
  return (
    !!set &&
    set.status === "draft" &&
    (set.programme ?? null) === (programme ?? null) &&
    set.level === level &&
    set.system === system
  );
}


/** updateRuleNode, refused (false) unless the node is in the target's draft. */
export function updateRuleNodeIfDraft(repo: Repo, 
  nodeId: number,
  programme: string | null,
  level: CourseLevel,
  system: AdmissionSystem,
  patch: Partial<Pick<RuleNode, "logic" | "field" | "subject" | "comparator" | "value">>
): boolean {
  if (!nodeInDraftSet(repo, nodeId, programme, level, system)) return false;
  repo.updateRuleNode(nodeId, patch);
  return true;
}


/** deleteRuleNode, refused (false) unless the node is in the target's draft. */
export function deleteRuleNodeIfDraft(repo: Repo, nodeId: number, programme: string | null, level: CourseLevel, system: AdmissionSystem): boolean {
  if (!nodeInDraftSet(repo, nodeId, programme, level, system)) return false;
  repo.deleteRuleNode(nodeId);
  return true;
}


/** Activate a draft: it becomes the new version; the old active retires. */
export function activateDraftSet(repo: Repo, setId: number): AdmissionRuleSet | undefined {
  const set = repo.getRuleSet(setId);
  if (!set || set.status !== "draft") return undefined;
  const tx = repo.db.transaction(() => {
    repo.db
      .prepare(
        `UPDATE admission_rules SET status = 'retired'
         WHERE status = 'active' AND system = ? AND level = ?
           AND (programme IS ?)`
      )
      .run(set.system, set.level, set.programme);
    repo.db.prepare("UPDATE admission_rules SET status = 'active', created_at = datetime('now') WHERE id = ?").run(setId);
  });
  tx();
  return repo.getRuleSet(setId);
}


export function discardDraftSet(repo: Repo, setId: number): void {
  const set = repo.getRuleSet(setId);
  if (!set || set.status !== "draft") return;
  repo.db.prepare("DELETE FROM admission_rules WHERE id = ?").run(setId); // cascades nodes
}


/** Freeze the current rule sets onto the applicant on first evaluation. */
export function freezeAdmissionSets(repo: Repo, a: ApplicantRow): AdmissionRuleSet[] {
  if (a.admission_rules_frozen) {
    try {
      return JSON.parse(a.admission_rules_frozen) as AdmissionRuleSet[];
    } catch {
      repo.audit(a.id, "system", "admission_rules_snapshot_corrupt", "frozen rule sets failed to parse — re-frozen from live rules; human should verify");
    }
  }
  const sets = repo.activeSetsForProgramme(a.programme);
  // E1: record WHEN the goalposts froze — audit/replay needs a real time,
  // and the FIRST freeze wins (a later corrupt re-parse must not move it).
  repo.db
    .prepare("UPDATE applicants SET admission_rules_frozen = ?, admission_rules_frozen_at = COALESCE(admission_rules_frozen_at, ?) WHERE id = ?")
    .run(JSON.stringify(sets), new Date().toISOString(), a.id);
  return sets;
}


// ── Evaluations ────────────────────────────────────────────────────────────
export function insertEvaluation(repo: Repo, row: {
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
  const res = repo.db
    .prepare(
      `INSERT INTO evaluations (applicant_id, set_id, programme, system, set_version, result, routing, reason, reason_code, detail, rule_snapshot)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(row.applicant_id, row.set_id, row.programme, row.system, row.set_version, row.result, row.routing, row.reason, row.reason_code, row.detail, row.rule_snapshot);
  return Number(res.lastInsertRowid);
}


export function latestEvaluation(repo: Repo, applicantId: number): (import("../../types").EvaluationReport & { id: number }) | null {
  const r = repo.db
    .prepare("SELECT * FROM evaluations WHERE applicant_id = ? ORDER BY id DESC LIMIT 1")
    .get(applicantId) as Record<string, unknown> | undefined;
  if (!r) return null;
  try {
    const report = JSON.parse(String(r.detail)) as import("../../types").EvaluationReport;
    return { ...report, id: r.id as number };
  } catch {
    return null;
  }
}


export function evaluationsForApplicant(repo: Repo, applicantId: number): Array<{ id: number; result: string; routing: string; reason: string; evaluated_at: string; set_version: number | null; system: string | null }> {
  return repo.db
    .prepare("SELECT id, result, routing, reason, evaluated_at, set_version, system FROM evaluations WHERE applicant_id = ? ORDER BY id DESC LIMIT 50")
    .all(applicantId) as never[];
}
