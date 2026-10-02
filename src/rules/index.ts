/** Pure deterministic document triage. Evidence is not an approval or rejection. */
import { fillSlots } from "../documents/matrix";
import type { Classification, DerivedFlag, DocType, DocumentRecord, RequirementSetEntry } from "../types";

export interface RulesInput { requirements: RequirementSetEntry[]; docs: DocumentRecord[]; flags: Array<{ type: DerivedFlag["type"]; detail: string }> }
export interface RulesOutput { status: Classification; reasoning: string; derivedFlags: DerivedFlag[]; missing: DocType[] }

export function normalizeName(name: string | null | undefined): string {
  if (!name) return "";
  return String(name)
    .toUpperCase()
    .replace(/[^A-Z ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Classic Levenshtein distance (pure, small inputs only). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Two distinct names are "similar" when they differ by at most 2 edits
 * (typo variants like OCHIMI vs OCHIEMI). Feature 23: these go to a human
 * too — we never guess which spelling is real.
 */
export function namesAreSimilar(a: string, b: string): boolean {
  if (a === b) return true;
  const minLen = Math.min(a.length, b.length);
  if (minLen < 6) return false;
  return levenshtein(a, b) <= 2;
}

export function docLabel(type: DocType): string {
  const labels: Record<string, string> = { request_form: "Request form", id: "Identity document", birth_cert: "Birth certificate", passport_photo: "Photograph", unknown: "Unknown document" };
  return labels[type] ?? type.replace(/[_:-]+/g, " ").replace(/^./, (character) => character.toUpperCase());
}
export function dedupeFlags(flags: DerivedFlag[]): DerivedFlag[] {
  const seen = new Set<string>();
  return flags.filter((flag) => { const key = `${flag.type}:${flag.detail}`; if (seen.has(key)) return false; seen.add(key); return true; });
}
export function deriveFlags(_requirements: RequirementSetEntry[], docs: DocumentRecord[]): DerivedFlag[] {
  const flags: DerivedFlag[] = [];
  for (const doc of docs) {
    const score = doc.confidence_score ?? (doc.confidence === "high" ? 100 : 0);
    if (score < 75 || doc.extraction_method === "none" || doc.document_type === "unknown") flags.push({ type: "low_confidence", detail: `${docLabel(doc.document_type)} could not be verified with sufficient confidence (${score}/100) — human review required` });
  }
  const names = [...new Set(docs.map((doc) => normalizeName(typeof doc.extracted_fields?.name === "string" ? doc.extracted_fields.name : null)).filter((name) => name.length >= 3))];
  if (names.length > 1) {
    const similar = names.every((name) => namesAreSimilar(name, names[0]));
    flags.push({ type: "name_mismatch", detail: `names differ across documents: ${names.join(" vs ")}${similar ? " — possible typo; a human must confirm" : " — human verification required"}` });
  }
  return flags;
}
export function decide(input: RulesInput): RulesOutput {
  const derivedFlags = deriveFlags(input.requirements, input.docs);
  const matrix = fillSlots(input.requirements, input.docs.map((doc) => doc.document_type));
  const missing = matrix.missing.map((slot) => slot.document_type);
  const configured = new Set(input.requirements.map((slot) => slot.document_type));
  const extra = [...new Set(matrix.leftover.filter((type) => !configured.has(type)))];
  if (extra.length) derivedFlags.push({ type: "wrong_document", detail: `File(s) not on this case's document list: ${extra.map(docLabel).join(", ")} — a human should check` });
  const flags = dedupeFlags([...derivedFlags, ...input.flags]).filter((flag) => flag.type !== "duplicate_submission");
  const status: Classification = missing.length || flags.some((flag) => flag.type === "watcher_flag") ? "Red" : flags.length ? "Orange" : "Green";
  const reasoning = [
    `Requirement check (${input.requirements.filter((slot) => slot.required && slot.blocking !== false).length} required):`,
    ...input.requirements.map((slot) => `  - ${slot.label ?? docLabel(slot.document_type)}: ${matrix.filled.includes(slot.document_type) ? "present" : "MISSING"}${slot.required && slot.blocking !== false ? " (required)" : " (optional)"}`),
    ...flags.map((flag) => `  - [${flag.type}] ${flag.detail}`),
    `Verdict: ${status} — ${missing.length ? "missing required information" : flags.length ? "human verification required" : "complete, high-confidence information"}. Outcomes are recorded by people.`,
  ].join("\n");
  return { status, reasoning, derivedFlags, missing };
}
