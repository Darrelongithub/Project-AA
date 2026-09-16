/**
 * `npm run serve` — the staff web console + public status page.
 *
 * In mock mode it runs fully offline (no Gmail/Gemini needed).
 * In live mode with Gmail configured it ALSO polls the inbox every 60s,
 * so new admissions emails flow into the dashboard automatically.
 */
import { loadConfig } from "../config";
import { openDb } from "../db/db";
import { Repo } from "../db/repo";
import { seedDefaults } from "../db/seed";
import { buildAdapters, MockSender, type EmailSender, type PipelineContext } from "../pipeline/adapters";
import { GmailClient } from "../ingestion/gmailClient";
import { ingestNewEmails } from "../ingestion";
import { createApp, runEscalationSweep } from "../web/server";
import { log } from "../util/log";

class GmailSender implements EmailSender {
  constructor(private gmail: GmailClient) {}
  async send(to: string, subject: string, body: string, threadId: string): Promise<void> {
    await this.gmail.sendReply(to, subject, body, threadId);
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const repo = new Repo(openDb(cfg.dbPath));
  seedDefaults(repo, { live: cfg.mode === "live" });

  let sender: EmailSender = new MockSender();
  let gmail: GmailClient | null = null;
  if (cfg.mode === "live" && cfg.gmail) {
    gmail = new GmailClient(cfg.gmail);
    sender = new GmailSender(gmail);
    log("serve: live mode — Gmail ingestion enabled");
  } else {
    log("serve: mock mode (no Gmail/Gemini). Run `npm run demo` first for sample data.");
  }

  const adapters = buildAdapters(cfg, sender);
  const ctx: PipelineContext = { repo, adapters, jsonlPath: cfg.logToFile ? "./logs/decisions.jsonl" : undefined };
  const app = createApp({ repo, ctx });

  const port = cfg.port;
  app.listen(port, "0.0.0.0", () => {
    log(`serve: listening on http://0.0.0.0:${port}`);
    log(`serve: staff login → admin/admin123 (change in Staff settings!)`);
    log(`serve: applicant status page → /status`);
  });

  // Escalation sweep every 5 minutes (feature 29). The window is re-read
  // each sweep so Settings changes apply without a restart.
  setInterval(() => {
    try {
      const escalationHours = Number(repo.getSetting("escalation_hours", "8"));
      runEscalationSweep(repo, escalationHours);
    } catch (e) {
      log(`escalation sweep failed: ${(e as Error).message}`, "error");
    }
  }, 5 * 60_000);

  // Follow-up ladder sweep every 2 minutes (v3 feature 13).
  const { runFollowUpSweep } = await import("../followups");
  setInterval(() => {
    runFollowUpSweep(repo, ctx).catch((e) =>
      log(`followup sweep failed: ${(e as Error).message}`, "error")
    );
  }, 2 * 60_000);

  // Live inbox polling.
  if (gmail) {
    const opts = { autoMissingDocsEmails: cfg.autoMissingDocsEmails, autoStatusAnswers: cfg.autoStatusAnswers };
    const poll = async () => {
      try {
        await ingestNewEmails(gmail, ctx, cfg.ingestLookbackDays, opts);
      } catch (e) {
        log(`ingest poll failed: ${(e as Error).message}`, "error");
      }
    };
    await poll();
    setInterval(poll, 60_000);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
