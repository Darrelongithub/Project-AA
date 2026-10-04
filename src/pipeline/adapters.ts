/**
 * External-world adapters. Everything with network credentials lives behind
 * these interfaces so the core pipeline is testable without any of them.
 */
import type { Repo } from "../db/repo";
import type { VisionAdapter } from "../extraction/gemini";
import { geminiCategoryLabeler, type CategoryLabeler } from "../categorize";
import type { Watcher } from "../watcher";
import type { AppConfig } from "../config";
import { BudgetedVisionAdapter, GeminiVisionAdapter, MockVisionAdapter } from "../extraction/gemini";

export { MockVisionAdapter };
import { GeminiWatcher, makeHeuristicWatcher } from "../watcher";
import { ocrImage } from "../extraction/ocr";

/** Optional extras on an outgoing email: the changeable banner and PDF packs. */
export interface SendExtras {
  attachments?: Array<{ filename: string; mimeType: string; content: Buffer }>;
  banner?: { mime: string; base64: string } | null;
  /** Organization sender identity (PPR P1-5) — applied to the MIME headers. */
  fromName?: string | null;
  fromAddress?: string | null;
  replyTo?: string | null;
}

export interface EmailSender {
  send(to: string, subject: string, body: string, threadId: string, extras?: SendExtras): Promise<void>;
  /**
   * Does this sender put mail on the wire? `false` means delivery is
   * unavailable: callers must not persist a successful send and should retain
   * the reply as a draft. Absent (a test double) is treated as "not our
   * business" and keeps the legacy assumed-success test behavior.
   */
  delivers?: boolean;
}

/** Records send attempts in memory. By default it simulates an offline install;
 *  pass `true` in tests that need to model a delivering sender. */
export class MockSender implements EmailSender {
  readonly delivers: boolean;
  constructor(delivers = false) { this.delivers = delivers; }
  sent: Array<{ to: string; subject: string; body: string; threadId: string; attachments: string[]; banner: boolean; fromName: string | null; replyTo: string | null }> = [];
  async send(to: string, subject: string, body: string, threadId: string, extras?: SendExtras): Promise<void> {
    this.sent.push({
      to, subject, body, threadId,
      attachments: (extras?.attachments ?? []).map((a) => a.filename),
      banner: Boolean(extras?.banner),
      fromName: extras?.fromName ?? null,
      replyTo: extras?.replyTo ?? null,
    });
  }
}

export interface Adapters {
  vision: VisionAdapter;
  watcher: Watcher;
  sender: EmailSender;
  ocr?: (image: Buffer, ext?: "png" | "jpg") => Promise<string | null>;
  /** Labels an incoming message with ONE of the tenant's own category keys.
   *  Absent when no Gemini key is reachable — classification then stays
   *  deterministic. */
  categorizer?: CategoryLabeler;
}

/** Gemini credentials are read only from the installation's secret store
 *  (Settings → Connections); environment variables never supply the API key. */
export function resolveGeminiCredentials(cfg: AppConfig, repo?: Repo): { apiKey: string; model: string } | null {
  const apiKey = repo?.getSecret("gemini_api_key").trim() || "";
  if (!apiKey) return null;
  const model = (repo && repo.getSetting("gemini_model", "").trim()) || cfg.geminiModel;
  return { apiKey, model };
}

export function buildAdapters(cfg: AppConfig, sender: EmailSender, repo?: Repo): Adapters {
  const credentials = resolveGeminiCredentials(cfg, repo);
  const useGemini = cfg.mode === "live" && credentials !== null;
  const geminiModel = credentials?.model ?? cfg.geminiModel;

  // Live vision gets the resilience wrapper: SHA-256 result cache, daily
  // budget and a circuit breaker. Mock mode stays unwrapped (no budget to
  // burn, and tests assert on MockVisionAdapter directly).
  let vision: VisionAdapter = useGemini
    ? new GeminiVisionAdapter(credentials!.apiKey, geminiModel)
    : new MockVisionAdapter();
  if (useGemini && repo) {
    vision = new BudgetedVisionAdapter(vision, repo.visionCacheStore());
  }

  // Construct the Gemini watcher ONCE — the old lambda re-required the SDK
  // and re-instantiated the model on every single email.
  const watcher: Watcher = useGemini
    ? (() => {
        const w = new GeminiWatcher(credentials!.apiKey, geminiModel);
        return (input) => w.watch(input);
      })()
    : makeHeuristicWatcher();

  // Classification is a sensor, never a decision-maker: it only runs when the
  // tenant has defined its own category keys AND a stored secret is available.
  const categorizer = credentials
    ? geminiCategoryLabeler({ apiKey: credentials.apiKey, model: credentials.model })
    : undefined;

  return {
    vision,
    watcher,
    sender,
    ocr: cfg.disableOcr ? undefined : ocrImage,
    categorizer,
  };
}

export interface PipelineContext {
  repo: Repo;
  adapters: Adapters;
  /** path for the JSONL mirror of decision logs; undefined disables it */
  jsonlPath?: string;
}
