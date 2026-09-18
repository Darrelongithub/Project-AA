/**
 * `npm run followups` — one-shot run of the automatic follow-up ladder
 * (Day 0 notice → Day 3 reminder → Day 7 final → Day 10 staff review).
 * The web server also runs this automatically every 2 minutes.
 */
import { loadConfig } from "../config";
import { openDb } from "../db/db";
import { Repo } from "../db/repo";
import { seedDefaults } from "../db/seed";
import { buildAdapters, MockSender, type EmailSender, type PipelineContext } from "../pipeline/adapters";
import { GmailClient } from "../ingestion/gmailClient";
import { runFollowUpSweep } from "../followups";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const repo = new Repo(openDb(cfg.dbPath));
  seedDefaults(repo, { live: cfg.mode === "live" });

  let sender: EmailSender = new MockSender();
  if (cfg.mode === "live" && cfg.gmail) {
    const gmail = new GmailClient(cfg.gmail);
    sender = { send: (to, subject, body, threadId) => gmail.sendReply(to, subject, body, threadId) };
  }
  const ctx: PipelineContext = { repo, adapters: buildAdapters(cfg, sender, repo) };
  const sent = await runFollowUpSweep(repo, ctx);
  console.log(`followups: ${sent} reminder(s) sent this sweep.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
