/**
 * /watcher — one narrow sanity check that runs ONLY when the rules engine
 * returned Green, before any auto-reply is allowed to fire.
 *
 * It never sets Green/Orange/Red by itself: it can only DOWNGRADE a Green
 * verdict (→ Red + a watcher_flag). If it says nothing is off, the rules
 * engine's Green stands.
 *
 * Two implementations behind one interface:
 *   - HeuristicWatcher: deterministic code checks (used in mock mode, and a
 *     reasonable stand-in so the simulation is reproducible).
 *   - GeminiWatcher: the live narrow Gemini call. FAILS CLOSED — if the API
 *     errors or returns garbage, the record is flagged to a human rather
 *     than auto-sent.
 */
import { DEFAULT_GEMINI_MODEL } from "../extraction/gemini";
import type { WatcherInput, WatcherResult } from "../types";
import { normalizeName } from "../rules";

const SUSPICIOUS_RE = /\b(specimen|sample\s+copy|void|not\s+valid|cancelled|draft\s+copy)\b/i;

export function heuristicWatcher(input: WatcherInput): WatcherResult {
  const concerns: string[] = [];

  // 1. Watermarks / markers that suggest a document isn't the real thing.
  for (const d of input.docs) {
    const m = d.textExcerpt.match(SUSPICIOUS_RE);
    if (m) {
      concerns.push(
        `${d.document_type}: text contains "${m[0]}" — possibly a specimen/sample rather than an original`
      );
    }
  }

  // 2. The same file content submitted as two different document types.
  const seen = new Map<string, string>();
  for (const d of input.docs) {
    const norm = d.textExcerpt.replace(/\s+/g, " ").trim().slice(0, 400);
    if (norm.length < 40) continue;
    const prev = seen.get(norm);
    if (prev && prev !== d.document_type) {
      concerns.push(
        `identical content submitted as both ${prev} and ${d.document_type} — possible wrong-file upload`
      );
    } else {
      seen.set(norm, d.document_type);
    }
  }

  // 3. Names disagreeing across documents (belt-and-braces; rules flags too).
  const names = new Set<string>();
  for (const d of input.docs) {
    const n = normalizeName(d.name);
    if (n.length >= 3) names.add(n);
  }
  if (names.size > 1) {
    concerns.push(`names differ across documents: ${[...names].join(" vs ")}`);
  }

  return { flagged: concerns.length > 0, concerns, source: "heuristic" };
}

const WATCHER_PROMPT = `You are a final sanity-checker in an admissions document-intake system.
The deterministic rules engine has marked this applicant file GREEN (complete).
Your ONLY job: look for reasons a human should double-check before an automatic acknowledgement is sent.
Look for: names that don't match across documents, a file that seems to be the wrong document type,
illegible or partial scans, specimen/sample/void markings, duplicate files, or anything else that looks off.
You never decide admissions outcomes. Respond with ONLY a JSON object:
{"looks_off": true|false, "concerns": ["short concern", ...]}`;

/**
 * A Gemini call that never settles must not stall the pipeline forever —
 * the fail-closed catch only fires on REJECTION; a hung socket rejects
 * never. Race the call against a hard timeout. (Timeout default matches
 * the vision tier; constructor override exists for tests.)
 */
const WATCHER_TIMEOUT_MS = 45_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    // An unref'd timer never keeps the process alive on its own.
    if (typeof timer === "object" && timer) (timer as { unref?: () => void }).unref?.();
  });
  return Promise.race([p, expiry]).finally(() => { if (timer) clearTimeout(timer); });
}

export class GeminiWatcher {
  private model: any;
  private timeoutMs: number;

  constructor(apiKey: string, modelName = DEFAULT_GEMINI_MODEL, model?: unknown, timeoutMs = WATCHER_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
    if (model) {
      this.model = model;
    } else {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { GoogleGenerativeAI } = require("@google/generative-ai");
      const gen = new GoogleGenerativeAI(apiKey);
      this.model = gen.getGenerativeModel({ model: modelName });
    }
  }

  async watch(input: WatcherInput): Promise<WatcherResult> {
    try {
      const record = {
        applicant_email: input.applicantEmail,
        subject: input.subject,
        documents: input.docs.map((d) => ({
          document_type: d.document_type,
          extraction_method: d.extraction_method,
          confidence: d.confidence,
          name_on_document: d.name ?? null,
          grade_points: d.gradePoints ?? null,
          text_excerpt: d.textExcerpt,
        })),
      };
      const res: any = await withTimeout<any>(
        this.model.generateContent(WATCHER_PROMPT + "\n\nFILE:\n" + JSON.stringify(record, null, 2)),
        this.timeoutMs,
        "gemini watcher call"
      );
      const raw: string = res.response.text();
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start < 0 || end <= start) throw new Error("watcher returned no JSON");
      const obj = JSON.parse(raw.slice(start, end + 1));
      const concerns = Array.isArray(obj.concerns)
        ? obj.concerns.map((c: unknown) => String(c)).slice(0, 10)
        : [];
      return { flagged: obj.looks_off === true, concerns, source: "gemini" };
    } catch (e) {
      // FAIL CLOSED: an unavailable or incoherent watcher must never let an
      // auto-reply through.
      return {
        flagged: true,
        concerns: [`watcher unavailable or incoherent (${(e as Error).message}) — failing closed to human review`],
        source: "gemini",
      };
    }
  }
}

export type Watcher = (input: WatcherInput) => Promise<WatcherResult>;

export function makeHeuristicWatcher(): Watcher {
  return async (input) => heuristicWatcher(input);
}
