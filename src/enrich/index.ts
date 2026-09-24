/**
 * Applicant enrichment — plain-code inference of programme, intake and phone
 * from email text and extracted document fields. Never a decision; just
 * pre-filling the case file for staff to confirm.
 */

export function extractPhone(text: string): string | null {
  if (!text) return null;
  // Collapse separators so "0712 345 678" and "0712-345-678" both match.
  const compact = text.replace(/[\s\-()]+/g, "");
  // Digit boundaries matter: without them a 12-digit ID number containing a
  // valid 9-digit subsequence would silently become the applicant's phone.
  const m = compact.match(/(?<!\d)(?:\+?254|0)(7\d{8}|1\d{8})(?!\d)/);
  if (!m) return null;
  return `+254${m[1]}`;
}

/** Words that appear in everyday admissions correspondence — they must never
 * count as programme keywords on their own. ("COMMUNICATION" appears in every
 * contact footer, so letting it match alone sent whole batches of unrelated
 * applicants to Certificate in Communication.) */
const GENERIC_WORDS = new Set([
  "BACHELOR", "SCIENCE", "DEGREE", "DIPLOMA", "CERTIFICATE", "MASTER",
  "ARTS", "EDUCATION", "MANAGEMENT", "BUSINESS", "ADMINISTRATION",
  "COMMUNICATION", "INFORMATION", "TECHNOLOGY", "STUDIES", "CURRICULA",
  "TEACHING", "KENYA", "REGISTERED", "COMMUNITY", "HEALTH", "PRE", "SERVICE",
]);

/** Keyword match against known programmes; returns the programme code or null.
 * Prefers an exact programme-code word (BCS, LLB…); otherwise requires the
 * programme's DISTINCTIVE name words — generic words only ever count as
 * supporting evidence, so "Certificate in Communication" needs COMMUNICATION
 * plus at least one more programme word, not the footer word alone. */
export function inferProgramme(
  text: string,
  programmes: Array<{ code: string; name: string }>
): string | null {
  if (!text) return null;
  const up = text.toUpperCase();
  // Pass 1 — an exact programme CODE written anywhere (BCS, MBA, LLB…) is the
  // strongest signal and always wins over fuzzy name matching. Doing this in a
  // dedicated pass keeps a bachelor's degree title quoted inside the file from
  // out-ranking the code the applicant actually wrote for the applied course.
  // Codes are staff-editable data — escape regex metacharacters so a code
  // like "B.COM" can only ever match itself, never act as a wildcard.
  const escRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const p of programmes) {
    if (new RegExp(`\\b${escRe(p.code.toUpperCase())}\\b`).test(up)) return p.code;
  }
  // Pass 2 — fuzzy name matching.
  for (const p of programmes) {
    // Significant words from the programme name; generic curriculum words
    // only support a match — they can never trigger one on their own.
    const words = p.name
      .toUpperCase()
      .split(/[^A-Z]+/)
      .filter((w) => w.length >= 4);
    const distinctive = words.filter((w) => !GENERIC_WORDS.has(w));
    const hits = words.filter((w) => up.includes(w));
    if (distinctive.length > 0) {
      // Every distinctive word must appear; longer names also need one
      // supporting generic word so "Diploma in Business Management" is not
      // mistaken for a stray mention of "management".
      const allDistinctive = distinctive.every((w) => up.includes(w));
      const supportHits = hits.filter((w) => GENERIC_WORDS.has(w)).length;
      const neededSupport = words.length - distinctive.length >= 2 ? 1 : 0;
      if (allDistinctive && supportHits >= neededSupport) return p.code;
    } else if (hits.length >= 2) {
      // All-generic name — two supporting words PLUS the name's leading word
      // ("Bachelor…" vs "Master…", "Diploma…" vs "Certificate…"), so a Master
      // of Business Administration form never matches the Bachelor's course.
      const first = words[0];
      if (first.length >= 4 && !up.includes(first)) continue;
      // OR-5: the name's LAST word is its most specific part — "Business
      // Administration" must never swallow "Business Information Technology".
      const last = words[words.length - 1];
      if (last.length >= 4 && !up.includes(last)) continue;
      return p.code;
    }
  }
  return null;
}

/** Transfer applicants mention credit transfer / exemptions from another
 * institution. Conservative on purpose — a stray "transfer" (bank transfer,
 * fee transfer) must not flip an applicant into the transfer track. But the
 * checklist's own wording ("transfer letter") and the plain "transfer INTO a
 * course" are unambiguous admissions language and must be recognised: missing
 * them means a real transfer applicant is never asked for the transfer form. */
export function inferTransfer(text: string): boolean {
  if (!text) return false;
  return /credit\s+transfer|transfer\s+letter|transfer\s+(?:of\s+)?(?:my\s+)?credits?|transferring\s+(?:from|to|into)|transfer\s+(?:application|student|entry)|transfer\s+into\b|course\s+exemption|exempt(?:ions?)?\s+(?:from|for)|prior\s+credits?\b/i.test(text);
}

/** Rough intake inference from phrases like "september intake"/"january 2027". */
export function inferIntake(text: string, intakes: string[]): string | null {
  if (!text) return null;
  const up = text.toUpperCase();
  for (const intake of intakes) {
    if (up.includes(intake.toUpperCase())) return intake;
    const [month, year] = intake.split(" ");
    // The month and the year must sit NEXT TO each other ("JANUARY 2026",
    // "JANUARY, 2026", "JANUARY INTAKE 2026"). Matching them anywhere in the
    // text let a DOB month on a birth certificate ("12 JANUARY 1990") pair
    // with an application year elsewhere ("2026 intake") and fabricate an
    // intake the applicant never mentioned as a unit.
    if (month && year) {
      const adjacent = new RegExp(`\\b${month.toUpperCase()}\\s*(?:INTAKE)?\\s*,?\\s*${year}\\b`);
      if (adjacent.test(up)) return intake;
    }
    if (month && up.includes(`${month.toUpperCase()} INTAKE`)) return intake;
  }
  return null;
}
