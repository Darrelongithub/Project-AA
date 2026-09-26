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
const ADMISSION_RE = /\b(admission|admissions|intake|programme|program|course(?:s)?|entry requirements|admission date(?:s)?|eligib(?:le|ility)|how to apply)\b/i;
const ENQUIRY_RE = /\b(enquir(?:y|ies)|enquire|inquir(?:y|ies)|inquire|question|whether|could you|would like to know|please advise|is there any possibility|how (?:can|do) i)\b|\?/i;
const SUBMISSION_RE = /\b(document(?:s)?|certificate(?:s)?|transcript(?:s)?|attachment(?:s)?|scanned|copies)\b/i;
/**
 * An attachment is not automatically a document submission. Applicants often
 * attach a screenshot as evidence while asking a question. Only treat it as
 * a submission when the language says the applicant is actually sending
 * their application/document set.
 */
const EXPLICIT_SUBMISSION_RE = /\b(?:please\s+)?find attached\b|\b(?:attached|enclosed)\s+(?:are|is)\s+(?:my|the)\s+(?:application|documents?|transcripts?|certificates?|forms?)\b|\b(?:submitt?(?:ed|ing)?|upload(?:ed|ing)?|send(?:ing)?)\s+(?:my|the)?\s*(?:application|documents?|transcripts?|certificates?|forms?)\b|\bcompleted\s+application\s+form\b/i;

export function categorizeEmail(
  subject: string,
  body: string,
  hasAttachments: boolean
): EmailCategory {
  const text = `${subject}\n${body}`;
  const isAdmissionsEnquiry = ADMISSION_RE.test(text) && ENQUIRY_RE.test(text);
  const isExplicitSubmission = EXPLICIT_SUBMISSION_RE.test(text);

  if (COMPLAINT_RE.test(text)) return "complaint";
  // Evidence attached to an eligibility/admissions question is still an
  // enquiry. This prevents a screenshot from putting the case in the
  // "Documents received" workflow merely because Gmail reported an
  // attachment. The image is retained and OCR'd; only its routing label is
  // corrected.
  if (isAdmissionsEnquiry && !isExplicitSubmission) return "admission_enquiry";
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

export interface ConfiguredCategoryLabel {
  label: string;
  confidence: number;
  source?: "gemini" | "fallback";
}

export type CategoryLabeler = (input: { subject: string; body: string }, categories: string[]) => Promise<ConfiguredCategoryLabel>;

/**
 * Gemini is a label sensor, not a decision-maker. The caller supplies the
 * organization's allow-list and this function rejects any model output that
 * is not on it. If the model fails or is uncertain, triage falls back to a
 * safe configured label; no case outcome is returned or inferred here.
 */
export async function classifyWithConfiguredCategories(
  input: { subject: string; body: string },
  categories: string[],
  labeler?: CategoryLabeler
): Promise<ConfiguredCategoryLabel> {
  const allowed = [...new Set(categories.map((x) => x.trim()).filter(Boolean))];
  if (allowed.length === 0) return { label: "other", confidence: 0, source: "fallback" };
  try {
    const result = labeler
      ? await labeler(input, allowed)
      : await geminiCategoryLabel(input, allowed);
    const label = allowed.find((x) => x.toLowerCase() === String(result.label).trim().toLowerCase());
    if (!label || !Number.isFinite(result.confidence) || result.confidence < 0) throw new Error("invalid category label");
    return { label, confidence: Math.min(1, result.confidence), source: "gemini" };
  } catch {
    const fallback = allowed.find((x) => x.toLowerCase() === "other") ?? allowed[0];
    return { label: fallback, confidence: 0, source: "fallback" };
  }
}

async function geminiCategoryLabel(input: { subject: string; body: string }, categories: string[]): Promise<ConfiguredCategoryLabel> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not configured");
  // Keep the SDK lazy and optional in mock/test mode, as with document vision.
  // Gemini receives categories as data and can only return one of them.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { GoogleGenerativeAI } = require("@google/generative-ai");
  const model = new GoogleGenerativeAI(key).getGenerativeModel({ model: process.env.GEMINI_MODEL || "gemini-3.8-flash" });
  const prompt = `Classify this message using exactly one category from ${JSON.stringify(categories)}. Return JSON only: {"label":"...","confidence":0}. The label is routing metadata only and must not make an approval or rejection decision.\nSubject: ${input.subject}\nBody: ${input.body}`;
  const response = await model.generateContent(prompt);
  const raw = String(response?.response?.text?.() ?? "");
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Gemini returned no category JSON");
  return JSON.parse(match[0]) as ConfiguredCategoryLabel;
}
