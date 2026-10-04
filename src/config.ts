/**
 * Configuration. Everything external (Gemini, Gmail) is optional: without
 * credentials the system runs in mock mode (tests, simulation, demo).
 */
import { DEFAULT_INTAKE_HOTWORDS } from "./intake";
import { envInt } from "./util/envnum";
import { DEFAULT_GEMINI_MODEL } from "./extraction/gemini";
import * as dotenv from "dotenv";

dotenv.config();

export interface AppConfig {
  mode: "mock" | "live";
  dbPath: string;
  port: number;
  geminiModel: string;
  gmail?: {
    address: string;
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    /** Gmail label to watch instead of the inbox (optional). */
    label?: string;
  };
  ingestLookbackDays: number;
  disableOcr: boolean;
  logToFile: boolean;
  /** Factual auto-replies (receipt/missing-docs/status). Never decisions. */
  autoMissingDocsEmails: boolean;
  autoStatusAnswers: boolean;
}

export function loadConfig(): AppConfig {
  const env = process.env;
  const mode = env.MODE === "live" ? "live" : "mock";
  const gmailConfigured =
    !!env.GMAIL_ADDRESS &&
    !!env.GMAIL_OAUTH_CLIENT_ID &&
    !!env.GMAIL_OAUTH_CLIENT_SECRET &&
    !!env.GMAIL_OAUTH_REFRESH_TOKEN;

  return {
    mode,
    dbPath: env.DB_PATH || "./data/email-sorter.sqlite",
    port: envInt(env.PORT, 8080),
    geminiModel: env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
    gmail: gmailConfigured
      ? {
          address: env.GMAIL_ADDRESS!,
          clientId: env.GMAIL_OAUTH_CLIENT_ID!,
          clientSecret: env.GMAIL_OAUTH_CLIENT_SECRET!,
          refreshToken: env.GMAIL_OAUTH_REFRESH_TOKEN!,
          label: env.GMAIL_LABEL || undefined,
        }
      : undefined,
    // A two-day default silently hid older applications. Settings can still
    // override this per deployment, but a fresh server starts with a useful
    // two-week history window (the web UI can backfill 30/90/365 days).
    ingestLookbackDays: envInt(env.INGEST_LOOKBACK_DAYS, 14),
    disableOcr: env.DISABLE_OCR === "1",
    logToFile: env.LOG_TO_FILE !== "0",
    autoMissingDocsEmails: env.AUTO_MISSING_DOCS_EMAILS !== "0",
    autoStatusAnswers: env.AUTO_STATUS_ANSWERS !== "0",
  };
}

/** Process-wide operational defaults; no tenant or workflow is configured on boot. */
export const DEFAULT_SETTINGS: Record<string, string> = {
  institution_name: "Organization",
  sla_target_hours: "4",
  escalation_hours: "8",
  // v3
  unanswered_target_hours: "4", // unanswered-email panel threshold
  followup_ladder_days: "3,7,10", // Day 3 reminder, Day 7 final, Day 10 → human
  retention_days: "730", // completed cases kept 2 years, then archived+removed
  automation_mode: "draft", // 'draft' holds EVERY automated reply for approval
  intake_hotwords: DEFAULT_INTAKE_HOTWORDS, // round 9: which emails become cases
};
// NOTE: the sender display name is NOT a setting — it lives on the
// organization row (`organizations.from_name`) and is applied to the MIME
// of every outgoing message (PPR P1-5). The old dead `from_name` setting
// is migrated there and then removed.
