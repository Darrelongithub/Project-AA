/**
 * Tier 3: Gemini vision — last resort for documents that beat pdf-parse and
 * Tesseract (bad scans, skewed photos, handwriting). Gemini is a SENSOR
 * here: it reports structured facts; plain code still classifies and the
 * rules engine still decides.
 *
 * MockVisionAdapter keeps tests/simulation deterministic: it returns the
 * sidecar `mockVision` payload attached to simulated attachments (i.e. it
 * simulates what the real model would have read).
 */
import type { Attachment, DocType, VisionExtraction } from "../types";
import { DOC_TYPES } from "../types";

export interface VisionAdapter {
  extractDocument(att: Attachment): Promise<VisionExtraction | null>;
}

export function parseVisionJson(raw: string): VisionExtraction | null {
  try {
    let s = (raw || "").trim();
    s = s.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    const obj = JSON.parse(s.slice(start, end + 1));
    const type: DocType = DOC_TYPES.includes(obj.document_type) ? obj.document_type : "unknown";
    const conf = ["high", "medium", "low"].includes(obj.confidence) ? obj.confidence : "low";
    return {
      document_type: type,
      text: typeof obj.text === "string" ? obj.text : "",
      fields: obj.fields && typeof obj.fields === "object" ? obj.fields : {},
      confidence: conf,
    };
  } catch {
    return null;
  }
}

const VISION_PROMPT = `You are a document reader for an admissions intake system.
Examine the attached document and report what you can read.
Respond with ONLY a JSON object, no markdown, in exactly this shape:
{
  "document_type": one of "academic_cert" | "id" | "kcpe_cert" | "birth_cert" | "application_form" | "unknown",
  "text": "the text visible on the document, as faithfully as you can read it",
  "fields": {
    "name": "full name on the document or null",
    "gradePoints": <number 100-500 if an exam score/points total is shown, else null>,
    "meanGrade": "letter mean grade e.g. B- or null",
    "subjectGrades": {"English": "B-", "Mathematics": "C+"} — every subject grade visible on the document, or {},
    "idNumber": "national ID number or null"
  },
  "confidence": "high" | "medium" | "low"
}`;

/** A hung vision call must never stall the pipeline forever. */
const VISION_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 60_000);

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

export class GeminiVisionAdapter implements VisionAdapter {
  private model: any;

  constructor(apiKey: string, modelName = "gemini-1.5-flash") {
    // Lazy require so mock mode never needs the SDK at runtime. A missing
    // SDK is a configuration error — say so loudly instead of throwing an
    // opaque MODULE_NOT_FOUND deep in request handling.
    let GoogleGenerativeAI: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      ({ GoogleGenerativeAI } = require("@google/generative-ai"));
    } catch (e) {
      throw new Error(
        `GEMINI_API_KEY is set but the @google/generative-ai SDK failed to load: ${(e as Error).message}`
      );
    }
    const gen = new GoogleGenerativeAI(apiKey);
    this.model = gen.getGenerativeModel({ model: modelName });
  }

  async extractDocument(att: Attachment): Promise<VisionExtraction | null> {
    try {
      const res: any = await withTimeout(
        this.model.generateContent([
          VISION_PROMPT,
          {
            inlineData: {
              mimeType: att.mimeType || "application/pdf",
              data: att.content.toString("base64"),
            },
          },
        ]),
        VISION_TIMEOUT_MS,
        "gemini vision call"
      );
      return parseVisionJson(res.response.text());
    } catch {
      return null;
    }
  }

  /** Settings-page key test: one real API round-trip that THROWS on failure. */
  async probeKey(): Promise<void> {
    const res: any = await withTimeout(
      this.model.generateContent("Reply with the single word OK."),
      VISION_TIMEOUT_MS,
      "gemini key test"
    );
    const text = String(res?.response?.text() ?? "");
    if (!text.trim()) throw new Error("Gemini returned an empty response");
  }
}

export class MockVisionAdapter implements VisionAdapter {
  /**
   * Attachments without a sidecar hint are treated as unreadable → null,
   * which sends them down the documented total-failure path (method "none").
   * (Previously returned a fake "unknown" object, which downstream labeled
   * as gemini_vision — the comment above promised this behavior; now it
   * actually happens.)
   */
  async extractDocument(att: Attachment): Promise<VisionExtraction | null> {
    return att.mockVision ?? null;
  }
}
