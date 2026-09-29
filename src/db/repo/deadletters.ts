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
  // Atomic upsert: the old SELECT-then-INSERT raced when two syncs (web
  // timer + CLI ingest) recorded the same poison message concurrently —
  // the loser died on UNIQUE(message_id) mid-batch, and concurrent
  // increments could lose an attempt count. Same observable behaviour
  // (attempts+1, latest error wins, once dead stays dead).
  const max = repo.deadLetterMaxAttempts();
  repo.db
    .prepare(
      `INSERT INTO dead_letters (message_id, subject, from_addr, error, attempts, dead)
       VALUES (?, ?, ?, ?, 1, CASE WHEN 1 >= ? THEN 1 ELSE 0 END)
       ON CONFLICT(message_id) DO UPDATE SET
         error = excluded.error,
         attempts = dead_letters.attempts + 1,
         dead = CASE WHEN dead_letters.attempts + 1 >= ? THEN 1 ELSE dead_letters.dead END,
         updated_at = datetime('now')`
    )
    .run(input.message_id, input.subject, input.from_addr, input.error, max, max);
  const row = repo.db
    .prepare("SELECT id, attempts, dead FROM dead_letters WHERE message_id = ?")
    .get(input.message_id) as { id: number; attempts: number; dead: number };
  return { attempts: row.attempts, dead: row.dead === 1, id: row.id };
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
