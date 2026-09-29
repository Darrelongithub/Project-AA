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
    // The backup is a full PII copy — copyFileSync inherits the live DB's
    // (typically world-readable) mode, so lock it down explicitly.
    fs.chmodSync(backupPath, 0o600);
    log(`purge-mock: backup written to ${backupPath}`);
  }

  // 3 — demo applicants: delete each one with every child row.
  for (const { id } of mockIds) {
    repo.deleteApplicantFull(id);
  }

  // 4 — demo staff accounts. FKs are enforced, so their child rows go
  // first: a demo account that ever logged in owns sessions (and possibly
  // reset codes, notifications, permission/scope rows) that would abort
  // the staff delete with SQLITE_CONSTRAINT. Surviving task/note
  // attributions are nulled, not deleted — the content (usually on demo
  // cases, already gone in step 3) is never the purge's business.
  const demoIds = (db.prepare("SELECT id FROM staff_users WHERE IFNULL(demo, 0) = 1").all() as Array<{ id: number }>).map((r) => r.id);
  if (demoIds.length) {
    const inList = demoIds.map(() => "?").join(",");
    for (const t of ["sessions", "password_reset_codes", "notifications", "staff_permissions", "staff_scopes", "staff_case_type_scopes"]) {
      db.prepare(`DELETE FROM ${t} WHERE staff_id IN (${inList})`).run(...demoIds);
    }
    for (const t of ["tasks", "notes"]) {
      db.prepare(`UPDATE ${t} SET staff_id = NULL WHERE staff_id IN (${inList})`).run(...demoIds);
    }
    // A demo staffer assigned to a surviving (live) case would abort the
    // delete on applicants.assigned_to's FK the same way — unassign.
    db.prepare(`UPDATE applicants SET assigned_to = NULL WHERE assigned_to IN (${inList})`).run(...demoIds);
  }
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
