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
import { buildAdapters, MockSender, type EmailSender, type PipelineContext, type SendExtras } from "../pipeline/adapters";
import { GmailClient } from "../ingestion/gmailClient";
import { GmailSender } from "../ingestion/sender";
import { ingestNewEmails } from "../ingestion";
import { missingGmailCredentials, resolveLookbackDays } from "../ingestion/sync";
import { createApp, runEscalationSweep } from "../web/server";
import { onceAtATime } from "../util/once";
import { log } from "../util/log";

/** Forwards to a swappable inner sender so Gmail can connect without a restart. */
class DelegatingSender implements EmailSender {
  constructor(public inner: EmailSender) {}
  async send(to: string, subject: string, body: string, threadId: string, extras?: SendExtras): Promise<void> {
    await this.inner.send(to, subject, body, threadId, extras);
  }
}

/** Gmail credentials entered in Settings → GmailClient config (or null). */
function gmailFromSettings(repo: Repo): { address: string; clientId: string; clientSecret: string; refreshToken: string } | null {
  const address = repo.getSetting("gmail_address", "");
  const clientId = repo.getSetting("gmail_client_id", "");
  const clientSecret = repo.getSetting("gmail_client_secret", "");
  const refreshToken = repo.getSetting("gmail_refresh_token", "");
  return address && clientId && clientSecret && refreshToken
    ? { address, clientId, clientSecret, refreshToken }
    : null;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const repo = new Repo(openDb(cfg.dbPath));
  seedDefaults(repo, { live: cfg.mode === "live" });

  let gmail: GmailClient | null = null;
  if (cfg.mode === "live" && cfg.gmail) {
    gmail = new GmailClient(cfg.gmail);
    log("serve: live mode — Gmail ingestion enabled");
  } else {
    // Gmail can still be connected later from Configuration → Gmail connection.
    log("serve: no Gmail/Gemini connected yet — set both up under Settings → Connections.");
  }
  const sender = new DelegatingSender(gmail ? new GmailSender(gmail) : new MockSender());

  const adapters = buildAdapters(cfg, sender, repo);
  const ctx: PipelineContext = { repo, adapters, jsonlPath: cfg.logToFile ? "./logs/decisions.jsonl" : undefined };
  // One ingest pass, usable by BOTH the 60s poll and Configuration → "Sync now".
  const runSyncOnce = async (backfillDays?: number): Promise<Error | null> => {
    try {
      const fromSettings = gmailFromSettings(repo);
      if (!gmail && fromSettings) {
        gmail = new GmailClient(fromSettings);
        sender.inner = new GmailSender(gmail);
        log(`serve: Gmail connected via Settings (${fromSettings.address}) — live sorting enabled`);
      } else if (gmail && !fromSettings) {
        log(`serve: Gmail disconnected via Settings — live fetching stopped`);
        gmail = null;
        sender.inner = new MockSender();
      }
      if (!gmail) {
        const missing = missingGmailCredentials(repo);
        return new Error(
          missing.length
            ? `Gmail is not connected — missing: ${missing.join(", ")} (Settings → Connections)`
            : "Gmail is not connected (Settings → Connections)."
        );
      }
      const opts = { autoMissingDocsEmails: cfg.autoMissingDocsEmails, autoStatusAnswers: cfg.autoStatusAnswers };
      // The window is re-read every pass: Settings changes apply without a
      // restart, and a backfill pass covers a deeper one-shot window.
      const lookback = backfillDays ?? resolveLookbackDays(repo, cfg.ingestLookbackDays);
      await ingestNewEmails(gmail, ctx, lookback, opts);
      repo.setSetting("gmail_last_sync_at", new Date().toISOString());
      repo.setSetting("gmail_last_error", "");
      return null;
    } catch (e) {
      const err = e as Error;
      log(`ingest poll failed: ${err.message}`, "error");
      try { repo.setSetting("gmail_last_error", err.message.slice(0, 300)); } catch { /* best-effort */ }
      return err;
    }
  };
  // Overlap guard: a slow pass (OCR / vision latency) must never let the
  // next 60 s tick stack a second pass on top — both would process the same
  // message ids. Overlapped ticks are skipped, not queued.
  const guardedSync = onceAtATime(runSyncOnce);
  const app = createApp({ repo, ctx, gmailSync: guardedSync, gmailBackfill: guardedSync });

  const port = cfg.port;
  app.listen(port, "0.0.0.0", () => {
    log(`serve: listening on http://0.0.0.0:${port}`);
    log(`serve: staff console → /login — on a fresh install you create the administrator account on first visit`);
    log(`serve: applicants who email just their reference number receive a status reply`);
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

  // Live inbox polling. Runs always: if Gmail gets connected from Settings
  // while the server is up, the next tick picks it up — no restart needed.
  await guardedSync();
  setInterval(() => { void guardedSync(); }, 60_000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
