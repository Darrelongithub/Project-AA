/**
 * /rules — the deterministic decision engine.
 *
 * HARD CONSTRAINTS (see spec §5):
 *   - This module is PURE. Zero imports except ./types-free local types.
 *     No I/O, no network, no database, no AI. It can be unit-tested
 *     exhaustively with fake data.
 *   - It is the ONLY thing that decides Green/Orange/Red.
 *   - Anything borderline (e.g. grades below the stated minimum) produces a
 *     Flag — never an auto-pass, never an auto-fail.
 */
import type {
  Classification,
  DerivedFlag,
  DocType,
  DocumentRecord,
  Flag,
  RequirementSetEntry,
} from "../types";

export interface RulesInput {
  requirements: RequirementSetEntry[];
  /** Only the applicant's ACTIVE (non-superseded) documents. */
  docs: DocumentRecord[];
  /** Pre-existing flags (e.g. a watcher downgrade from an earlier pass). */
  flags: Array<Pick<Flag, "type" | "detail">>;
}

export interface RulesOutput {
  status: Classification;
  reasoning: string;
  /** Flags derived from the current snapshot (deterministic). */
  derivedFlags: DerivedFlag[];
  /** Required document types with no active document. */
  missing: DocType[];
}

/** Canonicalise a person name for cross-document comparison. */
export function normalizeName(name: string | null | undefined): string {
  if (!name) return "";
  return String(name)
    .toUpperCase()
    .replace(/[^A-Z ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Classic Levenshtein distance (pure, small inputs only). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Two distinct names are "similar" when they differ by at most 2 edits
 * (typo variants like OCHIMI vs OCHIEMI). Feature 23: these go to a human
 * too — we never guess which spelling is real.
 */
export function namesAreSimilar(a: string, b: string): boolean {
  if (a === b) return true;
  const minLen = Math.min(a.length, b.length);
  if (minLen < 6) return false;
  return levenshtein(a, b) <= 2;
}

const GRADE_CHECKED_TYPES: DocType[] = ["academic_cert", "kcpe_cert"];

/** The KCSE/KCPE mean-grade ladder, best (A) → worst (E). */
export const GRADE_LADDER = ["A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D+", "D", "D-", "E"] as const;

/**
 * Pure mean-grade comparison: true when `actual` is STRICTLY below `required`.
 * Unknown grades never compare false-positive — callers treat them as
 * unreadable and flag for a human instead.
 */
/** "C (plus)" / "B (PLAIN)" → the ladder letter ("C+" / "B"). */
export function normalizeGrade(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/\s*\(PLUS\)\s*/i, "+")
    .replace(/\s*\(MINUS\)\s*/i, "-")
    .replace(/\s*\(PLAIN\)\s*/i, "");
}

export function gradeBelow(actual: string | null | undefined, required: string | null | undefined): boolean {
  if (!actual || !required) return false;
  const a = GRADE_LADDER.indexOf(normalizeGrade(actual) as never);
  const r = GRADE_LADDER.indexOf(normalizeGrade(required) as never);
  if (a < 0 || r < 0) return false;
  return a > r;
}

/**
 * KCSE/KCPE points → the grade ladder (same thresholds the legacy migration
 * in db.ts uses). Lets a grade rule be checked against a points document.
 */
export function ptsToGrade(p: number): string {
  return p >= 400 ? "A" : p >= 381 ? "A-" : p >= 353 ? "B+" : p >= 325 ? "B" : p >= 295 ? "B-"
    : p >= 265 ? "C+" : p >= 235 ? "C" : p >= 205 ? "C-" : p >= 175 ? "D+" : p >= 145 ? "D"
    : p >= 115 ? "D-" : "E";
}

/** Staff write subjects many ways ("Maths", "Kis", "Bio") — canonicalise. */
const SUBJECT_SYNONYMS: Record<string, string> = {
  maths: "mathematics", math: "mathematics", kis: "kiswahili", eng: "english",
  bio: "biology", chem: "chemistry", phys: "physics", phy: "physics",
  hist: "history", geo: "geography",
};
function canonSubject(s: string): string {
  const k = s.trim().toLowerCase();
  return SUBJECT_SYNONYMS[k] ?? k;
}

/** Parse "C+ in Maths, English" / "B (plain) in English" subject lines → entries. */
export function parseGradeRule(raw: string | null | undefined): Array<{ grade: string; subjects: string[] }> {
  if (!raw) return [];
  return String(raw)
    .split(/[,;\n]+/)
    .map((part) => {
      const m = part.trim().match(/^([A-E][+-]?(?:\s*\((?:plus|minus|plain)\))?)\s*(?:in\s+(.*))?$/i);
      if (!m) return null;
      let grade = m[1].toUpperCase().replace(/\s*\(PLUS\)/, "+").replace(/\s*\(MINUS\)/, "-").replace(/\s*\(PLAIN\)/, "");
      const subjects = (m[2] ?? "")
        .split(/\band\b|&|\+/i)
        .map((s) => s.trim())
        .filter(Boolean);
      return { grade, subjects };
    })
    .filter((x): x is { grade: string; subjects: string[] } => x !== null);
}

/**
 * Derive flags from the current document snapshot. Pure and deterministic.
 * Borderline/judgment-adjacent situations become flags here — they never
 * translate into an automatic pass or fail downstream.
 */
export function deriveFlags(
  requirements: RequirementSetEntry[],
  docs: DocumentRecord[]
): DerivedFlag[] {
  const flags: DerivedFlag[] = [];

  // 1. Grade-requirement checks → ALWAYS a flag, never an auto decision.
  //    Rules speak GRADES (mean grade + optional subject grades), exactly as
  //    the university publishes them — no numeric "points".
  for (const req of requirements) {
    if (!GRADE_CHECKED_TYPES.includes(req.document_type)) continue;
    if (!req.meanGrade && !req.subjectGrades) continue;
    const doc = docs.find((d) => d.document_type === req.document_type);
    if (!doc) continue; // missing documents are handled by the verdict logic
    let mean = typeof doc.extracted_fields?.meanGrade === "string" ? (doc.extracted_fields.meanGrade as string) : null;
    // KCPE slips carry POINTS, not a letter grade. A readable points total is
    // converted to its grade equivalent so grade rules still apply — only a
    // genuinely unreadable document is flagged for a human.
    if (!mean && req.document_type === "kcpe_cert") {
      const pts = doc.extracted_fields?.gradePoints;
      if (typeof pts === "number" && Number.isFinite(pts)) mean = ptsToGrade(pts);
    }
    if (req.meanGrade && mean) {
      if (gradeBelow(mean, req.meanGrade)) {
        flags.push({
          type: "grade_below_requirement",
          detail: `${req.document_type}: mean grade ${mean} is below the required ${req.meanGrade} — human must review`,
        });
      }
    } else if (req.meanGrade && !mean) {
      flags.push({
        type: "low_confidence",
        detail: `${req.document_type}: mean grade could not be read (rule expects ${req.meanGrade}) — human must verify`,
      });
    }
    // Subject grades: each configured "C+ in English" line is checked against
    // the extracted subjectGrades map; a missing reading is flagged, not guessed.
    // A "/" inside a subject means EITHER/OR (e.g. "English/Kiswahili"): the
    // rule is satisfied when ANY alternative is present and high enough.
    const got = (doc.extracted_fields?.subjectGrades ?? {}) as Record<string, string>;
    for (const rule of parseGradeRule(req.subjectGrades ?? null)) {
      for (const entry of rule.subjects) {
        const options = entry.split("/").map((x) => x.trim()).filter(Boolean);
        const found = options
          .map((opt) => {
            const key = Object.keys(got).find((k) => canonSubject(k) === canonSubject(opt));
            return key ? { subject: key, grade: String(got[key]) } : null;
          })
          .filter((x): x is { subject: string; grade: string } => x !== null);
        if (found.length === 0) {
          flags.push({
            type: "low_confidence",
            detail: `${req.document_type}: grade for ${options.join(" or ")} could not be read (rule expects ${rule.grade}) — human must verify`,
          });
        } else if (found.every((f) => gradeBelow(f.grade, rule.grade))) {
          flags.push({
            type: "grade_below_requirement",
            detail: `${req.document_type}: ${found.map((f) => `${f.subject} ${f.grade}`).join(", ")} below the required ${rule.grade} — human must review`,
          });
        }
      }
    }
  }

  // 2. Name mismatch across documents (incl. fuzzy typo variants).
  const names: string[] = [];
  for (const d of docs) {
    const n = normalizeName(d.extracted_fields?.name as string | undefined);
    if (n.length >= 3 && !names.includes(n)) names.push(n);
  }
  if (names.length > 1) {
    let allSimilar = true;
    for (let i = 0; i < names.length && allSimilar; i++) {
      for (let j = i + 1; j < names.length; j++) {
        if (!namesAreSimilar(names[i], names[j])) {
          allSimilar = false;
          break;
        }
      }
    }
    flags.push({
      type: "name_mismatch",
      detail: allSimilar
        ? `possible name typo across documents: ${names.join(" ≈ ")} — human must confirm the correct spelling`
        : `names differ across documents: ${names.join(" vs ")}`,
    });
  }

  // 3. Extraction confidence below high → never auto-approved.
  for (const d of docs) {
    if (d.confidence !== "high") {
      flags.push({
        type: "low_confidence",
        detail: `${d.document_type} extracted via ${d.extraction_method} with ${d.confidence} confidence`,
      });
    }
  }

  // 4. Attachments we could not recognise at all.
  for (const d of docs) {
    if (d.document_type === "unknown") {
      flags.push({
        type: "low_confidence",
        detail: `unrecognized attachment (email ${d.source_email_id}) — needs human eyes`,
      });
    }
  }

  // 5. Cross-document consistency anomalies (v3 feature 7). These are
  //    "flag → human verification", never an automatic authenticity verdict.
  const kcpe = docs.find((d) => d.document_type === "kcpe_cert");
  const kcse = docs.find((d) => d.document_type === "academic_cert");
  const kcpeYear = Number(kcpe?.extracted_fields?.examYear ?? NaN);
  const kcseYear = Number(kcse?.extracted_fields?.examYear ?? NaN);
  if (Number.isFinite(kcpeYear) && Number.isFinite(kcseYear) && kcpeYear >= kcseYear) {
    flags.push({
      type: "anomaly",
      detail: `exam dates are inconsistent: KCPE dated ${kcpeYear} is not before KCSE dated ${kcseYear} — potential anomaly, verify authenticity`,
    });
  }

  return dedupeFlags(flags);
}

export function dedupeFlags(flags: DerivedFlag[]): DerivedFlag[] {
  const seen = new Set<string>();
  const out: DerivedFlag[] = [];
  for (const f of flags) {
    const k = `${f.type}::${f.detail}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(f);
    }
  }
  return out;
}

const DOC_LABELS: Record<DocType, string> = {
  academic_cert: "KCSE Certificate",
  id: "National ID",
  kcpe_cert: "KCPE Certificate",
  birth_cert: "Birth Certificate",
  application_form: "Application Form",
  unknown: "Unknown document",
};

export function docLabel(t: DocType): string {
  return DOC_LABELS[t] ?? t;
}

/**
 * The decision. Pure function of (RequirementSet, active documents, flags).
 *
 *   Red    → a required document is missing, or a watcher_flag is active
 *   Orange → everything required is present, but something needs human
 *            review (any flag, or any non-high-confidence extraction)
 *   Green  → complete, high-confidence, flag-free
 */
export function decide(input: RulesInput): RulesOutput {
  const { requirements, docs } = input;
  const derived = deriveFlags(requirements, docs);
  const allFlags = dedupeFlags([
    ...derived,
    ...input.flags.map((f) => ({ type: f.type, detail: f.detail })),
  ]);

  const required = requirements.filter((r) => r.required);
  const missing = required
    .filter((r) => !docs.some((d) => d.document_type === r.document_type))
    .map((r) => r.document_type);

  // Per-requirement status lines for the reasoning trace.
  const docLines = requirements.map((r) => {
    const d = docs.find((x) => x.document_type === r.document_type);
    if (!d) return `  - ${r.document_type}: MISSING (${r.required ? "required" : "optional"})`;
    const name = d.extracted_fields?.name ? ` name="${d.extracted_fields.name}"` : "";
    const pts =
      typeof d.extracted_fields?.gradePoints === "number"
        ? ` points=${d.extracted_fields.gradePoints}`
        : "";
    return `  - ${r.document_type}: present via ${d.extraction_method}/${d.confidence}${name}${pts}${
      r.required ? "" : " (optional)"
    }`;
  });
  const extras = docs.filter(
    (d) => d.document_type === "unknown" || !requirements.some((r) => r.document_type === d.document_type)
  );
  for (const d of extras) {
    docLines.push(`  - extra unrecognized attachment: ${d.extraction_method}/${d.confidence}`);
  }

  const flagLines = allFlags.map((f) => `  - [${f.type}] ${f.detail}`);

  let status: Classification;
  let verdictLine: string;

  if (missing.length > 0) {
    status = "Red";
    verdictLine = `Verdict: Red — missing required document(s): ${missing
      .map((m) => docLabel(m))
      .join(", ")}. Queued for a human to request the remainder.`;
  } else if (allFlags.some((f) => f.type === "watcher_flag")) {
    status = "Red";
    verdictLine =
      "Verdict: Red — the watcher flagged the record after the rules engine said Green. Auto-reply blocked; queued for a human.";
  } else if (allFlags.length > 0) {
    status = "Orange";
    verdictLine =
      "Verdict: Orange — all required documents are present but at least one flag fired or confidence is below high. Queued for human review (never auto-approved, never auto-rejected).";
  } else {
    status = "Green";
    verdictLine =
      "Verdict: Green — all required documents present with high-confidence extractions and no flags. Eligible for auto-reply after the watcher check.";
  }

  const reasoning = [
    `Requirement check (${required.length} required):`,
    ...docLines,
    allFlags.length ? "Flags:" : "Flags: none",
    ...(allFlags.length ? flagLines : []),
    verdictLine,
  ].join("\n");

  return { status, reasoning, derivedFlags: derived, missing };
}
