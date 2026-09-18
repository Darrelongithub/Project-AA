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
  ExamSystem,
  ExtractedFields,
  Flag,
  RequirementSetEntry,
  SubjectRequirement,
  SystemBlock,
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


// ── Structured qualification checks (per exam system) ─────────────────────
// Requirement blocks speak the language each system is actually marked in:
// KCSE letter grades, IGCSE credits + A*–G, A-Level principal passes, IB
// points, diploma/degree classes, GPAs. Every check below DETERMINISTICALLY
// compares a read value against the configured minimum; anything unreadable
// becomes a flag for a human — never a guess.

export const IGCSE_LADDER = ["A*", "A", "B", "C", "D", "E", "F", "G"] as const;
export const ALEVEL_LADDER = ["A", "B", "C", "D", "E"] as const;
export const IB_SUBJECT_LADDER = ["7", "6", "5", "4", "3", "2", "1"] as const;
/** Worst → best. */
export const DIPLOMA_CLASS_LADDER = ["pass", "credit", "distinction"];
export const DEGREE_CLASS_LADDER = [
  "pass",
  "second class honours (lower division)",
  "second class lower",
  "second class honours (upper division)",
  "second class upper",
  "first class honours",
  "first class",
];

function canonClass(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9 ()]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Generic ladder comparison: true when `actual` is STRICTLY below `required`. */
export function ladderBelow(actual: string | null | undefined, required: string | null | undefined, ladder: readonly string[]): boolean {
  if (!actual || !required) return false;
  const a = ladder.indexOf(String(actual).trim().toUpperCase());
  const r = ladder.indexOf(String(required).trim().toUpperCase());
  if (a < 0 || r < 0) return false;
  return a > r;
}

function classBelow(actual: string | null | undefined, required: string | null | undefined, ladder: readonly string[]): boolean {
  if (!actual || !required) return false;
  const a = ladder.indexOf(canonClass(actual));
  const r = ladder.indexOf(canonClass(required));
  if (a < 0 || r < 0) return false;
  return a < r; // class ladders are ordered worst → best
}

const SYSTEM_LABEL: Record<ExamSystem, string> = {
  KCSE: "KCSE", IGCSE: "IGCSE/GCE O-Level", ALEVEL: "GCE A-Level/KACE",
  IB: "IB Diploma", DIPLOMA: "Diploma", PREUNI: "Pre-University", DEGREE: "Degree",
};

/**
 * Check one subject requirement ({subject, grade, alts}) against the subject
 * map read off the document. Either/or alternatives: ONE subject reaching the
 * grade is enough; nothing readable → flag, never a guess.
 */
function checkSubjectRule(req: SubjectRequirement, got: Record<string, string> | null | undefined, ladder: readonly string[] | null, label: string): DerivedFlag[] {
  const options = [req.subject, ...(req.alts ?? [])];
  const found: Array<{ subject: string; grade: string }> = [];
  for (const opt of options) {
    const key = Object.keys(got ?? {}).find((k) => canonSubject(k) === canonSubject(opt));
    if (key && got) found.push({ subject: key, grade: String(got[key]) });
  }
  if (found.length === 0) {
    return [{
      type: "low_confidence",
      detail: `${label}: grade for ${options.join(" or ")} could not be read (rule expects ${req.grade}) — human must verify`,
    }];
  }
  const passes = found.some((f) =>
    ladder ? !ladderBelow(f.grade, req.grade, ladder) : !gradeBelow(f.grade, req.grade)
  );
  if (!passes) {
    return [{
      type: "grade_below_requirement",
      detail: `${label}: ${found.map((f) => `${f.subject} ${f.grade}`).join(", ")} below the required ${req.grade} — human must review`,
    }];
  }
  return [];
}

/**
 * Deterministic check of one qualification-system block against the fields
 * read off the applicant's document. Returns flags only — never a decision.
 */
export function checkSystemBlock(block: SystemBlock, fields: ExtractedFields): DerivedFlag[] {
  const flags: DerivedFlag[] = [];
  const label = SYSTEM_LABEL[block.system];
  const subs = (fields.subjectGrades ?? null) as Record<string, string> | null;

  switch (block.system) {
    case "KCSE": {
      if (block.overall) {
        const mean = typeof fields.meanGrade === "string" ? fields.meanGrade : null;
        if (mean && gradeBelow(mean, block.overall)) {
          flags.push({ type: "grade_below_requirement", detail: `KCSE: mean grade ${mean} is below the required ${block.overall} — human must review` });
        } else if (!mean) {
          flags.push({ type: "low_confidence", detail: `KCSE: mean grade could not be read (rule expects ${block.overall}) — human must verify` });
        }
      }
      for (const r of block.subjects ?? []) flags.push(...checkSubjectRule(r, subs, null, "KCSE"));
      break;
    }
    case "IGCSE": {
      if (block.minCredits != null) {
        const credits = typeof fields.credits === "number" ? fields.credits : null;
        if (credits == null) {
          flags.push({ type: "low_confidence", detail: `IGCSE: credit count could not be read (rule expects ${block.minCredits} passes at C or better) — human must verify` });
        } else if (credits < block.minCredits) {
          flags.push({ type: "grade_below_requirement", detail: `IGCSE: ${credits} pass(es) at C or better, below the required ${block.minCredits} — human must review` });
        }
      }
      for (const r of block.subjects ?? []) flags.push(...checkSubjectRule(r, subs, [...IGCSE_LADDER], "IGCSE"));
      break;
    }
    case "ALEVEL": {
      if (block.minPrincipals != null) {
        const principals = typeof fields.principals === "number" ? fields.principals : null;
        if (principals == null) {
          flags.push({ type: "low_confidence", detail: `GCE A-Level: principal passes could not be read (rule expects ${block.minPrincipals}) — human must verify` });
        } else if (principals < block.minPrincipals) {
          flags.push({ type: "grade_below_requirement", detail: `GCE A-Level: ${principals} principal pass(es), below the required ${block.minPrincipals} — human must review` });
        }
      }
      if (block.minSubsidiaries != null) {
        const sub = typeof fields.subsidiaries === "number" ? fields.subsidiaries : 0;
        if (sub < block.minSubsidiaries) {
          flags.push({ type: "grade_below_requirement", detail: `GCE A-Level: ${sub} subsidiary pass(es), below the required ${block.minSubsidiaries} — human must review` });
        }
      }
      for (const r of block.subjects ?? []) flags.push(...checkSubjectRule(r, subs, [...ALEVEL_LADDER], "GCE A-Level"));
      break;
    }
    case "IB": {
      if (block.minPoints != null) {
        const pts = typeof fields.ibPoints === "number" ? fields.ibPoints : null;
        if (pts == null) {
          flags.push({ type: "low_confidence", detail: `IB: total points could not be read (rule expects ${block.minPoints}) — human must verify` });
        } else if (pts < block.minPoints) {
          flags.push({ type: "grade_below_requirement", detail: `IB: ${pts} points, below the required ${block.minPoints} — human must review` });
        }
      }
      for (const r of block.subjects ?? []) flags.push(...checkSubjectRule(r, subs, [...IB_SUBJECT_LADDER], "IB"));
      break;
    }
    case "DIPLOMA": {
      if (block.minClass) {
        const cls = typeof fields.classAwarded === "string" ? fields.classAwarded : null;
        if (!cls) flags.push({ type: "low_confidence", detail: `Diploma: award class could not be read (rule expects ${block.minClass}) — human must verify` });
        else if (classBelow(cls, block.minClass, DIPLOMA_CLASS_LADDER)) {
          flags.push({ type: "grade_below_requirement", detail: `Diploma: award class "${cls}" is below the required ${block.minClass} — human must review` });
        }
      }
      if (block.minGpa != null) {
        const gpa = typeof fields.gpa === "number" ? fields.gpa : null;
        if (gpa == null) flags.push({ type: "low_confidence", detail: `Diploma: GPA could not be read (rule expects ${block.minGpa}) — human must verify` });
        else if (gpa < block.minGpa) {
          flags.push({ type: "grade_below_requirement", detail: `Diploma: GPA ${gpa.toFixed(2)} is below the required ${block.minGpa} — human must review` });
        }
      }
      break;
    }
    case "PREUNI": {
      if (block.minGpa != null) {
        const gpa = typeof fields.gpa === "number" ? fields.gpa : null;
        if (gpa == null) flags.push({ type: "low_confidence", detail: `Pre-University: GPA could not be read (rule expects ${block.minGpa}) — human must verify` });
        else if (gpa < block.minGpa) {
          flags.push({ type: "grade_below_requirement", detail: `Pre-University: GPA ${gpa.toFixed(2)} is below the required ${block.minGpa} — human must review` });
        }
      }
      break;
    }
    case "DEGREE": {
      if (block.minClass) {
        const cls = typeof fields.classAwarded === "string" ? fields.classAwarded : null;
        if (!cls) flags.push({ type: "low_confidence", detail: `Degree: class of degree could not be read (rule expects ${block.minClass}) — human must verify` });
        else if (classBelow(cls, block.minClass, DEGREE_CLASS_LADDER)) {
          flags.push({ type: "grade_below_requirement", detail: `Degree: class "${cls}" is below the required ${block.minClass} — human must review` });
        }
      }
      // No minClass configured = recognised-degree route (no automated minimum).
      break;
    }
  }
  return flags;
}

/**
 * Check every ACTIVE academic document against the course's qualification
 * routes. A system with no configured route goes to a human — alternative
 * entry is never auto-judged in either direction.
 */
export function checkQualificationSystems(blocks: SystemBlock[], docs: DocumentRecord[]): DerivedFlag[] {
  const flags: DerivedFlag[] = [];
  const academic = docs.filter((d) => d.document_type === "academic_cert");
  for (const doc of academic) {
    const fields = (doc.extracted_fields ?? {}) as ExtractedFields;
    const system = fields.examSystem ?? null;
    if (!system) {
      flags.push({
        type: "low_confidence",
        detail: "academic document: qualification system could not be identified — human must verify which entry route applies",
      });
      continue;
    }
    const block = blocks.find((b) => b.system === system);
    if (!block) {
      flags.push({
        type: "alternative_qualification",
        detail: `${SYSTEM_LABEL[system]} presented, but no ${SYSTEM_LABEL[system]} route is configured for this course — human must assess this entry route`,
      });
      continue;
    }
    if (!block.enabled) {
      flags.push({
        type: "alternative_qualification",
        detail: `${SYSTEM_LABEL[system]} route is switched off for this course — human must assess this entry route`,
      });
      continue;
    }
    flags.push(...checkSystemBlock(block, fields));
  }
  return flags;
}
