/**
 * /db/repo — emails, threads, labels and mail folders. Extracted verbatim from the Repo god class;
 * every function takes the Repo as its first argument and the Repo
 * facade in ../repo.ts delegates to it (same API, same behaviour).
 */
import { EmailRecord } from "../../types";
import type { Repo } from "../repo";
import { ScopeTag, isNoAccess, scopePred } from "./shared";

// ── Mail window (Gmail-style): conversations grouped by thread ────────────
/** A thread key groups a conversation; emails without a thread_id form a
 *  singleton conversation keyed by their own id. */
export function threadKeySql(alias: string): string {
    return `COALESCE(NULLIF(${alias}.thread_id, ''), 'email-' || ${alias}.id)`;
  }

/** Gmail folders. bin/spam are exclusive — a conversation there is hidden
 *  from every other folder until restored. */
/** Conversations per mail-window page (round 9: All Mail is paginated, not capped). */
export const MAIL_PAGE_SIZE = 50;


export const MAIL_FOLDER_WHERE: Record<string, string> = {
  inbox: "agg.in_n > 0 AND agg.spam_n = 0 AND agg.bin_n = 0",
  starred: "agg.star_n > 0 AND agg.spam_n = 0 AND agg.bin_n = 0",
  important: "agg.imp_n > 0 AND agg.spam_n = 0 AND agg.bin_n = 0",
  sent: "agg.out_n > 0 AND agg.spam_n = 0 AND agg.bin_n = 0",
  all: "agg.spam_n = 0 AND agg.bin_n = 0",
  spam: "agg.spam_n > 0 AND agg.bin_n = 0",
  bin: "agg.bin_n > 0",
};


// ── Email history (feature 4) ────────────────────────────────────────────
export function insertEmail(repo: Repo, e: Omit<EmailRecord, "id" | "attachments"> & { channel?: string; attachments?: string[] }): number {
  const res = repo.db
    .prepare(
      `INSERT INTO emails (applicant_id, message_id, thread_id, direction, from_addr, to_addr, subject, body, category, auto, channel, at, attachments)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      e.applicant_id,
      e.message_id,
      e.thread_id,
      e.direction,
      e.from_addr,
      e.to_addr,
      e.subject,
      e.body,
      e.category,
      e.auto,
      e.channel ?? "email",
      e.at,
      e.attachments && e.attachments.length ? JSON.stringify(e.attachments) : ""
    );
  return Number(res.lastInsertRowid);
}


/** Parse the stored attachment list; tolerant of legacy empty rows. */
export function parseAttachmentList(_repo: Repo, raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}


/** Active document count per applicant — ONE query for every export. */
export function documentCountsByApplicant(repo: Repo): Map<number, number> {
  const rows = repo.db
    .prepare(
      `SELECT applicant_id AS id, COUNT(*) AS n FROM documents WHERE superseded_by IS NULL AND is_duplicate = 0 GROUP BY applicant_id`
    )
    .all() as Array<{ id: number; n: number }>;
  return new Map(rows.map((r) => [r.id, r.n]));
}


/** Distinct active flag types per applicant — ONE query for every export. */
export function activeFlagTypesByApplicant(repo: Repo): Map<number, string[]> {
  const rows = repo.db
    .prepare(`SELECT applicant_id AS id, type FROM flags WHERE active = 1 ORDER BY applicant_id, type`)
    .all() as Array<{ id: number; type: string }>;
  const out = new Map<number, string[]>();
  for (const r of rows) {
    const list = out.get(r.id) ?? [];
    if (!list.includes(r.type)) list.push(r.type);
    out.set(r.id, list);
  }
  return out;
}


export function emailsForApplicant(repo: Repo, applicantId: number): EmailRecord[] {
  return repo.db
    .prepare("SELECT * FROM emails WHERE applicant_id = ? ORDER BY at, id")
    .all(applicantId) as EmailRecord[];
}


/**
 * Conversation list for the mail window: one row per thread (the latest
 * email), with message count and unread count. Scoped by school, realm-
 * filtered by demo, optionally searched and limited to unread threads.
 * One aggregate query — no N+1.
 */
export function mailThreads(repo: Repo, opts: {
  schools?: string[] | null; demo?: number; q?: string; unreadOnly?: boolean; page?: number; folder?: string;
}): Array<EmailRecord & { tkey: string; thread_n: number; unread_n: number; star_n: number; imp_n: number; a_name: string | null; a_email: string | null; ref_number: string | null; programme: string | null; lifecycle: string | null }> {
  // Parked applicant-less mail has no school to match. It must not bypass
  // an explicitly empty staff scope and become a data leak in All Mail.
  if (isNoAccess(opts.schools)) return [];
  const where: string[] = [];
  const params: unknown[] = [];
  // Round 9: applicant rows are realm- and school-scoped through the join;
  // PARKED rows (applicant_id NULL — the intake hotword gate) carry no
  // school of their own, so they are visible to live accounts only.
  const demo = opts.demo ?? 0;
  const appConds: string[] = [];
  if (opts.demo !== undefined) { appConds.push("a.demo = ?"); params.push(opts.demo); }
  const scope = scopePred("a", opts.schools);
  if (scope.sql) { appConds.push(scope.sql.replace(/^ AND /, "")); params.push(...scope.params); }
  const appCondSql = appConds.length ? appConds.join(" AND ") : "1=1";
  // DEMO: parked (caseless) mail arrives on Organization #1's mailbox —
  // it is never shown inside another organization's workspace.
  const parkedOrgOk = ((opts.schools as ScopeTag | null | undefined)?.organizationId ?? 1) === 1 ? 1 : 0;
  where.push(`((e.applicant_id IS NOT NULL AND ${appCondSql}) OR (e.applicant_id IS NULL AND ${demo} = 0 AND ${parkedOrgOk} = 1))`);
  if (opts.q) {
    const escaped = opts.q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const like = `%${escaped}%`;
    where.push(`(e.subject LIKE ? ESCAPE '\\' OR e.body LIKE ? ESCAPE '\\' OR a.full_name LIKE ? ESCAPE '\\' OR a.email_address LIKE ? ESCAPE '\\' OR a.ref_number LIKE ? ESCAPE '\\')`);
    params.push(like, like, like, like, like);
  }
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  const folder = MAIL_FOLDER_WHERE[opts.folder ?? "inbox"] ?? MAIL_FOLDER_WHERE.inbox;
  const unreadOnly = opts.unreadOnly ? " AND agg.unread_n > 0" : "";
  const sql = `
    WITH keyed AS (
      SELECT e.*, COALESCE(NULLIF(e.thread_id, ''), 'email-' || e.id) AS tkey,
             a.full_name AS a_name, a.email_address AS a_email, a.ref_number AS ref_number,
             a.programme AS programme, a.lifecycle AS lifecycle
      FROM emails e LEFT JOIN applicants a ON a.id = e.applicant_id
      ${whereSql}
    ),
    agg AS (
      SELECT tkey, MAX(id) AS last_id, MAX(at) AS last_at, COUNT(*) AS n,
             SUM(CASE WHEN direction = 'in' THEN 1 ELSE 0 END) AS in_n,
             SUM(CASE WHEN direction = 'out' THEN 1 ELSE 0 END) AS out_n,
             SUM(CASE WHEN direction = 'in' AND read = 0 THEN 1 ELSE 0 END) AS unread_n,
             SUM(CASE WHEN labels LIKE '%"starred"%' THEN 1 ELSE 0 END) AS star_n,
             SUM(CASE WHEN labels LIKE '%"important"%' THEN 1 ELSE 0 END) AS imp_n,
             SUM(CASE WHEN labels LIKE '%"spam"%' THEN 1 ELSE 0 END) AS spam_n,
             SUM(CASE WHEN labels LIKE '%"bin"%' THEN 1 ELSE 0 END) AS bin_n
      FROM keyed GROUP BY tkey
    )
    SELECT k.*, agg.n AS thread_n, agg.unread_n AS unread_n, agg.star_n AS star_n, agg.imp_n AS imp_n
    FROM agg JOIN keyed k ON k.id = agg.last_id
    WHERE ${folder}${unreadOnly}
    ORDER BY agg.last_at DESC, k.id DESC
    LIMIT ${MAIL_PAGE_SIZE} OFFSET ${(Math.max(1, Math.floor(opts.page ?? 1)) - 1) * MAIL_PAGE_SIZE}`;
  return repo.db.prepare(sql).all(...params) as never[];
}


/** Every email in one conversation, oldest first. */
export function emailsForThread(repo: Repo, tkey: string): EmailRecord[] {
  return repo.db
    .prepare(`SELECT e.* FROM emails e WHERE ${threadKeySql("e")} = ? ORDER BY e.at, e.id`)
    .all(tkey) as EmailRecord[];
}


/** Opening a conversation reads its incoming mail. */
export function markThreadRead(repo: Repo, tkey: string): void {
  repo.db
    .prepare(`UPDATE emails SET read = 1 WHERE direction = 'in' AND ${threadKeySql("emails")} = ?`)
    .run(tkey);
}


/** Marking a conversation unread returns it to the Unread filter. */
export function markThreadUnread(repo: Repo, tkey: string): void {
  repo.db
    .prepare(`UPDATE emails SET read = 0 WHERE direction = 'in' AND ${threadKeySql("emails")} = ?`)
    .run(tkey);
}


/** Sidebar counts per folder (conversations), one aggregate query. */
export function mailFolderCounts(repo: Repo, opts: { schools?: string[] | null; demo?: number }): Record<string, number> {
  if (isNoAccess(opts.schools)) {
    return Object.fromEntries(Object.keys(MAIL_FOLDER_WHERE).map((folder) => [folder, 0]));
  }
  const where: string[] = [];
  const params: unknown[] = [];
  // Round 9: same realm rule as mailThreads — parked (applicant-less)
  // mail counts for live accounts only.
  const demo = opts.demo ?? 0;
  const appConds: string[] = [];
  if (opts.demo !== undefined) { appConds.push("a.demo = ?"); params.push(opts.demo); }
  const scope = scopePred("a", opts.schools);
  if (scope.sql) { appConds.push(scope.sql.replace(/^ AND /, "")); params.push(...scope.params); }
  const appCondSql = appConds.length ? appConds.join(" AND ") : "1=1";
  // DEMO: parked (caseless) mail arrives on Organization #1's mailbox —
  // it is never shown inside another organization's workspace.
  const parkedOrgOk = ((opts.schools as ScopeTag | null | undefined)?.organizationId ?? 1) === 1 ? 1 : 0;
  where.push(`((e.applicant_id IS NOT NULL AND ${appCondSql}) OR (e.applicant_id IS NULL AND ${demo} = 0 AND ${parkedOrgOk} = 1))`);
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  const row = repo.db.prepare(`
    WITH keyed AS (
      SELECT e.direction, e.read, e.labels,
             COALESCE(NULLIF(e.thread_id, ''), 'email-' || e.id) AS tkey
      FROM emails e LEFT JOIN applicants a ON a.id = e.applicant_id
      ${whereSql}
    ),
    agg AS (
      SELECT tkey,
             SUM(CASE WHEN direction = 'in' THEN 1 ELSE 0 END) AS in_n,
             SUM(CASE WHEN direction = 'out' THEN 1 ELSE 0 END) AS out_n,
             SUM(CASE WHEN direction = 'in' AND read = 0 THEN 1 ELSE 0 END) AS unread_n,
             SUM(CASE WHEN labels LIKE '%"starred"%' THEN 1 ELSE 0 END) AS star_n,
             SUM(CASE WHEN labels LIKE '%"important"%' THEN 1 ELSE 0 END) AS imp_n,
             SUM(CASE WHEN labels LIKE '%"spam"%' THEN 1 ELSE 0 END) AS spam_n,
             SUM(CASE WHEN labels LIKE '%"bin"%' THEN 1 ELSE 0 END) AS bin_n
      FROM keyed GROUP BY tkey
    )
    SELECT
      SUM(CASE WHEN in_n > 0 AND spam_n = 0 AND bin_n = 0 THEN 1 ELSE 0 END) AS inbox,
      SUM(CASE WHEN in_n > 0 AND spam_n = 0 AND bin_n = 0 AND unread_n > 0 THEN 1 ELSE 0 END) AS unread,
      SUM(CASE WHEN star_n > 0 AND spam_n = 0 AND bin_n = 0 THEN 1 ELSE 0 END) AS starred,
      SUM(CASE WHEN imp_n > 0 AND spam_n = 0 AND bin_n = 0 THEN 1 ELSE 0 END) AS important,
      SUM(CASE WHEN out_n > 0 AND spam_n = 0 AND bin_n = 0 THEN 1 ELSE 0 END) AS sent,
      SUM(CASE WHEN spam_n = 0 AND bin_n = 0 THEN 1 ELSE 0 END) AS all_mail,
      SUM(CASE WHEN spam_n > 0 AND bin_n = 0 THEN 1 ELSE 0 END) AS spam,
      SUM(CASE WHEN bin_n > 0 THEN 1 ELSE 0 END) AS bin
    FROM agg`).get(...params) as Record<string, number>;
  return { inbox: row.inbox ?? 0, unread: row.unread ?? 0, starred: row.starred ?? 0, important: row.important ?? 0, sent: row.sent ?? 0, all: row.all_mail ?? 0, spam: row.spam ?? 0, bin: row.bin ?? 0 };
}


/**
 * Apply/remove a label on every message of a conversation (gmail semantics:
 * labels live on the conversation). Restore = strip bin AND spam so the
 * conversation lands back in Inbox/Sent exactly where it came from.
 */
export function setThreadLabel(repo: Repo, tkey: string, label: string, on: boolean): void {
  const rows = repo.emailsForThread(tkey);
  const update = repo.db.prepare("UPDATE emails SET labels = ? WHERE id = ?");
  for (const e of rows) {
    let arr: string[] = [];
    try { arr = JSON.parse(e.labels || "[]") as string[]; } catch { arr = []; }
    const set = new Set(arr.filter((x) => typeof x === "string"));
    if (label === "restore") { set.delete("bin"); set.delete("spam"); }
    else if (on) set.add(label);
    else set.delete(label);
    update.run(JSON.stringify([...set].sort()), e.id);
  }
}


/** Aggregate label state of a conversation (any message labelled = labelled). */
export function threadLabelState(repo: Repo, tkey: string): { starred: boolean; important: boolean; spam: boolean; bin: boolean } {
  const rows = repo.emailsForThread(tkey);
  const has = (l: string) => rows.some((e) => (e.labels || "").includes(`"${l}"`));
  return { starred: has("starred"), important: has("important"), spam: has("spam"), bin: has("bin") };
}
