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
   * Does this sender put mail on the wire? `false` means every "sent" reply is
   * only RECORDED (no mail connection), which the console must say out loud —
   * an audit trail that claims a send nobody received is worse than no audit
   * trail. Absent (a test double) is treated as "not our business".
   */
  delivers?: boolean;
}

/** Records sends in memory (simulation/tests, and any install with no mail
 *  connection) — nothing is delivered, and it says so. */
export class MockSender implements EmailSender {
  readonly delivers = false;
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

/** The Gemini key the console knows: the organization's stored secret first
 *  (Settings → Connections), the environment second (headless CLIs). */
export function resolveGeminiCredentials(cfg: AppConfig, repo?: Repo): { apiKey: string; model: string } | null {
  const stored = repo?.getSecret("gemini_api_key").trim() || "";
  const apiKey = stored || cfg.geminiApiKey || "";
  if (!apiKey) return null;
  const model = (repo && repo.getSetting("gemini_model", "").trim()) || cfg.geminiModel;
  return { apiKey, model };
}

export function buildAdapters(cfg: AppConfig, sender: EmailSender, repo?: Repo): Adapters {
  const useGemini = cfg.mode === "live" && !!cfg.geminiApiKey;

  // Live vision gets the resilience wrapper: SHA-256 result cache, daily
  // budget and a circuit breaker. Mock mode stays unwrapped (no budget to
  // burn, and tests assert on MockVisionAdapter directly).
  let vision: VisionAdapter = useGemini
    ? new GeminiVisionAdapter(cfg.geminiApiKey!, cfg.geminiModel)
    : new MockVisionAdapter();
  if (useGemini && repo) {
    vision = new BudgetedVisionAdapter(vision, repo.visionCacheStore());
  }

  // Construct the Gemini watcher ONCE — the old lambda re-required the SDK
  // and re-instantiated the model on every single email.
  const watcher: Watcher = useGemini
    ? (() => {
        const w = new GeminiWatcher(cfg.geminiApiKey!, cfg.geminiModel);
        return (input) => w.watch(input);
      })()
    : makeHeuristicWatcher();

  // Classification is a sensor, never a decision-maker: it only runs when the
  // tenant has defined its own category keys AND a key is reachable.
  const credentials = resolveGeminiCredentials(cfg, repo);
  const categorizer = credentials
    ? geminiCategoryLabeler({ apiKey: credentials.apiKey, model: credentials.model })
    : (useGemini ? geminiCategoryLabeler({ apiKey: cfg.geminiApiKey!, model: cfg.geminiModel }) : undefined);

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
