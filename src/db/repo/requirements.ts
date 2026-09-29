/**
 * /db/repo — requirement rules, system blocks and requirement resolution. Extracted verbatim from the Repo god class;
 * every function takes the Repo as its first argument and the Repo
 * facade in ../repo.ts delegates to it (same API, same behaviour).
 */
import { ApplicantNationality, ProgrammeLevel, documentRequirementsFor } from "../../documents/matrix";
import { ApplicantRow, CourseLevel, DocType, RequirementRule, RequirementSetEntry, SystemBlock } from "../../types";
import type { Repo } from "../repo";

// ── Requirements (features 8, 36, 37) ────────────────────────────────────
/**
 * SQLite treats NULLs as DISTINCT in UNIQUE constraints, so
 * `ON CONFLICT(programme, intake, document_type)` can never fire for base
 * rules (programme=NULL, intake=NULL) — every "upsert" silently inserted a
 * duplicate. Rules are therefore upserted as delete-then-insert matched
 * with `IS`, which treats NULL as equal to NULL.
 */
function upsertRuleRow(repo: Repo, programme: string | null, intake: string | null, documentType: string, required: boolean, meanGrade: string | null, subjectGrades: string | null): void {
  repo.db
    .prepare("DELETE FROM requirement_rules WHERE programme IS ? AND intake IS ? AND document_type = ?")
    .run(programme, intake, documentType);
  repo.db
    .prepare("INSERT INTO requirement_rules (programme, intake, document_type, required, mean_grade, subject_grades) VALUES (?,?,?,?,?,?)")
    .run(programme, intake, documentType, required ? 1 : 0, meanGrade, subjectGrades);
}


export function seedBaseRequirements(repo: Repo, entries: RequirementSetEntry[]): void {
  const tx = repo.db.transaction(() => {
    for (const e of entries) {
      upsertRuleRow(repo, null, null, e.document_type, e.required, e.meanGrade ?? null, e.subjectGrades ?? null);
    }
  });
  tx();
}


/** Remove duplicate rule rows left behind by the old NULL-broken upsert. Idempotent. */
export function dedupeRules(repo: Repo): number {
  const res = repo.db
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


export function listRules(repo: Repo): RequirementRule[] {
  const rows = repo.db
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


export function upsertRule(repo: Repo, rule: { programme: string | null; intake: string | null; document_type: DocType; required: boolean; meanGrade?: string | null; subjectGrades?: string | null }): void {
  // See seedBaseRequirements: ON CONFLICT cannot see NULL programme/intake,
  // so upsert is delete-then-insert with IS-matching.
  repo.db.transaction(() => {
    upsertRuleRow(repo, rule.programme, rule.intake, rule.document_type, rule.required, rule.meanGrade ?? null, rule.subjectGrades ?? null);
  })();
}


export function deleteRule(repo: Repo, id: number): void {
  repo.db.prepare("DELETE FROM requirement_rules WHERE id = ?").run(id);
}


// ── Structured entry requirements (per qualification system) ──────────────
function rowToBlock(_repo: Repo, r: Record<string, unknown>): SystemBlock {
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


export function listSystemBlocks(repo: Repo, programme: string | null): Array<SystemBlock & { level: string }> {
  const rows = repo.db
    .prepare("SELECT * FROM course_requirements WHERE programme IS ? ORDER BY system")
    .all(programme) as Array<Record<string, unknown>>;
  return rows.map((r) => ({ ...rowToBlock(repo, r), level: String(r.level) }));
}


/** Delete-then-insert (NULL programme cannot take part in ON CONFLICT). */
export function upsertSystemBlock(repo: Repo, programme: string | null, level: CourseLevel, block: SystemBlock): void {
  repo.db.transaction(() => {
    repo.db
      .prepare("DELETE FROM course_requirements WHERE programme IS ? AND level = ? AND system = ?")
      .run(programme, level, block.system);
    repo.db
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


export function deleteSystemBlock(repo: Repo, programme: string | null, system: string, level?: CourseLevel): void {
  if (programme === null) {
    repo.db
      .prepare("DELETE FROM course_requirements WHERE programme IS NULL AND level = ? AND system = ?")
      .run(level ?? "degree", system);
  } else {
    repo.db
      .prepare("DELETE FROM course_requirements WHERE programme IS ? AND system = ?")
      .run(programme, system);
  }
}


/**
 * Effective entry-requirement blocks for a course: the course's own block
 * for a system wins; otherwise the university-wide default for the course's
 * level applies. Unknown programmes fall back to the degree defaults.
 */
export function resolveBlocks(repo: Repo, programme: string | null): SystemBlock[] {
  const row = programme
    ? (repo.db.prepare("SELECT level FROM programmes WHERE code = ?").get(programme.toUpperCase()) as { level?: string } | undefined)
    : undefined;
  const level = (row?.level ?? "degree") as CourseLevel;
  const base = repo.listSystemBlocks(null).filter((b) => b.level === level);
  const course = programme ? repo.listSystemBlocks(programme.toUpperCase()) : [];
  const merged = new Map<string, SystemBlock>();
  for (const b of base) merged.set(b.system, b);
  for (const b of course) merged.set(b.system, b);
  return [...merged.values()];
}


/** Structured blocks as they apply to THIS applicant (snapshot wins). */
export function effectiveBlocks(repo: Repo, a: ApplicantRow): SystemBlock[] {
  if (a.requirements_structured) {
    try {
      return JSON.parse(a.requirements_structured) as SystemBlock[];
    } catch {
      repo.audit(a.id, "system", "structured_snapshot_corrupt",
        "frozen structured requirements failed to parse — fell back to live rules; human should verify");
    }
  }
  return repo.resolveBlocks(a.programme);
}


/** Freeze the current structured blocks onto the applicant on first triage. */
export function freezeStructuredSnapshot(repo: Repo, a: ApplicantRow): void {
  if (a.requirements_structured) return;
  const blocks = repo.resolveBlocks(a.programme);
  repo.db
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
export function effectiveRequirements(repo: Repo, a: ApplicantRow): RequirementSetEntry[] {
  if (a.requirements_snapshot) {
    try {
      return JSON.parse(a.requirements_snapshot) as RequirementSetEntry[];
    } catch {
      // Corrupt snapshot: falling back to LIVE rules silently would re-judge
      // repo applicant by rules that changed after they applied — the exact
      // thing the snapshot exists to prevent. Make it visible.
      repo.audit(
        a.id,
        "system",
        "requirements_snapshot_corrupt",
        "frozen requirement snapshot failed to parse — fell back to live rules; human should verify"
      );
    }
  }
  const caseType = repo.caseTypeForCase(a.id);
  // PPR P0-2: the education_module flag is the switch. A profile without
  // the module NEVER sees the academic document matrix (audit F1/E4); it
  // uses only organization-owned document slots. Untyped legacy cases of
  // the migrated Organization #1 keep the academic compatibility path.
  const education = caseType ? caseType.education_module === 1 : (a.organization_id ?? 1) === 1;
  if (!education) {
    return caseType
      ? repo.listDocumentDefinitions(caseType.id).map((d) => ({
          document_type: d.key as DocType, required: d.required, blocking: d.blocking,
        }))
      : [];
  }
  return repo.resolveRequirements(a.programme, a.intake, {
    transfer: a.transfer === 1,
    nationality: (a as { nationality?: string | null }).nationality ?? null,
  });
}


/** Freeze the current requirement set onto the applicant on first triage.
 * effectiveRequirements (not raw resolveRequirements) so applicant-level
 * additions — like the credit transfer form for transfer applicants — are
 * captured in the frozen set too. */
export function freezeRequirementsSnapshot(repo: Repo, a: ApplicantRow): void {
  if (a.requirements_snapshot) return;
  const snapshot = repo.effectiveRequirements(a);
  repo.db
    .prepare("UPDATE applicants SET requirements_snapshot = ? WHERE id = ?")
    .run(JSON.stringify(snapshot), a.id);
}


/**
 * OR-5: document requirements come from the DETERMINISTIC generator
 * (level × curriculum × nationality × route + primary-cert constant), sourced from
 * the official application-form checklist. The legacy requirement_rules
 * table is no longer read — requirements are not staff-configurable.
 */
export function resolveRequirements(repo: Repo,
  programme: string | null,
  _intake: string | null,
  opts?: { transfer?: boolean; nationality?: string | null }
): RequirementSetEntry[] {
  const p = programme ? repo.programmeByCode(programme) : undefined;
  // CourseLevel "postgrad" maps onto the matrix's "masters" tier (the
  // PhD tier applies only to programmes explicitly recorded as PhD).
  const rawLevel = (p?.level ?? "degree") as string;
  // legacy "postgrad" rows behave as masters until the migration rewrites them
  const level: ProgrammeLevel = rawLevel === "postgrad" ? "masters" : (rawLevel as ProgrammeLevel);
  const nationality: ApplicantNationality =
    opts?.nationality === "kenyan" || opts?.nationality === "international" ? opts.nationality : "unknown";
  return applyCourseDocOverrides(repo, programme, documentRequirementsFor({
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
function applyCourseDocOverrides(repo: Repo, programme: string | null, entries: RequirementSetEntry[]): RequirementSetEntry[] {
  if (!programme) return entries;
  const configured = repo.courseDocConfig(programme);
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
export function courseDocConfig(repo: Repo, programme: string): Set<DocType> | null {
  const rows = repo.db
    .prepare("SELECT document_type FROM course_doc_requirements WHERE programme = ?")
    .all(programme.toUpperCase()) as Array<{ document_type: string }>;
  if (rows.length === 0) return null;
  return new Set(rows.map((r) => r.document_type as DocType));
}


/** Save a course's configured required document types (replaces the set). */
export function saveCourseDocConfig(repo: Repo, programme: string, types: DocType[]): void {
  const code = programme.toUpperCase();
  repo.db.prepare("DELETE FROM course_doc_requirements WHERE programme = ?").run(code);
  const ins = repo.db.prepare("INSERT OR IGNORE INTO course_doc_requirements (programme, document_type) VALUES (?, ?)");
  for (const t of new Set(types)) ins.run(code, t);
}


/** Remove a course's configuration — it falls back to the matrix defaults. */
export function deleteCourseDocConfig(repo: Repo, programme: string): void {
  repo.db.prepare("DELETE FROM course_doc_requirements WHERE programme = ?").run(programme.toUpperCase());
}
