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
