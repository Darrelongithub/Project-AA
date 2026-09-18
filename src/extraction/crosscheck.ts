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
 *   - initials: "JOHN K KAMAU" ~ "JOHN KAMAU"
 *   - subset when one side has extra middle names (common on certificates)
 */
export function namesConsistent(a: string | null | undefined, b: string | null | undefined): boolean {
  const ta = nameTokens(a ?? "");
  const tb = nameTokens(b ?? "");
  if (!ta.length || !tb.length) return true; // nothing to contradict
  if (ta.join(" ") === tb.join(" ")) return true;

  const sa = new Set(ta);
  const sb = new Set(tb);
  const intersection = [...sa].filter((t) => sb.has(t));
  const shorter = Math.min(ta.length, tb.length);

  // Every token of the shorter name must appear (as token or initial) in
  // the longer one.
  const cover = (short: string[], long: string[]): boolean =>
    short.every((t) => {
      if (long.includes(t)) return true;
      // Single-letter token matches the initial of some long token.
      if (t.length === 1) return long.some((lt) => lt.length > 1 && lt[0] === t);
      return false;
    });

  if (intersection.length >= shorter && (cover(ta.length <= tb.length ? ta : tb, ta.length <= tb.length ? tb : ta))) {
    return true;
  }
  return false;
}

/** Normalise a printed DOB to a comparable form (digits only). */
export function dobKey(dob: string | null | undefined): string | null {
  const digits = (dob || "").replace(/[^0-9]/g, "");
  return digits.length >= 6 ? digits : null;
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
    const clusters: ConsistencyDoc[][] = [];
    for (const d of named) {
      const cluster = clusters.find((c) => namesConsistent(c[0].name, d.name));
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
      const cluster = clusters.find((c) => dobsConsistent(c[0].dateOfBirth, d.dateOfBirth));
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
