import type { Confidence, DocType, DocumentRecord, RequirementSetEntry } from "../src/types";

export const REQS: RequirementSetEntry[] = [
  { document_type: "academic_cert", required: true },
  { document_type: "kcpe_cert", required: true, meanGrade: "C-", subjectGrades: "C- in English" },
  { document_type: "id", required: true },
  { document_type: "application_form", required: true },
  { document_type: "birth_cert", required: false },
];

let nextId = 1;

export function mkDoc(
  type: DocType,
  opts: {
    confidence?: Confidence;
    fields?: Record<string, unknown>;
    method?: DocumentRecord["extraction_method"];
    name?: string;
    text?: string;
  } = {}
): DocumentRecord {
  return {
    id: nextId++,
    applicant_id: 1,
    document_type: type,
    source_email_id: "email-test-1",
    extraction_method: opts.method ?? "pdf_text",
    extracted_text: opts.text ?? `some ${type} text`,
    extracted_fields: opts.fields ?? (opts.name ? { name: opts.name } : {}),
    confidence: opts.confidence ?? "high",
    superseded_by: null,
    received_at: "2026-09-14T00:00:00Z",
  };
}

/** A complete, clean, high-confidence document set (incl. optional birth cert). */
export function completeDocs(): DocumentRecord[] {
  return [
    mkDoc("academic_cert", { name: "ALICE WANJIKU KAMAU" }),
    mkDoc("kcpe_cert", { name: "ALICE WANJIKU KAMAU", fields: { name: "ALICE WANJIKU KAMAU", meanGrade: "B", subjectGrades: { English: "B" } } }),
    mkDoc("id", { name: "ALICE WANJIKU KAMAU" }),
    mkDoc("application_form", { name: "ALICE WANJIKU KAMAU" }),
    mkDoc("birth_cert", { name: "ALICE WANJIKU KAMAU" }),
  ];
}
