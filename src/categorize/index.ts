/**
 * Email categorization (feature 26) — deterministic keyword rules.
 * No AI: categories are routing hints for humans, never decisions.
 */
import type { EmailCategory } from "../types";

const COMPLAINT_RE = /\b(complain(?:t|ts|ing)?|grievance|dissatisf\w*|unacceptable|appall\w*|rude|escalat\w*|ombuds\w*)\b/i;
const FEE_RE = /\b(fee(?:s)?|tuition|payment|invoice|deposit|hesb|helb|billing|arrears)\b/i;
const MISSING_RE =
  /\b(have you received|received my|status of my|any update on my|missing (?:my )?document|my documents\??$|confirm(?:ing)? receipt|acknowledge(?:ment)? of)\b/i;
const FOLLOWUP_RE = /\b(follow(?:ing)?[\s-]?up|follow up|kindly respond|any update|gentle reminder|reminder|still waiting|awaiting (?:your )?response)\b/i;
const APPLICATION_RE = /\b(apply|applying|application|admission letter|admit me|prospective student|register(?:ing)? for)\b/i;
const ADMISSION_RE = /\b(admission|admissions|intake|programme|program|course(?:s)?|entry requirements|admission date(?:s)?|when (?:does|do))\b/i;
const SUBMISSION_RE = /\b(document(?:s)?|certificate(?:s)?|transcript(?:s)?|attachment(?:s)?|attached|scanned|copies)\b/i;

export function categorizeEmail(
  subject: string,
  body: string,
  hasAttachments: boolean
): EmailCategory {
  const text = `${subject}\n${body}`;

  if (COMPLAINT_RE.test(text)) return "complaint";
  if (hasAttachments && SUBMISSION_RE.test(text)) return "document_submission";
  if (FEE_RE.test(text)) return "fee_enquiry";
  if (MISSING_RE.test(text)) return "missing_document";
  if (FOLLOWUP_RE.test(text)) return "follow_up";
  if (APPLICATION_RE.test(text)) return "application";
  if (ADMISSION_RE.test(text)) return "admission_enquiry";
  if (hasAttachments) return "document_submission";
  return "other";
}

/** Priority assignment from category (feature 27). Complaints jump the line. */
export function priorityForCategory(category: EmailCategory): "normal" | "high" {
  return category === "complaint" ? "high" : "normal";
}
