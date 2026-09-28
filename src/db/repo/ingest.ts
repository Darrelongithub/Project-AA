/**
 * /db/repo — ingest claims ledger and outbox. Extracted verbatim from the Repo god class;
 * every function takes the Repo as its first argument and the Repo
 * facade in ../repo.ts delegates to it (same API, same behaviour).
 */
import type { Repo } from "../repo";

// ── Idempotency ──────────────────────────────────────────────────────────
export function isProcessed(repo: Repo, emailId: string): boolean {
  return !!repo.db.prepare("SELECT 1 FROM processed_emails WHERE email_id = ?").get(emailId);
}


export function markProcessed(repo: Repo, emailId: string, threadId: string): void {
  repo.db.prepare("INSERT OR IGNORE INTO processed_emails (email_id, thread_id) VALUES (?, ?)").run(emailId, threadId);
}


/**
 * Atomically claim a message at the START of the pipeline: false means
 * another (concurrent) run already owns it — treat as skipped. Claiming
 * at the end instead let two concurrent runs of the same email both pass
 * the isProcessed gate and double-process (double drafts, double sends).
 * A mid-pipeline failure must unmarkProcessed() so retry can see it.
 */
export function claimProcessed(repo: Repo, emailId: string, threadId: string): boolean {
  const res = repo.db
    .prepare("INSERT OR IGNORE INTO processed_emails (email_id, thread_id) VALUES (?, ?)")
    .run(emailId, threadId);
  return res.changes > 0;
}


/** Dead-letter retry: let the next poll see the message again. */
export function unmarkProcessed(repo: Repo, emailId: string): void {
  repo.db.prepare("DELETE FROM processed_emails WHERE email_id = ?").run(emailId);
}


// ── Outbox / human queue ─────────────────────────────────────────────────
export function addOutbox(repo: Repo, o: { applicant_id: number; to_address: string; subject: string; body: string; mode: "auto" | "queued"; template_key?: string; needs_approval?: number }): void {
  repo.db
    .prepare("INSERT INTO outbox (applicant_id, to_address, subject, body, mode, template_key, needs_approval) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(o.applicant_id, o.to_address, o.subject, o.body, o.mode, o.template_key ?? "", o.needs_approval ? 1 : 0);
}


export function latestOutbox(repo: Repo, applicantId: number): { subject: string; body: string; mode: string } | undefined {
  return repo.db
    .prepare("SELECT subject, body, mode FROM outbox WHERE applicant_id = ? ORDER BY id DESC LIMIT 1")
    .get(applicantId) as never;
}


/** Latest QUEUED draft awaiting a human [Send]/[Edit]/[Discard] decision. */
export function queuedOutbox(repo: Repo, applicantId: number): { id: number; subject: string; body: string; template_key?: string; needs_approval?: number } | undefined {
  return repo.db
    .prepare("SELECT id, subject, body, template_key, needs_approval FROM outbox WHERE applicant_id = ? AND mode = 'queued' ORDER BY id DESC LIMIT 1")
    .get(applicantId) as never;
}


export function updateOutbox(repo: Repo, id: number, subject: string, body: string): void {
  repo.db.prepare("UPDATE outbox SET subject = ?, body = ? WHERE id = ?").run(subject, body, id);
}


/**
 * Atomically claim a held draft for sending. Two concurrent approvals (the
 * send is awaited in between!) both used to read the still-queued draft and
 * mail the same reply twice; the claim is the gate — only the first update
 * wins. Claims older than 10 minutes are re-claimable: a sender that died
 * mid-send must not strand the draft forever.
 */
export function claimOutboxDraft(repo: Repo, id: number, nowIso: string): boolean {
  const staleBefore = new Date(new Date(nowIso).getTime() - 10 * 60_000).toISOString();
  const res = repo.db
    .prepare(`UPDATE outbox SET claimed_at = ? WHERE id = ? AND (claimed_at IS NULL OR claimed_at < ?)`)
    .run(nowIso, id, staleBefore);
  return res.changes > 0;
}


/** Send failed after the claim was taken — let the officer retry. */
export function releaseOutboxDraft(repo: Repo, id: number): void {
  repo.db.prepare("UPDATE outbox SET claimed_at = NULL WHERE id = ?").run(id);
}


export function deleteOutbox(repo: Repo, id: number): void {
  repo.db.prepare("DELETE FROM outbox WHERE id = ?").run(id);
}
