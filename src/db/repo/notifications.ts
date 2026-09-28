/**
 * /db/repo — notifications. Extracted verbatim from the Repo god class;
 * every function takes the Repo as its first argument and the Repo
 * facade in ../repo.ts delegates to it (same API, same behaviour).
 */
import type { Repo } from "../repo";
import { isNoAccess, scopePred } from "./shared";

// ── Notifications (feature 39) ───────────────────────────────────────────
export function notify(repo: Repo, kind: string, message: string, applicantId: number | null, staffId: number | null = null): void {
  repo.db
    .prepare("INSERT INTO notifications (staff_id, applicant_id, kind, message) VALUES (?,?,?,?)")
    .run(staffId, applicantId, kind, message);
}


/**
 * Realm separation: a notification about a demo applicant is only ever
 * shown to demo accounts, and vice versa (broadcasts without an applicant
 * are visible to everyone).
 */
export function notificationsFor(repo: Repo, staffId: number, limit = 50, demo?: number, schools?: string[] | null): Array<{ id: number; kind: string; message: string; read: number; at: string; applicant_id: number | null }> {
  const realmSql = demo === undefined ? "" : " AND (n.applicant_id IS NULL OR a.demo = ?)";
  // OR-8: scoped staff never see alerts about cases outside their schools
  // (broadcast alerts without an applicant stay visible to everyone).
  const scope = scopePred("a", schools);
  const scopeSql = scope.sql ? ` AND (n.applicant_id IS NULL OR 1=1${scope.sql})` : "";
  const params: unknown[] = demo === undefined ? [staffId, limit] : [staffId, demo, limit];
  return repo.db
    .prepare(
      `SELECT n.id AS id, n.kind AS kind, n.message AS message, n.read AS read, n.at AS at, n.applicant_id AS applicant_id
       FROM notifications n LEFT JOIN applicants a ON a.id = n.applicant_id
       WHERE (n.staff_id IS NULL OR n.staff_id = ?)${realmSql}${scopeSql}
       ORDER BY n.id DESC LIMIT ?`
    )
    .all(demo === undefined ? [params[0], ...scope.params, params[1]] : [params[0], params[1], ...scope.params, params[2]]) as never[];
}


export function unreadCount(repo: Repo, staffId: number, demo?: number, schools?: string[] | null): number {
  if (isNoAccess(schools)) return 0;
  const realmSql = demo === undefined ? "" : " AND (n.applicant_id IS NULL OR a.demo = ?)";
  const scope = scopePred("a", schools);
  const scopeSql = scope.sql ? ` AND (n.applicant_id IS NULL OR 1=1${scope.sql})` : "";
  const params: unknown[] = demo === undefined
    ? [staffId, ...scope.params]
    : [staffId, demo, ...scope.params];
  return (
    repo.db
      .prepare(
        `SELECT COUNT(*) AS n FROM notifications n LEFT JOIN applicants a ON a.id = n.applicant_id
         WHERE (n.staff_id IS NULL OR n.staff_id = ?) AND n.read = 0${realmSql}${scopeSql}`
      )
      .get(...params) as { n: number }
  ).n;
}


export function markNotificationsRead(repo: Repo, staffId: number): void {
  repo.db.prepare("UPDATE notifications SET read = 1 WHERE staff_id IS NULL OR staff_id = ?").run(staffId);
}
