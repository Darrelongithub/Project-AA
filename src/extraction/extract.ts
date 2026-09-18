/**
 * The extraction fallback chain — FIXED LOGIC, not a judgment call:
 *
 *   pdfjs text layer  →  Tesseract OCR  →  Gemini vision
 *   (free)               (free)             (last resort)
 *
 * Each tier's output is quality-checked before it is accepted. Code (not AI)
 * does the final document-type classification and field parsing; a vision
 * model's own type guess is only used when the code classifier is stumped,
 * and then at reduced confidence.
 */
import * as crypto from "crypto";
import type { Attachment, Confidence, DocType, ExtractionResult, ExtractedFields } from "../types";
import { classifyDocumentType } from "./classify";
import { extractFields } from "./fields";
import { isGoodText, assessTextQuality } from "./quality";
import { pdfExtractText } from "./pdfText";
import { extractPdfImages } from "./pdfImages";
import type { VisionAdapter } from "./gemini";
import { log } from "../util/log";

export interface ExtractDeps {
  vision: VisionAdapter;
  /** OCR tier; pass undefined to disable (e.g. DISABLE_OCR=1). */
  ocr?: (image: Buffer, ext?: "png" | "jpg") => Promise<string | null>;
}

/**
 * The numeric PDF readability gate. A document must score at or above this to
 * count toward an automatic (no-human) pass; below it the case stays with a
 * reviewer. The score is anchored to the confidence tier so the two can never
 * disagree: high ⇒ ≥75, medium ⇒ 55–74, low ⇒ ≤45.
 */
export const MIN_AUTO_PASS_SCORE = 75;

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

function finish(
  filename: string,
  text: string,
  method: ExtractionResult["method"],
  confidence: Confidence
): Omit<ExtractionResult, "sha256"> {
  const document_type = classifyDocumentType(text);
  const fields = extractFields(text);
  return {
    filename,
    document_type,
    method,
    text,
    fields,
    // An unrecognised document can never be high-confidence.
    confidence: document_type === "unknown" ? "low" : confidence,
    confidence_score: readabilityScore(document_type === "unknown" ? "low" : confidence, text),
  };
}

/**
 * Hard cap on attachment size, same as the portal upload limit. The portal
 * enforced it but the EMAIL path did not — a mail with several 25 MB
 * attachments would be base64-buffered and then handed to pdfjs/sharp/
 * Tesseract in-process. Oversized files are recorded as unreadable so a
 * human sees them; they are never fed to the heavy tiers.
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

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
    return {
      filename: att.filename,
      document_type: "unknown",
      method: "none",
      text: "",
      fields: {},
      confidence: "low",
      confidence_score: 15,
      sha256,
    };
  }

  const isPdf =
    att.mimeType === "application/pdf" || /\.pdf$/i.test(att.filename);
  const isImage = /^image\/(png|jpe?g|tiff?)$/i.test(att.mimeType);

  if (isPdf) {
    // ── Tier 1: embedded text layer ──────────────────────────────────────
    const text = await pdfExtractText(att.content);
    if (text && isGoodText(text)) {
      log(`extraction: ${att.filename} → embedded text layer (high confidence)`);
      return { ...finish(att.filename, text, "pdf_text", "high"), sha256 };
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
      if (joined && isGoodText(joined)) {
        log(`extraction: ${att.filename} → Tesseract OCR (medium confidence)`);
        return { ...finish(att.filename, joined, "ocr", "medium"), sha256 };
      }
      if (images.length === 0) {
        log(`extraction: ${att.filename} → no embedded images found for OCR`);
      } else {
        log(`extraction: ${att.filename} → OCR output failed quality check`);
      }
    }
  } else if (isImage && deps.ocr) {
    // Image attachments skip straight to OCR.
    const t = await deps.ocr(att.content, /\.jpe?g$/i.test(att.filename) ? "jpg" : "png");
    if (t && isGoodText(t)) {
      log(`extraction: ${att.filename} → Tesseract OCR on image (medium confidence)`);
      return { ...finish(att.filename, t, "ocr", "medium"), sha256 };
    }
  }

  // ── Tier 3: Gemini vision ──────────────────────────────────────────────
  const v = await deps.vision.extractDocument(att);
  if (v) {
    // Code classifies; the model's guess is a fallback signal only.
    const codeType: DocType = classifyDocumentType(v.text || "");
    const document_type = codeType !== "unknown" ? codeType : v.document_type;
    let confidence: Confidence = v.confidence;
    if (codeType === "unknown" && document_type !== "unknown") confidence = "low";
    const fields: ExtractedFields = { ...v.fields, ...extractFields(v.text || "") };
    log(`extraction: ${att.filename} → Gemini vision (${confidence} confidence)`);
    return {
      filename: att.filename,
      document_type,
      method: "gemini_vision",
      text: v.text || "",
      fields,
      confidence,
      confidence_score: readabilityScore(confidence, v.text || ""),
      sha256,
    };
  }

  // Nothing read it. Still record it so a human can see we tried.
  // Method is "none" — logging "gemini_vision" here (as before) lied about
  // provenance in the decision log whenever vision errored or was mocked.
  log(`extraction: ${att.filename} → unreadable by all three tiers`, "warn");
  return {
    filename: att.filename,
    document_type: "unknown",
    method: "none",
    text: "",
    fields: {},
    confidence: "low",
    confidence_score: 15,
    sha256,
  };
}

export { assessTextQuality };
