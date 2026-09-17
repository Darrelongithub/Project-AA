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
  "ARTS", "EDUCATION", "MANAGEMENT", "BUSINESS", "COMMUNICATION",
  "INFORMATION", "TECHNOLOGY", "STUDIES", "CURRICULA", "TEACHING",
  "KENYA", "REGISTERED", "COMMUNITY", "HEALTH", "PRE", "SERVICE",
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
  for (const p of programmes) {
    // Exact code as a word (BCS, BBIT, LAW…)
    if (new RegExp(`\\b${p.code.toUpperCase()}\\b`).test(up)) return p.code;
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
      // All-generic name (rare) — need at least two supporting words.
      return p.code;
    }
  }
  return null;
}

/** Rough intake inference from phrases like "september intake"/"january 2027". */
export function inferIntake(text: string, intakes: string[]): string | null {
  if (!text) return null;
  const up = text.toUpperCase();
  for (const intake of intakes) {
    if (up.includes(intake.toUpperCase())) return intake;
    const [month, year] = intake.split(" ");
    if (month && year && up.includes(month.toUpperCase()) && up.includes(year)) return intake;
    if (month && up.includes(`${month.toUpperCase()} INTAKE`)) return intake;
  }
  return null;
}
