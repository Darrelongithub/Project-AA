/**
 * Page renderers — every page is built server-side from the database.
 * Single source of truth: nothing is rendered that isn't in the DB.
 */
import { documentRequirementsFor, type ProgrammeLevel } from "../documents/matrix";
import type { Repo } from "../db/repo";
import type { AdmissionSystem, ApplicantRow, CourseLevel, Programme, RuleNode, StaffUser } from "../types";
import { ADMISSION_SYSTEMS, EMAIL_CATEGORY_LABELS, LIFECYCLE_LABELS, LIFECYCLE_ORDER } from "../types";
import { SYSTEM_LABELS } from "../admissions/systems";
import { QUEUES, SUB_LABELS, queueOf, type QueueKey } from "../admissions/queues";
import { describeRuleTree, interpretRuleTree } from "../admissions/engine";
import { docLabel } from "../rules";
import { renderTemplate } from "../drafting";
import { EXAM_SYSTEMS } from "../config";
import { packManifest } from "../pack";
import {
  avatar, categoryBadge, crest, esc, flagLabel, flowLine, fmtDate, gaugeRow,
  heroClock, layout, lifecycleBadge, lifecycleStepper, priorityBadge, readabilityScore, slaText, triageBadge, type Theme,
} from "./views";

interface Ctx {
  repo: Repo;
  user: StaffUser;
  unread: number;
  csrf: string;
  theme?: Theme;
  /** Fixed institution name — there is no settings field for it. */
  institution: string;
}

function head(c: Ctx, title: string, active: string, content: string): string {
  return layout({ title, content, user: c.user, unread: c.unread, active, csrf: c.csrf, theme: c.theme, institution: c.institution });
}

/** "it" → "IT", else first-letter title: polite, readable labels. */
export function capFirst(s: string): string {
  if (s.toLowerCase() === "it") return "IT";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Alert kinds arrive as snake_case — staff read words, not tokens. */
export function kindLabel(kind: string): string {
  const known: Record<string, string> = {
    review_needed: "Review needed", escalation: "Escalation", assignment: "Assignment",
  };
  return known[kind] ?? capFirst(kind.replace(/_/g, " "));
}

/** Stable school grouping for course lists. */
function groupBySchool<T extends { code: string; school?: string | null }>(rows: T[]): Array<[string, T[]]> {
  const out: Array<[string, T[]]> = [];
  for (const r of rows) {
    const key = r.school || "Other programmes";
    const last = out[out.length - 1];
    if (last && last[0] === key) last[1].push(r);
    else out.push([key, [r]]);
  }
  return out;
}

// ── Login ──────────────────────────────────────────────────────────────────

export function loginPage(error?: string, theme?: Theme, institution = "Riara University", loginCsrf?: string): string {
  return layout({
    title: `Sign in — ${institution}`,
    institution,
    publicPage: true,
    theme,
    content: `
<div class="loginbox card">
  ${crest(58)}
  <h1 class="center">Sign in</h1>
  <p class="sub center">${esc(institution)} · Automated admissions</p>
  ${error ? `<div class="flash err" style="position:static;margin-bottom:14px">${esc(error)}</div>` : ""}
  <form method="post" action="/login">
    ${loginCsrf ? `<input type="hidden" name="_lcsrf" value="${esc(loginCsrf)}">` : ""}
    <label>Username</label>
    <input type="text" name="username" autofocus autocomplete="username" placeholder="your.username">
    <label>Password</label>
    <input type="password" name="password" autocomplete="current-password" placeholder="••••••••">
    <p style="margin-top:18px"><button class="btn" style="width:100%">Sign in to the console</button></p>
  </form>
  <p class="small muted center">Accounts are provisioned by your administrator.</p>
</div>`,
  });
}


/** OR-1: one-time first-run screen — the owner creates their own admin account. */
export function setupPage(token: string, error?: string, theme?: Theme, institution = "Riara University"): string {
  return layout({
    title: `First-run setup — ${institution}`,
    institution,
    publicPage: true,
    theme,
    content: `
<div class="loginbox card">
  ${crest(58)}
  <h1 class="center">Welcome to ${esc(institution)}</h1>
  <p class="sub center">This is a fresh installation. Create the administrator account — you will not see this screen again.</p>
  ${error ? `<div class="flash err" style="position:static;margin-bottom:14px">${esc(error)}</div>` : ""}
  <form method="post" action="/setup">
    <input type="hidden" name="_setup" value="${token}">
    <label>Your name</label>
    <input type="text" name="display_name" autofocus autocomplete="name" placeholder="e.g. Darrel">
    <label>Username</label>
    <input type="text" name="username" autocomplete="username" placeholder="your.username">
    <label>Password (at least 8 characters)</label>
    <input type="password" name="password" autocomplete="new-password" placeholder="••••••••">
    <label>Confirm password</label>
    <input type="password" name="confirm" autocomplete="new-password" placeholder="••••••••">
    <p style="margin-top:18px"><button class="btn" style="width:100%">Create administrator account</button></p>
  </form>
</div>`,
  });
}


// ── Overview landing views ─────────────────────────────────────────────────
// Admins land on administration: courses, ownership, activity, system status.
// Managers/officers land on their casework command center, alerts included.

/** First name for the greeting — empty when the account has no personal name. */
function firstName(display: string): string {
  const w = (display || "").trim().split(/\s+/)[0] || "";
  return w === "System" ? "" : w;
}

function greeting(): string {
  const hour = new Date().getHours();
  return hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
}

function adminDashboard(c: Ctx): string {
  const { repo } = c;
  const realm = c.user.demo; // live admins see only live data; demo accounts only mock data.
  // OR-8: admins are never scoped, but the same code path serves scoped
  // accounts — visibility is decided in ONE place (repo.visibleSchoolsFor).
  const scope = repo.visibleSchoolsFor(c.user);
  const s = repo.dashboardStats(realm, scope);
  const stage = repo.stageCounts(realm, scope);
  const team = repo.staffStats(realm).filter((t) => t.demo === realm);
  const alerts = repo.notificationsFor(c.user.id, 6, realm, scope);
  const all = repo.allApplicants(realm, scope);
  const gmailConnected = Boolean(repo.getSetting("gmail_refresh_token", ""));
  const lastSync = repo.getSetting("gmail_last_sync_at", "");
  const globalMode = repo.getSetting("automation_mode", "auto");

  const applications = Number(s.applications);
  const completed = Number(s.completed);
  const completion = applications > 0 ? Math.round((completed / applications) * 100) : null;

  // Team performance — the same numbers a staff member sees, per person.
  const teamRows = team
    .map((t) => `<tr${t.active ? "" : ' class="muted"'}>
      <td><div class="nameline">${avatar(t.display_name, 26)}<span><b>${esc(t.display_name)}</b><br><span class="muted small">${esc(capFirst(t.role))}${t.active ? "" : " · deactivated"}</span></span></div></td>
      <td>${t.assignedCases}</td>
      <td>${t.emailsReceived} in · ${t.emailsSent} out</td>
      <td>${t.avgResponseMinutes !== null ? `${t.avgResponseMinutes} min` : "—"}</td>
      <td>${t.admissionsCompleted}</td>
    </tr>`)
    .join("");

  // Approvals: completed files with WHO completed them and when — real,
  // attributable work, not vanity counts.
  const completedFiles = all
    .filter((a) => a.lifecycle === "completed")
    .slice(0, 12)
    .map((a) => {
      const appr = repo.approverFor(a.id);
      const decision = a.admission_decision === "auto_admitted"
        ? `<span class="badge b-green">auto-admitted</span>`
        : a.admission_decision === "admitted_after_review"
          ? `<span class="badge b-purple">admitted after review</span>`
          : a.admission_decision === "not_admitted"
            ? `<span class="badge b-red">not admitted</span>`
            : "";
      return `<tr>
        <td class="mono"><a href="/case/${a.id}">${esc(a.ref_number)}</a></td>
        <td>${esc(a.full_name ?? "—")}</td>
        <td>${esc(a.programme ?? "—")}</td>
        <td class="small">${decision || esc(appr?.actor ?? "—")}</td>
        <td class="small nowrap muted">${esc(fmtDate(appr?.at ?? a.updated_at))}</td>
      </tr>`;
    })
    .join("");

  const alertRows = alerts
    .map((n) => `<div class="feed-row ${n.read ? "read" : ""}">
      <span class="badge ${n.kind === "escalation" ? "b-red" : n.kind === "review_needed" ? "b-orange" : n.kind === "auto_admission" ? "b-green" : "b-blue"}">${esc(kindLabel(n.kind))}</span>
      <span class="feed-msg">${esc(n.message)}</span>
      ${n.applicant_id ? `<a class="small nowrap" href="/case/${n.applicant_id}">open →</a>` : ""}
      <span class="feed-when right">${esc(fmtDate(n.at))}</span>
    </div>`)
    .join("");

  return head(
    c,
    `Overview — ${c.institution}`,
    "dashboard",
    `
<div class="hero hero-center">
  <div>
    <div class="kicker">Administration</div>
    <h1>${greeting()}${firstName(c.user.display_name) ? ", " + esc(firstName(c.user.display_name)) : ""}.</h1>
    <p class="lede">Everything worth knowing is right here.</p>
  </div>
  ${heroClock()}
</div>

<section class="card">
  <h2>Totals <span class="small muted" style="text-transform:none;letter-spacing:0">— ${applications} applications, every dial opens its level in Admissions</span></h2>
  ${gaugeRow([
    { n: stage.finished, label: "Finished", tone: "green", href: "/admissions?stage=completed", caption: `${completion ?? 0}% of all files` },
    { n: stage.unfinished, label: "Unfinished", tone: "orange", href: "/admissions?stage=unfinished", caption: "gathering documents" },
    { n: stage.pending, label: "Pending review", tone: "purple", href: "/admissions?stage=awaiting_review", caption: "waiting on staff" },
    { n: stage.enquiries, label: "Enquiries today", tone: "blue", href: "/admissions?stage=enquiries", caption: "across the team" },
  ])}
  <h2 style="margin-top:26px">Pipeline levels</h2>
  ${gaugeRow([
    { n: stage.application_received, label: "Application received", href: "/admissions?stage=application_received" },
    { n: stage.documents_received, label: "Documents received", href: "/admissions?stage=documents_received" },
    { n: stage.documents_checked, label: "Documents checked", href: "/admissions?stage=documents_checked" },
    { n: stage.awaiting_review, label: "Awaiting review", href: "/admissions?stage=awaiting_review" },
    { n: stage.verification, label: "Verification", href: "/admissions?stage=verification" },
    { n: stage.completed, label: "Completed", tone: "green", href: "/admissions?stage=completed" },
  ])}
</section>

<section class="card nopad" id="alerts">
  <div class="card-head"><h2>Alerts${c.unread ? ` <span class="badge b-purple">${c.unread} new</span>` : ""}</h2>
    ${c.unread ? `<form method="post" action="/notifications/read-all" style="margin:0"><input type="hidden" name="_csrf" value="${esc(c.csrf)}"><button class="btn small ghost">Mark all read</button></form>` : ""}
  </div>
  ${alerts.length
    ? `<div class="feed">${alertRows}</div>`
    : `<div class="empty"><p>No alerts. Escalations and auto-admissions appear here.</p></div>`}
</section>

<section class="card nopad">
  <div class="card-head"><h2>Team performance <span class="muted small" style="text-transform:none;letter-spacing:0">— how your staff are working</span></h2><a class="small" href="/staff">staff configuration →</a></div>
  ${team.length
    ? `<table><tr><th>Staff member</th><th>Assigned cases</th><th>Emails</th><th>Avg response</th><th>Files completed</th></tr>${teamRows}</table>`
    : `<div class="empty"><p>No staff accounts yet.</p></div>`}
</section>

<section class="card nopad">
  <div class="card-head"><h2>Completed files &amp; approvals <span class="muted small" style="text-transform:none;letter-spacing:0">— who finished what, and when</span></h2></div>
  ${completedFiles
    ? `<table><tr><th>Ref</th><th>Applicant</th><th>Course</th><th>Decision / completed by</th><th>When</th></tr>${completedFiles}</table>`
    : `<div class="empty"><p>No completed files yet — approvals appear here as cases finish.</p></div>`}
</section>

<section class="card">
  <h2>System</h2>
  <div class="kv">
    <div><span>Gmail</span><b>${gmailConnected ? `connected${lastSync ? ` · synced ${esc(fmtDate(lastSync))}` : ""}` : "not connected"} <a class="small" href="/settings#connections">manage</a></b></div>
    <div><span>Document AI (Gemini)</span><b>${repo.getSetting("gemini_api_key", "") ? "key saved · live" : "not set"} <a class="small" href="/settings#connections">manage</a></b></div>
    <div><span>Automation</span><b>${globalMode === "draft" ? "draft-first" : "auto"} · <a class="small" href="/settings#automation">change</a></b></div>
    <div><span>Team</span><b>${team.filter((t) => t.active).length}/${team.length} active · <a class="small" href="/staff">staff configuration</a></b></div>
    <div><span>Replies to date</span><b>${(() => { const ac = repo.accuracyStats(realm); return Number(ac.autoSends) + Number(ac.humanSends); })()}</b></div>
  </div>
</section>`
  );
}
export function dashboardPage(c: Ctx): string {
  if (c.user.role === "admin") return adminDashboard(c);
  return officerDashboard(c);
}

// ── Admissions command center (managers & officers), alerts merged in ──────

function officerDashboard(c: Ctx): string {
  const { repo } = c;
  const realm = c.user.demo;
  // OR-8: every number on this page counts ONLY the officer's schools.
  const scope = repo.visibleSchoolsFor(c.user);
  const s = repo.dashboardStats(realm, scope);
  const stage = repo.stageCounts(realm, scope);
  const today = repo.todayStats(realm, scope);
  const accuracy = repo.accuracyStats(realm, scope);
  const queue = repo.queueView(realm, scope);
  const unanswered = repo.unansweredCases(scope);
  const target = Number(repo.getSetting("unanswered_target_hours", "4"));
  const categories = repo.categoryCounts(scope);
  const alerts = repo.notificationsFor(c.user.id, 6, realm, scope);

  const activeCount = Number(s.applications) - Number(s.completed);

  const attention = [
    { label: "applicant emails unanswered", n: unanswered.filter((u) => u.hours >= target).length, href: "/applicants", tone: "orange" },
    { label: "cases past their response target", n: Number(s.overdue), href: "/queue?filter=overdue", tone: "red" },
    { label: "cases waiting for human review", n: Number(s.humanReview), href: "/queue", tone: "orange" },
    { label: "files incomplete (documents missing)", n: Number(s.incomplete), href: "/applicants?filter=awaiting_docs", tone: "blue" },
    { label: "replies auto-processed to date", n: Number(s.autoHandled), href: "/queue", tone: "green" },
  ];
  const attentionRows = attention
    .map((b) => `<a class="attn-row" href="${b.href}"><span class="n t-${b.tone}">${b.n}</span><span class="l">${esc(b.label)}</span><span class="arrow">→</span></a>`)
    .join("");

  const needsAttention = queue
    .slice(0, 8)
    .map((r) => {
      const overdue = r.sla_due_at && !r.sla_handled_at && r.sla_due_at < new Date().toISOString();
      return `<tr>
        <td class="mono"><a href="/case/${r.id}">${esc(r.ref_number)}</a></td>
        <td><div class="nameline">${avatar(r.full_name ?? r.ref_number, 26)}<span>${esc(r.full_name ?? "—")}</span></div></td>
        <td>${triageBadge(r.computed_status)} ${priorityBadge(r.priority)}</td>
        <td class="small">${esc(r.flag_summary ? humanizeFlagSummary(r.flag_summary) : "—")}</td>
        <td class="nowrap small ${overdue ? "overdue" : "muted"}">${esc(slaText(r.sla_due_at, r.sla_handled_at)) || "—"}</td>
      </tr>`;
    })
    .join("");

  const unansweredRows = unanswered
    .slice(0, 8)
    .map((u) => `<tr>
      <td class="mono"><a href="/case/${u.applicant.id}">${esc(u.applicant.ref_number)}</a></td>
      <td>${esc(u.applicant.full_name ?? "—")}</td>
      <td class="nowrap ${u.hours >= target ? "overdue" : "muted"} small">${u.hours}h waiting</td>
    </tr>`)
    .join("");

  const totalCat = categories.reduce((n, r) => n + r.n, 0) || 1;
  const catRows = categories
    .slice(0, 6)
    .map((r) => {
      const pct = Math.round((r.n / totalCat) * 100);
      return `<tr>
        <td class="small">${esc(r.category.replace(/_/g, " "))}</td>
        <td style="width:60%"><div class="barwrap"><div class="bar" style="width:${Math.max(pct, 2)}%"></div></div></td>
        <td class="small nowrap muted">${r.n} · ${pct}%</td>
      </tr>`;
    })
    .join("");

  const reviewed = accuracy.greenCases + accuracy.watcherCatches + accuracy.humanOverrides + accuracy.sendErrors;
  const accuracyPct = reviewed > 0 ? Math.round((accuracy.greenCases / reviewed) * 100) : 100;
  const avgAuto = Number(s.avgResponseMin) > 0 ? formatDuration(Number(s.avgResponseMin)) : "no data";
  const avgReview = Number(s.avgReviewHours) > 0
    ? (Number(s.avgReviewHours) < 48 ? `${s.avgReviewHours} hrs` : formatDuration(Number(s.avgReviewHours) * 60))
    : "no data";

  const alertRows = alerts
    .map((n) => `<div class="feed-row ${n.read ? "read" : ""}">
      <span class="badge ${n.kind === "escalation" ? "b-red" : n.kind === "review_needed" ? "b-orange" : n.kind === "auto_admission" ? "b-green" : "b-blue"}">${esc(kindLabel(n.kind))}</span>
      <span class="feed-msg">${esc(n.message.replace(/^\u26a0\ufe0f\s*/, ""))}</span>
      ${n.applicant_id ? `<a class="small nowrap" href="/case/${n.applicant_id}">open →</a>` : ""}
      <span class="feed-when right">${esc(fmtDate(n.at))}</span>
    </div>`)
    .join("");

  // Alerts sit IMMEDIATELY after the gauges — the first thing after the
  // pipeline picture is what needs a human right now.
  const alertsCard = `<section class="card nopad" id="alerts">
    <div class="card-head"><h2>Alerts${c.unread ? ` <span class="badge b-purple">${c.unread} new</span>` : ""}</h2>
      ${c.unread ? `<form method="post" action="/notifications/read-all" style="margin:0"><input type="hidden" name="_csrf" value="${esc(c.csrf)}"><button class="btn small ghost">Mark all read</button></form>` : ""}
    </div>
    ${alerts.length
      ? `<div class="feed">${alertRows}</div>`
      : `<div class="empty"><p>No alerts. Escalations and auto-admissions appear here.</p></div>`}
  </section>`;

  return head(
    c,
    `Overview — ${c.institution}`,
    "dashboard",
    `
<div class="hero">
  <div>
    <div class="kicker">${esc(c.institution)} · ${activeCount} active applicant${activeCount === 1 ? "" : "s"}</div>
    <h1>${greeting()}${firstName(c.user.display_name) ? ", " + esc(firstName(c.user.display_name)) : ""}.</h1>
    <p class="lede">Here is what needs you today.</p>
  </div>
  ${heroClock()}
</div>

<section class="card">
  <h2>The pipeline, at a glance <span class="small muted" style="text-transform:none;letter-spacing:0">— every dial opens its level in Admissions</span></h2>
  ${gaugeRow([
    { n: stage.finished, label: "Finished", tone: "green", href: "/admissions?stage=completed", caption: "completed files" },
    { n: stage.unfinished, label: "Unfinished", tone: "orange", href: "/admissions?stage=unfinished", caption: "still gathering documents" },
    { n: stage.pending, label: "Pending review", tone: "purple", href: "/admissions?stage=pending", caption: "waiting on a human" },
    { n: stage.enquiries, label: "Enquiries today", tone: "blue", href: "/admissions?stage=enquiries", caption: "fee · admission · follow-ups" },
  ])}
  <h2 style="margin-top:26px">By level</h2>
  ${gaugeRow([
    { n: stage.application_received, label: "Application received", href: "/admissions?stage=application_received" },
    { n: stage.documents_received, label: "Documents received", href: "/admissions?stage=documents_received" },
    { n: stage.documents_checked, label: "Documents checked", href: "/admissions?stage=documents_checked" },
    { n: stage.awaiting_review, label: "Awaiting review", href: "/admissions?stage=awaiting_review" },
    { n: stage.verification, label: "Verification", href: "/admissions?stage=verification" },
    { n: stage.completed, label: "Completed", tone: "green", href: "/admissions?stage=completed" },
  ])}
</section>

${alertsCard}

<div class="cols wide">
  <section class="card nopad">
    <div class="card-head"><h2>Needs attention</h2><a class="small" href="/applicants?queue=human_review">full queue →</a></div>
    <div>${attentionRows}</div>
  </section>
  <section class="card">
    <h2>Today</h2>
    <div class="kv">
      <div><span>Emails today</span><b>${today.emailsToday}</b></div>
      <div><span>Documents today</span><b>${today.docsToday}</b></div>
      <div><span>Cases completed today</span><b>${today.completedToday}</b></div>
      <div><span>Avg auto-response (7 days)</span><b>${esc(avgAuto)}</b></div>
      <div><span>Avg review time</span><b>${esc(avgReview)}</b></div>
    </div>
  </section>
</div>

<section class="card nopad">
  <div class="card-head"><h2>What needs my attention</h2><a class="small" href="/applicants?queue=human_review">open the Human Review queue →</a></div>
  ${queue.length
    ? `<table><tr><th>Ref</th><th>Applicant</th><th>Verdict</th><th>Flags</th><th>SLA</th></tr>${needsAttention}</table>`
    : `<div class="empty"><p>Queue is empty — every case is handled.</p></div>`}
</section>

<div class="cols wide">
  <section class="card nopad">
    <div class="card-head"><h2>Unanswered emails <span class="muted small">(target ${target}h)</span></h2></div>
    ${unanswered.length
      ? `<table><tr><th>Ref</th><th>Applicant</th><th>Waiting</th></tr>${unansweredRows}</table>`
      : `<div class="empty"><p>Every applicant email has a reply.</p></div>`}
  </section>
  <section class="card">
    <h2>Where applicants get stuck</h2>
    <p class="small muted" style="margin-top:-6px">Share of incoming email by category — the long bars are your bottlenecks.</p>
    ${catRows ? `<table>${catRows}</table>` : `<p class="muted">No emails yet.</p>`}
  </section>
</div>

<section class="card">
  <h2>Automation accuracy</h2>
  ${reviewed > 0
    ? `<p style="margin:2px 0 12px"><span style="font-family:var(--display);font-size:30px">${accuracyPct}%</span> <span class="muted small">of automation decisions stood uncorrected</span></p>`
    : `<p class="muted">No automation decisions recorded yet — accuracy appears here once the engine has processed mail.</p>`}
  <div class="kv">
    <div><span>Clean Greens</span><b>${accuracy.greenCases}</b></div>
    <div><span>Watcher catches</span><b>${accuracy.watcherCatches}</b></div>
    <div><span>Human overrides</span><b>${accuracy.humanOverrides}</b></div>
    <div><span>Send errors</span><b ${accuracy.sendErrors > 0 ? 'style="color:var(--red)"' : ""}>${accuracy.sendErrors}</b></div>
  </div>
  <p class="small muted" style="margin-bottom:0">${accuracy.autoSends} automated sends vs ${accuracy.humanSends} human sends · ${accuracy.reopened} cases reopened</p>
</section>`
  );
}

// ── Admissions: the pipeline split into its levels ──────────────────────────

const STAGE_TABS: Array<{ key: string; label: string }> = [
  { key: "all", label: "All" },
  { key: "application_received", label: "Application received" },
  { key: "documents_received", label: "Documents received" },
  { key: "documents_checked", label: "Documents checked" },
  { key: "awaiting_review", label: "Awaiting review" },
  { key: "verification", label: "Verification" },
  { key: "pending", label: "Pending review" },
  { key: "completed", label: "Completed" },
];

export function admissionsPage(c: Ctx, stage: string): string {
  const { repo } = c;
  const realm = c.user.demo;
  // OR-8: levels count only this staff member's schools.
  const scope = repo.visibleSchoolsFor(c.user);
  const counts = repo.stageCounts(realm, scope);
  const start = new Date(); start.setHours(0, 0, 0, 0);
  // ONE query for today's enquiry applicants — never one per applicant.
  const enquiryIds = repo.enquiryApplicantIdsToday(start.toISOString(), scope);
  const all = repo.allApplicants(realm, scope);
  const enquiriesToday = all.filter((a) => enquiryIds.has(a.id));

  const staffById = new Map(repo.listStaff().map((m) => [m.id, m.display_name]));
  const validStages = new Set(STAGE_TABS.map((t) => t.key));
  const active = validStages.has(stage) ? stage : "all";

  let rows = all;
  if (active === "unfinished") rows = rows.filter((a) => ["application_received", "documents_received", "documents_checked"].includes(a.lifecycle));
  else if (active === "pending") rows = rows.filter((a) => ["awaiting_review", "verification"].includes(a.lifecycle));
  else if (active === "enquiries") rows = enquiriesToday;
  else if (active !== "all") rows = rows.filter((a) => a.lifecycle === active);
  rows = rows.slice().sort((x, y) => (y.updated_at ?? "").localeCompare(x.updated_at ?? ""));

  const countFor = (key: string): number => {
    if (key === "all") return counts.total;
    if (key === "unfinished") return counts.unfinished;
    if (key === "enquiries") return enquiriesToday.length;
    return (counts as unknown as Record<string, number>)[key] ?? 0;
  };

  const tableRows = rows
    .slice(0, 300)
    .map((a) => {
      const owner = a.assigned_to ? staffById.get(a.assigned_to) : null;
      const courseOwner = a.programme ? repo.programmeByCode(a.programme)?.owner_name : null;
      return `<tr>
        <td class="mono"><a href="/case/${a.id}">${esc(a.ref_number)}</a></td>
        <td><div class="nameline">${avatar(a.full_name ?? a.ref_number, 30)}<span><b>${esc(a.full_name ?? "Unknown")}</b><br><span class="muted small">${esc(a.email_address)}</span></span></div></td>
        <td>${a.programme ? `<b>${esc(a.programme)}</b>` : `<span class="muted">—</span>`}<br><span class="muted small">${esc(a.intake ?? "no intake yet")}</span></td>
        <td>${lifecycleBadge(a.lifecycle)}</td>
        <td class="small nowrap muted" title="Applied">${esc(fmtDate(a.created_at))}</td>
        <td class="small">${owner ? esc(owner) : courseOwner ? `<span class="muted">course owner: ${esc(courseOwner)}</span>` : `<span class="muted">unassigned</span>`}</td>
        <td class="nowrap">
          <a class="btn small ghost" href="/case/${a.id}">Open</a>
          <a class="btn small" href="/case/${a.id}/compose?template=missing_documents" title="A ready-drafted request — edit if you like, then send">Request docs</a>
        </td>
      </tr>`;
    })
    .join("");

  return head(
    c,
    `Admissions — ${c.institution}`,
    "admissions",
    `
<h1>Admissions</h1>
<div class="sub">Every applicant sits in exactly one level. Finished files are counted at Completed — everything still moving is counted where it stands. Open a case to work it.</div>

<div style="margin-bottom:26px">
  ${gaugeRow([
    { n: counts.finished, label: "Finished", tone: "green", href: "/admissions?stage=completed" },
    { n: counts.unfinished, label: "Unfinished", tone: "orange", href: "/admissions?stage=unfinished" },
    { n: counts.pending, label: "Pending review", tone: "purple", href: "/admissions?stage=pending" },
    { n: enquiriesToday.length, label: "Enquiries today", tone: "blue", href: "/admissions?stage=enquiries" },
  ])}
</div>

<div class="tabs">
  ${STAGE_TABS.concat([{ key: "unfinished", label: "Unfinished" }, { key: "enquiries", label: "Enquiries" }])
    .map((t) => `<a href="/admissions?stage=${t.key}" class="${active === t.key ? "on" : ""}">${esc(t.label)}<span class="cnt">${countFor(t.key)}</span></a>`)
    .join("")}
</div>

<section class="card nopad">
  ${rows.length
    ? `<table>
        <tr><th>Ref</th><th>Applicant</th><th>Applied for</th><th>Level</th><th>Applied</th><th>Handled by</th><th></th></tr>
        ${tableRows}
      </table>`
    : `<div class="empty">${flowLine(150, 26)}<p>Nobody at this level right now.</p><p class="small muted">New applications land at <b>Application received</b> and move down the pipeline as your team works them.</p></div>`}
</section>`
  );
}

// ── Applicants (features 2, 18, 19) ────────────────────────────────────────

// ── Operational queues (round 18) ──────────────────────────────────────────

const RESULT_BADGES: Record<string, [string, string]> = {
  passed: ["Passed", "b-green"],
  failed: ["Failed", "b-red"],
  missing_data: ["Missing data", "b-blue"],
  needs_verification: ["Needs verification", "b-orange"],
  undetermined: ["Pending", "b-gray"],
};

const DECISION_BADGES: Record<string, [string, string]> = {
  undecided: ["Not yet decided", "b-gray"],
  auto_admitted: ["Auto-admitted", "b-green"],
  admitted_after_review: ["Admitted after human review", "b-purple"],
  not_admitted: ["Not admitted", "b-red"],
};

function resultBadge(result: string | null): string {
  const [label, cls] = RESULT_BADGES[result ?? ""] ?? [result ?? "—", "b-gray"];
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}

function decisionBadge(decision: string): string {
  const [label, cls] = DECISION_BADGES[decision] ?? [decision, "b-gray"];
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}

export function applicantsPage(
  c: Ctx,
  q: { search?: string; queue?: string; sub?: string; programme?: string; intake?: string }
): string {
  const { repo } = c;
  const rows = repo.searchApplicants({
    q: q.search,
    programme: q.programme || undefined,
    intake: q.intake || undefined,
    demo: c.user.demo,
    schools: repo.visibleSchoolsFor(c.user), // OR-8
  });
  const programmes = repo.listProgrammes();
  const intakes = repo.listIntakes();

  // OR-1: a completely fresh installation gets the next concrete step, not a
  // silent dead end. (Any filter/search in play means "nothing matched".)
  if (rows.length === 0 && !q.search && !q.programme && !q.intake && !q.queue && !q.sub) {
    return head(
      c,
      "Queues",
      "applicants",
      `<div class="empty" style="padding:56px 24px;text-align:center">
        <p style="font-size:17px;font-weight:700;margin-bottom:6px">No applications yet.</p>
        <p class="small muted">Connect Gmail in <a href="/settings">Settings</a> and applicant emails will land here as cases.</p>
      </div>`
    );
  }

  // Classify every row ONCE, then count and slice by queue.
  const ids = rows.map((r) => r.id);
  const directions = repo.lastEmailDirections(ids);
  const docCounts = repo.docCounts(ids);
  const evalReasons = repo.latestEvaluationReasons(ids);
  const placed = rows.map((r) => ({
    row: r,
    place: queueOf(r, { lastDirection: directions.get(r.id) ?? null, hasDocuments: (docCounts.get(r.id) ?? 0) > 0 }),
  }));

  const queueTotals = new Map<QueueKey, number>();
  for (const qm of QUEUES) queueTotals.set(qm.key, 0);
  for (const p of placed) queueTotals.set(p.place.queue, (queueTotals.get(p.place.queue) ?? 0) + 1);

  const activeKey: QueueKey = (QUEUES.some((qm) => qm.key === q.queue) ? q.queue : "human_review") as QueueKey;
  const active = QUEUES.find((qm) => qm.key === activeKey)!;
  const inActive = placed.filter((p) => p.place.queue === activeKey);
  const subCounts = new Map<string, number>();
  for (const p of inActive) subCounts.set(p.place.sub, (subCounts.get(p.place.sub) ?? 0) + 1);
  // A text search spans EVERY queue — you are looking for a person, not a bucket.
  const searchMode = Boolean(q.search && q.search.trim());
  const shown = searchMode
    ? placed
    : q.sub && active.subs.some((s) => s.key === q.sub)
      ? inActive.filter((p) => p.place.sub === q.sub)
      : inActive;

  const tabs = QUEUES.map((qm) => `
    <a class="stat-mini ${qm.key === activeKey ? "sel" : ""}" href="/applicants?queue=${qm.key}">
      <span class="n">${queueTotals.get(qm.key) ?? 0}</span>
      <span class="l">${esc(qm.label)}</span>
    </a>`).join("");

  const chips = [
    `<a class="chip ${!q.sub ? "sel" : ""}" href="/applicants?queue=${activeKey}">All (${inActive.length})</a>`,
    ...active.subs.map((s) =>
      `<a class="chip ${q.sub === s.key ? "sel" : ""}" href="/applicants?queue=${activeKey}&sub=${s.key}">${esc(s.label)} (${subCounts.get(s.key) ?? 0})</a>`
    ),
  ].join("");

  const toneClass = (tone: string): string =>
    tone === "green" ? "b-green" : tone === "purple" ? "b-purple" : tone === "orange" ? "b-orange" : tone === "blue" ? "b-blue" : "b-gray";

  const trs = shown
    .map(({ row: r, place }) => {
      const detail = evalReasons.get(r.id);
      const why = detail ? esc(detail.length > 96 ? detail.slice(0, 96) + "…" : detail) : "";
      const rowQueue = QUEUES.find((qm) => qm.key === place.queue)!;
      return `<tr>
      <td class="mono"><a href="/case/${r.id}">${esc(r.ref_number)}</a></td>
      <td><div class="nameline">${avatar(r.full_name ?? r.ref_number, 28)}<span>${esc(r.full_name ?? "—")}<br><span class="muted small">${esc(r.email_address)}</span></span></div></td>
      <td class="small">${esc(r.programme ?? "—")}${r.intake ? `<br><span class="muted">${esc(r.intake)}</span>` : ""}</td>
      <td class="small"><span class="badge ${toneClass(rowQueue.tone)}">${esc(SUB_LABELS[place.sub] ?? place.sub)}</span><br><span class="muted">${why}</span></td>
      <td>${resultBadge(r.req_result)}</td>
      <td>${decisionBadge(r.admission_decision)}</td>
      <td class="small muted nowrap">${esc(fmtDate(r.created_at))}</td>
      <td><a class="btn small" href="/case/${r.id}">Open</a></td>
    </tr>`;
    })
    .join("");

  const opt = (v: string, label: string, sel?: string) =>
    `<option value="${esc(v)}" ${sel === v ? "selected" : ""}>${esc(label)}</option>`;

  return head(
    c,
    searchMode ? "Search — Queues" : `${active.label} — Queues`,
    "applicants",
    `
<h1>Queues</h1>
<div class="sub">${searchMode
    ? `${shown.length} match${shown.length === 1 ? "" : "es"} across all queues.`
    : `${esc(active.caption)} — the subcategory says why a case is here.`}</div>

<div class="queue-tabs">${tabs}</div>

<form class="inline" method="get" action="/applicants">
  <input type="hidden" name="queue" value="${esc(activeKey)}">
  <input name="q" value="${esc(q.search ?? "")}" placeholder="Search name, email, reference…">
  <select name="programme"><option value="">All programmes</option>${programmes.map((p) => opt(p.code, p.name, q.programme)).join("")}</select>
  <select name="intake"><option value="">All intakes</option>${intakes.map((i) => opt(i, i, q.intake)).join("")}</select>
  <button class="btn ghost">Filter</button>
  ${c.user.role === "admin" ? `<a class="btn small ghost" href="/applicants/export.csv">Export CSV</a>` : ""}
</form>

<section class="card">
  ${searchMode ? "" : `<div class="chips">${chips}</div>`}
  ${shown.length
    ? `<table>
        <tr><th>Ref</th><th>Applicant</th><th>Programme</th><th>Why it's here</th><th>Requirement result</th><th>Admission decision</th><th>Opened</th><th></th></tr>
        ${trs}
      </table>`
    : searchMode
      ? `<div class="empty"><h3>No matches</h3><p>Nothing matches that search in this dataset.</p></div>`
      : `<div class="empty"><h3>Nothing in this queue</h3><p>Cases move here automatically as their situation changes.</p></div>`}
</section>`
  );
}


function reasoningFlags(reasoning: string): Set<string> {
  const out = new Set<string>();
  for (const line of reasoning.split("\n")) {
    const m = line.match(/^\s*- \[([a-z_]+)\] /);
    if (m) out.add(m[1]);
  }
  return out;
}

/** "What changed?" (v3 feature 33): diff the two most recent decisions. */
function whatChanged(repo: Repo, a: ApplicantRow): string | null {
  const decisions = repo.decisionLogs(a.id);
  if (decisions.length < 2) return null;
  const prev = decisions[decisions.length - 2];
  const last = decisions[decisions.length - 1];
  const before = reasoningFlags(prev.reasoning);
  const after = reasoningFlags(last.reasoning);
  const added = [...after].filter((f) => !before.has(f));
  const cleared = [...before].filter((f) => !after.has(f));
  const prevAt = prev.timestamp ?? "";
  const newDocs = repo
    .listDocuments(a.id, { activeOnly: false })
    .filter((d) => d.received_at > prevAt)
    .map((d) => docLabel(d.document_type));
  const parts: string[] = [];
  for (const d of new Set(newDocs)) parts.push(`<b>${esc(d)}</b> received`);
  for (const f of added) parts.push(`New flag: <b>${esc(f)}</b>`);
  for (const f of cleared) parts.push(`Flag cleared: <b>${esc(f)}</b>`);
  if (prev.computed_status !== last.computed_status) {
    const dotFor = (st: string): string => {
      const color = st === "Green" ? "#1F7A3D" : st === "Orange" ? "#9A6A00" : "#A11F2E";
      return `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:4px"></span>`;
    };
    parts.push(`${dotFor(prev.computed_status)}${esc(prev.computed_status)} → ${dotFor(last.computed_status)}<b>${esc(last.computed_status)}</b>`);
  }
  if (parts.length === 0) return null;
  return parts.join(" &nbsp;·&nbsp; ");
}

/** Split the suggested reply (what staff edit/send) from internal routing boilerplate. */
function displayDraft(body: string): { text: string; held: boolean } {
  const m = body.match(/Suggested starting point[^\n]*:\s*\n+([\s\S]*)$/);
  if (m) {
    let t = m[1].trim();
    if (t.startsWith('"') && t.endsWith('"') && t.length > 2) t = t.slice(1, -1).trim();
    return { text: t, held: false };
  }
  const isInternal = body.trimStart().startsWith("INTERNAL \u2014 DO NOT AUTO-SEND");
  return { text: isInternal ? "" : body, held: isInternal };
}

/** 195 → "3h 15m", 3000 → "2d 2h", 42 → "42m". */
function formatDuration(minutes: number): string {
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))}m`;
  if (minutes < 60 * 48) return `${Math.floor(minutes / 60)}h ${Math.round(minutes % 60)}m`;
  return `${Math.floor(minutes / 1440)}d ${Math.round((minutes % 1440) / 60)}h`;
}

/** "name_mismatch,low_confidence" → "Name mismatch, Low confidence". */
function humanizeFlagSummary(summary: string): string {
  return summary.split(",").map((t) => t.trim()).filter(Boolean).map(flagLabel).join(", ");
}

// ── Admission eligibility panel (round 18) ─────────────────────────────────
// Structured evaluation: per-rule rows (applicant value vs required), the
// automated routing verdict, and the human-decision form. The word "rejected"
// never appears anywhere — a failed rule means HUMAN REVIEW, nothing else.

const ROUTING_TEXT: Record<string, [string, string, string]> = {
  auto_admit: ["b-green", "Auto-admit", "Every configured requirement is satisfied — the system may progress this file and send the admission letter."],
  human_review: ["b-orange", "Human Review Required", "The automated path cannot decide this case. A person must review it before anything is decided."],
  waiting_documents: ["b-blue", "Waiting for Documents", "Missing information is waiting on the applicant — absence is never interpreted as failure."],
};

function evaluationPanel(c: Ctx, a: ApplicantRow): string {
  const { repo } = c;
  const ev = repo.latestEvaluation(a.id);
  const programme = a.programme ? repo.programmeByCode(a.programme) : undefined;
  const ctxLine = `${programme ? `${esc(programme.code)} ${esc(programme.name)}` : esc(a.programme ?? "No programme yet")}${a.intake ? ` · ${esc(a.intake)}` : ""}`;

  if (!ev) {
    const requirements = repo.effectiveRequirements(a);
    const activeDocs = repo.listDocuments(a.id, { activeOnly: true });
    const required = requirements.filter((r) => r.required);
    const supplied = required.filter((r) => activeDocs.some((d) => d.document_type === r.document_type)).length;
    return `<section class="sec">
      <div class="sec-head"><h2>Admission eligibility</h2>${resultBadge(a.req_result)}</div>
      <p class="sec-sub">${ctxLine} — no evaluation has run yet. It starts automatically once documents arrive.</p>
      ${required.length ? `<div class="req-progress ${supplied >= required.length ? "full" : ""}"><span class="big">${supplied} / ${required.length}</span><span class="cap">required documents supplied</span></div>` : ""}
    </section>`;
  }

  const sysLabel = ev.system ? (SYSTEM_LABELS[ev.system] ?? ev.system) : null;
  const leafRows = ev.leaves
    .map((l) => {
      const mk = l.status === "passed" ? `<span class="mk ok">✓</span>` : l.status === "failed" ? `<span class="mk no">✕</span>` : `<span class="mk opt">?</span>`;
      const note = l.via ? ` <span class="muted small">via ${esc(l.via)}</span>` : "";
      return `<tr><td>${esc(l.label)}${note}</td><td>${esc(l.required)}</td><td>${esc(l.applicantValue ?? "—")}</td><td class="ctr">${mk}</td></tr>`;
    })
    .join("");
  const groupRows = ev.groups
    .filter((g) => g.via)
    .map((g) => `<div class="small muted" style="margin-top:4px">Group alternative satisfied: <b>${esc(g.via)}</b> (${esc(g.label)})</div>`)
    .join("");
  const missingDocs = ev.missingDocuments.length
    ? `<div class="small" style="margin-top:8px">Still missing: ${ev.missingDocuments.map((m) => `<span class="badge b-blue">${esc(m)}</span>`).join(" ")}</div>`
    : "";
  const blocking = ev.blockingFlags.length
    ? `<div class="small" style="margin-top:8px">Blocking flags: ${ev.blockingFlags.map((f) => `<span class="badge b-orange">${esc(flagLabel(f))}</span>`).join(" ")}</div>`
    : "";
  const [toneCls, toneLabel, toneText] = ROUTING_TEXT[ev.routing] ?? ROUTING_TEXT.human_review;
  const reasonLine = ev.routing !== "auto_admit" && ev.reason ? `<div style="margin-top:6px"><b>Why:</b> ${esc(ev.reason)}</div>` : "";

  const decided = a.admission_decision !== "undecided";
  const decisionBlock = decided
    ? `<div class="routing-block ${a.admission_decision === "not_admitted" ? "b-red" : a.admission_decision === "auto_admitted" ? "b-green" : "b-purple"}">
        <b>${esc((DECISION_BADGES[a.admission_decision] ?? [a.admission_decision])[0])}</b>
        · ${a.admission_route === "human" ? "decided by a person" : "decided automatically"}${a.decision_by ? ` — ${esc(a.decision_by)}` : ""}
        ${a.decision_reason ? `<div class="small" style="margin-top:4px">${esc(a.decision_reason)}</div>` : ""}
       </div>`
    : ev.routing !== "auto_admit"
      ? `<form class="decision-form" method="post" action="/case/${a.id}/admission-decision">
          <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
          <h3 style="margin:0 0 8px">Human decision</h3>
          <p class="small muted" style="margin:0 0 10px">The automated path stopped here. If the applicant should still be admitted — alternative qualification, approved exception, special consideration, documented pathway — record it below. It is stored as a HUMAN decision, separately from anything automated, with your name on the audit trail.</p>
          <div class="row">
            <select name="route">
              <option value="alternative_qualification">Alternative qualification</option>
              <option value="approved_exception">Approved exception</option>
              <option value="special_consideration">Special consideration</option>
              <option value="documented_pathway">Documented pathway</option>
              <option value="standard_review">Standard review</option>
            </select>
            <input name="reason" required placeholder="Reason — recorded on the audit trail" style="flex:1">
          </div>
          <div class="row" style="margin-top:10px">
            <button class="btn" name="decision" value="admit">Admit after Human Review</button>
            <button class="btn danger" name="decision" value="decline">Not Admitted</button>
          </div>
        </form>`
      : "";

  return `<section class="sec">
    <div class="sec-head"><h2>Admission eligibility</h2>
      <div>${resultBadge(ev.result)} ${decisionBadge(a.admission_decision)}</div>
    </div>
    <p class="sec-sub">${ctxLine}${sysLabel ? ` · ${esc(sysLabel)}` : ""}${ev.setVersion ? ` · requirement set v${ev.setVersion}${ev.frozenAt ? ` (frozen ${esc(fmtDate(ev.frozenAt))})` : ""}` : ""}</p>
    ${ev.leaves.length
      ? `<table class="ruletable"><tr><th>Rule</th><th>Required</th><th>Applicant</th><th class="ctr">Result</th></tr>${leafRows}</table>${groupRows}`
      : `<p class="small muted">No individual rules were evaluated in this run.</p>`}
    ${missingDocs}${blocking}
    <div class="routing-block ${toneCls}" style="margin-top:14px">
      <b>Automated routing: ${esc(toneLabel)}</b><span class="small muted" style="margin-left:8px">${esc(ev.evaluatedAt ? fmtDate(ev.evaluatedAt) : "")}</span>
      <div style="margin-top:4px">${esc(toneText)}</div>
      ${reasonLine}
    </div>
    ${decisionBlock}
    <div class="row" style="margin-top:12px;justify-content:space-between">
      <span class="small muted">Evaluations are reproducible from the stored rule version and applicant data — ${ev.frozenAt ? "this case keeps its frozen set; configuration changes only affect future evaluations." : "no requirement set has been frozen yet."}</span>
      <form method="post" action="/case/${a.id}/reevaluate" style="margin:0"><input type="hidden" name="_csrf" value="${esc(c.csrf)}"><button class="btn small ghost">Re-run evaluation</button></form>
    </div>
  </section>`;
}

export function casePage(c: Ctx, a: ApplicantRow, flash?: string, preview?: { subject: string; body: string } | null): string {
  const { repo } = c;
  const requirements = repo.effectiveRequirements(a);
  const activeDocs = repo.listDocuments(a.id, { activeOnly: true });
  const allDocs = repo.listDocuments(a.id, { activeOnly: false });
  const flags = repo.activeFlags(a.id);
  const emails = repo.emailsForApplicant(a.id);
  const notes = repo.notesForApplicant(a.id);
  const history = repo.statusHistory(a.id);
  const audit = repo.auditForApplicant(a.id);
  const decisions = repo.decisionLogs(a.id);
  const staff = repo.listStaff();
  const templates = repo.listTemplates();
  const outbox = repo.queuedOutbox(a.id);
  // "INTERNAL — DO NOT AUTO-SEND" boilerplate never reaches the UI; staff see
  // the suggested reply (if any) and whether the draft is held for approval.
  const draftView = outbox ? displayDraft(outbox.body) : null;
  const latestIncoming = [...emails].reverse().find((e) => e.direction === "in");
  const autoSummary = repo
    .allAutomationConfig()
    .map((cfg) => `${cfg.category.replace(/_/g, " ")} → ${cfg.mode}`)
    .join(" · ");
  const tasks = repo.listTasks(a.id);
  const changed = whatChanged(repo, a);
  const threads = repo.threadsForApplicant(a.id);
  const programme = a.programme ? repo.programmeByCode(a.programme) : undefined;
  const staffById = new Map(staff.map((m) => [m.id, m.display_name]));
  const handledBy = a.assigned_to ? staffById.get(a.assigned_to) : programme?.owner_name ?? null;
  const isMgr = c.user.role === "admin";

  const staffOptions = staff.map((s) => `<option value="${s.id}" ${a.assigned_to === s.id ? "selected" : ""}>${esc(s.display_name)}</option>`).join("");
  const tplOptions = templates.map((t) => `<option value="${esc(t.key)}">${esc(t.name)}</option>`).join("");
  const nextStage = LIFECYCLE_ORDER[LIFECYCLE_ORDER.indexOf(a.lifecycle) + 1];
  const lastDecision = decisions.at(-1);

  // ── Admission requirements: needed vs supplied, at a glance ──────────────
  const reqByType = new Map(requirements.map((r) => [r.document_type, r]));

  // ── Document checklist: every received document, expandable ──────────────
  const docRowsHtml = allDocs
    .map((d, ix) => {
      const req = reqByType.get(d.document_type);
      const reqBadge = req
        ? req.required
          ? `<span class="badge b-purple">Required</span>`
          : `<span class="badge b-gray">Optional</span>`
        : `<span class="badge b-gray">—</span>`;
      const state = d.is_duplicate
        ? `<span class="badge b-gray">duplicate of #${d.duplicate_of}</span>`
        : d.superseded_by
          ? `<span class="badge b-gray">superseded by #${d.superseded_by}</span>`
          : d.extraction_method === "none"
            ? `<span class="badge b-orange">Unreadable</span>`
            : `<span class="badge b-green">Received</span>`;
      const fields = Object.entries(d.extracted_fields)
        .filter(([, v]) => v !== null && v !== undefined && v !== "" && JSON.stringify(v) !== "{}")
        .map(([k, v]) => `<div><div class="k">${esc(k)}</div><div class="v">${esc(typeof v === "object" ? Object.entries(v as Record<string, string>).map(([sk, sv]) => `${sk} ${sv}`).join(", ") : String(v))}</div></div>`)
        .join("");
      const raw = d.extracted_text.trim();
      return `<tr class="doc-main" data-doc="${ix}">
        <td><span class="doc-name"><span class="chev">▸</span>${esc(docLabel(d.document_type))}</span></td>
        <td>${reqBadge}</td>
        <td>${state}</td>
        <td>${readabilityScore(d.confidence_score)}</td>
        <td class="small nowrap">${esc(fmtDate(d.received_at))}</td>
      </tr>
      <tr class="doc-detail" id="doc-${ix}">
        <td colspan="5">
          <div class="kv2">
            <div><div class="k">Status</div><div class="v">${d.is_duplicate ? `Duplicate of #${d.duplicate_of}` : d.superseded_by ? `Superseded by #${d.superseded_by}` : "Active"}</div></div>
            <div><div class="k">Document #</div><div class="v mono">#${d.id}</div></div>
            <div><div class="k">Source email</div><div class="v mono">${esc(d.source_email_id)}</div></div>
            <div><div class="k">Extraction</div><div class="v">${esc(d.extraction_method)} · ${esc(d.confidence)} confidence</div></div>
            ${d.extraction_note ? `<div><div class="k">Reading note</div><div class="v">${esc(d.extraction_note)}</div></div>` : ""}
          </div>
          <div class="kv2" style="margin-bottom:14px">${fields || `<div><div class="k">Extracted fields</div><div class="v muted">no fields extracted</div></div>`}</div>
          <div class="k" style="font-size:10.5px;text-transform:uppercase;letter-spacing:.11em;color:var(--muted);font-weight:800;margin-bottom:6px">Raw extraction</div>
          ${raw ? `<pre class="raw">${esc(raw.slice(0, 1400))}</pre>` : `<p class="small muted" style="margin:0">No readable text extracted.</p>`}
        </td>
      </tr>`;
    })
    .join("");

  // ── Communication timeline ─────────────────────────────────────────────────
  const emailItems = [...emails]
    .reverse()
    .map((e) => {
      const attached = repo.parseAttachmentList(e.attachments);
      const attLine = attached.length
        ? `<p class="small muted" style="margin:0 0 6px"><b>Attached (${attached.length}):</b> ${attached.map((f) => `<span class="badge b-gray">${esc(f)}</span>`).join(" ")}</p>`
        : "";
      return `<details class="mail-item ${e.direction === "out" ? "out" : ""}">
      <summary>
        <span class="badge ${e.direction === "in" ? "b-blue" : "b-purple"}">${e.direction === "in" ? "← From applicant" : "→ To applicant"}</span>
        ${categoryBadge(e.category)}
        ${e.auto ? `<span class="badge b-gray">automated</span>` : ""}
        ${attached.length ? `<span class="badge b-purple">${attached.length} file(s) attached</span>` : ""}
        ${e.channel && e.channel !== "email" ? `<span class="badge b-blue">via ${esc(e.channel)}</span>` : ""}
        <span class="m-sub">${esc(e.subject)}</span>
        <span class="m-when" title="${esc(fmtDate(e.at))}">${esc(fmtDate(e.at))}</span>
      </summary>
      <div class="m-body">${attLine}<pre>${esc(e.body)}</pre></div>
    </details>`;
    })
    .join("");

  // ── Activity & audit trail (tabbed) ────────────────────────────────────────
  const historyRows = history
    .map((h) => `<tr><td class="small nowrap">${esc(fmtDate(h.at))}</td><td>${esc(LIFECYCLE_LABELS[(h.from_status as never)] ?? h.from_status ?? "—")} → <b>${esc(LIFECYCLE_LABELS[(h.to_status as never)] ?? h.to_status)}</b></td><td class="mono small">${esc(h.actor)}</td><td class="small">${esc(h.reason)}</td></tr>`)
    .join("");
  const auditRows = audit
    .map((ev) => `<div class="ev"><span class="t"><span data-rel="${esc(ev.at)}">${esc(fmtDate(ev.at))}</span> · ${esc(ev.actor)}</span><br><b>${esc(ev.event)}</b> — ${esc(ev.detail)}</div>`)
    .join("");
  const activityHtml = audit
    .slice()
    .reverse()
    .map((ev) => `<div style="padding:10px 0;border-bottom:1px dashed var(--line);font-size:13px">
      <span class="small muted">${esc(fmtDate(ev.at))} · ${esc(ev.actor)}</span><br>
      <b>${esc(capFirst(ev.event.replace(/_/g, " ")))}</b>${ev.detail ? ` <span class="muted">— ${esc(ev.detail)}</span>` : ""}
    </div>`)
    .join("") || `<p class="muted">No activity yet.</p>`;

  const noteCards = notes
    .map((n) => `<div class="note"><div>${esc(n.body)}</div><div class="meta">${esc(n.display_name ?? "system")} · ${esc(fmtDate(n.at))}</div></div>`)
    .join("");

  return head(
    c,
    `${a.ref_number} — case file`,
    "applicants",
    `
${flash ? `<div class="flash">${esc(flash)}</div>` : ""}

<!-- Level 1 — applicant identity -->
<div class="case-head">
  <div class="who">
    ${avatar(a.full_name ?? a.ref_number, 56)}
    <div class="ident">
      <h1>${esc(a.full_name ?? "Unknown applicant")}</h1>
      <div class="ref-line">
        <span class="mono">${esc(a.ref_number)}</span><span class="sep">·</span>
        ${programme ? `<span><b>${esc(programme.code)}</b> ${esc(programme.name)}</span><span class="sep">·</span>` : ""}
        <span>${esc(a.intake ?? "intake to be confirmed")}</span><span class="sep">·</span>
        <span>opened ${esc(fmtDate(a.created_at))}</span>
        ${handledBy ? `<span class="sep">·</span><span>handled by <b>${esc(handledBy)}</b></span>` : ""}
      </div>
      <div class="state-row">
        <span class="small muted" style="margin-right:2px">Status</span>
        ${lifecycleBadge(a.lifecycle)}
        ${triageBadge(a.triage)}
        ${priorityBadge(a.priority)}
        ${a.escalated ? `<span class="badge b-red">escalated</span>` : ""}
      </div>
    </div>
  </div>
  <div class="head-actions no-print">
    <a class="btn ghost small" href="/case/${a.id}/replay">Decision replay</a>
    <button class="btn ghost small" onclick="window.print()">Print case brief</button>
    <form method="post" action="/case/${a.id}/assign" class="ops-inline" style="margin:0">
      <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
      <select name="staff_id" style="max-width:160px"><option value="">Assign to…</option>${staffOptions}</select>
      <button class="btn small">Assign</button>
    </form>
  </div>
</div>

<!-- Lifecycle progress -->
<div class="stepper-band">${lifecycleStepper(a.lifecycle)}</div>

${changed ? `<div class="changed"><b>What changed since the last triage:</b> ${changed}</div>` : ""}

<div class="case-grid">
  <div class="case-main">

    <!-- Applicant details -->
    <section class="sec">
      <div class="sec-head"><h2>Applicant overview</h2></div>
      <div class="meta-grid">
        <div class="field"><span class="lbl">Name</span><span class="val">${esc(a.full_name ?? "—")}</span></div>
        <div class="field"><span class="lbl">Email</span><span class="val"><a href="mailto:${esc(a.email_address)}">${esc(a.email_address)}</a></span></div>
        <div class="field"><span class="lbl">Phone</span><span class="val">${esc(a.phone ?? "—")}</span></div>
        <div class="field"><span class="lbl">Applied programme</span><span class="val">${programme ? `${esc(programme.code)} — ${esc(programme.name)}` : `<span class="muted">not identified yet — the latest email decides it</span>`}</span></div>
        <div class="field"><span class="lbl">School</span><span class="val">${programme?.school ? esc(programme.school) : "—"}</span></div>
        <div class="field"><span class="lbl">Intake</span><span class="val">${esc(a.intake ?? "—")}</span></div>
        <div class="field"><span class="lbl">Reference number</span><span class="val mono">${esc(a.ref_number)}</span></div>
        <div class="field"><span class="lbl">Current level</span><span class="val">${lifecycleBadge(a.lifecycle)} <span class="muted small" style="font-weight:500">moved through ${history.length} change${history.length === 1 ? "" : "s"}</span></span></div>
      </div>
      <div class="op-strip">
        <div class="op"><span class="lbl">Threads</span><span class="val">${threads.length} linked conversation${threads.length === 1 ? "" : "s"}</span></div>
        <div class="op"><span class="lbl">Follow-up ladder</span><span class="val">${a.followup_next_at ? `rung ${a.followup_rung} — next reminder ${esc(fmtDate(a.followup_next_at))}` : "not armed"}</span></div>
        <div class="op"><span class="lbl">SLA</span><span class="val">${a.sla_due_at ? `${esc(slaText(a.sla_due_at, a.sla_handled_at))} (due ${esc(fmtDate(a.sla_due_at))})` : "—"}</span></div>
        <div class="op"><span class="lbl">Assigned to</span><span class="val">${handledBy ? esc(handledBy) : "unassigned"}</span></div>
      </div>
    </section>

    ${evaluationPanel(c, a)}

    <!-- Document checklist -->
    <section class="sec">
      <div class="sec-head"><h2>Document checklist</h2><span class="small muted">${allDocs.length} received · ${activeDocs.length} active</span></div>
      <table class="doctable">
        <thead><tr><th>Document</th><th>Required</th><th>Status</th><th>Readability</th><th>Received</th></tr></thead>
        <tbody>${docRowsHtml || `<tr><td colspan="5" class="muted">No documents received yet.</td></tr>`}</tbody>
      </table>
      <p class="small muted" style="margin:14px 0 0">Select a row to see its extracted fields, provenance and raw text.</p>
    </section>

    <!-- Communication history -->
    <section class="sec">
      <div class="sec-head"><h2>Email history</h2><span class="small muted">everything exchanged with ${esc(a.full_name ?? "this applicant")}</span></div>
      ${emailItems || `<p class="muted">No emails recorded.</p>`}
    </section>

    <!-- Activity & audit trail -->
    <section class="sec">
      <div class="sec-head"><h2>Activity &amp; audit trail</h2></div>
      <div class="mini-tabs" data-tabs>
        <button class="on" data-tab="act" type="button">Activity</button>
        <button data-tab="stat" type="button">Status history</button>
        <button data-tab="aud" type="button">Audit log</button>
      </div>
      <div class="tabpane on" id="tab-act">${activityHtml}</div>
      <div class="tabpane" id="tab-stat">
        <table><tr><th>When</th><th>Change</th><th>By</th><th>Why</th></tr>
        ${historyRows || `<tr><td colspan="4" class="muted">No changes recorded.</td></tr>`}</table>
      </div>
      <div class="tabpane" id="tab-aud"><div class="timeline">${auditRows || `<p class="muted">Empty.</p>`}</div></div>
    </section>
  </div>

  <div class="case-side no-print">

    <!-- Primary actions -->
    <div class="ops-card">
      <h2>Actions</h2>
      <div class="ops-primary">
        <a class="btn" href="/case/${a.id}/compose?template=missing_documents">Request missing documents</a>
      </div>
      <div class="ops-secondary">
        <a class="btn ghost" href="/case/${a.id}/compose?template=status_answer">Answer status question</a>
        <a class="btn ghost" href="/case/${a.id}/compose?template=ack_received">Acknowledge receipt</a>
      </div>
      <hr class="ops-divider">
      <div class="ops-secondary">
        ${nextStage ? `<form method="post" action="/case/${a.id}/action" style="margin:0"><input type="hidden" name="_csrf" value="${esc(c.csrf)}"><button class="btn ghost" name="action" value="advance">Advance → ${esc(LIFECYCLE_LABELS[nextStage])}</button></form>` : ""}
        ${a.lifecycle !== "completed" ? `<form method="post" action="/case/${a.id}/action" style="margin:0"><input type="hidden" name="_csrf" value="${esc(c.csrf)}"><button class="btn ghost" name="action" value="complete">Mark completed</button></form>` : ""}
      </div>
      <hr class="ops-divider">
      <form method="post" action="/case/${a.id}/priority" class="ops-inline" style="margin:0">
        <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
        <select name="priority" style="flex:1">${["normal", "high", "urgent"].map((p) => `<option value="${p}" ${a.priority === p ? "selected" : ""}>${p} priority</option>`).join("")}</select>
        <button class="btn small ghost">Set</button>
      </form>
      <p class="small muted" style="margin:12px 0 0">Every action opens a <b>ready, pre-filled reply</b> — nothing is sent until you press Send.</p>
    </div>

    <!-- Response composer -->
    <div class="ops-card">
      <h2>Responses</h2>
      <p class="ops-sub">Pick a reply template — it is rendered with this applicant's details. Preview first; nothing is sent without your click.</p>
      ${preview ? `<div class="resp-preview"><b>${esc(preview.subject)}</b>\n\n${esc(preview.body)}</div>` : ""}
      <form method="post" action="/case/${a.id}/send">
        <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
        <label>Template</label>
        <select name="template">${tplOptions}</select>
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
          <button class="btn ghost" name="preview" value="1">Preview</button>
          <button class="btn" onclick="return confirm('Send this reply now?')">Send now</button>
        </div>
      </form>
      <p class="small muted" style="margin-top:12px">Or open any template in the full composer: ${templates.slice(0, 3).map((t) => `<a href="/case/${a.id}/compose?template=${esc(t.key)}">${esc(t.name)}</a>`).join(" · ")}</p>
      <p class="small muted" style="margin:6px 0 0"><a href="/compose?case=${a.id}" target="_blank" rel="noopener">Open a compose window for this applicant <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/></svg></a> — keeps the case file open in this tab.</p>
      <p class="small muted" style="margin:6px 0 0">Auto-response toggles per category live in <a href="/settings#automation">Settings → Automation</a>. Current modes: ${esc(autoSummary || "defaults")}</p>
    </div>

    ${isMgr ? `<div class="ops-card" id="packs">
      <h2>Official packs</h2>
      <details style="margin-bottom:12px"><summary class="small" style="cursor:pointer;font-weight:700">What's included?</summary>
        <p class="small muted" style="margin:6px 0 0">The <b>application pack</b> (application form + brochure) goes to anyone who asks about applying. The <b>admission pack</b> sends the official admission letter with its accompanying documents. The <b>credit transfer form</b> goes to transferring applicants.</p>
      </details>
      <div class="ops-secondary">
        <form method="post" action="/case/${a.id}/send-pack" onsubmit="return confirm('Send the application pack — form and brochure attached?')" style="margin:0">
          <input type="hidden" name="_csrf" value="${esc(c.csrf)}"><input type="hidden" name="kind" value="application">
          <button class="btn">Send application pack</button>
        </form>
        <form method="post" action="/case/${a.id}/send-pack" onsubmit="return confirm('Send the admission pack — letter plus accompanying documents?')" style="margin:0">
          <input type="hidden" name="_csrf" value="${esc(c.csrf)}"><input type="hidden" name="kind" value="admission">
          <button class="btn">Send admission pack</button>
        </form>
        <form method="post" action="/case/${a.id}/send-pack" onsubmit="return confirm('Send the credit transfer form to this applicant?')" style="margin:0">
          <input type="hidden" name="_csrf" value="${esc(c.csrf)}"><input type="hidden" name="kind" value="transfer">
          <button class="btn ghost">Send credit transfer form</button>
        </form>
      </div>
    </div>` : ""}

    ${outbox ? `<div class="ops-card draft-card">
      <h2>Draft held for approval <span class="heldnote">not sent</span></h2>
      <p class="small muted">${draftView && draftView.held
        ? "The system is holding this reply pending your review — there is no suggested text yet, so write the response below."
        : "The system prepared this reply but did not send it — approve, edit, or discard."}</p>
      <details style="margin:6px 0 10px"><summary class="small" style="cursor:pointer;font-weight:700">Preview draft</summary>
        <div class="resp-preview" style="margin-top:8px"><b>${esc(outbox.subject)}</b>\n\n${esc(draftView ? draftView.text : outbox.body)}</div>
      </details>
      <form method="post" action="/case/${a.id}/draft">
        <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
        <label>Subject</label>
        <input type="text" name="subject" value="${esc(outbox.subject)}">
        <label>Body</label>
        <textarea name="body" style="min-height:130px" placeholder="Write the reply to the applicant…">${esc(draftView ? draftView.text : outbox.body)}</textarea>
        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
          <button class="btn" name="decision" value="send">Send</button>
          <button class="btn ghost" name="decision" value="edit">Save changes</button>
          <button class="btn ghost danger" name="decision" value="discard" onclick="return confirm('Discard this draft?')">Discard</button>
        </div>
      </form>
    </div>` : ""}

    <div class="ops-card">
      <h2>Tasks</h2>
      ${tasks.length ? tasks.map((t) => `<div class="taskrow ${t.done ? "done" : ""}">
        <form method="post" action="/case/${a.id}/task/toggle" style="margin:0">
          <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
          <input type="hidden" name="task_id" value="${t.id}">
          <button class="btn small ghost" title="toggle">${t.done ? "☑" : "☐"}</button>
        </form>
        <span class="t">${esc(t.title)}</span>
        <span class="small muted" style="margin-left:auto">${t.done ? "done" : ""} ${esc(t.display_name ?? "")}</span>
      </div>`).join("") : `<p class="muted small">No tasks yet.</p>`}
      <form method="post" action="/case/${a.id}/task/add" style="display:flex;gap:6px;margin-top:10px">
        <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
        <input type="text" name="title" placeholder="e.g. Verify certificate with KNEC" style="flex:1">
        <button class="btn small">Add task</button>
      </form>
    </div>

    <div class="ops-card">
      <h2>Flags</h2>
      ${flags.length ? flags.map((f) => `<div class="flag-item ${f.type === "watcher_flag" ? "red" : ""}">
        <span class="badge ${f.type === "watcher_flag" ? "b-red" : "b-orange"}">${esc(flagLabel(f.type))}</span>
        <span class="fd">${esc(f.detail)}<span class="human">Human decision required.</span></span>
      </div>`).join("") : `<p class="muted small">No active flags.</p>`}
    </div>

    <div class="ops-card">
      <h2>Internal notes</h2>
      <span class="note-banner">Internal · not visible to applicant</span>
      ${noteCards || `<p class="muted small">No notes yet.</p>`}
      <form method="post" action="/case/${a.id}/note">
        <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
        <label>Add note</label>
        <textarea name="body" style="min-height:60px" placeholder="e.g. Applicant called. Waiting for original certificate."></textarea>
        <p style="margin-top:8px"><button class="btn small">Add note</button></p>
      </form>
    </div>

    ${isMgr ? `<div class="ops-card">
      <h2>Re-categorise</h2>
      <p class="ops-sub">If triage put the newest incoming email in the wrong bucket, move it after your review. Recorded in the audit trail${latestIncoming ? ` — currently <b>${esc(latestIncoming.category ?? "uncategorised")}</b>` : ""}.</p>
      <form method="post" action="/case/${a.id}/category" class="ops-inline" style="align-items:center;margin:0">
        <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
        <select name="category" style="flex:1">
          ${Object.entries(EMAIL_CATEGORY_LABELS).map(([k, v]) => `<option value="${k}" ${latestIncoming?.category === k ? "selected" : ""}>${v}</option>`).join("")}
        </select>
        <button class="btn ghost small">Save</button>
      </form>
    </div>` : ""}

    ${lastDecision ? `<div class="ops-card">
      <h2>Latest triage</h2>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px">
        ${triageBadge(lastDecision.computed_status)}
        <span class="small muted">${lastDecision.auto_sent ? "auto-sent" : "human review required"}</span>
      </div>
      <p class="small muted" style="margin:0 0 10px">Orange means a person must review this case — it is never an automatic decision either way.</p>
      <details><summary class="small" style="cursor:pointer;font-weight:700">View reasoning</summary>
        <pre style="white-space:pre-wrap;font-size:12.5px;margin:8px 0 0">${esc(lastDecision.reasoning)}</pre>
      </details>
    </div>` : ""}
  </div>
</div>
<script>
(function () {
  // Expandable document rows.
  document.querySelectorAll(".doctable tr.doc-main").forEach(function (tr) {
    tr.addEventListener("click", function () {
      var d = document.getElementById("doc-" + tr.getAttribute("data-doc"));
      if (!d) return;
      var on = d.classList.toggle("on");
      tr.classList.toggle("open", on);
    });
  });
  // Activity / Status history / Audit log tabs.
  document.querySelectorAll("[data-tabs]").forEach(function (bar) {
    var btns = bar.querySelectorAll("button");
    btns.forEach(function (b) {
      b.addEventListener("click", function () {
        btns.forEach(function (x) { x.classList.remove("on"); });
        b.classList.add("on");
        var sec = bar.parentElement;
        sec.querySelectorAll(".tabpane").forEach(function (p) { p.classList.remove("on"); });
        var pane = document.getElementById("tab-" + b.getAttribute("data-tab"));
        if (pane) pane.classList.add("on");
      });
    });
  });
})();
</script>`
  );
}

// ── Compose: a ready, pre-filled reply — one obvious path to Send ───────────

export function composePage(c: Ctx, a: ApplicantRow, tpl: { key: string; name: string; subject: string; body: string; include_banner: number; attach_pack?: string }, rendered: { subject: string; body: string }, error?: string): string {
  return head(
    c,
    `Compose — ${a.ref_number}`,
    "applicants",
    `
<div class="hero">
  <div class="row">
    ${avatar(a.full_name ?? a.ref_number, 46)}
    <div style="min-width:0">
      <div class="kicker">Compose reply · ${esc(tpl.name)}</div>
      <h1 style="margin:0">${esc(a.full_name ?? a.ref_number)}</h1>
      <div class="sub" style="margin:2px 0 0">To <b>${esc(a.email_address)}</b> · ${lifecycleBadge(a.lifecycle)} · <a href="/case/${a.id}">← back to the case file</a></div>
    </div>
  </div>
</div>

<div class="card" style="max-width:880px">
  ${error ? `<div class="flash err" style="position:static;margin-bottom:16px">${esc(error)}</div>` : ""}
  <p class="small muted" style="margin-top:0">Everything below is already filled in from the case file — the checklist, the missing documents, the reference number. Edit if you like; nothing is sent until you press Send.</p>
  <form method="post" action="/case/${a.id}/compose">
    <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
    <input type="hidden" name="template" value="${esc(tpl.key)}">
    <label>Subject</label>
    <input type="text" name="subject" value="${esc(rendered.subject)}">
    <label>Message</label>
    <textarea name="body" style="min-height:380px;font-size:14px;line-height:1.7">${esc(rendered.body)}</textarea>
    <div style="display:flex;gap:10px;margin-top:18px;align-items:center">
      <button class="btn">Send now</button>
      <a class="btn ghost" href="/case/${a.id}">Cancel — don't send</a>
      ${tpl.include_banner === 0 ? `<span class="muted small">sends without the branded banner</span>` : `<span class="muted small">branded banner is attached automatically</span>`}
      ${tpl.attach_pack === "application" || tpl.attach_pack === "admission" ? `<span class="badge b-purple">${tpl.attach_pack} pack PDFs will be attached</span>` : ""}
    </div>
  </form>
</div>`
  );
}

/**
 * New-window composer. Two shapes:
 *  - no applicant yet → recipient search (scoped server-side);
 *  - applicant chosen → the draft itself (template optional, load-then-send).
 * Designed to stand alone in its own browser window — everything the reply
 * needs is on this one page, and after sending the window becomes the case.
 */
export function composeWindowPage(
  c: Ctx,
  opts: {
    applicant?: ApplicantRow;
    matches?: ApplicantRow[];
    q?: string;
    templateKey?: string;
    subject?: string;
    body?: string;
    error?: string;
    flash?: string;
  }
): string {
  const { repo } = c;

  // ── Shape 1: pick the recipient ──────────────────────────────────────────
  if (!opts.applicant) {
    const rows = (opts.matches ?? []).map((a) => {
      const prog = a.programme ? repo.programmeByCode(a.programme) : undefined;
      return `<a class="rowline" href="/compose?case=${a.id}${opts.templateKey ? `&template=${encodeURIComponent(opts.templateKey)}` : ""}" style="display:flex;gap:12px;align-items:center;padding:10px 8px;border-radius:8px;text-decoration:none;color:inherit">
        ${avatar(a.full_name ?? a.ref_number, 30)}
        <span style="min-width:0;flex:1">
          <b>${esc(a.full_name ?? a.ref_number)}</b>
          <span class="small muted"> · ${esc(a.email_address)}${prog ? ` · ${esc(prog.name)}` : ""}</span>
        </span>
        ${lifecycleBadge(a.lifecycle)}
      </a>`;
    }).join("");
    return head(c, "Compose", "compose", `
<div class="hero">
  <div class="row">
    <div style="min-width:0">
      <div class="kicker">New window · compose</div>
      <h1 style="margin:0">Who is this reply for?</h1>
      <div class="sub" style="margin:2px 0 0">Every reply belongs to a case file — search by name, email or reference, then open the draft.</div>
    </div>
  </div>
</div>
<div class="card" style="max-width:880px">
  <form method="get" action="/compose" class="formrow" style="align-items:end">
    <div style="flex:1"><label>Search applicants</label>
      <input type="text" name="q" value="${esc(opts.q ?? "")}" placeholder="Name, email or reference number…" autofocus>
    </div>
    <div style="flex:0"><button class="btn">Search</button></div>
  </form>
  ${opts.q !== undefined
    ? (rows ? `<div style="margin-top:10px">${rows}</div>` : `<p class="small muted" style="margin:14px 0 0">No applicants you can see match “${esc(opts.q ?? "")}”. Scoped staff only see cases from their own schools.</p>`)
    : `<p class="small muted" style="margin:14px 0 0">${rows ? "Recent files:" : "No cases yet — replies appear here once applications arrive."}</p>${rows ? `<div style="margin-top:4px">${rows}</div>` : ""}`}
</div>`);
  }

  // ── Shape 2: the draft ────────────────────────────────────────────────────
  const a = opts.applicant;
  const templates = repo.listTemplates();
  const tpl = opts.templateKey ? templates.find((t) => t.key === opts.templateKey) : undefined;
  const prog = a.programme ? repo.programmeByCode(a.programme) : undefined;
  return head(c, `Compose — ${a.ref_number}`, "compose", `
<div class="hero">
  <div class="row">
    ${avatar(a.full_name ?? a.ref_number, 46)}
    <div style="min-width:0">
      <div class="kicker">New window · compose</div>
      <h1 style="margin:0">${esc(a.full_name ?? a.ref_number)}</h1>
      <div class="sub" style="margin:2px 0 0">To <b>${esc(a.email_address)}</b>${prog ? ` · ${esc(prog.name)}` : ""} · ${lifecycleBadge(a.lifecycle)} · <a href="/case/${a.id}">open the case file</a></div>
    </div>
  </div>
</div>

<div class="card" style="max-width:880px">
  ${opts.error ? `<div class="flash err" style="position:static;margin-bottom:16px">${esc(opts.error)}</div>` : ""}
  ${opts.flash ? `<div class="flash ok" style="position:static;margin-bottom:16px">${esc(opts.flash)}</div>` : ""}
  <form method="post" action="/compose">
    <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
    <input type="hidden" name="case" value="${a.id}">
    <div class="formrow" style="align-items:end">
      <div style="flex:1"><label>Start from a template (optional)</label>
        <select name="template">
          <option value="">— blank message —</option>
          ${templates.map((t) => `<option value="${esc(t.key)}" ${opts.templateKey === t.key ? "selected" : ""}>${esc(t.name)}</option>`).join("")}
        </select>
      </div>
      <div style="flex:0"><button class="btn ghost" name="action" value="prepare">Load into the draft</button></div>
    </div>
    <label>Subject</label>
    <input type="text" name="subject" value="${esc(opts.subject ?? "")}">
    <label>Message</label>
    <textarea name="body" style="min-height:340px;font-size:14px;line-height:1.7">${esc(opts.body ?? "")}</textarea>
    <div style="display:flex;gap:10px;margin-top:18px;align-items:center">
      <button class="btn">Send now</button>
      <a class="btn ghost" href="/case/${a.id}">Cancel — don’t send</a>
      ${tpl ? (tpl.include_banner === 0 ? `<span class="muted small">sends without the branded banner</span>` : `<span class="muted small">branded banner is attached automatically</span>`) : ""}
      ${tpl && (tpl.attach_pack === "application" || tpl.attach_pack === "admission") ? `<span class="badge b-purple">${tpl.attach_pack} pack PDFs will be attached</span>` : ""}
    </div>
  </form>
</div>`);
}


// ── Settings (app behaviour) & Configuration (admissions setup) ────────────

export function settingsPage(c: Ctx, flash?: string): string {
  const { repo } = c;
  const settings = repo.allSettings();
  const settingInput = (key: string, label: string) =>
    `<div><label>${esc(label)}</label><input type="text" name="${esc(key)}" value="${esc(settings[key] ?? "")}"></div>`;

  return head(
    c,
    "Settings",
    "settings",
    `
<h1>Settings</h1>
<div class="sub">How the console behaves — automation, response targets, retention.</div>
${flash ? `<div class="flash ok" style="position:static;margin-bottom:16px">${esc(flash)}</div>` : ""}

${connectionsSection(c)}

<div class="card" id="automation">
  <h2>Automation mode (draft-first)</h2>
  <p class="small muted" style="margin-top:-6px">Two rules always apply. First, automated sending is reserved for <b>fully qualified</b> applicants — a Green verdict with no flags; everyone else gets the reply as a <b>suggested draft</b> for staff to review, edit or discard, because borderline files can still be admitted on special acceptance. Second, the rollout dial: keep the global mode on <b>draft</b> (every automated reply waits for a human), then switch automation on category by category as you trust it.</p>
  <form method="post" action="/settings/automation/global" class="formrow" style="align-items:end">
    <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
    <div><label>Global mode</label><select name="mode">
      <option value="auto" ${settings["automation_mode"] !== "draft" ? "selected" : ""}>auto — safe categories send automatically</option>
      <option value="draft" ${settings["automation_mode"] === "draft" ? "selected" : ""}>draft — hold EVERY automated reply for approval</option>
    </select></div>
    <div style="flex:0"><button class="btn">Apply global mode</button></div>
  </form>
  <table style="margin-top:14px"><tr><th>Email category</th><th>Mode</th><th></th></tr>
    ${(["application", "document_submission", "missing_document", "fee_enquiry", "admission_enquiry", "follow_up", "complaint", "other"] as string[])
      .map((cat) => {
        const mode = c.repo.automationMode(cat);
        return `<tr><td>${esc(cat.replace(/_/g, " "))}</td>
        <td><span class="badge ${mode === "auto" ? "b-green" : "b-orange"}">${mode === "auto" ? "auto-send" : "draft for approval"}</span></td>
        <td><form method="post" action="/settings/automation/category" style="margin:0">
          <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
          <input type="hidden" name="category" value="${esc(cat)}">
          <button class="btn small ghost" name="mode" value="${mode === "auto" ? "draft" : "auto"}">switch to ${mode === "auto" ? "draft" : "auto"}</button>
        </form></td></tr>`;
      })
      .join("")}
  </table>
  <p class="small muted">Note: with global mode set to draft, per-category switches take effect once global returns to auto.</p>
</div>

<div class="card" id="letters">
  <h2>Letters &amp; identity</h2>
  <p class="small muted" style="margin-top:-6px">Details that appear on generated letters and outgoing mail. Response timing is fully automated — replies go out the moment a decision is made, so there are no target hours or retention dials to tune.</p>
  <form method="post" action="/settings/general">
    <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
    <div class="formrow">
      ${settingInput("ref_prefix", "Reference prefix")}
      ${settingInput("from_name", "From name")}
    </div>
    <div class="formrow">
      ${settingInput("reg_date", "Registration date (admission letter)")}
      ${settingInput("orientation_dates", "Orientation dates (admission letter)")}
    </div>
    <p><button class="btn">Save settings</button></p>
  </form>
</div>`
  );
}

// ── Account (self-service settings, available to every signed-in user) ─────


/**
 * OR-4: Gmail + Gemini connection setup — ONE home, in Settings.
 * Step-by-step Google Cloud guide (exact scope, redirect URI,
 * OAuth-Playground fallback) plus live status and test buttons.
 */
export function connectionsSection(c: Ctx): string {
  const { repo } = c;
  const settings = repo.allSettings();
  const gAddress = settings["gmail_address"] ?? "";
  const gClientId = settings["gmail_client_id"] ?? "";
  const gClientSecret = settings["gmail_client_secret"] ?? "";
  const gRefresh = settings["gmail_refresh_token"] ?? "";
  const connected = Boolean(gAddress && gClientId && gClientSecret && gRefresh);
  return `
<div id="connections">
<h1 style="margin-top:34px">Connections</h1>
<div class="sub">Gmail inbox and Gemini document AI — set up once, live immediately, no restarts.</div>

<div class="card" id="gmail">
  <h2>Gmail connection ${connected
    ? `<span class="badge b-green">connected — live sorting on</span>`
    : `<span class="badge b-orange">not connected</span>`}</h2>
  <p class="small muted" style="margin-top:-6px">Connect the admissions mailbox so incoming mail is fetched, triaged and sorted automatically every minute.</p>
  <ol class="small" style="margin:0 0 14px 18px;line-height:1.7">
    <li>In <b>Google Cloud Console</b> (console.cloud.google.com) create or pick a project for the admissions mailbox.</li>
    <li><b>APIs &amp; Services → Library</b>: enable the <b>Gmail API</b>.</li>
    <li><b>APIs &amp; Services → Credentials → Create credentials → OAuth client ID</b>, application type <b>Web application</b>.</li>
    <li>Under <b>Authorised redirect URIs</b> add this console's URL plus <span class="mono">/settings/gmail/callback</span>.</li>
    <li>Paste the <b>Client ID</b> and <b>Client secret</b> below, save, then press <b>Connect with Google…</b> and approve. The only scope requested is <span class="mono">https://www.googleapis.com/auth/gmail.modify</span> — read and send for this one mailbox.</li>
    <li>No OAuth client of your own? Use the <b>OAuth Playground</b> (developers.google.com/oauthplayground) with your own client ID and the <span class="mono">gmail.modify</span> scope, then paste the resulting refresh token into the advanced field.</li>
  </ol>
  <form method="post" action="/settings/gmail/credentials">
    <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
    <div class="formrow">
      <div><label>Gmail address</label><input type="email" name="gmail_address" value="${esc(gAddress)}" placeholder="admissions@institution.ac.ke"></div>
      <div><label>OAuth client ID</label><input type="text" name="gmail_client_id" value="${esc(gClientId)}" placeholder="…apps.googleusercontent.com"></div>
      <div><label>OAuth client secret</label><input type="password" name="gmail_client_secret" value="" placeholder="${gClientSecret ? "saved — enter a new value to replace" : "GOCSPX-…"}" autocomplete="new-password"></div>
    </div>
    <div class="formrow" style="margin-top:10px">
      <div style="flex:2"><label>Mailbox label to watch <span class="muted small">(optional — leave blank for the inbox)</span></label><input type="text" name="gmail_label" value="${esc(settings["gmail_label"] ?? "")}" placeholder="e.g. admissions-intake"></div>
      <div style="flex:2"><label>Refresh token (advanced — OAuth Playground / manual) ${gRefresh ? "<span class='muted small'>(saved)</span>" : ""}</label><input type="password" name="gmail_refresh_token_manual" value="" placeholder="1//…" autocomplete="new-password"></div>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <button class="btn ghost">Save credentials</button>
      ${gClientId && (gClientSecret || gRefresh) ? `<a class="btn" href="/settings/gmail/connect">Connect with Google…</a>` : ""}
    </div>
  </form>
  ${connected ? `
  <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px">
    <form method="post" action="/settings/gmail/test" style="margin:0"><input type="hidden" name="_csrf" value="${esc(c.csrf)}"><button class="btn ghost">Test connection</button></form>
    <form method="post" action="/settings/gmail/sync" style="margin:0"><input type="hidden" name="_csrf" value="${esc(c.csrf)}"><button class="btn ghost">Sync now</button></form>
    <form method="post" action="/settings/gmail/disconnect" style="margin:0"><input type="hidden" name="_csrf" value="${esc(c.csrf)}"><button class="btn ghost danger">Disconnect</button></form>
  </div>` : ""}
  <p class="small muted" style="margin-top:10px">${connected
    ? `Signed in as <b>${esc(gAddress)}</b>. New mail is fetched automatically — no restart needed.${settings["gmail_last_sync_at"] ? ` Last successful sync: <b>${esc(fmtDate(settings["gmail_last_sync_at"]))}</b>.` : " First sync pending (runs every minute)."}`
    : "Mail is not being fetched yet — the console still works; process mail manually or connect when ready."}</p>
  ${settings["gmail_last_error"] ? `<p class="small" style="color:var(--red)">Last sync failed: ${esc(settings["gmail_last_error"])}<br><span class="muted">If this says <span class="mono">invalid_grant</span>, the refresh token expired — press “Connect with Google…” again (or paste a fresh refresh token). If new mail still doesn’t appear after a good sync, check that the message is in the inbox of <b>${esc(gAddress || "the connected address")}</b> and within the lookback window.</span></p>` : ""}
</div>

<div class="card" id="gemini">
  <h2>Document AI (Gemini) ${settings["gemini_api_key"]
    ? `<span class="badge b-green">key saved — AI reads what OCR can't</span>`
    : `<span class="badge b-gray">optional</span>`}</h2>
  <p class="small muted" style="margin-top:-6px">When a document beats text extraction and OCR (bad scans, photos, handwriting), Gemini reads it as a vision model. Get a free key at <b>aistudio.google.com/apikey</b> (Google account → “Get API key”). The key is tested with one real call on save and goes live <b>immediately</b>, no restart. Without a key the console still works; unreadable files simply land in the review queue.</p>
  <form method="post" action="/settings/gemini">
    <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
    <div class="formrow">
      <div style="flex:2"><label>Gemini API key ${settings["gemini_api_key"] ? "(saved — paste a new value to replace)" : ""}</label><input type="password" name="gemini_api_key" value="" placeholder="AIza…" autocomplete="new-password"></div>
      <div><label>Model</label><input type="text" name="gemini_model" value="${esc(settings["gemini_model"] ?? "gemini-1.5-flash")}" placeholder="gemini-1.5-flash"></div>
      <div style="flex:0"><label>&nbsp;</label><button class="btn">Save &amp; test key</button></div>
    </div>
  </form>
  ${settings["gemini_api_key"] ? `<form method="post" action="/settings/gemini" style="margin-top:8px"><input type="hidden" name="_csrf" value="${esc(c.csrf)}"><button class="btn ghost danger small" name="clear" value="1">Remove key</button></form>` : ""}
  ${settings["gemini_last_error"] ? `<p class="small" style="color:var(--red)">Last test failed: ${esc(settings["gemini_last_error"])}</p>` : ""}
</div>
</div>`;
}

export function accountPage(c: Ctx, msg?: string): string {
  const u = c.user;
  const theme: Theme = c.theme === "dark" ? "dark" : "light";
  return head(
    c,
    "Account",
    "account",
    `
<h1>Account settings</h1>
<div class="sub">Your sign-in and appearance. These apply only to your account.</div>
${msg ? `<div class="flash ok" style="position:static;margin-bottom:16px">${esc(msg)}</div>` : ""}

<div class="card" id="profile">
  <h2>Username</h2>
  <form method="post" action="/account/username" class="formrow" style="align-items:end">
    <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
    <div><label>Username</label><input name="username" value="${esc(u.username)}" required minlength="3" maxlength="40" autocomplete="username"></div>
    <div style="flex:0"><button class="btn">Update username</button></div>
  </form>
  <p class="small muted" style="margin-top:6px">This is the name you sign in with.</p>
</div>

<div class="card" id="password">
  <h2>Password</h2>
  <form method="post" action="/account/password">
    <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
    <div class="formrow">
      <div><label>Current password</label><input type="password" name="current" required autocomplete="current-password"></div>
      <div><label>New password</label><input type="password" name="next" required minlength="8" autocomplete="new-password"></div>
      <div><label>Confirm new password</label><input type="password" name="confirm" required minlength="8" autocomplete="new-password"></div>
    </div>
    <p><button class="btn">Change password</button></p>
  </form>
</div>

<div class="card" id="appearance">
  <h2>Appearance</h2>
  <p class="small muted" style="margin-top:-6px">Choose how the console looks. You can also flip it at any time with the sun/moon button in the top bar.</p>
  <form method="post" action="/account/theme" class="formrow" style="align-items:end">
    <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
    <div><label>Theme</label><select name="theme">
      <option value="light" ${theme === "light" ? "selected" : ""}>Light</option>
      <option value="dark" ${theme === "dark" ? "selected" : ""}>Dark</option>
    </select></div>
    <div style="flex:0"><button class="btn">Apply theme</button></div>
  </form>
</div>

<div class="card" id="role">
  <h2>Your role</h2>
  <p class="small">You are signed in as <b>${esc(u.display_name)}</b> (${esc(capFirst(u.role))}). Some areas — such as Configuration, Settings and Staff management — are only available to administrators and managers.</p>
</div>`
  );
}

// ── Entry requirements editor (structured, per qualification system) ──────

function documentsPackCard(c: Ctx): string {
  const manifest = packManifest();
  const app = manifest.filter((m) => m.pack === "application");
  const adm = manifest.filter((m) => m.pack === "admission");
  const fmt = (b: number) => b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`;
  const rows = (list: typeof manifest) => list.map((m) => `<tr>
      <td>${esc(m.pretty)}</td>
      <td class="small muted">${esc(m.purpose)}</td>
      <td>${m.exists ? fmt(m.bytes) : "<b>MISSING</b>"}</td>
      <td>${m.exists ? `<a class="btn small ghost" href="/pack/${esc(m.key)}" target="_blank" rel="noopener">Open</a>` : ""}</td>
      <td>
        <input type="file" accept="application/pdf" id="pack-${esc(m.key)}" style="max-width:210px">
        <button class="btn small ghost" data-pack-slot="${esc(m.key)}">Replace</button>
        <span class="small muted" id="pack-msg-${esc(m.key)}"></span>
      </td>
    </tr>`).join("");
  return `<div class="card" id="documents">
  <div class="card-head"><h2>Documents &amp; application packs</h2></div>
  <div style="padding:14px 24px 22px">
    <p class="small muted" style="margin-top:-4px">The official PDFs the university sends. The <b>application pack</b> (form + brochure) is attached when staff send the pack on an enquiry; the <b>admission pack</b> goes out with the admission letter. Replacing a file here swaps it everywhere immediately.</p>
    <h3>Application pack</h3>
    <table><tr><th>Document</th><th>Used for</th><th>Size</th><th></th><th>Replace (PDF)</th></tr>${rows(app)}</table>
    <h3 style="margin-top:18px">Admission pack</h3>
    <table><tr><th>Document</th><th>Used for</th><th>Size</th><th></th><th>Replace (PDF)</th></tr>${rows(adm)}</table>
    <h3 style="margin-top:18px">Transfer applicants</h3>
    <p class="small muted" style="margin-top:-4px">Applicants transferring credit from another institution must return this form with their file; it is required on their checklist automatically, and staff can send it from any case.</p>
    <table><tr><th>Document</th><th>Used for</th><th>Size</th><th></th><th>Replace (PDF)</th></tr>${rows(manifest.filter((m) => m.pack === "transfer"))}</table>
  </div>
</div>
<script>
(function () {
  document.querySelectorAll("[data-pack-slot]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var slot = btn.getAttribute("data-pack-slot");
      var file = document.getElementById("pack-" + slot).files[0];
      var msg = document.getElementById("pack-msg-" + slot);
      if (!file) { msg.textContent = "Choose a PDF first."; return; }
      if (file.type !== "application/pdf") { msg.textContent = "PDF files only."; return; }
      msg.textContent = "Uploading…";
      fetch("/config/pack/replace?slot=" + encodeURIComponent(slot), {
        method: "POST",
        headers: { "x-csrf-token": "${esc(c.csrf)}", "content-type": "application/pdf" },
        body: file,
      }).then(function (res) {
        msg.textContent = res.ok ? "Saved — the new file is live." : "Upload failed (PDF under 12 MB).";
      }).catch(function () { msg.textContent = "Upload failed — network error."; });
    });
  });
})();
</script>`;
}

// ── Requirements Configuration (round 18) ─────────────────────────────────
// Structured, machine-evaluable rules per (programme × qualification system).
// Visual builder only — no code, no raw expressions. Draft → preview → activate.

const FIELD_LABELS: Record<string, string> = {
  mean_grade: "Mean grade",
  subject: "Subject grade",
  credits: "Total credits",
  principals: "Principal passes",
  subsidiaries: "Subsidiary passes",
  points: "Total points",
  gpa: "GPA",
  class: "Degree class",
};

// OR-6: grades are CLICK-TO-REVEAL PICKERS from the system's own ladder —
// never free text — so the config screen can only express values the engine
// can actually enforce (display == enforce). Numeric fields keep bounded
// number inputs. The server re-validates against the same ladders.
const GRADE_CLASS_LADDERS: Record<string, string[]> = {
  degree: ["Pass", "Second Class Honours (Lower Division)", "Second Class Honours (Upper Division)", "First Class Honours"],
  diploma: ["Pass", "Credit", "Distinction"],
};

function conditionValuePicker(system: string, level: CourseLevel, node: RuleNode): string {
  const v = node.value ?? "";
  const picker = (opts: string[], attr: string): string =>
    `<select name="value" data-grade-picker="${esc(attr)}" style="width:auto;min-width:130px">
      <option value="">— pick —</option>
      ${opts.map((g) => `<option value="${esc(g)}"${v === g ? " selected" : ""}>${esc(g)}</option>`).join("")}
    </select>`;
  if (node.field === "class") {
    return picker(GRADE_CLASS_LADDERS[level === "diploma" || level === "certificate" ? "diploma" : "degree"], "class");
  }
  if (node.field === "mean_grade" || node.field === "subject") {
    const ladder = EXAM_SYSTEMS.find((m) => m.system === system)?.gradeOptions;
    if (ladder) return picker(ladder, system);
  }
  if (["credits", "principals", "subsidiaries", "points"].includes(node.field ?? "")) {
    return `<input type="number" min="0" step="1" name="value" value="${esc(v)}" placeholder="minimum" style="width:110px;margin:0">`;
  }
  if (node.field === "gpa") {
    return `<input type="number" min="0" max="4" step="0.1" name="value" value="${esc(v)}" placeholder="0.0–4.0" style="width:110px;margin:0">`;
  }
  return `<input name="value" value="${esc(v)}" placeholder="value" style="width:130px;margin:0">`;
}

/** Recursive visual builder for one node of the rule tree. */
function ruleNodeEditor(c: Ctx, target: string, system: string, node: RuleNode, depth: number, subjects: string[], level: CourseLevel): string {
  const csrf = `<input type="hidden" name="_csrf" value="${esc(c.csrf)}">`;
  const targetFields = `<input type="hidden" name="target" value="${esc(target)}"><input type="hidden" name="system" value="${esc(system)}">`;
  const pad = depth * 18;

  if (node.kind === "group") {
    const logicForm = `<form class="node-row" method="post" action="/config/requirements/node-save" style="margin-left:${pad}px">
      ${csrf}${targetFields}<input type="hidden" name="node" value="${node.id}">
      <span class="badge b-purple">Group</span>
      <select name="logic" style="width:auto">
        ${["AND", "OR", "NOT"].map((l) => `<option value="${l}" ${node.logic === l ? "selected" : ""}>${l === "NOT" ? "NOT (none of)" : l}</option>`).join("")}
      </select>
      <button class="btn small ghost" title="Save group logic">Save</button>
    </form>`;
    const addButtons = `<div class="node-add" style="margin-left:${pad + 18}px">
      <form method="post" action="/config/requirements/node-add" style="margin:0">${csrf}${targetFields}<input type="hidden" name="parent" value="${node.id}"><input type="hidden" name="kind" value="condition"><button class="btn small ghost">+ Condition</button></form>
      <form method="post" action="/config/requirements/node-add" style="margin:0">${csrf}${targetFields}<input type="hidden" name="parent" value="${node.id}"><input type="hidden" name="kind" value="group"><button class="btn small ghost">+ Subgroup</button></form>
      <form method="post" action="/config/requirements/node-delete" style="margin:0" onsubmit="return confirm('Remove this group and everything inside it?')">${csrf}${targetFields}<input type="hidden" name="node" value="${node.id}"><button class="btn small ghost" style="color:#A11F2E">Remove group</button></form>
    </div>`;
    const children = (node.children ?? []).map((ch) => ruleNodeEditor(c, target, system, ch, depth + 1, subjects, level)).join("");
    return `${logicForm}${addButtons}${children}`;
  }

  const isSubject = node.field === "subject";
  const subjectSelect = isSubject
    ? `<select name="subject" style="width:auto;min-width:160px" title="Subject">
        <option value="">— subject —</option>
        ${subjects.map((s) => `<option value="${esc(s)}" ${node.subject === s ? "selected" : ""}>${esc(s)}</option>`).join("")}
      </select>`
    : "";
  return `<form class="node-row" method="post" action="/config/requirements/node-save" style="margin-left:${pad}px">
    ${csrf}${targetFields}<input type="hidden" name="node" value="${node.id}">
    <span class="mk ${node.value ? "ok" : "opt"}">${node.value ? "✓" : "…"}</span>
    <select name="field" style="width:auto" title="What is checked">
      ${Object.entries(FIELD_LABELS).map(([k, v]) => `<option value="${k}" ${node.field === k ? "selected" : ""}>${v}</option>`).join("")}
    </select>
    ${subjectSelect}
    <span class="muted small">≥</span>
    <input type="hidden" name="comparator" value=">=">
    ${conditionValuePicker(system, level, node)}
    <button class="btn small ghost">Save</button>
    <form method="post" action="/config/requirements/node-delete" style="margin:0" onsubmit="return confirm('Remove this condition?')">${csrf}${targetFields}<input type="hidden" name="node" value="${node.id}"><button class="btn small ghost" style="color:#A11F2E">✕</button></form>
  </form>`;
}

function requirementsTab(c: Ctx, reqsTarget?: string, reqsSystem?: string): string {
  const { repo } = c;
  const programmes = repo.listProgrammes();

  const system = (reqsSystem && (ADMISSION_SYSTEMS as readonly string[]).includes(reqsSystem) ? reqsSystem : "KCSE") as AdmissionSystem;
  const targetOptions = [
    ["BASE:degree", "University-wide defaults — Degree"],
    ["BASE:diploma", "University-wide defaults — Diploma"],
    ["BASE:certificate", "University-wide defaults — Certificate"],
    ["BASE:masters", "University-wide defaults — Master's"],
    ["BASE:phd", "University-wide defaults — PhD"],
    ...programmes.map((p) => [p.code, `${p.code} · ${p.name}`] as [string, string]),
  ];
  const target = reqsTarget && targetOptions.some(([v]) => v === reqsTarget) ? reqsTarget : "BASE:degree";
  const isBase = target.startsWith("BASE:");
  const level = (isBase ? target.slice(5) : repo.programmeByCode(target)?.level ?? "degree") as CourseLevel;
  const programme = isBase ? null : target.toUpperCase();

  const active = repo.listRuleSets({ programme, status: "active", system }).find((s) => s.level === level);
  const draft = repo.getDraftSet(programme, level, system);
  const shown = draft ?? active;
  const shownTree = shown ? repo.getRuleTree(shown.id) : [];
  const catalogue = repo.listSubjectCatalogue(system).filter((s) => s.active === 1);
  const subjects = catalogue.map((s) => s.name);
  const sysLabel = SYSTEM_LABELS[system] ?? system;

  const targetBar = `<form class="inline" method="get" action="/config" id="reqbuilder" style="margin-bottom:18px">
    <input type="hidden" name="tab" value="requirements">
    <label class="small muted">Programme</label>
    <select name="reqs" onchange="this.form.submit()">
      ${targetOptions.map(([v, l]) => `<option value="${esc(v)}" ${target === v ? "selected" : ""}>${esc(l)}</option>`).join("")}
    </select>
    <label class="small muted">Qualification system</label>
    <select name="system" onchange="this.form.submit()">
      ${ADMISSION_SYSTEMS.map((s) => `<option value="${s}" ${system === s ? "selected" : ""}>${esc(SYSTEM_LABELS[s])}</option>`).join("")}
    </select>
  </form>`;

  const csrf = `<input type="hidden" name="_csrf" value="${esc(c.csrf)}">`;
  const tf = `<input type="hidden" name="target" value="${esc(target)}"><input type="hidden" name="system" value="${esc(system)}">`;

  const versionNote = shown
    ? shown.status === "draft"
      ? `<span class="badge b-orange">DRAFT v${shown.version}</span> <span class="small muted">based on active v${shown.version - 1} — not yet judging anyone</span>`
      : `<span class="badge b-green">ACTIVE v${shown.version}</span> <span class="small muted">edits create a draft; the active set keeps judging until you activate the replacement</span>`
    : `<span class="badge b-gray">NO SET YET</span>`;

  const builder = shown ? `
    <div class="node-add" style="margin-bottom:10px">
      <form method="post" action="/config/requirements/node-add" style="margin:0">${csrf}${tf}<input type="hidden" name="kind" value="condition"><button class="btn small ghost">+ Top-level condition</button></form>
      <form method="post" action="/config/requirements/node-add" style="margin:0">${csrf}${tf}<input type="hidden" name="kind" value="group"><button class="btn small ghost">+ Top-level group</button></form>
    </div>
    ${shownTree.length ? shownTree.map((n) => ruleNodeEditor(c, target, system, n, 0, subjects, level)).join("") : `<p class="small muted">No rules yet — add a condition (e.g. Mean grade ≥ C+) or a group (OR-alternatives).</p>`}
  ` : `<p class="small muted">No requirement set exists for this programme/system yet — add a first rule to create a draft.</p>
    <form method="post" action="/config/requirements/node-add" style="margin:10px 0 0">${csrf}${tf}<input type="hidden" name="kind" value="condition"><button class="btn small">Start a rule set</button></form>`;

  const preview = shown ? `
    <h3 style="margin:0 0 6px;font-size:13px">Preview before activation</h3>
    <p class="small" style="margin:0 0 8px"><b>Rule rendering:</b> ${esc(describeRuleTree(shownTree))}</p>
    <p class="small" style="margin:0 0 12px"><b>What it means:</b> ${esc(interpretRuleTree(shownTree, sysLabel))}</p>
    ${draft ? `<div class="row">
      <form method="post" action="/config/requirements/activate" style="margin:0" onsubmit="return confirm('Activate draft v${draft.version}? New evaluations will use it; historical cases keep their frozen version.')">${csrf}${tf}<button class="btn">Activate draft v${draft.version}</button></form>
      <form method="post" action="/config/requirements/discard" style="margin:0" onsubmit="return confirm('Discard the draft? The active requirement set stays as it is.')">${csrf}${tf}<button class="btn ghost">Discard draft</button></form>
    </div>` : `<p class="small muted" style="margin:0">Nothing to activate — you are looking at the active set.</p>`}
  ` : "";

  // OR-6: the subject catalogue is fully editable — add, rename, retire,
  // restore — per qualification system, all on this one page.
  const allCatalogue = repo.listSubjectCatalogue();
  const catalogueRows = ADMISSION_SYSTEMS.map((s) => {
    const items = allCatalogue.filter((r) => r.system === s);
    return `<details ${s === system ? "open" : ""} style="margin-bottom:8px">
      <summary style="cursor:pointer;font-weight:700;font-size:13px">${esc(SYSTEM_LABELS[s])} <span class="muted small">(${items.length} subject${items.length === 1 ? "" : "s"})</span></summary>
      <table style="margin-top:6px"><tr><th>Subject</th><th>Status</th><th style="min-width:280px">Rename</th><th></th></tr>
        ${items.map((r) => `<tr>
          <td>${esc(r.name)}</td>
          <td>${r.active ? `<span class="badge b-green">active</span>` : `<span class="badge b-gray">retired</span>`}</td>
          <td><form method="post" action="/config/requirements/catalogue-rename" style="display:flex;gap:6px;margin:0">${csrf}<input type="hidden" name="id" value="${r.id}"><input type="text" name="name" value="${esc(r.name)}" style="margin:0"><button class="btn small ghost">Save</button></form></td>
          <td><form method="post" action="/config/requirements/catalogue-toggle" style="margin:0">${csrf}<input type="hidden" name="id" value="${r.id}"><button class="btn small ghost">${r.active ? "Retire" : "Restore"}</button></form></td>
        </tr>`).join("")}
      </table>
      <form method="post" action="/config/requirements/catalogue-add" class="formrow" style="margin-top:10px">
        ${csrf}<input type="hidden" name="system" value="${esc(s)}">
        <div style="flex:2"><label>Add a subject to ${esc(SYSTEM_LABELS[s])}</label><input type="text" name="name" placeholder="e.g. Aviation Studies"></div>
        <div style="flex:0"><label>&nbsp;</label><button class="btn small ghost">Add subject</button></div>
      </form>
    </details>`;
  }).join("");

  // Round 19: rule operations — bulk re-evaluation + the parked-mail queue.
  const deadLetters = repo.listDeadLetters();
  const dlRows = deadLetters
    .map(
      (d) => `<tr>
      <td>${esc(d.subject || "(unknown subject)")}</td>
      <td class="small">${esc(d.from_addr || d.message_id)}</td>
      <td class="small muted">${esc(d.error.slice(0, 140))}${d.error.length > 140 ? "…" : ""}</td>
      <td>${d.attempts}</td>
      <td>
        <span style="display:inline-flex;gap:6px">
          <form method="post" action="/config/dead-letter/retry" style="margin:0">${csrf}<input type="hidden" name="id" value="${d.id}"><button class="btn small ghost">Retry</button></form>
          <form method="post" action="/config/dead-letter/delete" style="margin:0" onsubmit="return confirm('Drop this parked message for good? The sender will need to email again.')">${csrf}<input type="hidden" name="id" value="${d.id}"><button class="btn small ghost">Drop</button></form>
        </span>
      </td>
    </tr>`
    )
    .join("");

  const opsCard = `
<section class="card" id="rules-ops">
  <h2>Rule operations</h2>
  <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">
    <form method="post" action="/config/reevaluate-open" style="margin:0" onsubmit="return confirm('Re-evaluate every open case against its frozen rule set?')">
      ${csrf}<button class="btn ghost">Re-evaluate all open cases</button>
    </form>
    <p class="small muted" style="margin:0;max-width:560px">After changing or activating a rule set, this re-runs the admissions evaluation across every open case. Each case keeps the requirement version it was frozen under — nobody is judged retroactively.</p>
  </div>
</section>

<section class="card" id="deadletters">
  <h2>Parked mail <span class="muted small" style="text-transform:none;letter-spacing:0">— messages that kept failing ingestion, isolated instead of lost</span></h2>
  ${
    deadLetters.length
      ? `<table><tr><th>Message</th><th>From</th><th>Last error</th><th>Attempts</th><th></th></tr>${dlRows}</table>
         <p class="small muted" style="margin-top:8px">Retry re-runs ingestion for that message on the next sync. Oversized mail stays parked until the sender re-sends smaller files.</p>`
      : `<p class="small muted">Nothing parked — every message either processed cleanly or has not failed ${repo.deadLetterMaxAttempts()} times.</p>`
  }
</section>`;

  // OR-5: the document checklist is generated deterministically — read-only here.
  // OR-6: CourseLevel now carries masters/phd directly (legacy "postgrad"
  // rows are migrated on open; keep a defensive alias anyway).
  const genLevel: ProgrammeLevel = ((level as string) === "postgrad" ? "masters" : level) as ProgrammeLevel;
  const matrixSpecs = documentRequirementsFor({ level: genLevel, route: "fresh", nationality: "unknown", programmeCode: isBase ? null : target });
  const matrixRows = matrixSpecs
    .map(
      (spec, i) => `<tr>
      <td class="small muted">${i + 1}</td>
      <td>${esc(spec.label)}</td>
      <td>${spec.blocking ? `<span class="badge b-purple">required</span>` : `<span class="badge b-gray">post-admission — never blocks</span>`}</td>
      <td class="small muted">${esc(spec.conditional ?? "")}</td>
    </tr>`
    )
    .join("");
  const matrixCard = `
<section class="card" id="doc-matrix">
  <h2>Document checklist <span class="muted small" style="text-transform:none;letter-spacing:0">— generated deterministically, not staff-configurable</span></h2>
  <p class="small muted" style="margin-top:-4px">What an application file must contain is generated deterministically from the official application-form checklist (data/pack/application-form.pdf, pp. 3–4) — level × curriculum × nationality × route. There are no toggles: conditional items are asked for, never assumed, and post-admission items never block a file. Full matrix: <span class="mono">docs/DOCUMENT_MATRIX.md</span>. Shown for <b>${esc(isBase ? `university-wide ${genLevel}` : `${target} (${genLevel})`)}</b>, fresh applicants:</p>
  <table><tr><th>#</th><th>Document</th><th>Status</th><th>Applies because</th></tr>${matrixRows}</table>
</section>`;

  return `
${matrixCard}

<section class="card">
  <h2>Entry requirements <span class="muted small" style="text-transform:none;letter-spacing:0">— structured rules the engine can evaluate, per qualification route</span></h2>
  <p class="small muted" style="margin-top:-4px">Rules are built visually with AND / OR / NOT groups — never as code. Drafts are previewed below before activation; activated sets are versioned, and historical cases keep the version they were evaluated against.</p>
  ${targetBar}
  ${versionNote}
  <div style="margin-top:14px">${builder}</div>
</section>

${shown ? `<section class="card" id="reqpreview">${preview}</section>` : ""}

<section class="card" id="catalogue">
  <h2>Subject catalogue <span class="muted small" style="text-transform:none;letter-spacing:0">— managed centrally, shared by every programme</span></h2>
  ${catalogueRows || `<p class="small muted">The catalogue is empty.</p>`}
  <form class="inline" method="post" action="/config/requirements/catalogue-add" style="margin-top:10px">
    ${csrf}
    <select name="system" style="width:auto">${ADMISSION_SYSTEMS.map((s) => `<option value="${s}" ${s === system ? "selected" : ""}>${esc(SYSTEM_LABELS[s])}</option>`).join("")}</select>
    <input name="name" placeholder="New subject name" style="max-width:260px">
    <button class="btn ghost">Add subject</button>
  </form>
</section>

${opsCard}`;
}

export function configPage(c: Ctx, _selectedTemplate?: string, flash?: string, reqsTarget?: string, tabChoice?: string, reqsSystem?: string): string {

  const { repo } = c;
  const programmes = repo.listProgrammes();
  const staff = repo.listStaff().filter((m) => m.active);

  const assignForm = (p: { code: string; owner_id: number | null }) =>
    `<form method="post" action="/config/course-owner" style="display:flex;gap:6px;margin:0;align-items:center">
      <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
      <input type="hidden" name="programme" value="${esc(p.code)}">
      <select name="owner" style="width:auto;min-width:190px">
        <option value="">Unassigned</option>
        ${staff.map((m) => `<option value="${m.id}" ${p.owner_id === m.id ? "selected" : ""}>${esc(m.display_name)} (${capFirst(m.role)})</option>`).join("")}
      </select>
      <button class="btn small ghost">Assign</button>
    </form>`;
  // OR-6: schools and courses live on ONE page. Every school exists even
  // before it has courses; renaming a school moves every course with it.
  const schools = repo.listSchools();
  const unaffiliated = programmes.filter((x) => !x.school);
  const enforcedSummary = (code: string): string => {
    const sets = repo.activeSetsForProgramme(code);
    if (!sets.length) return `<span class="small muted">No active requirement rules yet — files for this course route to human review.</span>`;
    return `<details style="margin-top:8px"><summary class="small" style="cursor:pointer">Enforced entry requirements (${sets.length} route${sets.length === 1 ? "" : "s"}) — exactly what the engine checks</summary>
      <ul style="margin:6px 0 0;padding-left:18px">
        ${sets.map((s) => `<li class="small" style="margin-bottom:3px"><b>${esc(SYSTEM_LABELS[s.system] ?? s.system)}</b> <span class="muted">(${s.programme ? "course-specific" : "university-wide default"}, v${s.version})</span>: ${esc(describeRuleTree(s.nodes ?? []) || "no conditions")}</li>`).join("")}
      </ul>
      <p class="small muted" style="margin:6px 0 0">Edit in the <a href="/config?tab=requirements&reqs=${encodeURIComponent(code)}">Requirements tab</a> — edits create a draft; nothing judges applicants until you activate it.</p>
    </details>`;
  };
  const schoolHeader = (school: string): string => `<tr class="schoolrow"><td colspan="3">
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <b>${esc(school || "No school assigned")}</b>
        ${school ? `<form method="post" action="/config/schools/rename" style="display:flex;gap:6px;margin:0;align-items:center">
          <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
          <input type="hidden" name="from" value="${esc(school)}">
          <input type="text" name="to" value="${esc(school)}" title="New school name" style="width:auto;min-width:220px;margin:0">
          <button class="btn small ghost" title="Rename this school for every course in it">Rename school</button>
        </form>` : ""}
      </div>
    </td></tr>`;
  const courseRow = (pr: Programme): string => `<tr>
        <td><b>${esc(pr.code)}</b><br><span class="small muted">${esc(pr.name)}</span><br><span class="badge ${pr.level === "phd" || pr.level === "masters" ? "b-purple" : "b-gray"}" style="margin-top:4px">${pr.level === "phd" ? "PhD" : capFirst(pr.level)}</span></td>
        <td>
          <form method="post" action="/config/programme/edit" style="display:flex;gap:6px;align-items:flex-start;max-width:640px">
            <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
            <input type="hidden" name="programme" value="${esc(pr.code)}">
            <div style="flex:1">
              <input type="text" name="name" value="${esc(pr.name)}" title="Course name" style="margin-bottom:6px">
              <textarea name="entry_requirements" rows="3" title="Reference notes (not enforced — the enforced rules are shown below)" placeholder="Reference notes only — prospectus wording, special cases…" style="min-height:64px;font-size:12.5px">${esc(pr.entry_requirements)}</textarea>
            </div>
            <button class="btn small ghost" title="Save course details">Save</button>
          </form>
          ${enforcedSummary(pr.code)}
        </td>
        <td>${assignForm(pr)}</td>
      </tr>`;
  const courseRows = schools.map((school) => {
    const rows = programmes.filter((x) => (x.school || "") === school);
    return schoolHeader(school) + (rows.length
      ? rows.map(courseRow).join("")
      : `<tr><td colspan="3" class="small muted" style="padding-left:26px">No courses yet — add one below and set its school to “${esc(school)}”.</td></tr>`);
  }).join("") + (unaffiliated.length
    ? schoolHeader("") + unaffiliated.map(courseRow).join("")
    : "");

  const tab = tabChoice === "requirements" ? "requirements" : tabChoice === "replies" ? "replies" : "courses";
  const tabBar = `<div class="tabs" style="margin:0 0 20px">
    <a href="/config?tab=requirements" class="${tab === "requirements" ? "on" : ""}">Requirements</a>
    <a href="/config?tab=courses" class="${tab === "courses" ? "on" : ""}">Course configuration</a>
    <a href="/config?tab=replies" class="${tab === "replies" ? "on" : ""}">Reply configuration</a>
  </div>`;

  const intakesCard = `<div class="card" id="intakes">
  <h2>Intake deadlines</h2>
  <p class="small muted" style="margin-top:-6px">Submissions arriving after the deadline are flagged <b>late_submission</b> for a human — the system never auto-rejects on deadline alone.</p>
  <table><tr><th>Intake</th><th>Deadline</th><th></th></tr>
    ${c.repo.listIntakeRows().map((i) => `<tr>
      <td>${esc(i.name)}</td>
      <td><form method="post" action="/settings/intake-deadline" style="display:flex;gap:6px;margin:0">
        <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
        <input type="hidden" name="name" value="${esc(i.name)}">
        <input type="date" name="deadline" value="${esc(i.deadline ? i.deadline.slice(0, 10) : "")}" style="width:auto">
        <button class="btn small ghost">Save</button>
      </form></td>
      <td class="small muted">${i.deadline ? "" : "no deadline set"}</td>
    </tr>`).join("")}
  </table>
</div>`;

  const courseHtml = `
<div class="card nopad" id="courses">
  <div class="card-head"><h2>Courses &amp; ownership</h2></div>
  <p class="small muted" style="padding:0 24px;margin:8px 0 0">Every course is handled by someone — assign the responsible officer here. The notes column is free-text reference; the <b>enforced</b> subject-and-grade rules for each course live in the <a href="/config?tab=requirements">Requirements tab</a>.</p>
  ${programmes.length
    ? `<table><tr><th>Programme</th><th>Course details &amp; reference notes</th><th>Handled by</th></tr>${courseRows}</table>`
    : `<div class="empty"><p>No courses yet — add the first one below.</p></div>`}
  <div style="padding:18px 24px 22px;border-top:1px solid var(--line2);margin-top:14px">
    <h2 id="entryreqs">Entry requirements</h2>
    <p class="small muted" style="margin-top:-2px">Entry requirements are now structured, machine-evaluable rules — built visually per programme and qualification system, with a preview before activation. <a href="/config?tab=requirements">Open the Requirements tab →</a></p>

    <h2 style="margin-top:20px">Required documents (all courses)</h2>
    <p class="small muted" style="margin-top:-6px">OR-5: which documents a file must contain is <b>generated deterministically</b> from the official application-form checklist (level × curriculum × nationality × route). It is not staff-configurable — there are no toggles. Conditional items are asked for, never assumed; KCPE is never required; post-admission items never block a file. See the live matrix in the <a href="/config?tab=requirements">Requirements tab</a> and <span class="mono">docs/DOCUMENT_MATRIX.md</span>.</p>
    <h2 style="margin-top:26px" id="addcourse">Add a course or intake</h2>
    <p class="small muted" style="margin-top:-6px">Create a new programme — it appears immediately in the picker above, in course ownership and across the admissions pipeline — or add another intake for existing courses. Master's and PhD are separate levels, each judged by its own university-wide defaults.</p>
    <form method="post" action="/settings/lists/add" class="formrow" style="margin-top:10px">
      <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
      <div><label>New programme code</label><input type="text" name="prog_code" placeholder="e.g. MED"></div>
      <div style="flex:2"><label>Programme name</label><input type="text" name="prog_name" placeholder="e.g. Bachelor of Medicine"></div>
      <div><label>School</label><select name="prog_school"><option value="">No school yet</option>${schools.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("")}</select></div>
      <div><label>Level</label><select name="prog_level"><option value="degree">Degree</option><option value="diploma">Diploma</option><option value="certificate">Certificate</option><option value="masters">Master's</option><option value="phd">PhD</option></select></div>
      <div><label>New intake</label><input type="text" name="intake" placeholder="e.g. May 2027"></div>
      <div style="flex:0"><label>&nbsp;</label><button class="btn">Add course</button></div>
    </form>
    <h2 style="margin-top:26px" id="schools">Schools (faculties)</h2>
    <p class="small muted" style="margin-top:-6px">A school exists as soon as it is created — even before its first course. Rename it in the course table above (the rename follows every course); add a new one here.</p>
    <form method="post" action="/config/schools/add" class="formrow" style="margin-top:10px">
      <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
      <div style="flex:2"><label>New school name</label><input type="text" name="name" placeholder="e.g. School of Aviation"></div>
      <div style="flex:0"><label>&nbsp;</label><button class="btn">Add school</button></div>
    </form>
  </div>
</div>

${intakesCard}`;

  const replyHtml = `
${documentsPackCard(c)}


<div class="card" id="templates-home">
  <h2>Email templates</h2>
  <p class="small muted" style="margin-top:-6px">OR-7: every outgoing email type — automated replies, reminders and staff messages — is edited in the dedicated <a href="/templates">Templates section</a>, with placeholders documented, a live preview, reset-to-default and optional pack attachments.</p>
  <p><a class="btn" href="/templates">Open the Templates section →</a></p>
</div>

<div class="card" id="branding">
  <h2>Email branding</h2>
  <p class="small muted" style="margin-top:-6px">The banner below is placed at the top of <b>every</b> outgoing email — automated replies, template sends and document packs alike. Replace it any time; individual templates can also opt out in the editor above.</p>
  <img id="banner-preview" src="/assets/email-banner" alt="Email banner" style="width:100%;max-width:720px;border:1px solid var(--lav-line);border-radius:8px;display:block">
  <p class="small" style="margin-top:12px">Change the banner — JPG or PNG, under 900 KB:
    <input type="file" id="banner-file" accept="image/jpeg,image/png" style="width:auto;display:inline-block;margin-left:8px"></p>
  <p class="small muted" id="banner-msg" role="status"></p>
</div>
<script>
(function () {
  var f = document.getElementById("banner-file");
  if (!f) return;
  f.addEventListener("change", function () {
    var file = f.files && f.files[0];
    if (!file) return;
    var msg = document.getElementById("banner-msg");
    msg.textContent = "Uploading…";
    fetch("/config/branding/banner", {
      method: "POST",
      headers: { "x-csrf-token": "${esc(c.csrf)}", "content-type": file.type },
      body: file,
    }).then(function (res) {
      if (res.ok) {
        msg.textContent = "Saved — the banner now appears on every outgoing email.";
        document.getElementById("banner-preview").src = "/assets/email-banner?" + Date.now();
      } else {
        msg.textContent = "Upload failed — use a JPG or PNG under 900 KB.";
      }
    }).catch(function () { msg.textContent = "Upload failed — network error."; });
  });
})();
</script>

<div class="card" id="export">
  <h2>Export (CSV)</h2>
  <p style="display:flex;gap:8px;flex-wrap:wrap;margin:4px 0 0">
    <a class="btn ghost small" href="/export/applicants.csv">Applicants</a>
    <a class="btn ghost small" href="/export/queue.csv">Review queue</a>
    <a class="btn ghost small" href="/export/audit.csv">Audit log</a>
  </p>
</div>`;

  return head(
    c,
    "Configuration",
    "config",
    `
<h1>Configuration</h1>
<div class="sub">Courses, requirements, deadlines and reply behaviour — changes apply to newly processed email immediately.</div>
${flash ? `<div class="flash ok" style="position:static;margin-bottom:16px">${esc(flash)}</div>` : ""}
${tabBar}
${tab === "requirements" ? requirementsTab(c, reqsTarget, reqsSystem) : tab === "courses" ? courseHtml : replyHtml}
`
  );
}

// ── OR-7: Templates section — one home for every outgoing email type ──────
// What sends each template is annotated right next to it, placeholders are
// documented with a live preview, every template can be reset to the
// official default, and each can optionally attach an official pack PDF set.

const TEMPLATE_USAGE: Record<string, string> = {
  docs_request: "Sent automatically by the pipeline when an enquiry arrives with no documents yet.",
  missing_documents: "Sent automatically when only some documents arrived — and reused by the reminder ladder (each rung adds a REMINDER prefix).",
  ack_received: "Sent automatically when a file is complete and logged.",
  status_answer: "Sent automatically for status questions, including reference-number-only emails.",
  under_review: "Manual staff reply while a file is under review.",
  verification: "Manual staff reply once a file moves to verification.",
  generic_enquiry: "Automated fallback acknowledgement for anything else.",
  admission_letter: "Sent automatically on auto-admission and from the case page — carries the full admission pack.",
};

const PLACEHOLDER_DOCS: Array<[string, string]> = [
  ["{ref}", "the applicant's reference number"],
  ["{name}", "full name (falls back to “Applicant”)"],
  ["{first_name}", "first name only"],
  ["{missing_docs}", "bulleted list of still-missing documents"],
  ["{missing_docs_section}", "the missing list wrapped in a polite paragraph"],
  ["{checklist}", "the full requirement checklist with ✓ / ✗ per item"],
  ["{status}", "current lifecycle status in plain language"],
  ["{institution}", "the university name"],
  ["{programme}", "applied programme name"],
  ["{reg_date}", "registration date (Settings → Response targets)"],
  ["{orientation_dates}", "orientation dates (Settings → Response targets)"],
  ["{read_back}", "“we read your grades as …” read-back, when available"],
  ["{document_issues}", "per-document quality issues (unreadable pages etc.)"],
];

export function templatesPage(c: Ctx, selectedKey?: string, flash?: string): string {
  const { repo } = c;
  const templates = repo.listTemplates();
  const tpl = (selectedKey ? templates.find((t) => t.key === selectedKey) : undefined) ?? templates[0];

  const picker = `<form class="inline" method="get" action="/templates" style="margin-bottom:6px">
    <label class="small muted">Template</label>
    <select name="template" onchange="this.form.submit()">
      ${templates.map((t) => `<option value="${esc(t.key)}" ${tpl.key === t.key ? "selected" : ""}>${esc(t.name)} (${esc(t.key)})</option>`).join("")}
    </select>
  </form>`;

  const usage = TEMPLATE_USAGE[tpl.key] ?? "Manual staff reply.";
  const packFlag = tpl.attach_pack ?? "none";

  // Live preview against a sample applicant — exactly what renderTemplate
  // will produce, so staff see the real output before anyone receives it.
  const preview = renderTemplate(tpl.subject, tpl.body, {
    ref: "RU-2026-000001",
    institution: repo.getSetting("institution_name", "Riara University"),
    name: "Wanjiku Kamau",
    missingLabels: ["Leaving Certificate", "Passport Photo"],
    checklist: "✓ Application Form\n✗ Leaving Certificate\n✗ Passport Photo",
    statusLabel: "Documents received",
    programme: "Bachelor of Laws",
    regDate: repo.getSetting("reg_date", ""),
    orientationDates: repo.getSetting("orientation_dates", ""),
    readBack: "We read your KCSE mean grade as B (plain).",
    documentIssues: "",
  });
  const unknown = [...new Set(((tpl.subject + " " + tpl.body).match(/\{[a-z_]+\}/g) ?? []).filter((ph) => !PLACEHOLDER_DOCS.some(([k]) => k === ph)))];

  const editor = `<form method="post" action="/templates/save">
    <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
    <input type="hidden" name="key" value="${esc(tpl.key)}">
    <label>Display name</label><input type="text" name="name" value="${esc(tpl.name)}">
    <label>Subject (the reference number is prepended automatically)</label><input type="text" name="subject" value="${esc(tpl.subject)}">
    <label>Body</label><textarea name="body" style="min-height:260px">${esc(tpl.body)}</textarea>
    <div class="formrow" style="margin-top:10px">
      <div><label>Attach official pack PDFs</label><select name="attach_pack">
        <option value="none" ${packFlag === "none" ? "selected" : ""}>No pack</option>
        <option value="application" ${packFlag === "application" ? "selected" : ""}>Application pack (form + brochure)</option>
        <option value="admission" ${packFlag === "admission" ? "selected" : ""}>Admission pack (all 8 documents)</option>
      </select></div>
      <div style="flex:2"><label>&nbsp;</label><span class="small muted">Applies to automated and manual sends alike. Missing pack files are audited, never skipped silently.</span></div>
    </div>
    <label style="display:flex;gap:8px;align-items:center;margin-top:8px"><input type="checkbox" name="include_banner" style="width:auto" ${tpl.include_banner === 0 ? "" : "checked"}> Attach the email banner to this template</label>
    <div style="display:flex;gap:10px;margin-top:14px;align-items:center">
      <button class="btn">Save template</button>
    </div>
  </form>
  <form method="post" action="/templates/reset" style="margin-top:10px" onsubmit="return confirm('Reset this template to the official default? Your edits will be lost.')">
    <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
    <input type="hidden" name="key" value="${esc(tpl.key)}">
    <button class="btn ghost">Reset to the official default</button>
  </form>`;

  const list = templates.map((t) => `<tr>
      <td><a href="/templates?template=${encodeURIComponent(t.key)}#tpl-${esc(t.key)}"><b>${esc(t.name)}</b></a><br><span class="mono small muted">${esc(t.key)}</span></td>
      <td class="small muted">${esc(TEMPLATE_USAGE[t.key] ?? "Manual staff reply.")}</td>
      <td>${t.attach_pack === "none" ? `<span class="muted small">—</span>` : `<span class="badge b-purple">${esc(t.attach_pack)} pack</span>`}</td>
    </tr>`).join("");

  return head(
    c,
    "Templates",
    "templates",
    `
<div class="hero">
  <h1>Templates</h1>
  <div class="sub">Every email this system sends — automated replies, reminders and staff messages — is built from one of these templates. Edit the words, pick the pack, reset any time.</div>
</div>
${flash ? `<div class="flash">${esc(flash)}</div>` : ""}

<section class="card nopad">
  <div class="card-head"><h2>All outgoing types</h2></div>
  <table><tr><th>Template</th><th>Who sends it</th><th>Pack attached</th></tr>${list}</table>
</section>

<section class="card nopad" id="tpl-${esc(tpl.key)}">
  <div class="card-head"><h2>Edit — ${esc(tpl.name)}</h2></div>
  <div style="padding:16px 24px 22px">
    ${picker}
    <p class="small muted" style="margin-top:6px"><b>Who sends this:</b> ${esc(usage)}</p>
    ${unknown.length ? `<div class="flash err" style="position:static;margin:10px 0">Unknown placeholder${unknown.length === 1 ? "" : "s"} in this template: ${unknown.map(esc).join(", ")} — applicants will see it as literal text.</div>` : ""}
    <div style="display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:22px">
      <div>${editor}</div>
      <div>
        <h3 style="margin:0 0 6px;font-size:13px">Preview (sample applicant)</h3>
        <div id="tpl-preview" class="small" style="border:1px solid var(--line2);border-radius:8px;padding:12px;background:var(--panel2,#fff);white-space:pre-wrap;line-height:1.6"><b>${esc(preview.subject)}</b>\n\n${esc(preview.body)}</div>
        <h3 style="margin:16px 0 6px;font-size:13px">Placeholders</h3>
        <table><tr><th>Token</th><th>Filled with</th></tr>
          ${PLACEHOLDER_DOCS.map(([k, v]) => `<tr><td class="mono small">${esc(k)}</td><td class="small muted">${esc(v)}</td></tr>`).join("")}
        </table>
      </div>
    </div>
  </div>
</section>`
  );
}

// ── Staff (team performance + account management, merged) ──────────────────

// OR-8: the ONE place visibility scopes are edited — a staff × schools
// matrix. Each row saves the member's ENTIRE school set in a single action;
// tick nothing and save to restore full visibility.
function scopeMatrix(c: Ctx): string {
  const { repo } = c;
  const schools = repo.listSchools();
  const members = repo.listStaff().filter((m) => m.active);
  const rows = members.map((m) => {
    if (m.role === "admin") {
      return `<tr>
        <td><b>${esc(m.display_name)}</b><br><span class="muted small">@${esc(m.username)}</span></td>
        <td colspan="${schools.length + 1}"><span class="badge b-purple">admin</span> <span class="small muted">always sees every school — admins cannot be scoped</span></td>
      </tr>`;
    }
    const current = new Set(repo.scopesFor(m.id));
    return `<tr>
      <td><b>${esc(m.display_name)}</b><br><span class="muted small">@${esc(m.username)}</span></td>
      <form method="post" action="/staff/scopes"><td colspan="${schools.length + 1}" style="display:table-cell">
        <div style="display:flex;flex-wrap:wrap;gap:10px 18px;align-items:center">
          <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
          <input type="hidden" name="staff_id" value="${m.id}">
          ${schools.map((s) => `<label style="display:flex;gap:6px;align-items:center"><input type="checkbox" name="schools" value="${esc(s)}" style="width:auto" ${current.has(s) ? "checked" : ""}> ${esc(s)}</label>`).join("")}
          <button class="btn small ghost">Save scope</button>
          ${current.size ? "" : `<span class="muted small">no scope — sees everything</span>`}
        </div>
      </td></form>
    </tr>`;
  }).join("");
  return `<section class="card nopad" id="scopes">
    <div class="card-head"><h2>Visibility scope</h2></div>
    <p class="small muted" style="padding:0 24px;margin:8px 0 0">Tick the schools each officer handles and press <b>Save scope</b> — one action per person. From then on they see only cases from those schools, everywhere: queues, levels, search, direct links and the API. Untick everything and save to give full visibility back. Schools are managed in <a href="/config?tab=courses#schools">Configuration</a>.</p>
    ${schools.length ? `<table><tr><th>Staff member</th><th>Schools they may see</th></tr>${rows}</table>` : `<div class="empty"><p>Add a school in Configuration first.</p></div>`}
  </section>`;
}

export function staffPage(c: Ctx, flash?: string): string {
  const { repo } = c;
  const isAdmin = c.user.role === "admin";

  const stats = repo.staffStats(c.user.demo);
  const totals = stats.reduce(
    (acc, r) => ({ received: acc.received + r.emailsReceived, sent: acc.sent + r.emailsSent, completed: acc.completed + r.admissionsCompleted }),
    { received: 0, sent: 0, completed: 0 }
  );
  const perfRows = stats
    .map((r) => `<tr>
      <td>${avatar(r.display_name, 28)} <b>${esc(r.display_name)}</b><br><span class="muted small">@${esc(r.username)} · ${esc(r.role)}${r.active ? "" : " · disabled"}</span></td>
      <td>${r.assignedCases}</td>
      <td>${r.emailsReceived}</td>
      <td>${r.emailsSent}</td>
      <td>${r.avgResponseMinutes === null ? `<span class="muted">—</span>` : esc(formatDuration(r.avgResponseMinutes))}</td>
      <td>${r.admissionsCompleted}</td>
    </tr>`)
    .join("");

  const accountsSection = isAdmin
    ? `
<section class="card nopad">
  <div class="card-head"><h2>Accounts</h2></div>
  <table>
    <tr><th>Username</th><th>Name</th><th>Role</th><th>Status</th><th>Actions</th></tr>
    ${repo.listStaff()
      .map((st) => `<tr>
        <td class="mono">${esc(st.username)}</td>
        <td>${esc(st.display_name)}</td>
        <td><span class="badge b-gray">${esc(capFirst(st.role))}</span></td>
        <td>${st.active ? `<span class="badge b-green">active</span>` : `<span class="badge b-red">disabled</span>`}</td>
        <td>
          <form method="post" action="/staff/toggle" style="display:inline"><input type="hidden" name="_csrf" value="${esc(c.csrf)}"><input type="hidden" name="id" value="${st.id}"><button class="btn small ghost">${st.active ? "Disable" : "Enable"}</button></form>
          <form method="post" action="/staff/password" style="display:inline"><input type="hidden" name="_csrf" value="${esc(c.csrf)}"><input type="hidden" name="id" value="${st.id}"><input type="password" name="password" placeholder="new password" style="width:150px;display:inline-block"><button class="btn small ghost">Reset</button></form>
        </td>
      </tr>`)
      .join("")}
  </table>
</section>
<section class="card">
  <h2>Add staff member</h2>
  <form method="post" action="/staff/add" class="formrow">
    <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
    <div><label>Username</label><input type="text" name="username" required></div>
    <div><label>Display name</label><input type="text" name="display_name" required></div>
    <div><label>Password</label><input type="password" name="password" required></div>
    <div><label>Role</label><select name="role"><option value="user" selected>user</option><option value="admin">admin</option></select></div>
    <div style="flex:0"><label>&nbsp;</label><button class="btn">Create</button></div>
  </form>
  <p class="small muted" style="margin-bottom:0">Roles: <b>admin</b> (everything — configuration, settings, staff, cases) · <b>user</b> (cases, replies and queues).</p>
</section>`
    : `<p class="small muted">Account management is limited to administrators — you are seeing the team report only.</p>`;

  // Courses & ownership — moved here from the overview (round 18).
  const staffList = repo.listStaff().filter((m) => m.active);
  const assignForm = (p: { code: string; owner_id: number | null }) =>
    `<form method="post" action="/config/course-owner" style="display:flex;gap:6px;margin:0;align-items:center">
      <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
      <input type="hidden" name="programme" value="${esc(p.code)}">
      <select name="owner" style="width:auto;min-width:190px">
        <option value="">Unassigned</option>
        ${staffList.map((m) => `<option value="${m.id}" ${p.owner_id === m.id ? "selected" : ""}>${esc(m.display_name)} (${capFirst(m.role)})</option>`).join("")}
      </select>
      <button class="btn small ghost">Assign</button>
    </form>`;
  const programmes = repo.listProgrammes();
  const courseRows = groupBySchool(programmes)
    .map(([school, rows]) => `<tr class="schoolrow"><td colspan="3">${esc(school)}</td></tr>` + rows
      .map((p) => `<tr>
        <td><b>${esc(p.code)}</b><br><span class="small muted">${esc(p.name)}</span></td>
        <td class="small muted">${esc(p.entry_requirements ? (p.entry_requirements.length > 110 ? p.entry_requirements.slice(0, 110) + "…" : p.entry_requirements) : "—")} <a class="small" href="/config?tab=courses">edit</a></td>
        <td>${assignForm(p)}</td>
      </tr>`).join("")).join("");

  return head(
    c,
    "Staff Configuration",
    "staff",
    `
<h1>Staff Configuration</h1>
<div class="sub">Who handles what — workload, responsiveness, accounts and course ownership.</div>
${flash ? `<div class="flash ok" style="position:static;margin-bottom:16px">${esc(flash)}</div>` : ""}

<div class="cols wide">
  <section class="card nopad">
    <div class="card-head"><h2>Performance</h2></div>
    <table>
      <tr><th>Staff member</th><th>Assigned cases</th><th>Emails received</th><th>Replies sent</th><th>Avg response</th><th>Completed</th></tr>
      ${perfRows || `<tr><td colspan="6" class="muted">No staff yet.</td></tr>`}
    </table>
  </section>
  <section class="card">
    <h2>Totals</h2>
    <div class="kv">
      <div><span>Incoming emails (assigned cases)</span><b>${totals.received}</b></div>
      <div><span>Replies sent by staff</span><b>${totals.sent}</b></div>
      <div><span>Admissions completed</span><b>${totals.completed}</b></div>
    </div>
    <p class="small muted" style="margin-bottom:0">“Emails received” counts incoming mail on cases currently assigned to the person. Response time is measured from an incoming email to the next outgoing reply on their cases.</p>
  </section>
</div>

${accountsSection}

${isAdmin ? scopeMatrix(c) : ""}

<section class="card nopad">
  <div class="card-head"><h2>Courses &amp; ownership</h2><a class="small" href="/config?tab=courses">course details →</a></div>
  <p class="small muted" style="padding:0 24px;margin:8px 0 0">Every course is handled by someone — assign the responsible person here. Course details, notes and adding new courses live in Configuration.</p>
  ${programmes.length
    ? `<table><tr><th>Programme</th><th>Published entry requirements</th><th>Handled by</th></tr>${courseRows}</table>`
    : `<div class="empty"><p>No courses yet — add the first one in Configuration.</p></div>`}
</section>`
  );
}

// ── Decision replay (v3 feature 32): step-by-step "why was this flagged?" ──

export function replayPage(c: Ctx, a: ApplicantRow): string {
  const { repo } = c;
  const audit = repo.auditForApplicant(a.id).slice().reverse(); // oldest → newest
  const decisions = repo.decisionLogs(a.id);
  const flags = repo.activeFlags(a.id);

  const step = (cls: string, k: string, d: string) =>
    `<li class="${cls}"><div class="k">${k}</div><div class="d">${d}</div></li>`;

  const rows: string[] = [];
  for (const ev of audit) {
    const t = `<span class="muted small">${esc(fmtDate(ev.at))}</span>`;
    switch (ev.event) {
      case "applicant_created":
        rows.push(step("", "Case opened", `${t} — ${esc(ev.detail)}`));
        break;
      case "identity_matched":
        rows.push(step("", "Identity matched", `${t} — ${esc(ev.detail)}`));
        break;
      case "identity_concern":
        rows.push(step("flag", "Identity concern", `${t} — ${esc(ev.detail)}`));
        break;
      case "email_received":
        rows.push(step("", "Email received", `${t} — ${esc(ev.detail)}`));
        break;
      case "duplicate_detected":
        rows.push(step("", "Duplicate detected", `${t} — ${esc(ev.detail)}`));
        break;
      case "case_enriched":
      case "phone_captured":
        rows.push(step("", "Enriched", `${t} — ${esc(ev.detail)}`));
        break;
      case "requirements_checked":
        rows.push(step("", "Rules engine ran", `${t} — ${esc(ev.detail)}`));
        break;
      case "watcher_downgrade":
        rows.push(step("flag", "Watcher downgraded", `${t} — ${esc(ev.detail)}`));
        break;
      case "late_submission":
      case "priority_raised":
        rows.push(step("flag", "Flag raised", `${t} — <b>${esc(ev.event)}</b> ${esc(ev.detail)}`));
        break;
      case "automation_held":
        rows.push(step("flag", "Automation held for approval", `${t} — ${esc(ev.detail)}`));
        break;
      case "email_sent_auto":
        rows.push(step("verdict", "Auto-reply sent", `${t} — ${esc(ev.detail)}`));
        break;
      case "human_review_triggered":
        rows.push(step("flag", "Queued for a human", `${t} — ${esc(ev.detail)}`));
        break;
      case "status_changed":
        rows.push(step("", "Lifecycle changed", `${t} — ${esc(ev.detail)}`));
        break;
      case "case_reopened":
        rows.push(step("", "Case reopened", `${t} — ${esc(ev.detail)}`));
        break;
    }
  }

  const flagList = flags.length
    ? `<div class="card"><h2>Active flags</h2><ul style="margin:0;padding-left:18px">${flags
        .map((f) => `<li><span class="badge b-orange">${esc(flagLabel(f.type))}</span> ${esc(f.detail)}</li>`)
        .join("")}</ul></div>`
    : "";

  const last = decisions.at(-1);
  return head(
    c,
    `${a.ref_number} — decision replay`,
    "applicants",
    `
<div class="sub"><a href="/case/${a.id}">← back to case</a></div>
<h1>Decision replay <span class="mono">${esc(a.ref_number)}</span></h1>
<div class="sub">Every deterministic step the system took on this case, oldest → newest. Nothing here is AI judgment — it is the rules engine's chain.</div>
${flagList}
<div class="card">
  <ul class="steps">${rows.join("") || `<li><div class="d muted">No recorded steps.</div></li>`}</ul>
</div>
${last ? `<div class="card"><h2>Final reasoning (${esc(last.computed_status)})</h2><pre style="white-space:pre-wrap;font-size:12.5px">${esc(last.reasoning)}</pre></div>` : ""}`
  );
}
