/**
 * Email categorization (feature 26) — deterministic keyword rules.
 * No AI: categories are routing hints for humans, never decisions.
 */
import type { EmailCategory } from "../types";

const COMPLAINT_RE = /\b(complain(?:t|ts|ing)?|grievance|dissatisf\w*|unacceptable|appall\w*|rude|escalat\w*|ombuds\w*)\b/i;
const FEE_RE = /\b(fee(?:s)?|payment|invoice|deposit|billing|arrears|quote|quotation|pricing|price(?:s)?)\b/i;
const MISSING_RE =
  /\b(have you received|received my|status of my|any update on my|missing (?:my )?document|my documents\??$|confirm(?:ing)? receipt|acknowledge(?:ment)? of)\b/i;
const FOLLOWUP_RE = /\b(follow(?:ing)?[\s-]?up|follow up|kindly respond|any update|gentle reminder|reminder|still waiting|awaiting (?:your )?response)\b/i;
const APPLICATION_RE = /\b(apply|applying|application|request|service request|register(?:ing)? for)\b/i;
// Context words that make a question about US worth a human reply. Deliberately
// domain-free: a freight quote, a booking, an account or an order is the same
// shape of message as an enrolment question used to be.
const ENQUIRY_CONTEXT_RE = /\b(request|requests|services?|requirements?|eligib(?:le|ility)|quote|quotation|order|booking|appointment|account|contract|delivery|shipment|consignment|invoice|support|intake|how to apply)\b/i;
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
  const isGeneralEnquiry = ENQUIRY_CONTEXT_RE.test(text) && ENQUIRY_RE.test(text);
  const isExplicitSubmission = EXPLICIT_SUBMISSION_RE.test(text);

  if (COMPLAINT_RE.test(text)) return "complaint";
  // Evidence attached to an eligibility/general intake question is still an
  // enquiry. This prevents a screenshot from putting the case in the
  // "Documents received" workflow merely because Gmail reported an
  // attachment. The image is retained and OCR'd; only its routing label is
  // corrected.
  if (isGeneralEnquiry && !isExplicitSubmission) return "general_enquiry";
  if (hasAttachments && SUBMISSION_RE.test(text)) return "document_submission";
  if (FEE_RE.test(text)) return "fee_enquiry";
  if (MISSING_RE.test(text)) return "missing_document";
  if (FOLLOWUP_RE.test(text)) return "follow_up";
  if (APPLICATION_RE.test(text)) return "application";
  if (ENQUIRY_CONTEXT_RE.test(text)) return "general_enquiry";
  if (hasAttachments) return "document_submission";
  return "other";
}

/** Priority assignment from category (feature 27). Complaints jump the line. */
export function priorityForCategory(category: EmailCategory): "normal" | "high" {
  return category === "complaint" ? "high" : "normal";
}

/**
 * Below this confidence a model label is treated as a guess: the message is
 * routed by the deterministic matcher AND held for a person. PROVISIONAL value
 * (see QUESTIONS.md Q4) — it is a routing threshold, not a decision threshold.
 */
export const CLASSIFIER_MIN_CONFIDENCE = 0.7;

export interface ConfiguredCategoryLabel {
  label: string;
  confidence: number;
  source?: "gemini" | "fallback";
}

export type CategoryLabeler = (input: { subject: string; body: string }, categories: string[]) => Promise<ConfiguredCategoryLabel>;

/** Map the deterministic legacy vocabulary onto an organization's labels.
 * This is deliberately a real second tier, not a generic "other" answer. */
function deterministicConfiguredLabel(input: { subject: string; body: string }, allowed: string[]): string {
  const detected = categorizeEmail(input.subject, input.body, false);
  const aliases: Record<string, string[]> = {
    general_enquiry: ["general_enquiry", "application", "enquiry", "inquiry"],
    document_submission: ["document_submission", "documents", "document", "support"],
    missing_document: ["missing_document", "document_submission", "support"],
    fee_enquiry: ["fee_enquiry", "fees", "fee", "support"],
    complaint: ["complaint", "grievance", "support"],
    follow_up: ["follow_up", "follow-up", "support"],
    application: ["application", "general_enquiry"],
    other: ["other", "normal", "support"],
  };
  const candidates = aliases[detected] ?? [detected];
  return allowed.find((x) => candidates.includes(x.toLowerCase()))
    ?? allowed.find((x) => x.toLowerCase() !== "other" && x.toLowerCase() !== "normal")
    ?? allowed[0];
}

/**
 * Gemini is a label sensor, not a decision-maker. The caller supplies the
 * organization's allow-list and this function rejects any model output that
 * is not on it. If the model fails or is uncertain, triage falls back to a
 * safe configured label; no case outcome is returned or inferred here.
 */
export async function classifyWithConfiguredCategories(
  input: { subject: string; body: string },
  categories: string[],
  labeler?: CategoryLabeler,
  credentials?: { apiKey: string; model?: string }
): Promise<ConfiguredCategoryLabel> {
  const allowed = [...new Set(categories.map((x) => x.trim()).filter(Boolean))];
  if (allowed.length === 0) return { label: "other", confidence: 0, source: "fallback" };
  try {
    const result = labeler
      ? await labeler(input, allowed)
      : await geminiCategoryLabel(input, allowed, credentials);
    const label = allowed.find((x) => x.toLowerCase() === String(result.label).trim().toLowerCase());
    if (!label || !Number.isFinite(result.confidence) || result.confidence < 0) throw new Error("invalid category label");
    return { label, confidence: Math.min(1, result.confidence), source: "gemini" };
  } catch {
    return {
      label: deterministicConfiguredLabel(input, allowed),
      confidence: 0,
      source: "fallback",
    };
  }
}

/**
 * Credentials come from the CALLER: the console stores the key in the
 * organization's secret store (Settings → Connections), and a headless CLI may
 * use the environment. Reading `process.env` in here meant a key saved through
 * the UI could never enable classification.
 */
/** A labeler bound to specific credentials: built once by the adapters (from
 *  the key the console manages) and passed in by the pipeline. */
export function geminiCategoryLabeler(credentials: { apiKey: string; model?: string }): CategoryLabeler {
  return (input, categories) => geminiCategoryLabel(input, categories, credentials);
}

async function geminiCategoryLabel(
  input: { subject: string; body: string },
  categories: string[],
  credentials?: { apiKey: string; model?: string }
): Promise<ConfiguredCategoryLabel> {
  const key = (credentials?.apiKey || process.env.GEMINI_API_KEY || "").trim();
  if (!key) throw new Error("no Gemini API key is configured (Settings → Connections, or GEMINI_API_KEY)");
  // Keep the SDK lazy and optional in mock/test mode, as with document vision.
  // Gemini receives categories as data and can only return one of them.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { GoogleGenerativeAI } = require("@google/generative-ai");
  const model = new GoogleGenerativeAI(key).getGenerativeModel({ model: credentials?.model || process.env.GEMINI_MODEL || "gemini-3.8-flash" });
  const prompt = `Classify this message using exactly one category from ${JSON.stringify(categories)}. Return JSON only: {"label":"...","confidence":0}. The label is routing metadata only and must not make an approval or rejection decision.\nSubject: ${input.subject}\nBody: ${input.body}`;
  const response = await model.generateContent(prompt);
  const raw = String(response?.response?.text?.() ?? "");
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Gemini returned no category JSON");
  return JSON.parse(match[0]) as ConfiguredCategoryLabel;
}
