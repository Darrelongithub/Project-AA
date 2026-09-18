/**
 * The extraction fallback chain — FIXED LOGIC, not a judgment call:
 *
 *   pdfjs text layer → Tesseract on embedded images → full-page rasterise
 *   (free)             (free)                          + Tesseract (free)
 *                                       → Gemini vision (last resort)
 *
 * Each tier's output is quality-checked (against thresholds that fit the
 * document TYPE) before it is accepted. Code (not AI) does the final
 * document-type classification and field parsing; a vision model's own type
 * guess is only used when the code classifier is stumped, and then at
 * reduced confidence.
 *
 * Round 19 — CONFIDENCE v2. The score is no longer "how nice the text
 * looks". It answers the real question — can we TRUST this document?
 *   1. field quality   — did we actually read the facts this document exists
 *                        to carry (mean grade, points, name, DOB, ID)?
 *   2. accuracy        — were the facts read from a native text layer or a
 *                        real OCR pass rather than a vision-model guess?
 *   3. forgery resistance — native text layers on official formats are far
 *                        harder to fake than a vision reading of a photo.
 * Cross-document name/DOB consistency is applied by the pipeline (it needs
 * the whole file, not one attachment).
 */
import * as crypto from "crypto";
import type { Attachment, Confidence, DocType, ExtractionResult, ExtractedFields } from "../types";
import { classifyDocumentType } from "./classify";
import { extractFields } from "./fields";
import { isGoodText, assessTextQuality, thresholdsFor } from "./quality";
import { pdfRead } from "./pdfText";
import { extractPdfImages } from "./pdfImages";
import { rasterizePdf, preprocessImage, RASTER_DEFAULTS } from "./rasterize";
import type { VisionAdapter } from "./gemini";
import { VisionUnavailableError } from "./gemini";
import { log } from "../util/log";

export interface ExtractDeps {
  vision: VisionAdapter;
  /** OCR tier; pass undefined to disable (e.g. DISABLE_OCR=1). */
  ocr?: (image: Buffer, ext?: "png" | "jpg") => Promise<string | null>;
  /** Set false to skip the rasterise tier (tests). Default on. */
  rasterize?: boolean;
}

/**
 * The numeric confidence gate. A document must score at or above this to
 * count toward an automatic (no-human) pass; below it the case stays with a
 * reviewer.
 */
export const MIN_AUTO_PASS_SCORE = 75;

/**
 * Text-quality sub-score (0-100). Kept anchored to the confidence tier so
 * the legacy contract holds: high ⇒ ≥75, medium ⇒ 55–74, low ⇒ ≤45.
 * This is ONE input to confidence v2 — not the whole answer any more.
 */
export function readabilityScore(confidence: Confidence, text: string): number {
  const trimmed = (text || "").trim();
  if (!trimmed) return confidence === "high" ? 85 : confidence === "medium" ? 60 : 20;
  const q = assessTextQuality(text);
  const lengthSat = Math.min(1, q.length / 400);
  const vocabSat = Math.min(1, q.distinctWords / 25);
  let score = Math.round(100 * (0.5 * q.letterRatio + 0.3 * lengthSat + 0.2 * vocabSat));
  if (q.maxRepeatRun > 20) score = Math.min(score, 40);
  if (confidence === "high") score = Math.max(score, 85);
  else if (confidence === "medium") score = Math.min(Math.max(score, 55), 74);
  else score = Math.min(score, 45);
  return Math.max(5, Math.min(100, score));
}

// ── Confidence v2 ────────────────────────────────────────────────────────────

/** How trustworthy is the way this text was obtained? (forgery resistance) */
const METHOD_SCORE: Record<ExtractionResult["method"], number> = {
  pdf_text: 95, // native text layer — structure must really be there
  ocr: 70, // real OCR pass; pixel-level, but mechanical
  pdf_raster: 68, // same, after rendering pages first
  gemini_vision: 50, // model reading: occasionally inventive
  none: 0,
};

/**
 * Field-quality sub-score: did we read the facts this document type exists
 * to carry? A birth certificate with no name is useless no matter how clean
 * the OCR was.
 */
export function fieldScore(fields: ExtractedFields, docType: DocType): number {
  const f = fields || {};
  const hasName = Boolean(f.name);
  const hasAcademic = Boolean(
    f.meanGrade || f.gradePoints || f.ibPoints || f.credits || f.principals ||
    f.classAwarded || f.gpa ||
    (f.subjectGrades && Object.keys(f.subjectGrades as object).length > 0)
  );
  switch (docType) {
    case "academic_cert": {
      let s = 0;
      if (hasAcademic) s += 55;
      if (f.subjectGrades && Object.keys(f.subjectGrades as object).length >= 3) s += 15;
      else if (f.subjectGrades) s += 8;
      if (hasName) s += 20;
      if (f.examSystem) s += 10;
      return s;
    }
    case "kcpe_cert": {
      let s = 0;
      if (f.gradePoints) s += 50;
      if (hasName) s += 35;
      if (f.examYear) s += 15;
      return s;
    }
    case "birth_cert": {
      let s = 0;
      if (hasName) s += 60;
      if (f.dateOfBirth) s += 40;
      return s;
    }
    case "id": {
      let s = 0;
      if (hasName) s += 45;
      if (f.idNumber) s += 45;
      if (f.dateOfBirth) s += 10;
      return s;
    }
    case "application_form":
    case "credit_transfer_form":
      return hasName ? 80 : 20;
    default:
      return 10; // unknown type: fields alone can't earn trust
  }
}

export interface ConfidenceInput {
  text: string;
  fields: ExtractedFields;
  docType: DocType;
  method: ExtractionResult["method"];
  /** Tier the text came from: pdf_text high, OCR medium, vision as reported. */
  tier: Confidence;
}

export interface ConfidenceVerdict {
  confidence: Confidence;
  score: number;
  /** Human-readable reasons the score is what it is. */
  reasons: string[];
}

/**
 * Confidence v2: weighted blend of text quality, field presence and method
 * trust, capped when the document type is unknown (a doc we can't even
 * place never auto-passes).
 */
export function computeConfidence(input: ConfidenceInput): ConfidenceVerdict {
  const reasons: string[] = [];
  const textScore = readabilityScore(input.tier, input.text);
  const fScore = fieldScore(input.fields, input.docType);
  const mScore = METHOD_SCORE[input.method] ?? 0;

  let score = Math.round(0.4 * textScore + 0.45 * fScore + 0.15 * mScore);
  reasons.push(`text quality ${textScore}/100, critical fields ${fScore}/100, extraction method ${mScore}/100`);

  if (input.docType === "unknown") {
    if (score > 45) {
      reasons.push("document type not identified — capped at 45 until a human classifies it");
    }
    score = Math.min(score, 45);
  }
  if (input.method === "gemini_vision" && score > 74) {
    // A vision-model reading, however fluent, is the easiest tier to fool
    // and the one that can hallucinate fields. It earns trust only after a
    // human confirms — so it can never auto-pass on its own.
    reasons.push("vision-model reading held below the auto-pass line pending human confirmation");
    score = 74;
  }
  if (input.docType === "academic_cert" && !input.fields?.examSystem && fScore < 55) {
    reasons.push("qualification system not identified on results document");
  }

  const confidence: Confidence = score >= MIN_AUTO_PASS_SCORE ? "high" : score >= 45 ? "medium" : "low";
  return { confidence, score: Math.max(5, Math.min(100, score)), reasons };
}

function finish(
  filename: string,
  text: string,
  method: ExtractionResult["method"],
  tier: Confidence,
  note?: string
): Omit<ExtractionResult, "sha256"> {
  const document_type = classifyDocumentType(text);
  const fields = extractFields(text);
  const verdict = computeConfidence({ text, fields, docType: document_type, method, tier });
  return {
    filename,
    document_type,
    method,
    text,
    fields,
    confidence: verdict.confidence,
    confidence_score: verdict.score,
    failure_reason: note ?? null,
  };
}

/**
 * Hard cap on attachment size, same as the portal upload limit. Oversized
 * files are recorded as unreadable so a human sees them; they are never fed
 * to the heavy tiers.
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

function unreadable(
  filename: string,
  sha256: string,
  reason: string,
  score = 15
): ExtractionResult {
  return {
    filename,
    document_type: "unknown",
    method: "none",
    text: "",
    fields: {},
    confidence: "low",
    confidence_score: score,
    failure_reason: reason,
    sha256,
  };
}

export async function extractAttachment(
  att: Attachment,
  deps: ExtractDeps
): Promise<ExtractionResult> {
  const sha256 = crypto.createHash("sha256").update(att.content).digest("hex");

  if (att.content.length > MAX_ATTACHMENT_BYTES) {
    log(
      `extraction: ${att.filename} rejected — ${(att.content.length / 1024 / 1024).toFixed(1)} MB exceeds the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB cap`,
      "warn"
    );
    return unreadable(
      att.filename,
      sha256,
      `File is larger than the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB limit — please re-send a smaller scan.`
    );
  }

  const isPdf =
    att.mimeType === "application/pdf" || /\.pdf$/i.test(att.filename);
  const isImage = /^image\/(png|jpe?g|tiff?)$/i.test(att.mimeType);

  if (isPdf) {
    // ── Inspect first: WHY a PDF fails matters ───────────────────────────
    const { text: rawText, inspection } = await pdfRead(att.content);
    if (inspection.status === "encrypted") {
      log(`extraction: ${att.filename} is password-protected`, "warn");
      return unreadable(
        att.filename,
        sha256,
        "The PDF is password-protected. Please remove the password and send it again."
      );
    }
    if (inspection.status === "corrupt") {
      log(`extraction: ${att.filename} is corrupt (${inspection.error})`, "warn");
      return unreadable(
        att.filename,
        sha256,
        "The file appears to be damaged or incomplete. Please re-export the PDF and send it again."
      );
    }
    if (inspection.status === "empty") {
      log(`extraction: ${att.filename} contains no pages`, "warn");
      return unreadable(
        att.filename,
        sha256,
        "The PDF has no readable pages. Please re-scan the document and send it again."
      );
    }
    const truncNote = inspection.truncated
      ? `Only the first 25 of ${inspection.numPages} pages were read.`
      : undefined;
    if (truncNote) log(`extraction: ${att.filename} — ${truncNote}`, "warn");

    // ── Tier 1: embedded text layer ──────────────────────────────────────
    if (rawText) {
      const t1Type = classifyDocumentType(rawText);
      if (isGoodText(rawText, t1Type)) {
        log(`extraction: ${att.filename} → embedded text layer (high confidence)`);
        return { ...finish(att.filename, rawText, "pdf_text", "high", truncNote), sha256 };
      }
    }

    // ── Tier 2: OCR on embedded images ───────────────────────────────────
    if (deps.ocr) {
      const images = extractPdfImages(att.content);
      const parts: string[] = [];
      for (const img of images) {
        const t = await deps.ocr(img.buffer, img.kind === "jpeg" ? "jpg" : "png");
        if (t) parts.push(t);
      }
      const joined = parts.join("\n");
      if (joined && isGoodText(joined, classifyDocumentType(joined))) {
        log(`extraction: ${att.filename} → Tesseract OCR on embedded images`);
        return { ...finish(att.filename, joined, "ocr", "medium", truncNote), sha256 };
      }
      if (images.length === 0) {
        log(`extraction: ${att.filename} → no usable embedded images found for OCR`);
      } else {
        log(`extraction: ${att.filename} → embedded-image OCR failed quality check`);
      }
    }

    // ── Tier 2½: full-page rasterisation ─────────────────────────────────
    // Phone "Scan" apps wrap images in PDFs with exotic filters; 16-bit
    // scans and JPX/JBIG2 XObjects are skipped above. Rendering the pages
    // ourselves gives Tesseract clean PNGs to read. Pages stream through
    // one at a time (OCR → discard) so memory holds a single page.
    if (deps.ocr && deps.rasterize !== false) {
      try {
        const ocr = deps.ocr;
        const parts: string[] = [];
        const report = await rasterizePdf(
          att.content,
          { maxPages: Math.min(RASTER_DEFAULTS.maxPages, inspection.numPages || RASTER_DEFAULTS.maxPages) },
          async (pg) => {
            const t = await ocr(pg.buffer, "png");
            if (t) parts.push(t);
          }
        );
        const joined = parts.join("\n");
        if (joined && isGoodText(joined, classifyDocumentType(joined))) {
          log(`extraction: ${att.filename} → rasterised ${report.rendered} page(s) + Tesseract OCR`);
          const notes: string[] = [];
          if (truncNote) notes.push(truncNote);
          else if (report.overCap > 0) {
            notes.push(`Rendered ${report.rendered} of ${inspection.numPages} pages (per-document page limit).`);
          } else if (report.rendered < inspection.numPages) {
            notes.push(`Rendered ${report.rendered} of ${inspection.numPages} pages.`);
          }
          if (report.skipped > 0) notes.push(`${report.skipped} page(s) were too large to render.`);
          if (report.timedOut) notes.push("Rendering stopped at the time limit; later pages were not read.");
          return { ...finish(att.filename, joined, "pdf_raster", "medium", notes.length ? notes.join(" ") : undefined), sha256 };
        }
      } catch (e) {
        log(`extraction: rasterise failed for ${att.filename}: ${(e as Error).message}`);
      }
    }
  } else if (isImage && deps.ocr) {
    // Image attachments: EXIF-rotate first (sideways phone shots of IDs),
    // then OCR.
    const prep = await preprocessImage(att.content);
    const t = await deps.ocr(prep ?? att.content, "png");
    if (t && isGoodText(t, classifyDocumentType(t))) {
      log(`extraction: ${att.filename} → Tesseract OCR on image (medium confidence)`);
      const screenshotNote = /screen\s?shot|screen\s?capture|screencap/i.test(att.filename)
        ? "This looks like a screenshot. Where possible, please send the official document as a PDF or a photo of the paper original."
        : undefined;
      return { ...finish(att.filename, t, "ocr", "medium", screenshotNote), sha256 };
    }
  }

  // ── Tier 3: Gemini vision ──────────────────────────────────────────────
  let visionError: VisionUnavailableError | null = null;
  let v: Awaited<ReturnType<VisionAdapter["extractDocument"]>> = null;
  try {
    v = await deps.vision.extractDocument(att);
  } catch (e) {
    if (e instanceof VisionUnavailableError) visionError = e;
    else throw e;
  }
  if (v) {
    // Code classifies; the model's guess is a fallback signal only.
    const codeType: DocType = classifyDocumentType(v.text || "");
    const document_type = codeType !== "unknown" ? codeType : v.document_type;
    let tier: Confidence = v.confidence;
    if (codeType === "unknown" && document_type !== "unknown") tier = "low";
    const fields: ExtractedFields = { ...v.fields, ...extractFields(v.text || "") };
    const verdict = computeConfidence({
      text: v.text || "",
      fields,
      docType: document_type,
      method: "gemini_vision",
      tier,
    });
    log(`extraction: ${att.filename} → Gemini vision (${verdict.confidence} confidence, score ${verdict.score})`);
    return {
      filename: att.filename,
      document_type,
      method: "gemini_vision",
      text: v.text || "",
      fields,
      confidence: verdict.confidence,
      confidence_score: verdict.score,
      failure_reason: null,
      sha256,
    };
  }

  // Nothing read it. Record WHY — a vision outage is a different situation
  // from an unreadable document, and the pipeline tells staff which one.
  if (visionError) {
    log(`extraction: ${att.filename} → vision model unavailable (${visionError.kind}: ${visionError.message})`, "warn");
    return unreadable(att.filename, sha256, `Vision model unavailable (${visionError.kind}). The document is preserved for human review.`);
  }
  log(`extraction: ${att.filename} → unreadable by all tiers`, "warn");
  const handwrittenHint = !isPdf
    ? " It may be handwritten, blurred, or a photo of a screen — a clear scan of the original will help."
    : "";
  return unreadable(
    att.filename,
    sha256,
    `The document could not be read automatically.${handwrittenHint} It has been kept for manual review.`
  );
}

export { assessTextQuality, thresholdsFor };
