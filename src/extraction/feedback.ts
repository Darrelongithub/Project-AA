/**
 * Applicant-facing extraction feedback (round 19).
 *
 * Two small renderers, both written in words an applicant should see:
 *   - readBackText:      "your KCSE was read as mean grade B+ with these
 *                        subjects…" — lets applicants spot a misread grade
 *                        before a human has to.
 *   - documentIssuesText: "we couldn't read your results — the PDF is
 *                        password-protected, please re-send" instead of the
 *                        old generic "we need more documents".
 *
 * Internal notes (cross-document contradictions, routing) never surface
 * here — they start with a known internal prefix and are filtered out.
 */
import type { DocumentRecord } from "../types";
import { SYSTEM_LABELS } from "../admissions/systems";
import { docLabel } from "../rules";

/** Notes staff need but applicants must not (kept out of emails). */
const INTERNAL_NOTE_PREFIXES = ["Contradicts"];

function isApplicantSafe(note: string): boolean {
  return !INTERNAL_NOTE_PREFIXES.some((p) => note.startsWith(p));
}

function subjectSummary(grades: Record<string, string>): string {
  const parts = Object.entries(grades).map(([subj, g]) => `${subj} ${g}`);
  if (parts.length <= 4) return parts.join(", ");
  return `${parts.slice(0, 4).join(", ")} and ${parts.length - 4} more`;
}

/** Friendly one-liners for every academic document we managed to read. */
export function readBackText(docs: DocumentRecord[]): string {
  const lines: string[] = [];
  for (const d of docs) {
    if (d.document_type !== "academic_cert" && d.document_type !== "kcpe_cert") continue;
    const f = d.extracted_fields ?? {};
    const label = docLabel(d.document_type);
    const bits: string[] = [];

    if (d.document_type === "kcpe_cert" && f.gradePoints) {
      bits.push(`${f.gradePoints} points`);
    }
    if (f.examSystem && SYSTEM_LABELS[f.examSystem as keyof typeof SYSTEM_LABELS]) {
      bits.push(String(SYSTEM_LABELS[f.examSystem as keyof typeof SYSTEM_LABELS]));
    }
    if (f.meanGrade) bits.push(`mean grade ${f.meanGrade}`);
    else if (f.ibPoints) bits.push(`${f.ibPoints} points out of 45`);
    else if (f.credits) bits.push(`${f.credits} subjects at credit level or better`);
    else if (f.principals) bits.push(`${f.principals} principal pass(es)`);
    else if (f.classAwarded) bits.push(`awarded ${f.classAwarded}`);
    else if (f.gpa) bits.push(`GPA ${f.gpa}`);

    const grades = (f.subjectGrades ?? {}) as Record<string, string>;
    if (Object.keys(grades).length) bits.push(`subjects: ${subjectSummary(grades)}`);

    if (bits.length) lines.push(`  • ${label} — ${bits.join("; ")}`);
    else if (d.confidence_score && d.confidence_score >= 75) {
      lines.push(`  • ${label} — received and read successfully`);
    }
  }
  if (!lines.length) return "";
  return `Here is what we read from your documents:\n\n${lines.join("\n")}\n\nIf any of this looks wrong, just reply and tell us — we will correct it.`;
}

/** Friendly per-document problems an applicant can act on. */
export function documentIssuesText(docs: DocumentRecord[]): string {
  const lines: string[] = [];
  for (const d of docs) {
    const note = (d.extraction_note ?? "").trim();
    if (!note || !isApplicantSafe(note)) continue;
    // Only surface problems an applicant can fix: unreadable/low-trust docs.
    if ((d.confidence_score ?? 0) >= 75 && d.extraction_method !== "none") continue;
    lines.push(`  • ${docLabel(d.document_type)}: ${note} Please send it again as a clear PDF or photo.`);
  }
  if (!lines.length) return "";
  return `We had trouble with:\n\n${lines.join("\n")}`;
}
