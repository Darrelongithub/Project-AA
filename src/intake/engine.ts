/**
 * Smart intake engine (round 11) — which mail becomes an intake case.
 *
 * The engine itself is generic scoring machinery; the VOCABULARY it scores
 * with comes from the active preset (the admissions preset by default — see
 * data/presets/admissions.json, read through src/presets/loader.ts). Pass
 * `vocabulary` explicitly to score with a different word set.

 * Replaces the blunt flat-hotword gate with a scored classifier, designed
 * from the operator's own spec: weighted keywords + exact phrases, the
 * subject line weighted higher, "2+ strong signals or 1 strong phrase",
 * course names counted as hotwords, an attachment-name boost, and
 * negative/disambiguation terms (job applications, vacancies, CVs, refunds,
 * invoices) so staff mail and job ads stop opening cases.
 *
 * Decision order (a case is opened when ANY of 1–5 fires; everything else
 * is PARKED — kept in the Mail window, never dropped):
 *
 *   1. known applicant — quoted reference number or known sender
 *      (conversation continuity; always wins)
 *   2. strong negatives — job/vacancy/recruitment/CV/resume/refund/invoice/
 *      complaint vocabulary (penalty ≥ the configured gate)
 *   3. a configured hotword (Settings → "Which emails become cases" — the
 *      defaults AND the operator's own words)
 *   4. net application score ≥ 4  (each strong phrase +3, each keyword +1,
 *      a full course name +4, application-named attachments +2; matches in
 *      the SUBJECT count double; ≥4 = "two signals or one strong phrase")
 *   5. enquiry score ≥ 2 AND at least one admissions signal (score ≥ 1) —
 *      enquiries about applying are intake too (they get a factual reply);
 *      general questions without admissions signal stay parked
 */

import type { IntakeVocabulary } from "../presets/loader";
import { admissionsPreset } from "../presets/loader";

/** The default scoring vocabulary: the admissions preset's intake word set. */
export function defaultIntakeVocabulary(): IntakeVocabulary {
  return admissionsPreset().intake;
}

export interface IntakeInput {
  /** Scoring vocabulary — defaults to the admissions preset's word set. */
  vocabulary?: IntakeVocabulary;
  subject: string;
  body: string;
  attachmentFilenames: string[];
  /** Course/programme names from the database — the operator asked for ALL of them to act as hotwords. */
  courseNames: string[];
  /** Configured hotwords (already a trimmed, lower-cased list). */
  customHotwords: string[];
  /** Quoted reference number or known sender — conversation continuity. */
  knownApplicant: boolean;
}

export interface IntakeVerdict {
  category: "application" | "enquiry" | "parked";
  /** Net application score (positives − negatives). */
  score: number;
  enquiryScore: number;
  positives: string[];
  negatives: string[];
  hotwordHit: string | null;
  via: "known_applicant" | "hotword" | "score" | "enquiry" | "none";
}

const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const has = (text: string, term: string) => new RegExp(`\\b${esc(term)}\\b`).test(text);

/**
 * One signal scan of a text region with a weight multiplier (subject ×2,
 * body ×1). Returns { added, hits } — a signal found in the subject is not
 * counted again in the body (per-signal max, never double-dipped).
 */
function scan(text: string, weight: number, seen: Set<string>, positives: string[], add: (n: number) => number, phrases: readonly string[], keywords: readonly string[]): number {
  if (!text) return 0;
  let added = 0;
  for (const phrase of phrases) {
    if (!seen.has(phrase) && has(text, phrase)) {
      seen.add(phrase);
      positives.push(`"${phrase}"`);
      added += add(3 * weight);
    }
  }
  for (const kw of keywords) {
    if (!seen.has(kw) && has(text, kw)) {
      seen.add(kw);
      positives.push(kw);
      added += add(1 * weight);
    }
  }
  return added;
}

export function classifyIntakeEmail(input: IntakeInput): IntakeVerdict {
  const V = input.vocabulary ?? defaultIntakeVocabulary();
  const stopTokens = new Set(V.stopTokens);
  const alwaysNonIntake = new Set(V.alwaysNonAdmissions);
  const attachmentRe = new RegExp(V.attachmentPattern, "i");
  const subject = (input.subject || "").toLowerCase();
  const body = (input.body || "").toLowerCase();

  const positives: string[] = [];
  const negatives: string[] = [];
  const seen = new Set<string>();

  // ── Application bucket: subject first (×2), then body (×1) ────────────
  let score = 0;
  const bump = (n: number) => {
    score += n;
    return n;
  };
  scan(subject, 2, seen, positives, bump, V.strongAppPhrases, V.appKeywords);
  scan(body, 1, seen, positives, bump, V.strongAppPhrases, V.appKeywords);

  // Course names: the full name anywhere is a strong signal (+4); otherwise
  // each distinctive token (≥4 chars, not a stopword) is +1, capped at +3.
  for (const rawName of input.courseNames) {
    const name = (rawName || "").toLowerCase().trim();
    if (!name) continue;
    if (has(`${subject}\n${body}`, name)) {
      score += 4;
      positives.push(`course: ${name}`);
    } else {
      let tokenScore = 0;
      for (const tok of name.split(/[^a-z0-9]+/)) {
        if (tok.length < 4 || stopTokens.has(tok) || seen.has(tok)) continue;
        if (has(`${subject}\n${body}`, tok)) {
          seen.add(tok);
          tokenScore += 1;
        }
      }
      if (tokenScore > 0) {
        const capped = Math.min(tokenScore, 3);
        score += capped;
        positives.push(`course tokens (${capped})`);
      }
    }
  }

  // Attachment-name boost (+2 once): "ApplicationForm.pdf", "transcript.pdf"…
  for (const f of input.attachmentFilenames) {
    if (f && attachmentRe.test(f)) {
      score += 2;
      positives.push(`attachment: ${f}`);
      break;
    }
  }

  // ── Configured hotwords: the operator's explicit words — decisive ─────
  let hotwordHit: string | null = null;
  for (const hw of input.customHotwords) {
    if (hw && has(`${subject}\n${body}`, hw)) {
      hotwordHit = hw;
      break;
    }
  }

  // ── Negatives ──────────────────────────────────────────────────────────
  // Disambiguation is contextual. CV/vacancy/recruitment language is a hard
  // non-admissions signal, but “complaint about my admission application” or
  // “refund of my application fee” is still applicant mail and must reach a
  // human. The old flat penalty parked those legitimate cases.
  const corpus = `${subject}\n${body}`;
  const admissionsContext =
    V.appKeywords.some((kw) => has(corpus, kw)) ||
    V.enqPhrases.some((phrase) => has(corpus, phrase)) ||
    V.enqKeywords.some((kw) => has(corpus, kw)) ||
    input.courseNames.some((course) => course && has(corpus, course.toLowerCase()));
  let penalty = 0;
  for (const phrase of V.negPhrases) {
    if (!has(corpus, phrase)) continue;
    const tiedToAdmissions = admissionsContext && phrase === "parent evening";
    if (!tiedToAdmissions) {
      penalty += 6;
      negatives.push(`"${phrase}"`);
    }
  }
  for (const kw of V.negKeywords) {
    if (!has(corpus, kw)) continue;
    if (!alwaysNonIntake.has(kw) && admissionsContext) continue;
    penalty += 4;
    negatives.push(kw);
  }
  const net = score - penalty;

  // ── Enquiry bucket (separate vocabulary) ───────────────────────────────
  let enq = 0;
  for (const phrase of V.enqPhrases) {
    if (has(subject, phrase)) enq += 4;
    else if (has(body, phrase)) enq += 2;
  }
  for (const kw of V.enqKeywords) {
    if (has(subject, kw)) enq += 2;
    else if (has(body, kw)) enq += 1;
  }

  // ── Decision order (module doc) ────────────────────────────────────────
  const verdict: IntakeVerdict = {
    category: "parked",
    score: net,
    enquiryScore: enq,
    positives,
    negatives,
    hotwordHit,
    via: "none",
  };
  if (input.knownApplicant) {
    verdict.category = "application";
    verdict.via = "known_applicant";
    return verdict;
  }
  if (penalty >= V.thresholds.negGate) return verdict; // parked: strong negatives win
  if (hotwordHit) {
    verdict.category = "application";
    verdict.via = "hotword";
    return verdict;
  }
  const studentRelatedIssue =
    admissionsContext && negatives.length === 0 &&
    ["complaint", "refund", "invoice"].some((kw) => has(corpus, kw));
  if (studentRelatedIssue && score >= 1) {
    verdict.category = enq >= V.thresholds.enqThreshold ? "enquiry" : "application";
    verdict.via = "score";
    return verdict;
  }
  if (net >= V.thresholds.appThreshold) {
    verdict.category = "application";
    verdict.via = "score";
    return verdict;
  }
  if (enq >= V.thresholds.enqThreshold && net >= 1) {
    verdict.category = "enquiry";
    verdict.via = "enquiry";
    return verdict;
  }
  return verdict;
}
