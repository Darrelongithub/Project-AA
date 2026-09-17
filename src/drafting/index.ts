/**
 * /drafting — reply generation. Template-based, no AI.
 *
 * v2: applicant-facing templates live in the database (feature 35 — staff can
 * edit them in Settings). Placeholders: {ref} {name} {missing_docs}
 * {checklist} {status} {institution}.
 *
 * Every outgoing subject carries the reference number (feature 14):
 *   Subject: [RU-2026-000085] Document Submission
 *
 * Human-only drafts (Orange / watcher-Red) are marked INTERNAL and are never
 * auto-sent by the gate.
 */
import type { Classification, DocType, DerivedFlag } from "../types";
import { docLabel } from "../rules";

export interface DraftContext {
  ref: string;
  institution: string;
  name?: string;
  missingLabels: string[];
  checklist: string;
  statusLabel: string;
  /** Admission-letter extras. */
  programme?: string;
  regDate?: string;
  orientationDates?: string;
}

export interface Draft {
  subject: string;
  body: string;
  audience: "auto" | "human";
  templateKey?: string;
}

export function subjectWithRef(ref: string, subject: string): string {
  const s = subject.trim();
  return s.startsWith(`[${ref}]`) ? s : `[${ref}] ${s}`;
}

export function renderTemplate(
  subject: string,
  body: string,
  ctx: DraftContext
): { subject: string; body: string } {
  const name = ctx.name?.trim() ? ctx.name.trim() : "Applicant";
  const first = name.split(/\s+/)[0];
  const missingSection = ctx.missingLabels.length
    ? `We are still missing:\n\n${ctx.missingLabels.map((m) => `  • ${m}`).join("\n")}\n\nPlease send these as PDF attachments in reply to this thread.`
    : "Nothing is missing — your file is complete.";
  const replacements: Record<string, string> = {
    "{ref}": ctx.ref,
    "{name}": name,
    "{first_name}": first,
    "{missing_docs}": ctx.missingLabels.length
      ? ctx.missingLabels.map((m) => `  • ${m}`).join("\n")
      : "  (none — your file is complete)",
    "{missing_docs_section}": missingSection,
    "{checklist}": ctx.checklist,
    "{status}": ctx.statusLabel,
    "{institution}": ctx.institution,
    "{programme}": ctx.programme?.trim() || "your programme",
    "{reg_date}": ctx.regDate?.trim() || "the announced registration date",
    "{orientation_dates}": ctx.orientationDates?.trim() || "the announced orientation dates",
  };
  let s = subject;
  let b = body;
  for (const [k, v] of Object.entries(replacements)) {
    s = s.split(k).join(v);
    b = b.split(k).join(v);
  }
  return { subject: subjectWithRef(ctx.ref, s), body: b };
}

export function checklistText(args: {
  requirements: Array<{ document_type: DocType; required: boolean }>;
  presentTypes: DocType[];
}): string {
  return args.requirements
    .filter((r) => r.required)
    .map((r) => `${args.presentTypes.includes(r.document_type) ? "✓" : "✗"} ${docLabel(r.document_type)}`)
    .join("\n");
}

/** INTERNAL draft for Orange cases — never auto-sent. */
export function orangeDraft(flags: DerivedFlag[], applicantName?: string, ref = ""): Draft {
  const list = flags.map((f) => `  • [${f.type}] ${f.detail}`).join("\n");
  return {
    subject: subjectWithRef(ref, "SUGGESTED REPLY (human review required) — application documents"),
    audience: "human",
    body: `INTERNAL — DO NOT AUTO-SEND.
All required documents are present, but this file needs human review before any reply goes out.

Flags:
${list || "  • none recorded"}

Suggested starting point for the reply to ${applicantName || "the applicant"}:

"Thank you for your documents. We are verifying the details you provided and will come back to you shortly if we need anything further."`,
  };
}

/** INTERNAL draft for watcher-downgraded cases — never auto-sent. */
export function watcherRedDraft(applicantName?: string, ref = ""): Draft {
  return {
    subject: subjectWithRef(ref, "SUGGESTED REPLY (human review required) — documents need verification"),
    audience: "human",
    body: `INTERNAL — DO NOT AUTO-SEND.
The rules engine marked this file complete, but the final sanity check raised concerns.
A human must inspect the attachments before replying.

Suggested starting point for the reply to ${applicantName || "the applicant"}:

"Thank you for your documents. Some items require additional verification on our side; we will contact you if we need anything further."`,
  };
}

export function pickQueuedDraft(args: {
  finalStatus: Classification;
  watcherFlagged: boolean;
  flags: DerivedFlag[];
  applicantName?: string;
  ref: string;
}): Draft {
  if (args.finalStatus === "Red" && args.watcherFlagged) {
    return watcherRedDraft(args.applicantName, args.ref);
  }
  if (args.finalStatus === "Orange") {
    return orangeDraft(args.flags, args.applicantName, args.ref);
  }
  // Red queued for reasons other than plain missing docs is unusual; give a generic internal note.
  return {
    subject: subjectWithRef(args.ref, "SUGGESTED REPLY (human review required)"),
    audience: "human",
    body: "INTERNAL — DO NOT AUTO-SEND.\nThis case requires human review before any reply goes out. See flags and reasoning.",
  };
}
