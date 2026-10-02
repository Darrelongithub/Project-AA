import type { DocumentRecord } from "../types";
import { docLabel } from "../rules";

/**
 * Notes staff need but contacts must not see are built through
 * `internalNote()` and recognised by the marker — one constant, two files,
 * no magic-string drift.
 */
export const INTERNAL_NOTE_PREFIX = "INTERNAL: ";

export function internalNote(message: string): string {
  return `${INTERNAL_NOTE_PREFIX}${message.charAt(0).toUpperCase()}${message.slice(1)}`;
}

function isContactSafe(note: string): boolean {
  return !note.startsWith(INTERNAL_NOTE_PREFIX);
}

/** Report receipt/readability without exposing internal notes or arbitrary private fields. */
export function readBackText(docs: DocumentRecord[]): string {
  const lines = docs.filter((doc) => (doc.confidence_score ?? 0) >= 75 && doc.extraction_method !== "none")
    .map((doc) => `  • ${docLabel(doc.document_type)} — received and read successfully`);
  return lines.length ? `Here is what we read from your documents:\n\n${lines.join("\n")}\n\nIf anything looks wrong, reply and tell us.` : "";
}

/** Friendly per-document problems an contact can act on. */
export function documentIssuesText(docs: DocumentRecord[]): string {
  const lines: string[] = [];
  for (const d of docs) {
    const note = (d.extraction_note ?? "").trim();
    if (!note || !isContactSafe(note)) continue;
    // Only surface problems an contact can fix: unreadable/low-trust docs.
    if ((d.confidence_score ?? 0) >= 75 && d.extraction_method !== "none") continue;
    lines.push(`  • ${docLabel(d.document_type)}: ${note} Please send it again as a clear PDF or photo.`);
  }
  if (!lines.length) return "";
  return `We had trouble with:\n\n${lines.join("\n")}`;
}
