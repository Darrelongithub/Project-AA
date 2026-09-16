/**
 * `npm run ingest` — live mode: pull recent mail from the Gmail test inbox
 * and run it through the pipeline.
 *
 *   npm run ingest            # one pass over recent mail
 *   npm run ingest -- --watch # keep polling every 60s
 *
 * Requires MODE=live plus GMAIL_* and GEMINI_API_KEY in .env
 */
import { DEFAULT_REQUIREMENTS, loadConfig } from "../config";
import { openDb } from "../db/db";
import { Repo } from "../db/repo";
import { seedDefaults } from "../db/seed";
import { GmailClient } from "../ingestion/gmailClient";
import { ingestNewEmails } from "../ingestion";
import { buildAdapters, type EmailSender, type PipelineContext } from "../pipeline/adapters";
import { log } from "../util/log";

class GmailSender implements EmailSender {
  constructor(private gmail: GmailClient) {}
  async send(to: string, subject: string, body: string, threadId: string): Promise<void> {
    await this.gmail.sendReply(to, subject, body, threadId);
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (cfg.mode !== "live" || !cfg.gmail) {
    console.error(
      [
        "Live ingestion is not configured.",
        "",
        "Set these in .env (copy .env.example):",
        "  MODE=live",
        "  GMAIL_ADDRESS, GMAIL_OAUTH_CLIENT_ID, GMAIL_OAUTH_CLIENT_SECRET, GMAIL_OAUTH_REFRESH_TOKEN",
        "  GEMINI_API_KEY",
        "",
        "Tip: `npm run demo` + `npm run serve` exercises everything without credentials.",
      ].join("\n")
    );
    process.exit(1);
  }

  const repo = new Repo(openDb(cfg.dbPath));
  seedDefaults(repo, { live: true });
  // Idempotent now (IS-matched upsert) — older versions duplicated every
  // base rule on each ingest run.
  repo.seedBaseRequirements(DEFAULT_REQUIREMENTS);

  const gmail = new GmailClient(cfg.gmail);
  const adapters = buildAdapters(cfg, new GmailSender(gmail));
  const ctx: PipelineContext = {
    repo,
    adapters,
    jsonlPath: cfg.logToFile ? "./logs/decisions.jsonl" : undefined,
  };
  const opts = { autoMissingDocsEmails: cfg.autoMissingDocsEmails, autoStatusAnswers: cfg.autoStatusAnswers };

  const watch = process.argv.includes("--watch");
  do {
    log(`ingest: pass starting (lookback ${cfg.ingestLookbackDays}d)`);
    const results = await ingestNewEmails(gmail, ctx, cfg.ingestLookbackDays, opts);
    log(`ingest: pass complete — ${results.length} email(s) processed`);
    for (const r of results) {
      if (r.skipped) continue;
      log(`ingest:   ${r.refNumber} → ${r.finalStatus} (auto=${r.autoKind ?? "none"})`);
    }
    if (watch) {
      log("ingest: sleeping 60s…");
      await new Promise((r) => setTimeout(r, 60_000));
    }
  } while (watch);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
