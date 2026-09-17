/**
 * External-world adapters. Everything with network credentials lives behind
 * these interfaces so the core pipeline is testable without any of them.
 */
import type { Repo } from "../db/repo";
import type { VisionAdapter } from "../extraction/gemini";
import type { Watcher } from "../watcher";
import type { AppConfig } from "../config";
import { GeminiVisionAdapter, MockVisionAdapter } from "../extraction/gemini";

export { MockVisionAdapter };
import { GeminiWatcher, makeHeuristicWatcher } from "../watcher";
import { ocrImage } from "../extraction/ocr";

/** Optional extras on an outgoing email: the changeable banner and PDF packs. */
export interface SendExtras {
  attachments?: Array<{ filename: string; mimeType: string; content: Buffer }>;
  banner?: { mime: string; base64: string } | null;
}

export interface EmailSender {
  send(to: string, subject: string, body: string, threadId: string, extras?: SendExtras): Promise<void>;
}

/** Records sends in memory (simulation/tests) — plus an audit printout. */
export class MockSender implements EmailSender {
  sent: Array<{ to: string; subject: string; body: string; threadId: string; attachments: string[]; banner: boolean }> = [];
  async send(to: string, subject: string, body: string, threadId: string, extras?: SendExtras): Promise<void> {
    this.sent.push({
      to, subject, body, threadId,
      attachments: (extras?.attachments ?? []).map((a) => a.filename),
      banner: Boolean(extras?.banner),
    });
  }
}

export interface Adapters {
  vision: VisionAdapter;
  watcher: Watcher;
  sender: EmailSender;
  ocr?: (image: Buffer, ext?: "png" | "jpg") => Promise<string | null>;
}

export function buildAdapters(cfg: AppConfig, sender: EmailSender): Adapters {
  const useGemini = cfg.mode === "live" && !!cfg.geminiApiKey;

  const vision: VisionAdapter = useGemini
    ? new GeminiVisionAdapter(cfg.geminiApiKey!, cfg.geminiModel)
    : new MockVisionAdapter();

  // Construct the Gemini watcher ONCE — the old lambda re-required the SDK
  // and re-instantiated the model on every single email.
  const watcher: Watcher = useGemini
    ? (() => {
        const w = new GeminiWatcher(cfg.geminiApiKey!, cfg.geminiModel);
        return (input) => w.watch(input);
      })()
    : makeHeuristicWatcher();

  return {
    vision,
    watcher,
    sender,
    ocr: cfg.disableOcr ? undefined : ocrImage,
  };
}

export interface PipelineContext {
  repo: Repo;
  adapters: Adapters;
  /** path for the JSONL mirror of decision logs; undefined disables it */
  jsonlPath?: string;
}
