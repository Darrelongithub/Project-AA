/**
 * Configuration. Everything external (Gemini, Gmail) is optional: without
 * credentials the system runs in mock mode (tests, simulation, demo).
 */
import * as dotenv from "dotenv";

dotenv.config();

export interface AppConfig {
  mode: "mock" | "live";
  dbPath: string;
  port: number;
  geminiApiKey?: string;
  geminiModel: string;
  gmail?: {
    address: string;
    clientId: string;
    clientSecret: string;
    refreshToken: string;
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
    port: Number(env.PORT || 8080),
    geminiApiKey: env.GEMINI_API_KEY || undefined,
    geminiModel: env.GEMINI_MODEL || "gemini-1.5-flash",
    gmail: gmailConfigured
      ? {
          address: env.GMAIL_ADDRESS!,
          clientId: env.GMAIL_OAUTH_CLIENT_ID!,
          clientSecret: env.GMAIL_OAUTH_CLIENT_SECRET!,
          refreshToken: env.GMAIL_OAUTH_REFRESH_TOKEN!,
        }
      : undefined,
    ingestLookbackDays: Number(env.INGEST_LOOKBACK_DAYS || 2),
    disableOcr: env.DISABLE_OCR === "1",
    logToFile: env.LOG_TO_FILE !== "0",
    autoMissingDocsEmails: env.AUTO_MISSING_DOCS_EMAILS !== "0",
    autoStatusAnswers: env.AUTO_STATUS_ANSWERS !== "0",
  };
}

/** Default (base) requirement set — overridden by programme/intake rules. */
export const DEFAULT_REQUIREMENTS = [
  { document_type: "academic_cert" as const, required: true, minGradePoints: null },
  { document_type: "kcpe_cert" as const, required: true, minGradePoints: 250 },
  { document_type: "id" as const, required: true, minGradePoints: null },
  { document_type: "application_form" as const, required: true, minGradePoints: null },
  { document_type: "birth_cert" as const, required: false, minGradePoints: null },
];

/** Seed data for programmes and intakes (editable in Settings). */
export const DEFAULT_PROGRAMMES = [
  { code: "BCS", name: "BSc Computer Science" },
  { code: "BBIT", name: "Bachelor of Business Information Technology" },
  { code: "LAW", name: "Bachelor of Laws (LLB)" },
  { code: "NUR", name: "Bachelor of Science in Nursing" },
];

export const DEFAULT_INTAKES = ["September 2026", "January 2027"];

/** Default SLA / institution settings (editable in Settings). */
export const DEFAULT_SETTINGS: Record<string, string> = {
  institution_name: "Riara University",
  ref_prefix: "RU",
  sla_target_hours: "4",
  escalation_hours: "8",
  from_name: "Riara University Admissions",
  // v3
  unanswered_target_hours: "4", // unanswered-email panel threshold
  followup_ladder_days: "3,7,10", // Day 3 reminder, Day 7 final, Day 10 → human
  retention_days: "730", // completed cases kept 2 years, then archived+removed
  automation_mode: "auto", // 'draft' holds EVERY automated reply for approval
  portal_otp_delivery: "screen", // 'email' sends the OTP via the configured sender
};
