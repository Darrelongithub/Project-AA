/**
 * Intake hotwords (round 9) — which emails become application cases.
 *
 * The inbox receives more than applications: service promos, newsletters,
 * the odd stray message. A case (reference number, queue entry, auto-reply)
 * is only worth opening for admissions intake. The gate is two-pronged:
 *   1. the email carries one of the configured hotwords (subject or body),
 *   2. OR it targets an applicant we already know — a quoted reference
 *      number or a known sender (conversation continuity).
 * Everything else is PARKED, not dropped: it is kept in the Mail window
 * without an applicant, so a human can still find it.
 */

/** Sensible defaults for a Kenyan university admissions inbox. */
export const DEFAULT_INTAKE_HOTWORDS =
  "application, admission, admissions, apply, applicant, prospective, enrol, enroll, matric, intake, prospectus, readmission, upgrade, transfer, entry requirements";

const ESC_RE = /[.*+?^${}()|[\]\\]/g;

/** Comma-separated list → trimmed, lower-cased, de-duplicated words/phrases. */
export function intakeHotwordList(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(",")
        .map((w) => w.trim().toLowerCase())
        .filter((w) => w.length > 0)
    )
  );
}

/**
 * Word-boundary, case-insensitive: does the text carry any configured
 * hotword? Phrases work as phrases ("entry requirements").
 */
export function matchesIntakeHotwords(text: string, raw: string): boolean {
  const lower = text.toLowerCase();
  return intakeHotwordList(raw).some((w) =>
    new RegExp(`\\b${w.replace(ESC_RE, "\\$&")}\\b`).test(lower)
  );
}
