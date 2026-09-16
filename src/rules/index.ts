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
  for (const req of requirements) {
    if (req.minGradePoints == null) continue;
    if (!GRADE_CHECKED_TYPES.includes(req.document_type)) continue;
    const doc = docs.find((d) => d.document_type === req.document_type);
    if (!doc) continue; // missing documents are handled by the verdict logic
    const points = doc.extracted_fields?.gradePoints;
    if (typeof points === "number" && Number.isFinite(points)) {
      if (points < req.minGradePoints) {
        flags.push({
          type: "grade_below_requirement",
          detail: `${req.document_type}: extracted ${points} points < required minimum ${req.minGradePoints} — borderline case, human must review`,
        });
      }
    } else {
      flags.push({
        type: "low_confidence",
        detail: `${req.document_type}: grade could not be read reliably — human must verify`,
      });
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
