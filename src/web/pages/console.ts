/**
 * Phase 12: per-org admin security console (monitoring only — no actions).
 *
 * All data comes from existing logs (audit_log, decision_logs,
 * evaluations, documents, notifications, metric_daily) through the
 * org-scoped queries in src/db/repo/console.ts. Rows link out to their
 * case; applicant content is never dumped here beyond short excerpts the
 * admin could already see on the case/mail pages.
 */
import { badge, emptyState, html, raw } from "../tpl";
import { fmtDate } from "../views";
import { head, type Ctx } from "./shared";

export type ConsoleRange = "24h" | "7d" | "30d" | "all" | "custom";

export interface ConsoleQuery {
  range: ConsoleRange;
  from: string;
  to: string;
}

/** Map the range UI to inclusive [since, until] bounds (undefined = open). */
export function consoleBounds(q: ConsoleQuery, now = Date.now()): { since?: string; until?: string } {
  const day = 24 * 3600_000;
  if (q.range === "24h") return { since: new Date(now - day).toISOString() };
  if (q.range === "7d") return { since: new Date(now - 7 * day).toISOString() };
  if (q.range === "30d") return { since: new Date(now - 30 * day).toISOString() };
  if (q.range === "custom") {
    const ok = /^\d{4}-\d{2}-\d{2}$/;
    const since = ok.test(q.from) ? `${q.from}T00:00:00.000Z` : undefined;
    const until = ok.test(q.to) ? `${q.to}T23:59:59.999Z` : undefined;
    return since || until ? { since, until } : {};
  }
  return {};
}

function trunc(s: string | null, n: number): string {
  if (!s) return "—";
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function fmtSecs(s: number | null): string {
  if (s === null || s === undefined || s < 0) return "—";
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function fmtMs(ms: number): string {
  if (ms <= 0) return "—";
  return fmtSecs(ms / 1000);
}

function ipOf(detail: string): string {
  const m = /^ip=(\S+)/.exec(detail || "");
  return m ? m[1] : "—";
}

function visionKind(note: string): string {
  return (/Vision model unavailable \((\w+)\)/.exec(note || "") || [])[1] ?? "?";
}

const TAMPER_LABEL: Record<string, string> = {
  multi_decision: "decided more than once",
  no_trail: "outcome outside decision flow",
  unpermitted_actor: "decider lacks permission",
  unknown_actor: "decider unknown",
};

export function consolePage(c: Ctx, orgId: number, orgName: string, q: ConsoleQuery): string {
  const { repo } = c;
  const { since, until } = consoleBounds(q);
  const logins = repo.consoleLogins(orgId, since, until);
  const failCounts = repo.consoleLoginFailCounts(orgId, since, until);
  const runs = repo.consoleRuns(orgId, since, until);
  const durDays = q.range === "24h" ? 1 : q.range === "7d" ? 7 : 30;
  const dur = repo.consoleOrgDuration(orgId, durDays);
  const errors = repo.consoleErrors(orgId, since, until);
  const alerts = repo.consoleAlerts(orgId, since, until);
  const tampers = [...repo.consoleTamperOutcomes(orgId), ...repo.consoleTamperActors(orgId)];
  const vision = repo.consoleVisionAttempts(orgId, since, until);
  const routings = repo.consoleRoutings(orgId, since, until);
  const triggers = repo.consoleFallbackTriggers(orgId, since, until);

  const rangeLink = (key: ConsoleRange, label: string): string =>
    html`<a class="btn small ${q.range === key ? "" : "ghost"}" href="/console?range=${key}">${label}</a>`;

  const loginRows = logins.map((l) => {
    const tone = l.event === "staff_login" ? "green" : l.event === "staff_login_failed" ? "orange" : "red";
    const label = l.event === "staff_login" ? "success" : l.event === "staff_login_failed" ? "failed" : "blocked";
    return html`<tr><td class="small nowrap">${fmtDate(l.at)}</td><td>${l.display_name} <span class="muted small">${l.actor}</span></td>
      <td>${badge(tone, label)}</td><td class="mono small">${ipOf(l.detail)}</td></tr>`;
  }).join("");
  const failCallout = failCounts.length
    ? html`<p>${failCounts.map((f) => badge("red", `${f.actor}: ${f.fails} failed`)).join(" ")}</p>`
    : "";

  const latencies = runs.map((r) => r.latency_secs).filter((s): s is number => s !== null && s >= 0);
  const avgLatency = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null;
  const autoN = runs.filter((r) => r.auto_sent).length;
  const runRows = runs.map((r) => html`<tr><td class="small nowrap">${fmtDate(r.timestamp)}</td>
    <td><a href="/case/${r.applicant_id}"><span class="mono">${r.ref_number}</span></a></td>
    <td>${badge(r.computed_status === "Green" ? "green" : r.computed_status === "Orange" ? "orange" : "red", r.computed_status)}</td>
    <td>${r.auto_sent ? badge("green", "auto") : badge("gray", "held")}</td>
    <td class="small nowrap">${fmtSecs(r.latency_secs)}</td><td class="small">${trunc(r.subject, 60)}</td></tr>`).join("");

  const errorRows = errors.map((e) => html`<tr><td class="small nowrap">${fmtDate(e.at)}</td>
    <td><a href="/case/${e.applicant_id}"><span class="mono">${e.ref_number}</span></a></td>
    <td><span class="mono small">${e.event}</span></td><td class="small">${e.actor}</td>
    <td class="small">${trunc(e.detail, 120)}</td></tr>`).join("");
  const alertRows = alerts.map((a) => html`<tr><td class="small nowrap">${fmtDate(a.at)}</td>
    <td><a href="/case/${a.applicant_id}"><span class="mono">${a.ref_number}</span></a></td>
    <td>${badge(a.kind === "escalation" ? "red" : "orange", a.kind)}</td><td class="small">${trunc(a.message, 120)}</td></tr>`).join("");

  const tamperRows = tampers.map((t) => html`<tr><td><a href="/case/${t.applicant_id}"><span class="mono">${t.ref_number}</span></a></td>
    <td>${badge("red", TAMPER_LABEL[t.signal] ?? t.signal)}</td><td class="small">${t.detail}</td>
    <td class="small nowrap">${t.at ? fmtDate(t.at) : "—"}</td></tr>`).join("");

  const vFailures = vision.filter((v) => v.note.startsWith("Vision model unavailable"));
  const vRate = vision.length ? Math.round((vFailures.length / vision.length) * 100) : 0;
  const kindCounts = new Map<string, number>();
  for (const v of vFailures) kindCounts.set(visionKind(v.note), (kindCounts.get(visionKind(v.note)) ?? 0) + 1);
  const failAppIds = new Set(vFailures.map((v) => v.applicant_id));
  const coveredAppIds = new Set([
    ...routings.filter((r) => r.routing === "human_review").map((r) => r.applicant_id),
    ...triggers.map((t) => t.applicant_id),
  ]);
  const covered = [...failAppIds].filter((id) => coveredAppIds.has(id)).length;
  const firePct = failAppIds.size ? Math.round((covered / failAppIds.size) * 100) : 100;
  const humanRoutings = routings.filter((r) => r.routing === "human_review").length;
  const autoRoutings = routings.filter((r) => r.routing === "auto_admit").length;
  const visionRows = vFailures.slice(0, 100).map((v) => html`<tr><td class="small nowrap">${fmtDate(v.received_at)}</td>
    <td><a href="/case/${v.applicant_id}"><span class="mono">${v.ref_number}</span></a></td>
    <td>${badge("orange", visionKind(v.note))}</td><td class="small">${v.document_type}</td></tr>`).join("");

  const content = html`
  <div class="page-head"><div><h1>Security console</h1>
    <p class="sub">Monitoring for <b>${orgName}</b> — logins, runs, errors, outcome integrity, service health. Read-only.</p></div></div>
  <div class="card"><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
    ${raw(rangeLink("24h", "Last 24h") + rangeLink("7d", "Last 7d") + rangeLink("30d", "Last 30d") + rangeLink("all", "All time"))}
    <form method="get" action="/console" style="display:flex;gap:6px;margin:0 0 0 auto;align-items:center">
      <input type="hidden" name="range" value="custom">
      <input type="date" name="from" value="${q.from}" aria-label="From" style="width:auto">
      <span class="muted small">to</span>
      <input type="date" name="to" value="${q.to}" aria-label="To" style="width:auto">
      <button class="btn small">Apply</button>
    </form>
  </div></div>

  <div class="card" id="logins"><h2>Logins</h2>
    ${raw(failCallout)}
    ${raw(logins.length ? `<table><tr><th>When</th><th>Who</th><th>Result</th><th>IP</th></tr>${loginRows}</table>`
      : emptyState(`<p>No sign-in events in this range.</p>`))}
    <p class="small muted">Attempts under unknown usernames can't be attributed to an org and are excluded entirely — there is deliberately no global attack-traffic signal here.</p>
  </div>

  <div class="card" id="runs"><h2>Runs</h2>
    <p class="small muted">${runs.length} runs · ${autoN} auto-sent · avg decision latency ${fmtSecs(avgLatency)} · avg processing ${fmtMs(dur.avgMs)} over ${dur.n} timed runs (last ${durDays}d)</p>
    ${raw(runs.length ? `<table><tr><th>When</th><th>Case</th><th>Decision</th><th>Reply</th><th>Latency</th><th>Email</th></tr>${runRows}</table>`
      : emptyState(`<p>No pipeline runs in this range.</p>`))}
  </div>

  <div class="card" id="errors"><h2>Crashes &amp; errors</h2>
    ${raw(errors.length ? `<table><tr><th>When</th><th>Case</th><th>Error</th><th>Actor</th><th>Detail</th></tr>${errorRows}</table>`
      : emptyState(`<p>No case errors recorded in this range.</p>`))}
    <h3 style="margin-top:16px">Alerts</h3>
    ${raw(alerts.length ? `<table><tr><th>When</th><th>Case</th><th>Kind</th><th>Message</th></tr>${alertRows}</table>`
      : emptyState(`<p>No escalations or review requests in this range.</p>`))}
  </div>

  <div class="card" id="tampering"><h2>Case-tampering signals</h2>
    <p class="small muted">All-time (not range-filtered): outcomes decided more than once, outcomes with no decision-flow trail, deciders without the record_outcome permission.</p>
    ${raw(tampers.length ? `<table><tr><th>Case</th><th>Signal</th><th>Detail</th><th>When</th></tr>${tamperRows}</table>`
      : emptyState(`<p>No outcome-integrity signals. Every recorded outcome has exactly one in-flow trail.</p>`))}
  </div>

  <div class="card" id="health"><h2>External service health</h2>
    <p>Gemini failure rate: <b>${vRate}%</b> <span class="muted small">(${vFailures.length} of ${vision.length} vision attempts)</span>
    ${raw([...kindCounts].map(([k, n]) => badge("orange", `${k}: ${n}`)).join(" "))}</p>
    <p>Human-review fallback: <b>${firePct}%</b> <span class="muted small">(${covered} of ${failAppIds.size} failure cases routed/triggered to human review in range; ${humanRoutings} human routings, ${triggers.length} triggers, ${autoRoutings} auto-admits)</span></p>
    ${raw(vFailures.length ? `<table><tr><th>When</th><th>Case</th><th>Failure</th><th>Document</th></tr>${visionRows}</table>`
      : emptyState(`<p>No vision failures in this range.</p>`))}
  </div>`;
  return head(c, `Security console — ${orgName}`, "console", content);
}
