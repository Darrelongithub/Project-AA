/**
 * Fixture document factory.
 *
 * - makeTextPdf: a digitally-generated PDF with a real embedded text layer
 *   (pdf-parse reads it → the "high confidence" tier).
 * - makeScannedPdf: an image-only PDF (the page is a rasterised bitmap of
 *   the text, no text layer) — pdf-parse gets nothing from it, so it must be
 *   read by OCR or Gemini, exactly like a phone scan.
 */
import * as fs from "fs";
import * as path from "path";
import PDFDocument from "pdfkit";
import { renderTextImage } from "../extraction/png";
import { admissionsPreset, bundledDataDir } from "../presets/loader";

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
  primaryPoints?: number;
  meanGrade?: string;
  secondaryMeanGrade?: string;
  year?: string;
  idNumber?: string;
  programme?: string;
  /** Per-subject grades printed on the slip/transcript (subject → grade). */
  subjects?: Record<string, string>;
  /** Qualification system printed on the academic document (preset default when unset). */
  examSystem?: string;
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
 * Document content templates — simulation data (data/simulation/
 * doc-templates.json), loaded once. `{placeholder}` lines fill from the spec
 * or the template's defaults; a `__SUBJECTS__` line expands to `SUBJECT:
 * grade` lines from spec.subjects or the template's subject default.
 */
interface DocTemplate {
  lines: string[];
  defaults: Record<string, string | number>;
  subjects?: { default: Record<string, string> };
}
interface DocTemplates {
  academic_cert: { bySystem: Record<string, DocTemplate>; default: DocTemplate };
  [type: string]: DocTemplate | DocTemplates["academic_cert"];
}

let cachedTemplates: DocTemplates | null = null;
function docTemplates(): DocTemplates {
  if (!cachedTemplates) {
    const file = path.join(bundledDataDir(), "simulation", "doc-templates.json");
    cachedTemplates = JSON.parse(fs.readFileSync(file, "utf8")) as DocTemplates;
  }
  return cachedTemplates;
}

function fillLine(line: string, spec: DocSpec, defaults: Record<string, string | number>): string {
  return line.replace(/\{(\w+)\}/g, (_m, key: string) => {
    if (key === "year") return spec.year ?? String(defaults.year ?? "2021");
    const value = (spec as unknown as Record<string, string | number | undefined>)[key] ?? defaults[key];
    return value === undefined ? "" : String(value);
  });
}

export function docLines(type: string, spec: DocSpec): string[] {
  const templates = docTemplates();
  let template: DocTemplate | undefined;
  if (type === "academic_cert") {
    const academic = templates.academic_cert;
    const sys = spec.examSystem ?? admissionsPreset().defaultSystem;
    template = academic.bySystem[sys] ?? academic.default;
  } else {
    template = templates[type] as DocTemplate | undefined;
  }
  if (!template) return spec.extraLines ?? [];
  const out: string[] = [];
  for (const line of template.lines) {
    if (line === "__SUBJECTS__") {
      const subjects = spec.subjects ?? template.subjects?.default ?? {};
      for (const [subj, grade] of Object.entries(subjects)) out.push(`${subj}: ${grade}`);
    } else {
      out.push(fillLine(line, spec, template.defaults));
    }
  }
  return [...out, ...(spec.extraLines ?? [])];
}
