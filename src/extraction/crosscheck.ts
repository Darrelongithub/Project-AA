/**
 * Cross-document consistency (round 19, confidence v2).
 *
 * A real applicant's documents agree with each other: the name on the birth
 * certificate is the name on the results slip (allowing for initials, order
 * and case), and a date of birth — where printed twice — is the same date.
 * When they don't agree, confidence in the whole file drops and a human
 * must look. This module is pure string logic: no AI, no network.
 */
import type { DocType } from "../types";

export interface ConsistencyDoc {
  id: number;
  document_type: DocType;
  confidence_score: number;
  name?: string | null;
  dateOfBirth?: string | null;
}

export interface ConsistencyReport {
  nameConsistent: boolean;
  dobConsistent: boolean;
  /** Document ids whose names disagree with the majority name. */
  nameOutliers: number[];
  /** Document ids whose DOB disagrees with the majority DOB. */
  dobOutliers: number[];
  issues: string[];
}

/** Upper-case token list; hyphens join ("MWA-NDO" → one token). */
export function nameTokens(name: string): string[] {
  return (name || "")
    .toUpperCase()
    .replace(/[^A-Z\-\s]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Do two names plausibly belong to the same person?
 *   - token-set equality (order-insensitive): "KAMAU JOHN" = "John Kamau"
 *   - initials: "JOHN K KAMAU" ~ "JOHN KAMAU", "J P KAMAU" ~ "JOHN PETER KAMAU"
 *   - subset when one side has extra middle names (common on certificates)
 *
 * The check is coverage, not intersection: EVERY token of the shorter name
 * must appear in the longer one, either verbatim or as an initial. (An
 * intersection gate would silently reject genuine initial-only matches.)
 */
export function namesConsistent(a: string | null | undefined, b: string | null | undefined): boolean {
  const ta = nameTokens(a ?? "");
  const tb = nameTokens(b ?? "");
  if (!ta.length || !tb.length) return true; // nothing to contradict
  if (ta.join(" ") === tb.join(" ")) return true;

  const cover = (short: string[], long: string[]): boolean =>
    short.every((t) => {
      if (long.includes(t)) return true;
      // Single-letter token matches the initial of some long token.
      if (t.length === 1) return long.some((lt) => lt.length > 1 && lt[0] === t);
      return false;
    });

  const short = ta.length <= tb.length ? ta : tb;
  const long = ta.length <= tb.length ? tb : ta;
  return cover(short, long);
}

const MONTH_NAMES: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function validYmd(y: number, m: number, d: number): boolean {
  return y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

function monthFromWord(w: string): number | null {
  const key = w.slice(0, 3).toUpperCase();
  return MONTH_NAMES[key] ?? null;
}

/**
 * Parse a printed DOB to canonical {y, m, d}. Format-aware: "12/03/2004"
 * (assumed day-first; swapped automatically when only the US order is
 * possible), "2004-03-12", "12 JANUARY 2005", "JANUARY 12 2005". Returns
 * null when the date cannot be pinned down — unknown never contradicts.
 */
export function dobCanonical(dob: string | null | undefined): { y: number; m: number; d: number } | null {
  const s = (dob || "").trim().toUpperCase().replace(/\s+/g, " ");
  if (!s) return null;

  let m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (m) {
    let d = Number(m[1]);
    let mo = Number(m[2]);
    const y = Number(m[3]);
    if (!validYmd(y, mo, d) && validYmd(y, d, mo)) [d, mo] = [mo, d]; // US order rescue
    return validYmd(y, mo, d) ? { y, m: mo, d } : null;
  }
  m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (m) {
    const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
    return validYmd(y, mo, d) ? { y, m: mo, d } : null;
  }
  m = s.match(/^(\d{1,2})(?:ST|ND|RD|TH)?\s+([A-Z]{3,9})\s*,?\s*(\d{4})$/);
  if (m) {
    const mo = monthFromWord(m[2]);
    const d = Number(m[1]); const y = Number(m[3]);
    return mo && validYmd(y, mo, d) ? { y, m: mo, d } : null;
  }
  m = s.match(/^([A-Z]{3,9})\s+(\d{1,2})(?:ST|ND|RD|TH)?\s*,?\s*(\d{4})$/);
  if (m) {
    const mo = monthFromWord(m[1]);
    const d = Number(m[2]); const y = Number(m[3]);
    return mo && validYmd(y, mo, d) ? { y, m: mo, d } : null;
  }
  return null;
}

/** Stable comparable key (kept for callers that want a string). */
export function dobKey(dob: string | null | undefined): string | null {
  const c = dobCanonical(dob);
  return c ? `${c.y}-${String(c.m).padStart(2, "0")}-${String(c.d).padStart(2, "0")}` : null;
}

export function dobsConsistent(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = dobKey(a);
  const kb = dobKey(b);
  if (!ka || !kb) return true; // nothing to contradict
  return ka === kb;
}

/**
 * Check every named/DOB'd document against every other. With 2+ conflicting
 * names the MAJORITY reading wins (the applicant's own paper trail usually
 * repeats); outliers get flagged.
 */
export function consistencyCheck(docs: ConsistencyDoc[]): ConsistencyReport {
  const named = docs.filter((d) => nameTokens(d.name ?? "").length > 0);
  const dated = docs.filter((d) => dobKey(d.dateOfBirth) !== null);
  const report: ConsistencyReport = {
    nameConsistent: true,
    dobConsistent: true,
    nameOutliers: [],
    dobOutliers: [],
    issues: [],
  };

  // Pairwise pass first: any contradiction at all is an issue.
  for (let i = 0; i < named.length; i++) {
    for (let j = i + 1; j < named.length; j++) {
      if (!namesConsistent(named[i].name, named[j].name)) {
        report.nameConsistent = false;
        report.issues.push(
          `name on ${named[i].document_type} ("${named[i].name}") does not match ${named[j].document_type} ("${named[j].name}")`
        );
      }
    }
  }
  for (let i = 0; i < dated.length; i++) {
    for (let j = i + 1; j < dated.length; j++) {
      if (!dobsConsistent(dated[i].dateOfBirth, dated[j].dateOfBirth)) {
        report.dobConsistent = false;
        report.issues.push(
          `date of birth differs between ${dated[i].document_type} (${dated[i].dateOfBirth}) and ${dated[j].document_type} (${dated[j].dateOfBirth})`
        );
      }
    }
  }

  // Majority pass: mark the outliers so the pipeline can cap THEIR scores.
  if (!report.nameConsistent && named.length >= 2) {
    // Single-linkage clustering: a doc joins a cluster when it is consistent
    // with ANY member (not just the first), so chained variants stay together.
    const clusters: ConsistencyDoc[][] = [];
    for (const d of named) {
      const cluster = clusters.find((c) => c.some((member) => namesConsistent(member.name, d.name)));
      if (cluster) cluster.push(d);
      else clusters.push([d]);
    }
    clusters.sort((x, y) => y.length - x.length);
    const majority = clusters[0];
    for (const c of clusters.slice(1)) {
      for (const d of c) report.nameOutliers.push(d.id);
    }
    if (majority.length > 0 && clusters.length > 1) {
      report.issues.push(
        `majority name reading: "${majority[0].name}" on ${majority.length} document(s)`
      );
    }
  }
  if (!report.dobConsistent && dated.length >= 2) {
    const clusters: ConsistencyDoc[][] = [];
    for (const d of dated) {
      const cluster = clusters.find((c) => c.some((member) => dobsConsistent(member.dateOfBirth, d.dateOfBirth)));
      if (cluster) cluster.push(d);
      else clusters.push([d]);
    }
    clusters.sort((x, y) => y.length - x.length);
    for (const c of clusters.slice(1)) {
      for (const d of c) report.dobOutliers.push(d.id);
    }
  }

  return report;
}
