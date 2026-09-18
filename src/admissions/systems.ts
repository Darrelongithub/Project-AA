/**
 * /admissions — qualification systems, grade scales and value comparison.
 *
 * Every route speaks the language it is actually marked in: KCSE letter
 * grades, IGCSE A*–G, A-Level/KACE letters, IB 1–7 points, GPAs and award
 * classes. Comparisons are deterministic; anything unknown is NEVER guessed —
 * it becomes "undetermined" and the routing layer decides what that means.
 */
import type { AdmissionSystem, ExtractedFields, RuleField } from "../types";

export const SYSTEM_LABELS: Record<AdmissionSystem, string> = {
  KCSE: "KCSE",
  IGCSE: "IGCSE / GCE O-Level",
  IB: "IB Diploma",
  ALEVEL: "GCE A-Level",
  KACE: "KACE (A-Level)",
  EACE: "EACE (O-Level)",
  DIPLOMA: "Diploma",
  PROFCERT: "Professional Certificate",
  DEGREE: "Degree",
  OTHER: "Other recognised qualification",
};

/** Best → worst ladders (index 0 = best). */
export const KCSE_LADDER = ["A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D+", "D", "D-", "E"];
export const IGCSE_LADDER = ["A*", "A", "B", "C", "D", "E", "F", "G"];
export const ALEVEL_LADDER = ["A", "B", "C", "D", "E"];
export const IB_SUBJECT_LADDER = ["7", "6", "5", "4", "3", "2", "1"];
/** Worst → best class ladders. */
export const DIPLOMA_CLASS_LADDER = ["pass", "credit", "distinction"];
export const DEGREE_CLASS_LADDER = [
  "pass",
  "second class honours (lower division)", "second class lower",
  "second class honours (upper division)", "second class upper",
  "first class honours", "first class",
];

/** The letter/grade ladder a system's grades live on (null = numeric/class). */
export function gradeLadderFor(system: AdmissionSystem): string[] | null {
  switch (system) {
    case "KCSE": return KCSE_LADDER;
    case "IGCSE":
    case "EACE": return IGCSE_LADDER;
    case "ALEVEL":
    case "KACE": return ALEVEL_LADDER;
    case "IB": return IB_SUBJECT_LADDER;
    default: return null;
  }
}

export function classLadderFor(system: AdmissionSystem): string[] | null {
  if (system === "DIPLOMA" || system === "PROFCERT") return DIPLOMA_CLASS_LADDER;
  if (system === "DEGREE") return DEGREE_CLASS_LADDER;
  return null;
}

/** "C (plus)" / "b (PLAIN)" → ladder form ("C+" / "B"). */
export function normalizeGrade(raw: string): string {
  return String(raw)
    .trim()
    .toUpperCase()
    .replace(/\s*\(PLUS\)\s*/i, "+")
    .replace(/\s*\(MINUS\)\s*/i, "-")
    .replace(/\s*\(PLAIN\)\s*/i, "");
}

function canonClass(raw: string): string {
  return String(raw).toLowerCase().replace(/[^a-z0-9 ()]+/g, " ").replace(/\s+/g, " ").trim();
}

export type CmpResult = "ok" | "below" | "unknown";

/** Compare two grades on a best→worst ladder. */
export function compareLadder(actual: string, required: string, ladder: string[]): CmpResult {
  const a = ladder.indexOf(normalizeGrade(actual));
  const r = ladder.indexOf(normalizeGrade(required));
  if (a < 0 || r < 0) return "unknown";
  return a <= r ? "ok" : "below";
}

/** Compare two award classes (worst→best ladders). */
export function compareClass(actual: string, required: string, ladder: string[]): CmpResult {
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
    return gradeLadderFor(system) ?? [];
  }
  return [];
}

/** Numeric fields (compared as numbers, not grades). */
export const NUMERIC_FIELDS: RuleField[] = ["credits", "principals", "subsidiaries", "points", "gpa"];

export const FIELD_LABELS: Record<RuleField, string> = {
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
  }
}
