/**
 * Tier 3: Gemini vision — last resort for documents that beat pdf-parse and
 * Tesseract (bad scans, skewed photos, handwriting). Gemini is a SENSOR
 * here: it reports structured facts; plain code still classifies and the
 * rules engine still decides.
 *
 * MockVisionAdapter keeps tests/simulation deterministic: it returns the
 * sidecar `mockVision` payload attached to simulated attachments (i.e. it
 * simulates what the real model would have read).
 *
 * Round 19 — resilience wrappers:
 *   - VisionUnavailableError distinguishes "the vision model is unavailable"
 *     (timeout / API error / budget / open circuit) from "the document was
 *     read and nothing came back". The pipeline turns the former into an
 *     explicit human-review reason instead of a generic failure.
 *   - BudgetedVisionAdapter adds a SHA-256 result cache (the same bytes are
 *     never paid for twice), a daily call budget, and a circuit breaker that
 *     stops hammering a dead API.
 */
import * as crypto from "crypto";
import type { Attachment, DocType, VisionExtraction } from "../types";
import { DOC_TYPES } from "../types";

export interface VisionAdapter {
  extractDocument(att: Attachment): Promise<VisionExtraction | null>;
}

/** Cached stand-in for "the model read this and found nothing". */
const NULL_MARKER: VisionExtraction = {
  document_type: "unknown",
  text: "__null__",
  fields: {},
  confidence: "low",
};

function isNullMarker(v: VisionExtraction): boolean {
  return v.text === "__null__";
}

/** A cache row must at least smell like a VisionExtraction or it's a miss. */
export function isValidCachedVision(v: unknown): v is VisionExtraction {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as any).document_type === "string" &&
    typeof (v as any).text === "string" &&
    ["high", "medium", "low"].includes((v as any).confidence) &&
    typeof (v as any).fields === "object" &&
    (v as any).fields !== null
  );
}

/** Why the vision tier could not run — surfaced verbatim to staff. */
export type VisionFailureKind = "timeout" | "api" | "budget" | "circuit";

export class VisionUnavailableError extends Error {
  kind: VisionFailureKind;
  constructor(kind: VisionFailureKind, message: string) {
    super(message);
    this.kind = kind;
    this.name = "VisionUnavailableError";
  }
}

/** Persistence behind the vision cache + daily budget (repo implements). */
export interface VisionCacheStore {
  get(sha256: string): VisionExtraction | null;
  set(sha256: string, result: VisionExtraction): void;
  /** Paid vision calls made today (UTC day). */
  callsToday(): number;
  noteCall(): void;
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
    "subjectGrades": {"English": "B-", "Mathematics": "C+"},
    "idNumber": "national ID number or null"
  },
  "confidence": "high" | "medium" | "low"
}
"subjectGrades" lists every subject grade visible on the document; use {} when none are shown.`;

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
    } catch (e) {
      const msg = (e as Error)?.message || String(e);
      if (/timed out/i.test(msg)) throw new VisionUnavailableError("timeout", `Vision model timed out (${VISION_TIMEOUT_MS / 1000}s)`);
      throw new VisionUnavailableError("api", `Vision model call failed: ${msg.slice(0, 200)}`);
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


/**
 * Wraps any VisionAdapter with a content-hash cache, a daily call budget and
 * a circuit breaker. Cache hits never consume budget. A parsed-null response
 * is also cached (the model saw it and read nothing — re-asking costs money
 * for the same answer).
 */
export class BudgetedVisionAdapter implements VisionAdapter {
  constructor(
    private inner: VisionAdapter,
    private store: VisionCacheStore,
    private dailyBudget: number = Number(process.env.GEMINI_DAILY_BUDGET || 100),
    private circuitThreshold = 3,
    private circuitCooldownMs = 5 * 60_000
  ) {}

  private consecutiveFailures = 0;
  private circuitOpenedAt: number | null = null;

  circuitState(): { open: boolean; failures: number } {
    return { open: this.isCircuitOpen(), failures: this.consecutiveFailures };
  }

  private isCircuitOpen(): boolean {
    if (this.circuitOpenedAt === null) return false;
    if (Date.now() - this.circuitOpenedAt >= this.circuitCooldownMs) {
      // Half-open: allow one probe through.
      this.circuitOpenedAt = null;
      this.consecutiveFailures = 0;
      return false;
    }
    return true;
  }

  async extractDocument(att: Attachment): Promise<VisionExtraction | null> {
    const sha = crypto.createHash("sha256").update(att.content).digest("hex");

    // 1 — cache first: identical bytes were already read (or already read
    //     as nothing). Zero cost, zero API risk. A cached NULL is replayed
    //     as null — provenance must be identical on first read and replay.
    const cached = this.store.get(sha);
    if (cached) return isNullMarker(cached) ? null : cached;

    // 2 — budget: refuse to overspend; the document goes to a human.
    if (this.store.callsToday() >= this.dailyBudget) {
      throw new VisionUnavailableError(
        "budget",
        `Daily vision-model budget exhausted (${this.dailyBudget} calls) — document queued for human review`
      );
    }

    // 3 — circuit: don't hammer an API that keeps failing.
    if (this.isCircuitOpen()) {
      throw new VisionUnavailableError(
        "circuit",
        "Vision model unavailable (circuit open after repeated failures) — document queued for human review"
      );
    }

    try {
      this.store.noteCall();
      const v = await this.inner.extractDocument(att);
      this.consecutiveFailures = 0;
      // Cache BOTH outcomes: a reading, and a confirmed "read as nothing"
      // (stored as a marker so the replay returns the same null).
      this.store.set(sha, v ?? NULL_MARKER);
      return v;
    } catch (e) {
      if (e instanceof VisionUnavailableError) {
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= this.circuitThreshold && this.circuitOpenedAt === null) {
          this.circuitOpenedAt = Date.now();
        }
      }
      throw e;
    }
  }
}
