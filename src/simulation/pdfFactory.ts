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
  extraLines?: string[];
}

export function docLines(type: string, spec: DocSpec): string[] {
  const year = spec.year ?? "2021";
  switch (type) {
    case "academic_cert":
      return [
        "REPUBLIC OF KENYA",
        "KENYA CERTIFICATE OF SECONDARY EDUCATION",
        "ACADEMIC TRANSCRIPT",
        "",
        `NAME: ${spec.name}`,
        `MEAN GRADE: ${spec.kcseMeanGrade ?? "C+"}`,
        `YEAR: ${year}`,
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
