/**
 * /db/repo — dead letters. Extracted verbatim from the Repo god class;
 * every function takes the Repo as its first argument and the Repo
 * facade in ../repo.ts delegates to it (same API, same behaviour).
 */
import { DeadLetter } from "../../types";
import type { Repo } from "../repo";

// ── Dead-letter queue (round 19) ─────────────────────────────────────────
// Poison mail accumulates attempts here; after DEAD_LETTER_MAX_ATTEMPTS it
// is parked (dead=1) and surfaced to a human instead of being retried
// forever.
export function deadLetterMaxAttempts(repo: Repo): number {
  const n = Number(repo.getSetting("dead_letter_max_attempts", "5"));
  return Number.isFinite(n) && n > 0 ? n : 5;
}


export function recordDeadLetter(repo: Repo, input: {
  message_id: string;
  subject: string;
  from_addr: string;
  error: string;
}): { attempts: number; dead: boolean; id: number } {
  const existing = repo.db
    .prepare("SELECT * FROM dead_letters WHERE message_id = ?")
    .get(input.message_id) as (DeadLetter & { dead: number }) | undefined;
  if (existing) {
    const attempts = existing.attempts + 1;
    const dead = attempts >= repo.deadLetterMaxAttempts() ? 1 : existing.dead;
    repo.db
      .prepare(
        `UPDATE dead_letters SET attempts = ?, error = ?, dead = ?, updated_at = datetime('now') WHERE id = ?`
      )
      .run(attempts, input.error, dead, existing.id);
    return { attempts, dead: dead === 1, id: existing.id };
  }
  const attempts = 1;
  const dead = attempts >= repo.deadLetterMaxAttempts() ? 1 : 0;
  const res = repo.db
    .prepare(
      `INSERT INTO dead_letters (message_id, subject, from_addr, error, attempts, dead)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(input.message_id, input.subject, input.from_addr, input.error, attempts, dead);
  return { attempts, dead: dead === 1, id: Number(res.lastInsertRowid) };
}


export function listDeadLetters(repo: Repo, onlyDead = true): DeadLetter[] {
  const sql = onlyDead
    ? "SELECT * FROM dead_letters WHERE dead = 1 ORDER BY updated_at DESC"
    : "SELECT * FROM dead_letters ORDER BY updated_at DESC";
  return repo.db.prepare(sql).all() as DeadLetter[];
}


/**
 * Park a message permanently (known-unprocessable, e.g. oversized mail):
 * no retry budget, straight to the human queue.
 */
export function parkDeadLetter(repo: Repo, input: {
  message_id: string;
  subject: string;
  from_addr: string;
  error: string;
}): DeadLetter {
  const max = repo.deadLetterMaxAttempts();
  repo.db
    .prepare(
      `INSERT INTO dead_letters (message_id, subject, from_addr, error, attempts, dead)
       VALUES (?, ?, ?, ?, ?, 1)
       ON CONFLICT(message_id) DO UPDATE SET
         error = excluded.error, attempts = excluded.attempts, dead = 1, updated_at = datetime('now')`
    )
    .run(input.message_id, input.subject, input.from_addr, input.error, max);
  return repo.db
    .prepare("SELECT * FROM dead_letters WHERE message_id = ?")
    .get(input.message_id) as DeadLetter;
}


/** Reset a parked letter so the next poll retries it. */
export function resetDeadLetter(repo: Repo, id: number): void {
  repo.db
    .prepare(`UPDATE dead_letters SET dead = 0, attempts = 0, updated_at = datetime('now') WHERE id = ?`)
    .run(id);
}


export function removeDeadLetter(repo: Repo, id: number): void {
  repo.db.prepare("DELETE FROM dead_letters WHERE id = ?").run(id);
}


export function getDeadLetter(repo: Repo, id: number): DeadLetter | undefined {
  return repo.db.prepare("SELECT * FROM dead_letters WHERE id = ?").get(id) as DeadLetter | undefined;
}


export function clearDeadLetterByMessage(repo: Repo, messageId: string): void {
  repo.db.prepare("DELETE FROM dead_letters WHERE message_id = ?").run(messageId);
}


export function isDeadLetter(repo: Repo, messageId: string): boolean {
  const r = repo.db
    .prepare("SELECT dead FROM dead_letters WHERE message_id = ?")
    .get(messageId) as { dead: number } | undefined;
  return Boolean(r?.dead);
}
