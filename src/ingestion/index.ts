/**
 * /ingestion — detect new emails and hand them to the pipeline.
 * Idempotent: processed message ids are recorded and never re-processed.
 *
 * Round 19: POISON MAIL is isolated, not skipped. A message that keeps
 * failing (pathological attachment, provider hiccup) accumulates attempts in
 * the dead-letter table; after the retry budget it is parked and surfaced
 * to a human with the reason. Oversized mail is parked at once — retrying a
 * 40 MB scan five times gains nothing. A single auth failure (refresh token
 * expired) logs loudly and notifies staff instead of silently ending the
 * poll.
 */
import type { ProcessResult } from "../types";
import { processEmail, type PipelineOptions } from "../pipeline";
import type { PipelineContext } from "../pipeline/adapters";
import { log } from "../util/log";
import { EmailTooLargeError, type GmailClient } from "./gmailClient";

export async function ingestNewEmails(
  gmail: GmailClient,
  ctx: PipelineContext,
  lookbackDays: number,
  opts?: PipelineOptions
): Promise<ProcessResult[]> {
  const { repo } = ctx;
  let ids: string[];
  try {
    ids = await gmail.listRecentMessageIds(lookbackDays);
  } catch (e) {
    // One refresh-token failure must not silently stop ingestion: report it
    // and try again on the next poll.
    const msg = (e as Error).message || String(e);
    log(`ingestion: mailbox listing failed — ${msg}`, "error");
    repo.notify(
      "review_needed",
      `Gmail sync failed (${gmail.watchTarget()}): ${msg.slice(0, 200)} — check the Gmail connection settings`,
      null
    );
    return [];
  }
  log(`ingestion: ${ids.length} recent message(s) in ${gmail.watchTarget()}`);
  const results: ProcessResult[] = [];

  for (const id of ids) {
    if (repo.isProcessed(id)) continue;
    if (repo.isDeadLetter(id)) continue; // parked → a human owns it now

    let email;
    try {
      email = await gmail.fetchEmail(id);
    } catch (e) {
      const msg = (e as Error).message || String(e);
      if (e instanceof EmailTooLargeError) {
        repo.parkDeadLetter({ message_id: id, subject: "", from_addr: "", error: msg });
        repo.notify("review_needed", `Oversized mail parked (~${(e.sizeEstimate / 1024 / 1024).toFixed(0)} MB): ask the sender for smaller scans`, null);
        log(`ingestion: ${id} parked — ${msg}`, "error");
        continue;
      }
      const dl = repo.recordDeadLetter({ message_id: id, subject: "", from_addr: "", error: msg });
      if (dl.dead) {
        repo.notify("review_needed", `Message ${id} failed ${dl.attempts} times and was parked: ${msg.slice(0, 200)}`, null);
        log(`ingestion: ${id} dead-lettered after ${dl.attempts} attempts — ${msg}`, "error");
      } else {
        log(`ingestion: failed to fetch ${id} (attempt ${dl.attempts}): ${msg}`, "error");
      }
      continue;
    }

    log(`ingestion: processing "${email.subject}" from ${email.from}`);
    try {
      results.push(await processEmail(email, ctx, opts));
      // Successful processing clears any earlier failure record.
      repo.clearDeadLetterByMessage(email.id);
    } catch (e) {
      // One poison email (constraint race, pathological PDF, DB hiccup) must
      // not kill the rest of the batch — and it must not vanish either.
      const msg = (e as Error).message || String(e);
      const dl = repo.recordDeadLetter({
        message_id: email.id,
        subject: email.subject,
        from_addr: email.from,
        error: msg,
      });
      if (dl.dead) {
        repo.notify(
          "review_needed",
          `Message "${email.subject}" from ${email.from} failed ${dl.attempts} times and was parked: ${msg.slice(0, 200)}`,
          null
        );
        log(`ingestion: "${email.subject}" dead-lettered after ${dl.attempts} attempts`, "error");
      } else {
        log(`ingestion: "${email.subject}" failed processing (attempt ${dl.attempts}): ${msg}`, "error");
      }
    }
  }
  return results;
}
