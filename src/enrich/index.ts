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

/** Keyword match against known programmes; returns the programme code or null. */
export function inferProgramme(
  text: string,
  programmes: Array<{ code: string; name: string }>
): string | null {
  if (!text) return null;
  const up = text.toUpperCase();
  for (const p of programmes) {
    // Exact code as a word (BCS, BBIT, LAW…)
    if (new RegExp(`\\b${p.code.toUpperCase()}\\b`).test(up)) return p.code;
    // Significant words from the programme name (skip tiny/generic words)
    const words = p.name
      .toUpperCase()
      .split(/[^A-Z]+/)
      .filter((w) => w.length >= 4 && !["BACHELOR", "SCIENCE", "DEGREE", "DIPLOMA"].includes(w));
    const hits = words.filter((w) => up.includes(w));
    // One strong keyword is enough for short names; longer names need two.
    const needed = words.length <= 2 ? 1 : 2;
    if (words.length > 0 && hits.length >= needed) return p.code;
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
