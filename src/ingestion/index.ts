/**
 * /ingestion — detect new emails and hand them to the pipeline.
 * Idempotent: processed message ids are recorded and never re-processed.
 */
import type { ProcessResult } from "../types";
import { processEmail, type PipelineOptions } from "../pipeline";
import type { PipelineContext } from "../pipeline/adapters";
import { log } from "../util/log";
import type { GmailClient } from "./gmailClient";

export async function ingestNewEmails(
  gmail: GmailClient,
  ctx: PipelineContext,
  lookbackDays: number,
  opts?: PipelineOptions
): Promise<ProcessResult[]> {
  const ids = await gmail.listRecentMessageIds(lookbackDays);
  log(`ingestion: ${ids.length} recent message(s) in inbox`);
  const results: ProcessResult[] = [];

  for (const id of ids) {
    if (ctx.repo.isProcessed(id)) continue;
    let email;
    try {
      email = await gmail.fetchEmail(id);
    } catch (e) {
      log(`ingestion: failed to fetch message ${id}: ${(e as Error).message}`, "error");
      continue;
    }
    log(`ingestion: processing "${email.subject}" from ${email.from}`);
    try {
      results.push(await processEmail(email, ctx, opts));
    } catch (e) {
      // One poison email (constraint race, pathological PDF, DB hiccup) must
      // not kill the rest of the batch — log it and move on to the next.
      log(`ingestion: message ${id} failed processing: ${(e as Error).message}`, "error");
    }
  }
  return results;
}
