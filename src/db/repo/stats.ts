/**
 * /db/repo — dashboards, queues, search and statistics. Extracted verbatim from the Repo god class;
 * every function takes the Repo as its first argument and the Repo
 * facade in ../repo.ts delegates to it (same API, same behaviour).
 */
import { fillSlots } from "../../documents/matrix";
import { ApplicantRow } from "../../types";
import type { ApplicantSearchQuery, Repo, StaffStatsRow } from "../repo";
import { scopePred } from "./shared";

/** Direction of each applicant's most recent email — one query, for queues. */
export function lastEmailDirections(repo: Repo, ids: number[]): Map<number, "in" | "out"> {
  if (ids.length === 0) return new Map();
  const rows = repo.db
    .prepare(
      `SELECT e.applicant_id AS applicant_id, e.direction AS direction FROM emails e
       JOIN (SELECT applicant_id, MAX(id) AS max_id FROM emails
             WHERE applicant_id IN (${ids.map(() => "?").join(",")}) GROUP BY applicant_id) m
         ON m.max_id = e.id`
    )
    .all(...ids) as Array<{ applicant_id: number; direction: "in" | "out" }>;
  return new Map(rows.map((r) => [r.applicant_id, r.direction]));
}


/** Human-readable reason from each applicant's LATEST evaluation — one query. */
export function latestEvaluationReasons(repo: Repo, ids: number[]): Map<number, string> {
  if (ids.length === 0) return new Map();
  const rows = repo.db
    .prepare(
      `SELECT e.applicant_id AS applicant_id, e.reason AS reason FROM evaluations e
       JOIN (SELECT applicant_id, MAX(id) AS max_id FROM evaluations
             WHERE applicant_id IN (${ids.map(() => "?").join(",")}) GROUP BY applicant_id) m
         ON m.max_id = e.id`
    )
    .all(...ids) as Array<{ applicant_id: number; reason: string }>;
  const out = new Map<number, string>();
  for (const r of rows) if (r.reason) out.set(r.applicant_id, r.reason);
  return out;
}


/** Active document counts per applicant — one query, for queues. */
export function docCounts(repo: Repo, ids: number[]): Map<number, number> {
  if (ids.length === 0) return new Map();
  const rows = repo.db
    .prepare(
      `SELECT applicant_id, COUNT(*) AS n FROM documents
       WHERE superseded_by IS NULL AND is_duplicate = 0 AND applicant_id IN (${ids.map(() => "?").join(",")})
       GROUP BY applicant_id`
    )
    .all(...ids) as Array<{ applicant_id: number; n: number }>;
  return new Map(rows.map((r) => [r.applicant_id, r.n]));
}


/**
 * Applicants who received an enquiry-style incoming email today (one SQL
 * query — the admissions page must not do one query per applicant).
 */
export function enquiryApplicantIdsToday(repo: Repo, startISO: string, schools?: string[] | null): Set<number> {
  const scope = scopePred("a", schools);
  const rows = repo.db
    .prepare(
      `SELECT DISTINCT e.applicant_id AS id FROM emails e JOIN applicants a ON a.id = e.applicant_id
       WHERE e.direction = 'in' AND e.at >= ?
         AND e.category IN ('fee_enquiry','admission_enquiry','follow_up','complaint','other')${scope.sql}`
    )
    .all(startISO, ...scope.params) as Array<{ id: number }>;
  return new Set(rows.map((r) => r.id));
}


/** Counters for the Overview "Today" panel. */
// ── Stage model (v5): every applicant sits in exactly one level ──────────
// finished / unfinished / pending are the three buckets staff think in;
// awaiting_review inside pending is the classic "human queue".
export function stageCounts(repo: Repo, demo?: number, schools?: string[] | null): {
  finished: number;
  unfinished: number;
  pending: number;
  enquiries: number;
  application_received: number;
  documents_received: number;
  documents_checked: number;
  awaiting_review: number;
  verification: number;
  completed: number;
  total: number;
} {
  const where: string[] = [];
  const params: unknown[] = [];
  if (demo !== undefined) { where.push("demo = ?"); params.push(demo); }
  const scope = scopePred("applicants", schools);
  if (scope.sql) { where.push(scope.sql.replace(/^ AND /, "")); params.push(...scope.params); }
  const rows = repo.db
    .prepare(`SELECT lifecycle, COUNT(*) AS n FROM applicants${where.length ? " WHERE " + where.join(" AND ") : ""} GROUP BY lifecycle`)
    .all(...params) as Array<{
    lifecycle: string;
    n: number;
  }>;
  const by = new Map(rows.map((r) => [r.lifecycle, r.n]));
  const g = (k: string) => by.get(k) ?? 0;
  const total = rows.reduce((n, r) => n + r.n, 0);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const enquiries = repo.enquiryApplicantIdsToday(start.toISOString(), schools).size;
  return {
    finished: g("completed"),
    unfinished: g("application_received") + g("documents_received") + g("documents_checked"),
    pending: g("awaiting_review") + g("verification"),
    enquiries,
    application_received: g("application_received"),
    documents_received: g("documents_received"),
    documents_checked: g("documents_checked"),
    awaiting_review: g("awaiting_review"),
    verification: g("verification"),
    completed: g("completed"),
    total,
  };
}


export function todayStats(repo: Repo, demo?: number, schools?: string[] | null): { emailsToday: number; docsToday: number; completedToday: number } {
  // date('now') is UTC — in UTC+3 the "today" counters would reset at 03:00
  // local. Compute THIS machine's local day boundaries instead.
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 24 * 3600_000);
  const lo = start.toISOString();
  const hi = end.toISOString();
  const dp: unknown[] = demo === undefined ? [] : [demo];
  const scope = scopePred("a", schools);
  const pred = (demo === undefined ? "" : " AND a.demo = ?") + scope.sql;
  const one = (sql: string) => (repo.db.prepare(sql).get(lo, hi, ...dp, ...scope.params) as { n: number }).n;
  return {
    emailsToday: one(`SELECT COUNT(*) AS n FROM emails e JOIN applicants a ON a.id = e.applicant_id WHERE e.direction = 'in' AND e.at >= ? AND e.at < ?${pred}`),
    docsToday: one(`SELECT COUNT(*) AS n FROM documents d JOIN applicants a ON a.id = d.applicant_id WHERE d.received_at >= ? AND d.received_at < ?${pred}`),
    completedToday: one(`SELECT COUNT(*) AS n FROM status_history h JOIN applicants a ON a.id = h.applicant_id WHERE h.to_status = 'completed' AND h.at >= ? AND h.at < ?${pred}`),
  };
}


/** The human work queue (feature 11): cases whose latest decision wasn't auto-resolved. */
export function queueView(repo: Repo, demo?: number, schools?: string[] | null): Array<ApplicantRow & { computed_status: string; reasoning: string; auto_sent: boolean; decided_at: string; flag_summary: string }> {
  const scope = scopePred("a", schools);
  const demoSql = (demo === undefined ? "" : " AND a.demo = ?") + scope.sql;
  const demoParams: unknown[] = demo === undefined ? [...scope.params] : [demo, ...scope.params];
  const rows = repo.db
    .prepare(
      `SELECT a.*, d.computed_status, d.reasoning, d.auto_sent, d.timestamp AS decided_at
       FROM decision_logs d
       JOIN (SELECT applicant_id, MAX(id) AS max_id FROM decision_logs GROUP BY applicant_id) latest
         ON latest.max_id = d.id
       JOIN applicants a ON a.id = d.applicant_id
       WHERE (
           a.lifecycle NOT IN ('completed','verification')
           -- Completed files stay out of the review queue UNLESS something
           -- still needs a human: a held draft or an active blocking flag.
           OR EXISTS (SELECT 1 FROM flags f2 WHERE f2.applicant_id = a.id AND f2.active = 1 AND f2.type != 'duplicate_submission')
           OR EXISTS (SELECT 1 FROM outbox o2 WHERE o2.applicant_id = a.id AND o2.mode = 'queued')
         )
         AND (
           d.auto_sent = 0
           -- A case whose latest decision auto-sent still needs a human
           -- when a blocking flag is active or a draft is held for approval.
           OR EXISTS (SELECT 1 FROM flags f WHERE f.applicant_id = a.id AND f.active = 1 AND f.type != 'duplicate_submission')
           OR EXISTS (SELECT 1 FROM outbox o WHERE o.applicant_id = a.id AND o.mode = 'queued')
         )${demoSql}
       ORDER BY
         CASE a.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,
         d.id`
    )
    .all(...demoParams) as any[];
  // Flags for the whole page in ONE query (was: one query per row — the
  // queue page and CSV export fired hundreds of statements).
  const flagMap = new Map<number, string>();
  if (rows.length > 0) {
    const flagRows = repo.db
      .prepare(
        `SELECT applicant_id, group_concat(DISTINCT type) AS types
         FROM flags
         WHERE active = 1 AND type != 'duplicate_submission' AND applicant_id IN (${rows.map(() => "?").join(",")})
         GROUP BY applicant_id`
      )
      .all(...rows.map((r) => r.id)) as Array<{ applicant_id: number; types: string }>;
    for (const f of flagRows) flagMap.set(f.applicant_id, f.types);
  }
  return rows.map((r) => ({
    ...r,
    auto_sent: r.auto_sent === 1,
    flag_summary: flagMap.get(r.id) ?? "",
  }));
}


// ── Search & filters (features 18, 19) ───────────────────────────────────
export function searchApplicants(repo: Repo, opts: ApplicantSearchQuery): ApplicantRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.demo !== undefined) {
    where.push("demo = ?");
    params.push(opts.demo);
  }
  if (opts.q) {
    // Phone matching: compare against the raw column, the digits-only form,
    // and the domestic form (leading 254 shown as 0) so "0700111" finds
    // "+254700111222".
    where.push(
      `(ref_number LIKE ? ESCAPE '\\' OR full_name LIKE ? ESCAPE '\\' OR email_address LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\'
        OR replace(replace(replace(coalesce(phone,''),'+',''),' ',''),'-','') LIKE ? ESCAPE '\\'
        OR (CASE WHEN replace(replace(replace(coalesce(phone,''),'+',''),' ',''),'-','') LIKE '254%'
                 THEN '0' || substr(replace(replace(replace(coalesce(phone,''),'+',''),' ',''),'-',''), 4)
                 ELSE replace(replace(replace(coalesce(phone,''),'+',''),' ',''),'-','')
            END) LIKE ? ESCAPE '\\')`
    );
    // Escape LIKE wildcards — a user-typed "%" must match a literal "%",
    // not the whole table.
    const escaped = opts.q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const like = `%${escaped}%`;
    params.push(like, like, like, like, like, like);
  }
  if (opts.programme) {
    where.push("programme = ?");
    params.push(opts.programme);
  }
  if (opts.intake) {
    where.push("intake = ?");
    params.push(opts.intake);
  }
  const scope = scopePred("applicants", opts.schools);
  if (scope.sql) {
    where.push(scope.sql.replace(/^ AND /, ""));
    params.push(...scope.params);
  }
  const now = new Date().toISOString();
  switch (opts.filter) {
    case "awaiting_docs":
      where.push("lifecycle IN ('application_received','documents_received') AND triage = 'Red'");
      break;
    case "human_review":
      where.push("lifecycle = 'awaiting_review'");
      break;
    case "complete":
      where.push("lifecycle IN ('documents_checked','verification','completed')");
      break;
    case "overdue":
      where.push("sla_due_at IS NOT NULL AND sla_handled_at IS NULL AND sla_due_at < ?");
      params.push(now);
      break;
  }
  const sql = `SELECT * FROM applicants ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`;
  params.push(opts.limit ?? 200);
  return repo.db.prepare(sql).all(...params) as ApplicantRow[];
}


// ── Dashboard analytics (feature 30) ─────────────────────────────────────
export function dashboardStats(repo: Repo, demo?: number, schools?: string[] | null): Record<string, number | string> {
  // Realm scope: every applicant-derived count filters by the caller's demo
  // flag so live admins never see seeded (mock) data and vice versa.
  // OR-8: school scope applies to every count too.
  const scope = scopePred("a", schools);
  const pred = (demo === undefined ? "" : " AND a.demo = ?") + scope.sql;
  const dp: unknown[] = demo === undefined ? [...scope.params] : [demo, ...scope.params];
  const one = (sql: string, p: unknown[] = []) => (repo.db.prepare(sql).get(...p) as { n: number }).n;
  const applications = one(`SELECT COUNT(*) AS n FROM applicants a WHERE 1=1${pred}`, dp);
  // M-4: superseded documents are inactive everywhere else (case view,
  // CSV) — the dashboard must not count them either.
  const documents = one(
    `SELECT COUNT(*) AS n FROM documents d JOIN applicants a ON a.id = d.applicant_id WHERE d.is_duplicate = 0 AND d.superseded_by IS NULL${pred}`,
    dp
  );
  const autoHandled = one(
    `SELECT COUNT(*) AS n FROM decision_logs d JOIN applicants a ON a.id = d.applicant_id WHERE d.auto_sent = 1${pred}`,
    dp
  );
  const humanReview = one(`SELECT COUNT(*) AS n FROM applicants a WHERE a.lifecycle = 'awaiting_review'${pred}`, dp);
  const incomplete = one(
    `SELECT COUNT(*) AS n FROM applicants a WHERE a.lifecycle IN ('application_received','documents_received') AND a.triage = 'Red'${pred}`,
    dp
  );
  const completed = one(`SELECT COUNT(*) AS n FROM applicants a WHERE a.lifecycle = 'completed'${pred}`, dp);
  const overdue = one(
    `SELECT COUNT(*) AS n FROM applicants a WHERE a.sla_due_at IS NOT NULL AND a.sla_handled_at IS NULL AND a.sla_due_at < ? AND a.lifecycle NOT IN ('completed','verification')${pred}`,
    [new Date().toISOString(), ...dp]
  );
  // Avg time from email receipt → automated decision (minutes), last 7 days.
  // (Previously had no date filter and silently averaged all-time.)
  const avgRow = repo.db
    .prepare(
      `SELECT AVG((julianday(d.timestamp) - julianday(e.at)) * 24 * 60) AS m
       FROM decision_logs d
       JOIN applicants a ON a.id = d.applicant_id
       JOIN emails e ON e.message_id = d.triggering_email_id AND e.direction = 'in'
       WHERE d.auto_sent = 1 AND d.timestamp > datetime('now', '-7 days')${pred}`
    )
    .get(...dp) as { m: number | null };
  const avgResponseMin = avgRow?.m && avgRow.m > 0 ? Math.round(avgRow.m * 10) / 10 : 0;
  // Avg time from queue → first staff action (hours).
  const avgReview = repo.db
    .prepare(
      `SELECT AVG((julianday(h.at) - julianday(d.timestamp)) * 24) AS h
       FROM status_history h
       JOIN applicants a ON a.id = h.applicant_id
       JOIN (SELECT applicant_id, MAX(id) AS max_id FROM decision_logs WHERE auto_sent = 0 GROUP BY applicant_id) dl
         ON dl.applicant_id = h.applicant_id
       JOIN decision_logs d ON d.id = dl.max_id
       WHERE h.actor <> 'system' AND h.at >= d.timestamp${pred}`
    )
    .get(...dp) as { h: number | null };
  const avgReviewHours = avgReview?.h && avgReview.h > 0 ? Math.round(avgReview.h * 10) / 10 : 0;
  return { applications, documents, autoHandled, humanReview, incomplete, completed, overdue, avgResponseMin, avgReviewHours };
}


/**
 * Most common MISSING required documents across OPEN (not completed, not
 * in verification) cases — scoped by realm + schools like every other
 * admin number. Each applicant counts once per missing type, judged by
 * the frozen requirement snapshot where present (else live rules), minus
 * their active (non-superseded) documents.
 */
export function commonMissingDocs(repo: Repo, demo?: number, schools?: string[] | null, limit = 5): Array<{ type: string; count: number }> {
  const counts = new Map<string, number>();
  for (const a of repo.allApplicants(demo, schools)) {
    if (a.lifecycle === "completed" || a.lifecycle === "verification") continue;
    // The SAME slot semantics as decide(): a generic academic upload fills
    // an academic slot (fillSlots), so the tile must not count as missing
    // a document the pipeline already considers present. A literal
    // type-set difference used to show complete files as short.
    const present = repo.listDocuments(a.id, { activeOnly: true }).map((d) => d.document_type);
    const { missing } = fillSlots(repo.effectiveRequirements(a), present);
    for (const m of missing) counts.set(m.document_type, (counts.get(m.document_type) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((x, y) => y.count - x.count)
    .slice(0, limit);
}


// ── Export (feature 38) ──────────────────────────────────────────────────
export function allApplicants(repo: Repo, demo?: number, schools?: string[] | null): ApplicantRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (demo !== undefined) { where.push("demo = ?"); params.push(demo); }
  const scope = scopePred("applicants", schools);
  if (scope.sql) { where.push(scope.sql.replace(/^ AND /, "")); params.push(...scope.params); }
  return repo.db
    .prepare(`SELECT * FROM applicants${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY id`)
    .all(...params) as ApplicantRow[];
}


/**
 * Listener stats: one row per staff member.
 * - emailsReceived: incoming mail on cases currently assigned to them
 * - emailsSent: replies they personally approved/sent (audit trail)
 * - avgResponseMinutes: mean gap between an incoming email and the next
 *   outgoing reply on their assigned cases
 * - admissionsCompleted: distinct cases they moved to "completed"
 */
export function staffStats(repo: Repo, demo?: number, organizationId?: number): StaffStatsRow[] {
  const staff = repo.listStaff(organizationId);
  const demoSql = demo === undefined ? "" : " AND a.demo = ?";
  const dp: unknown[] = demo === undefined ? [] : [demo];
  const qAssigned = repo.db.prepare(`SELECT COUNT(*) AS c FROM applicants a WHERE a.assigned_to = ?${demoSql}`);
  const qReceived = repo.db.prepare(
    `SELECT COUNT(*) AS c FROM emails e
     JOIN applicants a ON a.id = e.applicant_id
     WHERE e.direction = 'in' AND a.assigned_to = ?${demoSql}`
  );
  const qSent = repo.db.prepare(
    `SELECT COUNT(*) AS c FROM audit_log
     WHERE actor = ? AND event IN ('email_sent_manual','human_override')`
  );
  const qCompleted = repo.db.prepare(
    `SELECT COUNT(DISTINCT h.applicant_id) AS c FROM status_history h
     JOIN applicants a ON a.id = h.applicant_id
     WHERE h.actor = ? AND h.to_status = 'completed'${demoSql}`
  );
  const qAvg = repo.db.prepare(
    `SELECT AVG((julianday(o.at) - julianday(i.at)) * 1440.0) AS mins
     FROM emails i
     JOIN applicants a ON a.id = i.applicant_id
     JOIN emails o ON o.applicant_id = i.applicant_id AND o.direction = 'out'
       AND o.at = (SELECT MIN(o2.at) FROM emails o2
                   WHERE o2.applicant_id = i.applicant_id
                     AND o2.direction = 'out' AND o2.at > i.at)
     WHERE i.direction = 'in' AND a.assigned_to = ?${demoSql}`
  );
  return staff.map((s) => {
    const assigned = (qAssigned.get(s.id, ...dp) as { c: number }).c;
    const received = (qReceived.get(s.id, ...dp) as { c: number }).c;
    const sent = (qSent.get(s.username) as { c: number }).c;
    const completed = (qCompleted.get(s.username, ...dp) as { c: number }).c;
    const avg = qAvg.get(s.id, ...dp) as { mins: number | null };
    return {
      id: s.id,
      username: s.username,
      display_name: s.display_name,
      role: s.role,
      active: s.active,
      demo: s.demo ?? 0,
      assignedCases: assigned,
      emailsReceived: received,
      emailsSent: sent,
      avgResponseMinutes: avg.mins === null || avg.mins === undefined ? null : Math.round(avg.mins),
      admissionsCompleted: completed,
    };
  });
}


// ── Unanswered email detection (feature 1) ───────────────────────────────
export function unansweredCases(repo: Repo, schools?: string[] | null): Array<{ applicant: ApplicantRow; lastInAt: string; hours: number }> {
  // Any outgoing email (automated or human) counts as "answered" — that is
  // the specified behavior (a factual auto-reply IS a reply). Batched into
  // one query; previously repo ran one query per applicant (N+1).
  const rows = repo.db
    .prepare(
      `SELECT a.id AS aid, MAX(e.at) AS last_in
       FROM applicants a
       JOIN emails e ON e.applicant_id = a.id AND e.direction = 'in'
       WHERE a.lifecycle NOT IN ('completed')${scopePred("a", schools).sql}
       GROUP BY a.id`
    )
    .all(...scopePred("a", schools).params) as Array<{ aid: number; last_in: string }>;
  if (rows.length === 0) return [];
  const replies = repo.db
    .prepare(
      `SELECT applicant_id, MAX(at) AS last_out
       FROM emails
       WHERE direction = 'out' AND applicant_id IN (${rows.map(() => "?").join(",")})
       GROUP BY applicant_id`
    )
    .all(...rows.map((r) => r.aid)) as Array<{ applicant_id: number; last_out: string }>;
  const lastOut = new Map(replies.map((r) => [r.applicant_id, r.last_out]));
  const out: Array<{ applicant: ApplicantRow; lastInAt: string; hours: number }> = [];
  const now = Date.now();
  for (const r of rows) {
    const outAt = lastOut.get(r.aid);
    if (outAt && outAt >= r.last_in) continue;
    const a = repo.getApplicant(r.aid);
    if (!a) continue;
    out.push({ applicant: a, lastInAt: r.last_in, hours: Math.max(0, Math.round((now - new Date(r.last_in).getTime()) / 3600_000)) });
  }
  return out.sort((x, y) => y.hours - x.hours);
}


// ── Analytics (features 28–31) ───────────────────────────────────────────
export function categoryCounts(repo: Repo, schools?: string[] | null): Array<{ category: string; n: number }> {
  const scope = scopePred("a", schools);
  return repo.db
    .prepare(
      `SELECT coalesce(e.category,'other') AS category, COUNT(*) AS n
       FROM emails e JOIN applicants a ON a.id = e.applicant_id
       WHERE e.direction = 'in'${scope.sql} GROUP BY e.category ORDER BY n DESC`
    )
    .all(...scope.params) as never[];
}


/** Round 10: the three current markings per case (applicants.triage),
 *  realm- and school-scoped like every other dashboard number. */
export function triageCounts(repo: Repo, demo?: number, schools?: string[] | null): { green: number; orange: number; red: number } {
  const scope = scopePred("a", schools);
  const dp: unknown[] = demo === undefined ? [...scope.params] : [demo, ...scope.params];
  const pred = (demo === undefined ? "" : " AND a.demo = ?") + scope.sql;
  const one = (sql: string) => (repo.db.prepare(sql).get(...dp) as { n: number }).n;
  return {
    green: one(`SELECT COUNT(*) AS n FROM applicants a WHERE a.triage = 'Green'${pred}`),
    orange: one(`SELECT COUNT(*) AS n FROM applicants a WHERE a.triage = 'Orange'${pred}`),
    red: one(`SELECT COUNT(*) AS n FROM applicants a WHERE a.triage = 'Red'${pred}`),
  };
}


export function accuracyStats(repo: Repo, demo?: number, schools?: string[] | null): Record<string, number> {
  const scope = scopePred("a", schools);
  const dp: unknown[] = demo === undefined ? [...scope.params] : [demo, ...scope.params];
  const pred = (demo === undefined ? "" : " AND a.demo = ?") + scope.sql;
  const one = (sql: string) => (repo.db.prepare(sql).get(...dp) as { n: number }).n;
  return {
    greenCases: one(`SELECT COUNT(*) AS n FROM decision_logs d JOIN applicants a ON a.id = d.applicant_id WHERE d.computed_status = 'Green'${pred}`),
    watcherCatches: one(`SELECT COUNT(*) AS n FROM audit_log l JOIN applicants a ON a.id = l.applicant_id WHERE l.event = 'watcher_downgrade'${pred}`),
    humanOverrides: one(`SELECT COUNT(*) AS n FROM audit_log l JOIN applicants a ON a.id = l.applicant_id WHERE l.event = 'human_override'${pred}`),
    sendErrors: one(`SELECT COUNT(*) AS n FROM audit_log l JOIN applicants a ON a.id = l.applicant_id WHERE l.event = 'send_failed'${pred}`),
    autoSends: one(`SELECT COUNT(*) AS n FROM emails e JOIN applicants a ON a.id = e.applicant_id WHERE e.direction = 'out' AND e.auto = 1${pred}`),
    humanSends: one(`SELECT COUNT(*) AS n FROM emails e JOIN applicants a ON a.id = e.applicant_id WHERE e.direction = 'out' AND e.auto = 0${pred}`),
    reopened: one(`SELECT COUNT(*) AS n FROM audit_log l JOIN applicants a ON a.id = l.applicant_id WHERE l.event = 'case_reopened'${pred}`),
  };
}
