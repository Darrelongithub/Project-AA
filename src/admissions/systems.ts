/**
 * /admissions — qualification systems, grade scales and value comparison.
 *
 * Every route speaks the language it is actually marked in: national-
 * secondary letter grades, O-Level A*–G, A-Level/KACE letters, IB 1–7 points,
 * GPAs and award classes. Comparisons are deterministic; anything unknown is
 * NEVER guessed —
 * it becomes "undetermined" and the routing layer decides what that means.
 */
import type { AdmissionSystem, ExtractedFields, RuleField } from "../types";
import { admissionsPreset } from "../presets/loader";
import {
  ALEVEL_LADDER as SHARED_ALEVEL_LADDER,
  DEGREE_CLASS_LADDER as SHARED_DEGREE_CLASS_LADDER,
  DIPLOMA_CLASS_LADDER as SHARED_DIPLOMA_CLASS_LADDER,
  GRADE_LADDER as SHARED_GRADE_LADDER,
  IB_SUBJECT_LADDER as SHARED_IB_SUBJECT_LADDER,
  O_LEVEL_LADDER as SHARED_O_LEVEL_LADDER,
  canonClass,
  normalizeGrade,
} from "../rules/ladders";
// Grade ladders are defined ONCE in src/rules/ladders.ts (shared with the
// rules engine); this module keeps its historical export names as aliases.
export { normalizeGrade } from "../rules/ladders";

/** System display labels — admissions-preset data (same mapping as shipped). */
export const SYSTEM_LABELS: Record<AdmissionSystem, string> =
  admissionsPreset().admissionSystemLabels as Record<AdmissionSystem, string>;

/** Best → worst ladders (index 0 = best). Aliases of the shared ladders. */
export const NATIONAL_SECONDARY_LADDER: readonly string[] = SHARED_GRADE_LADDER;
export const O_LEVEL_LADDER: readonly string[] = SHARED_O_LEVEL_LADDER;
export const ALEVEL_LADDER: readonly string[] = SHARED_ALEVEL_LADDER;
export const IB_SUBJECT_LADDER: readonly string[] = SHARED_IB_SUBJECT_LADDER;
/** Worst → best class ladders. Aliases of the shared ladders. */
export const DIPLOMA_CLASS_LADDER: readonly string[] = SHARED_DIPLOMA_CLASS_LADDER;
export const DEGREE_CLASS_LADDER: readonly string[] = SHARED_DEGREE_CLASS_LADDER;

/**
 * Preset-defined system codes the core routes on but never spells: the
 * national-secondary system and the O-Level system of the active preset.
 */
export const NATIONAL_SECONDARY_SYSTEM: string = admissionsPreset().subjects.nationalSecondarySystem;
export const O_LEVEL_SYSTEM: string =
  admissionsPreset().examSystems.find((s) => s.scale === "oLevel")?.system ?? "unconfigured-o-level";

/** The letter/grade ladder a system's grades live on (null = numeric/class). */
export function gradeLadderFor(system: AdmissionSystem): readonly string[] | null {
  const preset = admissionsPreset();
  const key = preset.scaleRoutes.letter[system];
  return key ? preset.scales[key] : null;
}

export function classLadderFor(system: AdmissionSystem): readonly string[] | null {
  const preset = admissionsPreset();
  const key = preset.scaleRoutes.class[system];
  return key ? preset.scales[key] : null;
}

export type CmpResult = "ok" | "below" | "unknown";

/** Compare two grades on a best→worst ladder. */
export function compareLadder(actual: string, required: string, ladder: readonly string[]): CmpResult {
  const a = ladder.indexOf(normalizeGrade(actual));
  const r = ladder.indexOf(normalizeGrade(required));
  if (a < 0 || r < 0) return "unknown";
  return a <= r ? "ok" : "below";
}

/** Compare two award classes (worst→best ladders). */
export function compareClass(actual: string, required: string, ladder: readonly string[]): CmpResult {
  const a = ladder.indexOf(canonClass(actual));
  const r = ladder.indexOf(canonClass(required));
  if (a < 0 || r < 0) return "unknown";
  return a >= r ? "ok" : "below";
}

/** Compare two numbers. */
export function compareNumber(actual: number, required: number): CmpResult {
  if (!Number.isFinite(actual)) return "unknown";
  return actual >= required ? "ok" : "below";
}

/** Grade value options offered in the rule editor, per system. */
export function gradeOptionsFor(system: AdmissionSystem, field: RuleField): string[] {
  if (field === "class") {
    const ladder = classLadderFor(system);
    return ladder ? [...ladder].reverse().map((c) => c.replace(/\b\w/g, (m) => m.toUpperCase())) : [];
  }
  if (field === "subject" || field === "mean_grade") {
    return [...(gradeLadderFor(system) ?? [])];
  }
  return [];
}

/** Numeric fields (compared as numbers, not grades). */
export const NUMERIC_FIELDS: RuleField[] = ["credits", "principals", "subsidiaries", "points", "gpa"];

export const FIELD_LABELS: Record<string, string> = {
  mean_grade: "Mean grade",
  subject: "Subject",
  credits: "Passes at C or better",
  principals: "Principal passes",
  subsidiaries: "Subsidiary passes",
  points: "Total points",
  gpa: "GPA",
  class: "Award class",
};

/**
 * Pull the applicant's value for one field out of the extracted document
 * fields. `null` = the value was not extracted.
 */
export function readValue(fields: ExtractedFields, ruleField: RuleField, subject: string | null): string | number | null {
  switch (ruleField) {
    case "mean_grade":
      return typeof fields.meanGrade === "string" && fields.meanGrade ? fields.meanGrade : null;
    case "subject": {
      if (!subject) return null;
      const subs = fields.subjectGrades ?? {};
      const want = subject.trim().toLowerCase();
      const key = Object.keys(subs).find((k) => k.trim().toLowerCase() === want || k.trim().toLowerCase().replace(/&/g, "and") === want.replace(/&/g, "and"));
      return key ? String(subs[key]) : null;
    }
    case "credits":
      return typeof fields.credits === "number" ? fields.credits : null;
    case "principals":
      return typeof fields.principals === "number" ? fields.principals : null;
    case "subsidiaries":
      return typeof fields.subsidiaries === "number" ? fields.subsidiaries : null;
    case "points":
      return typeof fields.ibPoints === "number" ? fields.ibPoints : null;
    case "gpa":
      return typeof fields.gpa === "number" ? fields.gpa : null;
    case "class":
      return typeof fields.classAwarded === "string" && fields.classAwarded ? fields.classAwarded : null;
    default:
      return fields[ruleField] as string | number | null ?? null;
  }
}
