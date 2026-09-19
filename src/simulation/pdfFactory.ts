/**
 * Fixture document factory.
 *
 * - makeTextPdf: a digitally-generated PDF with a real embedded text layer
 *   (pdf-parse reads it → the "high confidence" tier).
 * - makeScannedPdf: an image-only PDF (the page is a rasterised bitmap of
 *   the text, no text layer) — pdf-parse gets nothing from it, so it must be
 *   read by OCR or Gemini, exactly like a phone scan.
 */
import PDFDocument from "pdfkit";
import { renderTextImage } from "../extraction/png";

function pdfFrom(build: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 60 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    build(doc);
    doc.end();
  });
}

export function makeTextPdf(lines: string[]): Promise<Buffer> {
  return pdfFrom((doc) => {
    doc.font("Helvetica").fontSize(14);
    for (const line of lines) {
      if (line === "") doc.moveDown(0.6);
      else doc.text(line, { lineBreak: true });
    }
  });
}

export async function makeScannedPdf(lines: string[]): Promise<Buffer> {
  const { png } = await renderTextImage(lines, { scale: 4, padding: 48 });
  return pdfFrom((doc) => {
    doc.image(png, 40, 40, { width: 515 });
  });
}

// ── Per-document-type content templates ────────────────────────────────────

export interface DocSpec {
  name: string;
  kcpePoints?: number;
  meanGrade?: string;
  kcseMeanGrade?: string;
  year?: string;
  idNumber?: string;
  programme?: string;
  /** Per-subject grades printed on the slip/transcript (subject → grade). */
  subjects?: Record<string, string>;
  /** Qualification system printed on the academic document (default KCSE). */
  examSystem?: "KCSE" | "IGCSE" | "ALEVEL" | "IB" | "DIPLOMA" | "PREUNI" | "DEGREE";
  /** IB total points; GPA for diploma/pre-university; award class text. */
  ibPoints?: number;
  gpa?: number;
  classAwarded?: string;
  subsidiaries?: number;
  diplomaTitle?: string;
  degreeTitle?: string;
  previousInstitution?: string;
  extraLines?: string[];
}

/**
 * A clean KCSE subject set used when a fixture doesn't specify one. Real
 * slips list every sat subject; these defaults satisfy the university's
 * published subject requirements (e.g. LLB's B in English/Kiswahili, BCS's
 * C+ in Mathematics/Physics), so per-subject rules see readable grades.
 */
const DEFAULT_SUBJECTS: Record<string, string> = {
  ENGLISH: "B", KISWAHILI: "B", MATHEMATICS: "B",
  PHYSICS: "B", CHEMISTRY: "B", BIOLOGY: "B",
};

const DEFAULT_IGCSE_SUBJECTS: Record<string, string> = {
  ENGLISH: "C", MATHEMATICS: "B", BIOLOGY: "C", CHEMISTRY: "C", PHYSICS: "D", HISTORY: "C",
};
const DEFAULT_ALEVEL_SUBJECTS: Record<string, string> = {
  MATHEMATICS: "B", PHYSICS: "C", ECONOMICS: "C",
};

export function docLines(type: string, spec: DocSpec): string[] {
  const year = spec.year ?? "2021";
  switch (type) {
    case "academic_cert": {
      const sys = spec.examSystem ?? "KCSE";
      if (sys === "IGCSE") {
        return [
          "CAMBRIDGE INTERNATIONAL EXAMINATIONS",
          "INTERNATIONAL GCSE (IGCSE) — STATEMENT OF RESULTS",
          "",
          `NAME: ${spec.name}`,
          `YEAR: ${year}`,
          ...Object.entries(spec.subjects ?? DEFAULT_IGCSE_SUBJECTS).map(([subj, g]) => `${subj}: ${g}`),
          ...(spec.extraLines ?? []),
        ];
      }
      if (sys === "ALEVEL") {
        return [
          "GCE ADVANCED LEVEL EXAMINATION",
          "STATEMENT OF RESULTS",
          "",
          `NAME: ${spec.name}`,
          `YEAR: ${year}`,
          ...Object.entries(spec.subjects ?? DEFAULT_ALEVEL_SUBJECTS).map(([subj, g]) => `${subj}: ${g}`),
          `SUBSIDIARY: ${spec.subsidiaries ?? 1}`,
          ...(spec.extraLines ?? []),
        ];
      }
      if (sys === "IB") {
        return [
          "INTERNATIONAL BACCALAUREATE DIPLOMA — RESULTS",
          "",
          `NAME: ${spec.name}`,
          `TOTAL POINTS: ${spec.ibPoints ?? 28}`,
          `YEAR: ${year}`,
          "ENGLISH HL: 5", "MATHEMATICS HL: 5", "PHYSICS SL: 4",
          "HISTORY SL: 5", "BIOLOGY SL: 5", "FRENCH SL: 4",
          ...(spec.extraLines ?? []),
        ];
      }
      if (sys === "DIPLOMA") {
        return [
          `${spec.diplomaTitle ?? "DIPLOMA IN BUSINESS MANAGEMENT"} — DIPLOMA TRANSCRIPT`,
          "",
          `NAME: ${spec.name}`,
          `OVERALL GRADE: ${spec.classAwarded ?? "CREDIT"}`,
          `GPA: ${spec.gpa ?? 2.8}`,
          `YEAR: ${year}`,
          ...(spec.extraLines ?? []),
        ];
      }
      if (sys === "PREUNI") {
        return [
          "PRE-UNIVERSITY CERTIFICATE — BRIDGING PROGRAMME",
          "",
          `NAME: ${spec.name}`,
          `GPA: ${spec.gpa ?? 3.0}`,
          `YEAR: ${year}`,
          ...(spec.extraLines ?? []),
        ];
      }
      if (sys === "DEGREE") {
        return [
          `${spec.degreeTitle ?? "BACHELOR OF BUSINESS ADMINISTRATION"} — DEGREE TRANSCRIPT`,
          "",
          `NAME: ${spec.name}`,
          `DEGREE CLASSIFICATION: ${spec.classAwarded ?? "SECOND CLASS HONOURS (UPPER DIVISION)"}`,
          `YEAR: ${year}`,
          ...(spec.extraLines ?? []),
        ];
      }
      return [
        "REPUBLIC OF KENYA",
        "KENYA CERTIFICATE OF SECONDARY EDUCATION",
        "ACADEMIC TRANSCRIPT",
        "",
        `NAME: ${spec.name}`,
        `MEAN GRADE: ${spec.kcseMeanGrade ?? "C+"}`,
        `YEAR: ${year}`,
        ...Object.entries(spec.subjects ?? DEFAULT_SUBJECTS).map(([subj, g]) => `${subj}: ${g}`),
        ...(spec.extraLines ?? []),
      ];
    }
    case "exam_result_slip":
      return [
        "REPUBLIC OF KENYA",
        "KENYA CERTIFICATE OF SECONDARY EDUCATION",
        "EXAMINATION RESULT SLIP",
        "",
        `NAME: ${spec.name}`,
        `YEAR: ${year}`,
        `MEAN GRADE: ${spec.kcseMeanGrade ?? "C+"}`,
        "INDEX NO: 20438112",
        ...(spec.extraLines ?? []),
      ];
    case "leaving_certificate":
      return [
        `${spec.previousInstitution ?? "ALLIANCE HIGH SCHOOL"}`,
        "HIGH SCHOOL LEAVING CERTIFICATE",
        "",
        `NAME: ${spec.name}`,
        `YEAR OF COMPLETION: ${year}`,
        "KCSE EXAMINATION CANDIDATE",
        ...(spec.extraLines ?? []),
      ];
    case "passport_photo":
      return [
        "PASSPORT SIZE PHOTOGRAPH",
        "(Applicant writes their name at the back)",
        "",
        `NAME: ${spec.name}`,
        ...(spec.extraLines ?? []),
      ];
    case "undergraduate_transcript":
      return [
        `${spec.previousInstitution ?? "UNIVERSITY OF NAIROBI"}`,
        "UNDERGRADUATE ACADEMIC TRANSCRIPT",
        "",
        `NAME: ${spec.name}`,
        `PROGRAMME: ${spec.degreeTitle ?? "BACHELOR OF COMMERCE"}`,
        `CLASSIFICATION: ${spec.classAwarded ?? "SECOND CLASS HONOURS (UPPER DIVISION)"}`,
        `YEAR: ${year}`,
        ...(spec.extraLines ?? []),
      ];
    case "undergraduate_degree_certificate":
      return [
        `${spec.previousInstitution ?? "UNIVERSITY OF NAIROBI"}`,
        "UNDERGRADUATE DEGREE CERTIFICATE",
        "",
        `NAME: ${spec.name}`,
        `DEGREE: ${spec.degreeTitle ?? "BACHELOR OF COMMERCE"}`,
        `YEAR OF GRADUATION: ${year}`,
        ...(spec.extraLines ?? []),
      ];
    case "masters_transcript":
      return [
        `${spec.previousInstitution ?? "UNIVERSITY OF NAIROBI"}`,
        "MASTER'S ACADEMIC TRANSCRIPT",
        "",
        `NAME: ${spec.name}`,
        `PROGRAMME: ${spec.degreeTitle ?? "MASTER OF BUSINESS ADMINISTRATION"}`,
        `YEAR: ${year}`,
        ...(spec.extraLines ?? []),
      ];
    case "masters_degree_certificate":
      return [
        `${spec.previousInstitution ?? "UNIVERSITY OF NAIROBI"}`,
        "MASTER'S DEGREE CERTIFICATE",
        "",
        `NAME: ${spec.name}`,
        `DEGREE: ${spec.degreeTitle ?? "MASTER OF BUSINESS ADMINISTRATION"}`,
        `YEAR OF GRADUATION: ${year}`,
        ...(spec.extraLines ?? []),
      ];
    case "law_personal_statement":
      return [
        "PERSONAL STATEMENT",
        "(LLB applicants — not more than 500 words)",
        "",
        `NAME: ${spec.name}`,
        "I wish to study law because I believe justice begins with listening.",
        "My debate club leadership taught me advocacy grounded in evidence.",
        ...(spec.extraLines ?? []),
      ];
    case "business_statement_of_objective":
      return [
        "STATEMENT OF OBJECTIVE",
        "(BBA applicants — not more than 300 words)",
        "",
        `NAME: ${spec.name}`,
        "My objective is to build a family enterprise with sound governance.",
        ...(spec.extraLines ?? []),
      ];
    case "kcpe_cert":
      return [
        "REPUBLIC OF KENYA",
        "KENYA CERTIFICATE OF PRIMARY EDUCATION",
        "(KCPE)",
        "",
        `NAME: ${spec.name}`,
        `KCPE POINTS: ${spec.kcpePoints ?? 300}`,
        `MEAN GRADE: ${spec.meanGrade ?? "B"}`,
        `YEAR: ${spec.year ?? "2017"}`,
        "INDEX NO: 10438211",
        ...(spec.extraLines ?? []),
      ];
    case "credit_transfer_form":
      return [
        "RIARA UNIVERSITY — OFFICE OF ADMISSIONS",
        "CREDIT TRANSFER APPLICATION FORM",
        "",
        `NAME OF APPLICANT: ${spec.name}`,
        `PREVIOUS INSTITUTION: ${spec.previousInstitution ?? "KENYATTA UNIVERSITY"}`,
        `PROGRAMME APPLIED FOR: ${spec.programme ?? "BACHELOR OF BUSINESS ADMINISTRATION"}`,
        `YEAR OF ENTRY: ${year}`,
        ...(spec.extraLines ?? []),
      ];
    case "id":
      return [
        "REPUBLIC OF KENYA",
        "NATIONAL IDENTITY CARD",
        "",
        `NAME: ${spec.name}`,
        `ID NO: ${spec.idNumber ?? "12345678"}`,
        "DATE OF ISSUE: 12 JAN 2020",
        ...(spec.extraLines ?? []),
      ];
    case "birth_cert":
      return [
        "REPUBLIC OF KENYA",
        "CERTIFICATE OF BIRTH",
        "",
        `NAME: ${spec.name}`,
        "DATE OF BIRTH: 04 MAR 2001",
        "REGISTRATION NO: 00441289",
        ...(spec.extraLines ?? []),
      ];
    case "application_form":
      return [
        "UNIVERSITY APPLICATION FORM",
        "OFFICE OF ADMISSIONS",
        "",
        `NAME OF APPLICANT: ${spec.name}`,
        `PROGRAMME APPLIED FOR: ${spec.programme ?? "BSC COMPUTER SCIENCE"}`,
        `YEAR OF ENTRY: ${year}`,
        ...(spec.extraLines ?? []),
      ];
    default:
      return spec.extraLines ?? [];
  }
}
