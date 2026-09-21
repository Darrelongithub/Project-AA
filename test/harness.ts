/**
 * Test harness helpers.
 */
import type { ProcessResult } from "../src/types";

/**
 * Assert (by construction) that a pipeline run was actually processed, and
 * hand back the narrowed result: after the ProcessResult union replaced the
 * `applicantId: -1` sentinel, a skipped run carries NO applicant handle, so
 * tests that need the applicant must state the expectation explicitly.
 */
export function mustProcessed(r: ProcessResult): ProcessResult & { applicantId: number } {
  if (r.skipped) throw new Error(`expected processed result, got skipped (${r.reasoning})`);
  return r as ProcessResult & { applicantId: number };
}
