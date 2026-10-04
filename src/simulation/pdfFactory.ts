/**
 * Fixture document factory.
 *
 * - makeTextPdf: a digitally-generated PDF with a real embedded text layer
 *   (pdfjs-dist reads it → the "high confidence" tier).
 * - makeScannedPdf: an image-only PDF (the page is a rasterised bitmap of
 *   the text, no text layer) — pdfjs-dist gets nothing from it, so it must be
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
