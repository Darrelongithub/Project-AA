/** Intake triggers are configured by the organization; no domain comes preselected. */
export const DEFAULT_INTAKE_HOTWORDS = "";

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

// Round 11: the smart scored engine (replaces the blunt flat gate in the pipeline).
export * from "./engine";
