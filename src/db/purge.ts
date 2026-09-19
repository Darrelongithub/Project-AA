/**
 * OR-1 — one-time, safe purge of demo/simulation contamination.
 *
 * Old versions of `npm run demo` wrote the synthetic corpus into the SAME
 * database the live server reads, flagged with `demo = 1`. This purge
 * removes ONLY rows provably created by that tooling:
 *   - applicants with demo = 1 (plus every child row via full delete)
 *   - staff accounts with demo = 1 (demo_admin / demo_user)
 *   - the demo_dataset marker setting
 * It NEVER touches rows with demo = 0 — i.e. anything created by real
 * Gmail ingestion or real staff actions. A backup copy of the database file
 * is written first. The purge is idempotent: a second run removes nothing.
 */
import * as fs from "fs";
import type { Repo } from "./repo";
import { log } from "../util/log";

export interface PurgeResult {
  applicants: number;
  staff: number;
  backupPath: string | null;
}

export function purgeMockData(repo: Repo, opts: { backupPath?: string } = {}): PurgeResult {
  const db = repo.db;
  const dbFile: string = db.name;

  // 1 — count what will go. A clean database gets NO backup file and no
  // writes at all (the purge must be safe to run on a schedule).
  const mockIds = db
    .prepare("SELECT id FROM applicants WHERE IFNULL(demo, 0) = 1")
    .all() as Array<{ id: number }>;
  const demoStaff = (db.prepare("SELECT COUNT(*) AS n FROM staff_users WHERE IFNULL(demo, 0) = 1").get() as { n: number }).n;
  if (mockIds.length === 0 && demoStaff === 0) {
    db.prepare("DELETE FROM settings WHERE key = 'demo_dataset'").run();
    return { applicants: 0, staff: 0, backupPath: null };
  }

  // 2 — backup first, before any delete. In-memory DBs have no file to copy.
  let backupPath: string | null = null;
  if (dbFile !== ":memory:") {
    // Checkpoint so the copy includes WAL contents.
    db.pragma("wal_checkpoint(TRUNCATE)");
    backupPath = opts.backupPath ?? `${dbFile}.pre-purge-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.copyFileSync(dbFile, backupPath);
    log(`purge-mock: backup written to ${backupPath}`);
  }

  // 3 — demo applicants: delete each one with every child row.
  for (const { id } of mockIds) {
    repo.deleteApplicantFull(id);
  }

  // 4 — demo staff accounts.
  const staffDeleted = db.prepare("DELETE FROM staff_users WHERE IFNULL(demo, 0) = 1").run().changes;

  // 5 — demo markers in settings.
  db.prepare("DELETE FROM settings WHERE key = 'demo_dataset'").run();

  const result: PurgeResult = { applicants: mockIds.length, staff: staffDeleted, backupPath };
  log(
    result.applicants + result.staff > 0
      ? `purge-mock: removed ${result.applicants} mock applicant(s) and ${result.staff} demo account(s)`
      : "purge-mock: database is clean — nothing to remove"
  );
  return result;
}
