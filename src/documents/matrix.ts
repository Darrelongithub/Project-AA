/**
 * OR-5 — THE deterministic document-requirement generator.
 *
 * What an application file must contain is a PURE function of:
 *
 *   level × curriculum × nationality × route (+ preset cases)
 *
 * The mechanism (which AXIS each item hangs off) is generic code; the
 * education CASES themselves (programme-conditional items, the Kenyan
 * school-leaver constant, result-slip wording) live in the admissions
 * preset (data/presets/admissions.json) and are read through the loader.

 * It is NOT staff-configurable: there are deliberately no toggles, no table
 * edits, no overrides in the console. The source-of-truth hierarchy used to
 * build this matrix (owner instruction):
 *
 *   1. the official pack PDFs (data/pack/application-form.pdf, "CHECKLIST AND
 *      DECLARATION", pp. 3–4) — authoritative;
 *   2. the owner's prompt (preserved existing behaviour, e.g. the application
 *      form itself being part of the file);
 *   3. web summaries (post-admission international items — always non-blocking).
 *
 * Guarantees:
 *   - conditional items are ASKED FOR, never assumed satisfied;
 *   - missing data is never treated as failure (existing product rule);
 *   - no slot may use a vague umbrella name (see BANNED_GENERIC_TERMS);
 *   - nationalRequiresPrimaryCert is a preset constant, currently false: the primary
 *     leaving certificate is never demanded of anyone;
 *   - post-admission items for international applicants never block a file.
 */
import type { DocType } from "../types";
import { admissionsPreset } from "../presets/loader";

/** Preset constant (data/presets/admissions.json → documents). If ever true,
 * Kenyan school-leaver files would also require the leaving certificate.
 * Currently false — it never appears. */
export const NATIONAL_REQUIRES_PRIMARY_CERT: boolean = admissionsPreset().documents.nationalRequiresPrimaryCert;
/** The preset's primary-certificate document-type token (comparisons use this, never a literal). */
export const PRIMARY_CERT_TYPE: DocType = admissionsPreset().documents.primaryCertSpec.document_type;

/** Umbrella phrases that must never describe a required document. */
export const BANNED_GENERIC_TERMS = ["academic certificate"];

export type ProgrammeLevel = "certificate" | "diploma" | "degree" | "masters" | "phd";
export type AdmissionRoute = "fresh" | "transfer";
export type ApplicantNationality = "kenyan" | "international" | "unknown";

export interface RequirementInput {
  level: ProgrammeLevel;
  route: AdmissionRoute;
  nationality: ApplicantNationality;
  /** Qualification system wording — refines the result-slip label. */
  curriculum?: string | null;
  /** Programme code for programme-conditional items ("LLB", "BBA"). */
  programmeCode?: string | null;
}

export interface RequirementSpec {
  document_type: DocType;
  /** Applicant-facing, concrete wording (never an umbrella term). */
  label: string;
  /** true = the file waits for it (still never treated as failure); false =
   * requested after admission only. */
  required: boolean;
  /** false ⇒ post-admission item: shown, requested, but never holds the file. */
  blocking: boolean;
  /** Human wording of WHY this item applies (conditional items only). */
  conditional?: string;
  /** Provenance tier from the owner's hierarchy. */
  source: "pack-pdf" | "owner-prompt" | "web-summary";
}

const PACK = "pack-pdf" as const;
const OWNER = "owner-prompt" as const;
const WEB = "web-summary" as const;

/** Academic slots the generic `academic_cert` fallback may fill, in priority
 * order — one uploaded document fills exactly one slot (slot semantics). */
export const ACADEMIC_SLOT_ORDER: DocType[] = [
  "exam_result_slip",
  "leaving_certificate",
  "undergraduate_transcript",
  "undergraduate_degree_certificate",
  "masters_transcript",
  "masters_degree_certificate",
];

function resultSlipLabel(curriculum?: string | null): string {
  const preset = admissionsPreset().documents.resultSlip;
  const sys = (curriculum ?? "").trim().toUpperCase();
  if (sys === preset.defaultSystem || sys === "") {
    return preset.defaultLabel;
  }
  return preset.template.replace("{SYS}", sys);
}

/** The matrix itself. Deterministic: same inputs → same output, every time. */
export function documentRequirementsFor(input: RequirementInput): RequirementSpec[] {
  const { level, route, nationality, curriculum, programmeCode } = input;
  const specs: RequirementSpec[] = [];

  // ── Core file — application-form checklist (pack PDF, authoritative) ──
  specs.push({
    document_type: "application_form",
    label: "Completed application form",
    required: true,
    blocking: true,
    source: OWNER,
  });

  // School-leaver academic evidence (checklist items 1–2) applies to
  // certificate/diploma/degree entry. Postgraduate files prove prior degrees
  // instead — a Master's/PhD applicant is not asked for the high-school
  // result slip and leaving certificate a second time.
  const postgrad = level === "masters" || level === "phd";
  if (!postgrad) {
    specs.push(
      {
        document_type: "exam_result_slip",
        label: resultSlipLabel(curriculum),
        required: true,
        blocking: true,
        source: PACK,
      },
      {
        document_type: "leaving_certificate",
        label: "Copy of the high school leaving certificate",
        required: true,
        blocking: true,
        source: PACK,
      }
    );
  }

  specs.push(
    {
      document_type: "passport_photo",
      label: "One passport-size photograph (with your name at the back)",
      required: true,
      blocking: true,
      source: PACK,
    },
    {
      document_type: "id",
      label: "Copy of your national ID or passport",
      required: true,
      blocking: true,
      source: PACK,
    },
    {
      document_type: "birth_cert",
      label: "Copy of your birth certificate",
      required: true,
      blocking: true,
      source: PACK,
    }
  );

  // Preset-governed leaving-certificate case. Currently false → never required.
  if (NATIONAL_REQUIRES_PRIMARY_CERT && nationality === "kenyan" && (level === "certificate" || level === "diploma" || level === "degree")) {
    specs.push({ ...admissionsPreset().documents.primaryCertSpec });
  }

  // ── Programme-conditional statements (checklist: asked, never assumed) ──
  // The cases are preset data keyed by programme code — no per-programme
  // branches in code.
  const code = (programmeCode ?? "").trim().toUpperCase();
  const programmeCase = admissionsPreset().documents.programmeCases[code];
  if (programmeCase) {
    specs.push({ ...programmeCase });
  }

  // ── Route-conditional: transfer cases ──
  if (route === "transfer") {
    specs.push({
      document_type: "credit_transfer_form",
      label: "Transfer letter / credit transfer form",
      required: true,
      blocking: true,
      conditional: "Required for transfer cases only.",
      source: PACK,
    });
  }

  // ── Level-conditional: postgraduate prior-degree paperwork ──
  if (level === "masters" || level === "phd") {
    specs.push(
      {
        document_type: "undergraduate_transcript",
        label: "Undergraduate academic transcripts",
        required: true,
        blocking: true,
        conditional: "Required for Master's and PhD applicants.",
        source: PACK,
      },
      {
        document_type: "undergraduate_degree_certificate",
        label: "Undergraduate degree certificate",
        required: true,
        blocking: true,
        conditional: "Required for Master's and PhD applicants.",
        source: PACK,
      }
    );
  }
  if (level === "phd") {
    specs.push(
      {
        document_type: "masters_transcript",
        label: "Master's academic transcripts",
        required: true,
        blocking: true,
        conditional: "Required for PhD applicants.",
        source: PACK,
      },
      {
        document_type: "masters_degree_certificate",
        label: "Master's degree certificate",
        required: true,
        blocking: true,
        conditional: "Required for PhD applicants.",
        source: PACK,
      }
    );
  }

  // ── Nationality-conditional: international, post-admission, NEVER blocking ──
  if (nationality === "international") {
    specs.push(
      {
        document_type: "student_pass_application",
        label: "Student pass / study permit application (requested after admission)",
        required: false,
        blocking: false,
        conditional: "International applicants only; handled after admission — it never holds the file.",
        source: WEB,
      },
      {
        document_type: "foreign_qualification_equivalence",
        label: "Equivalence certificate for foreign qualifications (requested after admission)",
        required: false,
        blocking: false,
        conditional: "International applicants only; handled after admission — it never holds the file.",
        source: WEB,
      }
    );
  }

  return specs;
}

export interface FillResult {
  /** Slot types that at least one submitted document fills. */
  filled: DocType[];
  /** Blocking slots still unfilled (asked for — never treated as failure).
   * Same element type as the input: a legacy RequirementSetEntry goes in,
   * RequirementSetEntries come out — never promised fields that aren't there. */
  missing: Slottable[];
  /** Submitted document types that filled no slot (true extras). */
  leftover: DocType[];
}

/**
 * Slot semantics: every submitted document fills AT MOST ONE slot; every slot
 * is filled by AT MOST ONE document. Exact type matches win; the classifier's
 * generic `academic_cert` fallback fills unfilled academic slots in priority
 * order. Non-blocking (post-admission) slots take no documents and never
 * appear as missing.
 */
/** Anything carrying a document_type plus optional blocking/required flags
 * (RequirementSpec or legacy RequirementSetEntry) can be slotted. */
export type Slottable = { document_type: DocType; blocking?: boolean; required?: boolean };

export interface CaseTypeDocumentDefinition {
  key: string;
  label: string;
  required: boolean;
  blocking: boolean;
  position?: number;
  /** Optional organization-defined axis condition. */
  axis?: string;
  values?: string[];
}

/** A generic document slot. It deliberately does not use DocType: a workplace
 * or community case may define any organization-owned document key. */
export interface CaseTypeRequirement {
  key: string;
  label: string;
  required: boolean;
  blocking: boolean;
}

/** Configurable document matrix entry point. The legacy academic generator is
 * retained for migrated academic compatibility; new case types use their own
 * organization-owned definitions and never inherit academic assumptions. */
export function documentRequirementsForCaseType(input: {
  caseType: { id: number; code: string; category?: string };
  definitions: CaseTypeDocumentDefinition[];
}): CaseTypeRequirement[] {
  return [...input.definitions]
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((d) => ({ key: d.key, label: d.label, required: !!d.required, blocking: !!d.blocking }));
}

export interface OrganizationDocumentAxis {
  key: string;
  label: string;
  values: string[];
}

/** The axis idea is still useful for generated checklists, but axes are now
 * data, not academic concepts. */
export function documentRequirementsFromAxes(input: {
  axes: OrganizationDocumentAxis[];
  selections?: Record<string, string>;
  definitions: CaseTypeDocumentDefinition[];
}): CaseTypeRequirement[] {
  const selected = input.selections ?? {};
  const validSelections = new Set(input.axes
    .filter((a) => selected[a.key] === undefined || a.values.includes(selected[a.key]))
    .map((a) => a.key));
  const definitions = input.definitions.filter((source) => {
    if (!source.axis || !validSelections.has(source.axis) || selected[source.axis] === undefined) return true;
    return !source.values?.length || source.values.includes(selected[source.axis]);
  });
  return documentRequirementsForCaseType({ caseType: { id: 0, code: "generic" }, definitions });
}

export function fillSlots(specs: Slottable[], submitted: DocType[]): FillResult {
  const pool = [...submitted];
  const filled: DocType[] = [];
  const take = (t: DocType): boolean => {
    const i = pool.indexOf(t);
    if (i === -1) return false;
    pool.splice(i, 1);
    return true;
  };

  for (const spec of specs) {
    const blocking = spec.blocking ?? spec.required ?? true;
    if (!blocking) continue; // post-admission items: not part of the file gate
    if (take(spec.document_type)) {
      filled.push(spec.document_type);
      continue;
    }
    if (ACADEMIC_SLOT_ORDER.includes(spec.document_type) && take("academic_cert")) {
      filled.push(spec.document_type);
    }
  }

  const missing = specs.filter((s) => {
    const blocking = s.blocking ?? s.required ?? true;
    return blocking && !filled.includes(s.document_type);
  });
  return { filled, missing, leftover: [...pool] };
}
