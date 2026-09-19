/**
 * OR-5 — THE deterministic document-requirement generator.
 *
 * What an application file must contain is a PURE function of:
 *
 *   level × curriculum × nationality × route (+ the KCPE constant)
 *
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
 *   - KENYAN_REQUIRES_KCPE is an owner constant, currently false: the KCPE
 *     certificate is never demanded of anyone;
 *   - post-admission items for international applicants never block a file.
 */
import type { DocType } from "../types";

/** Owner-set constant. If ever true, Kenyan school-leaver files would also
 * require the KCPE certificate. Currently false — it never appears. */
export const KENYAN_REQUIRES_KCPE = false;

/** Umbrella phrases that must never describe a required document. */
export const BANNED_GENERIC_TERMS = ["academic certificate"];

export type ProgrammeLevel = "certificate" | "diploma" | "degree" | "masters" | "phd";
export type AdmissionRoute = "fresh" | "transfer";
export type ApplicantNationality = "kenyan" | "international" | "unknown";

export interface RequirementInput {
  level: ProgrammeLevel;
  route: AdmissionRoute;
  nationality: ApplicantNationality;
  /** Qualification system wording, e.g. "KCSE" — refines the result-slip label. */
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
  const sys = (curriculum ?? "").trim().toUpperCase();
  if (sys === "KCSE" || sys === "") {
    return "Certified copy of the examination result slip (KCSE result slip or equivalent)";
  }
  return `Certified copy of the ${sys} examination result slip/statement of results`;
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

  // KCPE: the owner constant governs. Currently false → never required.
  if (KENYAN_REQUIRES_KCPE && nationality === "kenyan" && (level === "certificate" || level === "diploma" || level === "degree")) {
    specs.push({
      document_type: "kcpe_cert",
      label: "KCPE certificate",
      required: true,
      blocking: true,
      source: OWNER,
    });
  }

  // ── Programme-conditional statements (checklist: asked, never assumed) ──
  const code = (programmeCode ?? "").trim().toUpperCase();
  if (code === "LLB") {
    specs.push({
      document_type: "law_personal_statement",
      label: "Personal statement of not more than 500 words",
      required: true,
      blocking: true,
      conditional: "Required of LLB applicants by the application-form checklist.",
      source: PACK,
    });
  }
  if (code === "BBA") {
    specs.push({
      document_type: "business_statement_of_objective",
      label: "Statement of objective of not more than 300 words",
      required: true,
      blocking: true,
      conditional: "Required of BBA applicants by the application-form checklist.",
      source: PACK,
    });
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
  /** Blocking slots still unfilled (asked for — never treated as failure). */
  missing: RequirementSpec[];
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
  }) as RequirementSpec[];
  return { filled, missing, leftover: [...pool] };
}
