/**
 * Smart intake engine (round 11) — which mail becomes an admissions case.
 *
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
 *      complaint vocabulary (penalty ≥ 4)
 *   3. a configured hotword (Settings → "Which emails become cases" — the
 *      defaults AND the operator's own words)
 *   4. net application score ≥ 4  (each strong phrase +3, each keyword +1,
 *      a full course name +4, application-named attachments +2; matches in
 *      the SUBJECT count double; ≥4 = "two signals or one strong phrase")
 *   5. enquiry score ≥ 2 AND at least one admissions signal (score ≥ 1) —
 *      enquiries about applying are intake too (they get a factual reply);
 *      general questions without admissions signal stay parked
 */

/** Strong exact phrases — one of these is a "strong signal". */
const STRONG_APP_PHRASES = [
  "application form",
  "submit my application",
  "submitting my application",
  "submitted my application",
  "completed application",
  "completed form",
  "filled form",
  "supporting documents",
  "reference letter",
  "recommendation letter",
  "entrance test",
  "entrance exam",
  "conditional offer",
];

/** Single-word application vocabulary (+1 each). */
const APP_KEYWORDS = [
  "application",
  "apply",
  "applied",
  "applying",
  "applicant",
  "admission",
  "admissions",
  "admit",
  "admitted",
  "enrol",
  "enroll",
  "enrolment",
  "enrollment",
  "registration",
  "register",
  "submit",
  "submission",
  "submitted",
  "transcript",
  "transcripts",
  "certificate",
  "certificates",
  "portfolio",
  "interview",
  "assessment",
  "deadline",
  "offer",
  "acceptance",
];

/** Enquiry phrasing — questions about applying (+2 phrases, +1 words). */
const ENQ_PHRASES = [
  "how to apply",
  "how do i apply",
  "application process",
  "application requirements",
  "entry requirements",
  "admission requirements",
  "eligibility",
  "open day",
  "open evening",
  "school visit",
  "campus tour",
  "places available",
  "waiting list",
  "interested in applying",
  "looking to enrol",
  "want to join",
];
const ENQ_KEYWORDS = [
  "enquiry",
  "enquire",
  "inquire",
  "inquiry",
  "prospectus",
  "brochure",
  "tuition",
  "scholarship",
  "bursary",
  "fees",
  "fee",
  "availability",
];

/**
 * Negative vocabulary. Phrases are heavy (−6): they are unambiguous
 * "this is not admissions mail". Words are −4 each and the PENALTY GATE is
 * ≥ 4 — one clear negative (CV, refund, …) is enough to park, so a single
 * stray word in an otherwise admissions email still opens a case (a human
 * closes it in minutes; a missed application costs the applicant).
 */
const NEG_PHRASES = [
  "job application",
  "staff vacancy",
  "recruitment drive",
  "parent evening",
  "payment already made",
];
const NEG_KEYWORDS = ["cv", "resume", "recruitment", "vacancy", "complaint", "refund", "invoice"];
const ALWAYS_NON_ADMISSIONS = new Set(["cv", "resume", "recruitment", "vacancy"]);

/** Filenames that look like admissions documents boost the score (+2 once). */
const ATTACHMENT_RE = /application|transcript|certificate|statement|result|form|national\s?id|\bid\b/i;

const STOP_TOKENS = new Set(["of", "the", "and", "for", "with", "bachelor", "master", "phd", "mba", "bba", "bcse", "bsc"]);
const NEG_GATE = 4;
const APP_THRESHOLD = 4;
const ENQ_THRESHOLD = 2;

export interface IntakeInput {
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
function scan(text: string, weight: number, seen: Set<string>, positives: string[], add: (n: number) => number): number {
  if (!text) return 0;
  let added = 0;
  for (const phrase of STRONG_APP_PHRASES) {
    if (!seen.has(phrase) && has(text, phrase)) {
      seen.add(phrase);
      positives.push(`"${phrase}"`);
      added += add(3 * weight);
    }
  }
  for (const kw of APP_KEYWORDS) {
    if (!seen.has(kw) && has(text, kw)) {
      seen.add(kw);
      positives.push(kw);
      added += add(1 * weight);
    }
  }
  return added;
}

export function classifyIntakeEmail(input: IntakeInput): IntakeVerdict {
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
  scan(subject, 2, seen, positives, bump);
  scan(body, 1, seen, positives, bump);

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
        if (tok.length < 4 || STOP_TOKENS.has(tok) || seen.has(tok)) continue;
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
    if (f && ATTACHMENT_RE.test(f)) {
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
    APP_KEYWORDS.some((kw) => has(corpus, kw)) ||
    ENQ_PHRASES.some((phrase) => has(corpus, phrase)) ||
    ENQ_KEYWORDS.some((kw) => has(corpus, kw)) ||
    input.courseNames.some((course) => course && has(corpus, course.toLowerCase()));
  let penalty = 0;
  for (const phrase of NEG_PHRASES) {
    if (!has(corpus, phrase)) continue;
    const tiedToAdmissions = admissionsContext && phrase === "parent evening";
    if (!tiedToAdmissions) {
      penalty += 6;
      negatives.push(`"${phrase}"`);
    }
  }
  for (const kw of NEG_KEYWORDS) {
    if (!has(corpus, kw)) continue;
    if (!ALWAYS_NON_ADMISSIONS.has(kw) && admissionsContext) continue;
    penalty += 4;
    negatives.push(kw);
  }
  const net = score - penalty;

  // ── Enquiry bucket (separate vocabulary) ───────────────────────────────
  let enq = 0;
  for (const phrase of ENQ_PHRASES) {
    if (has(subject, phrase)) enq += 4;
    else if (has(body, phrase)) enq += 2;
  }
  for (const kw of ENQ_KEYWORDS) {
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
  if (penalty >= NEG_GATE) return verdict; // parked: strong negatives win
  if (hotwordHit) {
    verdict.category = "application";
    verdict.via = "hotword";
    return verdict;
  }
  const studentRelatedIssue =
    admissionsContext && negatives.length === 0 &&
    ["complaint", "refund", "invoice"].some((kw) => has(corpus, kw));
  if (studentRelatedIssue && score >= 1) {
    verdict.category = enq >= ENQ_THRESHOLD ? "enquiry" : "application";
    verdict.via = "score";
    return verdict;
  }
  if (net >= APP_THRESHOLD) {
    verdict.category = "application";
    verdict.via = "score";
    return verdict;
  }
  if (enq >= ENQ_THRESHOLD && net >= 1) {
    verdict.category = "enquiry";
    verdict.via = "enquiry";
    return verdict;
  }
  return verdict;
}
