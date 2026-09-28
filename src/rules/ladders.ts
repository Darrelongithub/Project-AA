/**
 * Grade ladders — the SINGLE source of truth for qualification grade scales.
 *
 * The scales themselves are admissions-preset DATA (data/presets/
 * admissions.json → scales), read once through the loader; this module keeps
 * the historical export names so every comparison in the codebase runs on the
 * same ladders without hardcoding them. The string helpers are pure code.
 */
import { admissionsPreset } from "../presets/loader";

const scales = admissionsPreset().scales;

/** The mean-grade ladder, best (A) → worst (E). */
export const GRADE_LADDER: readonly string[] = scales.grade;

export const O_LEVEL_LADDER: readonly string[] = scales.oLevel;
export const ALEVEL_LADDER: readonly string[] = scales.alevel;
export const IB_SUBJECT_LADDER: readonly string[] = scales.ibSubject;
/** Worst → best. */
export const DIPLOMA_CLASS_LADDER: readonly string[] = scales.diplomaClass;
export const DEGREE_CLASS_LADDER: readonly string[] = scales.degreeClass;

/** "C (plus)" / "B (PLAIN)" → the ladder letter ("C+" / "B"). */
export function normalizeGrade(raw: string): string {
  return String(raw)
    .trim()
    .toUpperCase()
    .replace(/\s*\(PLUS\)\s*/i, "+")
    .replace(/\s*\(MINUS\)\s*/i, "-")
    .replace(/\s*\(PLAIN\)\s*/i, "");
}

/** Canonical form for award-class comparison ("Second Class Honours (Upper Division)" → ladder key). */
export function canonClass(raw: string): string {
  return String(raw).toLowerCase().replace(/[^a-z0-9 ()]+/g, " ").replace(/\s+/g, " ").trim();
}
