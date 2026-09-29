/**
 * /db/repo — Phase 12 admin security console queries.
 *
 * Every query is scoped to ONE organization in SQL (never in the page):
 * the caller's `staff.organization_id ?? 1`. Cross-org rows are excluded
 * by INNER JOINs, so an unattributable row (NULL applicant, unknown staff)
 * can never leak into another org's console — the same isolation property
 * as applicantVisibleTo, enforced at the data layer.
 *
 * Timestamps come in two formats (SQLite `datetime('now')` and ISO-8601),
 * so range filters compare via `datetime()` which parses both. `since` is
 * an inclusive lower bound; undefined = all time.
 */
import type { Repo } from "../repo";

/** Org predicate for applicant-joined rows (applicants aliased `a`). */
const ORG_APPLICANT = "COALESCE(a.organization_id, 1) = ?";
/** Org predicate for staff-joined rows (staff_users aliased `u`). */
const ORG_STAFF = "COALESCE(u.organization_id, 1) = ?";

function sinceSql(col: string, since: string | undefined, params: unknown[]): string {
  if (since === undefined) return "";
  params.push(since);
  return ` AND datetime(${col}) >= datetime(?)`;
}

// ── 1. Logins ────────────────────────────────────────────────────────────
export interface ConsoleLoginRow {
  actor: string;
  display_name: string;
  event: "staff_login" | "staff_login_failed" | "staff_login_blocked";
  at: string;
  detail: string;
}

/**
 * Auth events for the org's staff, newest first. Failed attempts + IPs are
 * recorded by the login route (Phase 12); older rows predate them, so
 * `detail` may be empty. Joining staff_users on the actor both resolves
 * display names AND enforces the org boundary.
 */
export function consoleLogins(repo: Repo, orgId: number, since?: string): ConsoleLoginRow[] {
  const params: unknown[] = [orgId];
  const rows = repo.db
    .prepare(
      `SELECT l.actor AS actor, u.display_name AS display_name, l.event AS event,
              l.at AS at, l.detail AS detail
       FROM audit_log l JOIN staff_users u ON u.username = l.actor
       WHERE l.event IN ('staff_login', 'staff_login_failed', 'staff_login_blocked') AND ${ORG_STAFF}
       ${sinceSql("l.at", since, params)}
       ORDER BY l.id DESC LIMIT 500`
    )
    .all(...params) as ConsoleLoginRow[];
  return rows;
}

/** Failed-login counts per staff member (repeated-failure surfacing). */
export function consoleLoginFailCounts(
  repo: Repo, orgId: number, since?: string
): Array<{ actor: string; display_name: string; fails: number; last_at: string }> {
  const params: unknown[] = [orgId];
  return repo.db
    .prepare(
      `SELECT l.actor AS actor, u.display_name AS display_name,
              COUNT(*) AS fails, MAX(l.at) AS last_at
       FROM audit_log l JOIN staff_users u ON u.username = l.actor
       WHERE l.event = 'staff_login_failed' AND ${ORG_STAFF}
       ${sinceSql("l.at", since, params)}
       GROUP BY l.actor ORDER BY fails DESC`
    )
    .all(...params) as Array<{ actor: string; display_name: string; fails: number; last_at: string }>;
}

// ── 2. Runs ──────────────────────────────────────────────────────────────
export interface ConsoleRunRow {
  id: number;
  applicant_id: number;
  ref_number: string;
  computed_status: string;
  reasoning: string;
  auto_sent: boolean;
  timestamp: string;
  /** Seconds from email arrival to recorded decision; null when the triggering email isn't found. */
  latency_secs: number | null;
  subject: string | null;
}

/**
 * Pipeline runs for the org's cases, newest first. "How long it took" is
 * decision latency (email arrival → recorded decision) from existing
 * timestamps — no new per-run timer was added.
 */
export function consoleRuns(repo: Repo, orgId: number, since?: string): ConsoleRunRow[] {
  const params: unknown[] = [orgId];
  const rows = repo.db
    .prepare(
      `SELECT d.id AS id, d.applicant_id AS applicant_id, a.ref_number AS ref_number,
              d.computed_status AS computed_status, d.reasoning AS reasoning,
              d.auto_sent AS auto_sent, d.timestamp AS timestamp,
              (strftime('%s', d.timestamp) - strftime('%s', e.at)) AS latency_secs,
              e.subject AS subject
       FROM decision_logs d JOIN applicants a ON a.id = d.applicant_id
       LEFT JOIN emails e ON e.message_id = d.triggering_email_id
       WHERE ${ORG_APPLICANT}${sinceSql("d.timestamp", since, params)}
       ORDER BY d.id DESC LIMIT 500`
    )
    .all(...params) as Array<Omit<ConsoleRunRow, "auto_sent"> & { auto_sent: number }>;
  return rows.map((r) => ({ ...r, auto_sent: r.auto_sent === 1 }));
}

// ── 3. Crashes / errors ──────────────────────────────────────────────────
/** Audit events that mean something went wrong (all applicant-attributed). */
export const CONSOLE_ERROR_EVENTS = [
  "send_failed",
  "followup_send_failed",
  "evaluation_rerun_failed",
  "structured_snapshot_corrupt",
  "admission_rules_snapshot_corrupt",
  "pack_incomplete",
  "cross_doc_inconsistency",
  "gmail_sync_failed",
  "gmail_connect_failed",
  "gmail_test_failed",
  "gemini_test_failed",
  "escalated",
] as const;

export interface ConsoleErrorRow {
  at: string;
  actor: string;
  event: string;
  detail: string;
  applicant_id: number;
  ref_number: string;
}

export function consoleErrors(repo: Repo, orgId: number, since?: string): ConsoleErrorRow[] {
  // Param order must match the SQL: IN-list, org, since.
  const params: unknown[] = [...CONSOLE_ERROR_EVENTS];
  const placeholders = CONSOLE_ERROR_EVENTS.map(() => "?").join(",");
  params.push(orgId);
  return repo.db
    .prepare(
      `SELECT l.at AS at, l.actor AS actor, l.event AS event, l.detail AS detail,
              l.applicant_id AS applicant_id, a.ref_number AS ref_number
       FROM audit_log l JOIN applicants a ON a.id = l.applicant_id
       WHERE l.event IN (${placeholders}) AND ${ORG_APPLICANT}
       ${sinceSql("l.at", since, params)}
       ORDER BY l.id DESC LIMIT 500`
    )
    .all(...params) as ConsoleErrorRow[];
}

export interface ConsoleAlertRow {
  at: string;
  kind: string;
  message: string;
  applicant_id: number;
  ref_number: string;
}

/** Failure-ish notifications tied to the org's cases (escalations, review-needed). */
export function consoleAlerts(repo: Repo, orgId: number, since?: string): ConsoleAlertRow[] {
  const params: unknown[] = [orgId];
  return repo.db
    .prepare(
      `SELECT n.at AS at, n.kind AS kind, n.message AS message,
              n.applicant_id AS applicant_id, a.ref_number AS ref_number
       FROM notifications n JOIN applicants a ON a.id = n.applicant_id
       WHERE n.kind IN ('escalation', 'review_needed') AND ${ORG_APPLICANT}
       ${sinceSql("n.at", since, params)}
       ORDER BY n.id DESC LIMIT 200`
    )
    .all(...params) as ConsoleAlertRow[];
}

// ── 4. Case-tampering signals ────────────────────────────────────────────
export interface ConsoleTamperRow {
  applicant_id: number;
  ref_number: string;
  signal: "multi_decision" | "no_trail" | "unpermitted_actor" | "unknown_actor";
  detail: string;
  at: string | null;
}

/**
 * Outcome-integrity signals from decision provenance (no new tracking):
 * - multi_decision: more than one human-recorded outcome on the case.
 * - no_trail: a recorded outcome with no matching audit (human outcome
 *   without human_admission_decision, auto outcome without the auto trail).
 * - unpermitted_actor / unknown_actor: resolved in TypeScript (needs
 *   hasPermission), see consoleTamperActors.
 */
export function consoleTamperOutcomes(repo: Repo, orgId: number): ConsoleTamperRow[] {
  const out: ConsoleTamperRow[] = [];
  const decided = repo.db
    .prepare(
      `SELECT a.id AS applicant_id, a.ref_number AS ref_number,
              a.admission_decision AS admission_decision,
              a.admission_route AS admission_route,
              a.decision_by AS decision_by, a.decision_at AS decision_at,
              (SELECT COUNT(*) FROM audit_log l WHERE l.applicant_id = a.id AND l.event = 'human_admission_decision') AS human_n,
              (SELECT COUNT(*) FROM audit_log l WHERE l.applicant_id = a.id AND l.event IN ('auto_admission_triggered', 'admission_auto_qualified')) AS auto_n
       FROM applicants a WHERE ${ORG_APPLICANT} AND a.admission_decision IS NOT NULL
       ORDER BY a.id DESC LIMIT 500`
    )
    .all(orgId) as Array<{
      applicant_id: number; ref_number: string; admission_decision: string;
      admission_route: string | null; decision_by: string | null; decision_at: string | null;
      human_n: number; auto_n: number;
    }>;
  for (const d of decided) {
    if (d.human_n > 1) {
      out.push({
        applicant_id: d.applicant_id, ref_number: d.ref_number, signal: "multi_decision",
        detail: `outcome recorded ${d.human_n} times by staff (latest: ${d.decision_by ?? "?"})`,
        at: d.decision_at,
      });
    }
    if (d.admission_route === "human" && d.human_n === 0) {
      out.push({
        applicant_id: d.applicant_id, ref_number: d.ref_number, signal: "no_trail",
        detail: `human outcome "${d.admission_decision}" with no human_admission_decision audit — changed outside the decision flow`,
        at: d.decision_at,
      });
    }
    if (d.admission_route === "auto" && d.auto_n === 0) {
      out.push({
        applicant_id: d.applicant_id, ref_number: d.ref_number, signal: "no_trail",
        detail: `auto outcome "${d.admission_decision}" with no auto-admission audit — changed outside the decision flow`,
        at: d.decision_at,
      });
    }
  }
  return out;
}

/** Human decisions whose actor lacks the record_outcome permission (or is unknown). */
export function consoleTamperActors(repo: Repo, orgId: number): ConsoleTamperRow[] {
  const out: ConsoleTamperRow[] = [];
  const rows = repo.db
    .prepare(
      `SELECT l.applicant_id AS applicant_id, a.ref_number AS ref_number,
              l.actor AS actor, l.detail AS detail, l.at AS at
       FROM audit_log l JOIN applicants a ON a.id = l.applicant_id
       WHERE l.event = 'human_admission_decision' AND ${ORG_APPLICANT}
       ORDER BY l.id DESC LIMIT 500`
    )
    .all(orgId) as Array<{ applicant_id: number; ref_number: string; actor: string; detail: string; at: string }>;
  for (const r of rows) {
    const staff = repo.getStaffByUsername(r.actor);
    if (!staff || (staff.organization_id ?? 1) !== orgId) {
      out.push({
        applicant_id: r.applicant_id, ref_number: r.ref_number, signal: "unknown_actor",
        detail: `decided by "${r.actor}" — no staff account by that name in this org`,
        at: r.at,
      });
    } else if (!repo.hasPermission(staff.id, "record_outcome")) {
      out.push({
        applicant_id: r.applicant_id, ref_number: r.ref_number, signal: "unpermitted_actor",
        detail: `decided by "${r.actor}" who lacks the record_outcome permission`,
        at: r.at,
      });
    }
  }
  return out;
}

// ── 5. External service health (per-org Gemini) ──────────────────────────
export interface ConsoleVisionRow {
  applicant_id: number;
  ref_number: string;
  received_at: string;
  document_type: string;
  method: string;
  note: string;
}

/** Vision attempts in range: successes (method) + failures (note prefix). */
export function consoleVisionAttempts(repo: Repo, orgId: number, since?: string): ConsoleVisionRow[] {
  const params: unknown[] = [orgId];
  return repo.db
    .prepare(
      `SELECT d.applicant_id AS applicant_id, a.ref_number AS ref_number,
              d.received_at AS received_at, d.document_type AS document_type,
              d.extraction_method AS method, d.extraction_note AS note
       FROM documents d JOIN applicants a ON a.id = d.applicant_id
       WHERE ${ORG_APPLICANT}
         AND (d.extraction_method = 'gemini_vision' OR d.extraction_note LIKE 'Vision model unavailable%')
       ${sinceSql("d.received_at", since, params)}
       ORDER BY d.id DESC LIMIT 1000`
    )
    .all(...params) as ConsoleVisionRow[];
}

export interface ConsoleRoutingRow {
  applicant_id: number;
  ref_number: string;
  result: string;
  routing: string;
  reason_code: string;
  evaluated_at: string;
}

/** Evaluation routings in range (is the human-review fallback firing?). */
export function consoleRoutings(repo: Repo, orgId: number, since?: string): ConsoleRoutingRow[] {
  const params: unknown[] = [orgId];
  return repo.db
    .prepare(
      `SELECT e.applicant_id AS applicant_id, a.ref_number AS ref_number,
              e.result AS result, e.routing AS routing,
              e.reason_code AS reason_code, e.evaluated_at AS evaluated_at
       FROM evaluations e JOIN applicants a ON a.id = e.applicant_id
       WHERE ${ORG_APPLICANT}${sinceSql("e.evaluated_at", since, params)}
       ORDER BY e.id DESC LIMIT 1000`
    )
    .all(...params) as ConsoleRoutingRow[];
}

/** Fallback-firing audits in range (human_review_triggered for org cases). */
export function consoleFallbackTriggers(repo: Repo, orgId: number, since?: string): ConsoleErrorRow[] {
  const params: unknown[] = [orgId];
  return repo.db
    .prepare(
      `SELECT l.at AS at, l.actor AS actor, l.event AS event, l.detail AS detail,
              l.applicant_id AS applicant_id, a.ref_number AS ref_number
       FROM audit_log l JOIN applicants a ON a.id = l.applicant_id
       WHERE l.event = 'human_review_triggered' AND ${ORG_APPLICANT}
       ${sinceSql("l.at", since, params)}
       ORDER BY l.id DESC LIMIT 500`
    )
    .all(...params) as ConsoleErrorRow[];
}
