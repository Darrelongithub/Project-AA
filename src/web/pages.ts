/**
 * Page renderers — every page is built server-side from the database.
 * Single source of truth: nothing is rendered that isn't in the DB.
 */
import type { ApplicantSearchQuery, Repo } from "../db/repo";
import type { ApplicantRow, CourseLevel, DocType, Programme, StaffUser, SystemBlock } from "../types";
import { EMAIL_CATEGORY_LABELS, LIFECYCLE_LABELS, LIFECYCLE_ORDER } from "../types";
import { docLabel } from "../rules";
import { EXAM_SYSTEMS, SUBJECT_CATALOG } from "../config";
import { packManifest } from "../pack";
import { verifyPassword } from "../util/password";
import {
  avatar, categoryBadge, confidenceBadge, crest, esc, flagLabel, flowLine, fmtDate, fmtTime, gaugeRow,
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
  /** True when the seeded demo dataset is present — banner shown to staff. */
  demo: boolean;
}

function head(c: Ctx, title: string, active: string, content: string): string {
  return layout({ title, content, user: c.user, unread: c.unread, active, csrf: c.csrf, theme: c.theme, institution: c.institution, demo: c.demo });
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

export function loginPage(error?: string, theme?: Theme, institution = "Riara University"): string {
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
  const s = repo.dashboardStats(realm);
  const stage = repo.stageCounts(realm);
  const audit = repo.recentAudit(12);
  const team = repo.staffStats(realm);
  const staff = repo.listStaff().filter((m) => m.active);
  const alerts = repo.notificationsFor(c.user.id, 6);
  const programmes = repo.listProgrammes();
  const rules = repo.listRules();
  const all = repo.allApplicants(realm);
  const gmailConnected = Boolean(repo.getSetting("gmail_refresh_token", ""));
  const lastSync = repo.getSetting("gmail_last_sync_at", "");
  const globalMode = repo.getSetting("automation_mode", "auto");

  const applications = Number(s.applications);
  const completed = Number(s.completed);
  const completion = applications > 0 ? Math.round((completed / applications) * 100) : null;

  // Inline owner picker — assigning a course no longer needs a trip to Configuration.
  const inlineAssign = (p: { code: string }) =>
    `<form method="post" action="/config/course-owner" style="display:flex;gap:6px;margin:0;align-items:center">
      <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
      <input type="hidden" name="programme" value="${esc(p.code)}">
      <select name="owner" style="width:auto;min-width:150px"><option value="">Pick a staff member…</option>${staff.map((m) => `<option value="${m.id}">${esc(m.display_name)} (${capFirst(m.role)})</option>`).join("")}</select>
      <button class="btn small ghost">Assign</button>
    </form>`;

  const courseRows = groupBySchool(programmes)
    .map(([school, rows]) => `<tr class="schoolrow"><td colspan="4">${esc(school)}</td></tr>` + rows
      .map((p) => {
        const specific = rules.filter((r) => r.programme === p.code);
        const effective = specific.length ? specific : rules.filter((r) => r.programme === null && r.intake === null);
        const required = effective.filter((r) => r.required).length;
        const graded = effective.filter((r) => r.meanGrade);
        const reqText = required
          ? `${required} required doc${required === 1 ? "" : "s"}${graded.length ? ` · min ${graded.map((r) => esc(r.meanGrade ?? "")).join("/")}` : ""}`
          : `<span class="muted">base rules apply</span>`;
        const n = all.filter((a) => a.programme === p.code).length;
        return `<tr>
          <td><b>${esc(p.code)}</b> <span class="muted small">${esc(p.name)}</span></td>
          <td>${p.owner_name ? `${esc(p.owner_name)} <a class="small" href="/config#courses">change</a>` : inlineAssign(p)}</td>
          <td class="small">${reqText}</td>
          <td>${n}</td>
        </tr>`;
      }).join("")).join("");

  const activityRows = audit
    .map((e) => `<div class="feed-row">
      <span class="feed-when">${esc(fmtDate(e.at))}</span>
      <span class="feed-actor mono">${esc(e.actor)}</span>
      <span class="feed-event">${esc(e.event)}</span>
      <span class="feed-detail muted">${esc(e.detail.slice(0, 110))}</span>
    </div>`)
    .join("");

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
      return `<tr>
        <td class="mono"><a href="/case/${a.id}">${esc(a.ref_number)}</a></td>
        <td>${esc(a.full_name ?? "—")}</td>
        <td>${esc(a.programme ?? "—")}</td>
        <td class="small">${esc(appr?.actor ?? "—")}</td>
        <td class="small nowrap muted">${esc(fmtDate(appr?.at ?? a.updated_at))}</td>
      </tr>`;
    })
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

<section class="card nopad">
  <div class="card-head"><h2>Team performance <span class="muted small" style="text-transform:none;letter-spacing:0">— how your staff are working</span></h2><a class="small" href="/staff">staff accounts →</a></div>
  ${team.length
    ? `<table><tr><th>Staff member</th><th>Assigned cases</th><th>Emails</th><th>Avg response</th><th>Files completed</th></tr>${teamRows}</table>`
    : `<div class="empty"><p>No staff accounts yet.</p></div>`}
</section>

<section class="card nopad">
  <div class="card-head"><h2>Completed files &amp; approvals <span class="muted small" style="text-transform:none;letter-spacing:0">— who finished what, and when</span></h2></div>
  ${completedFiles
    ? `<table><tr><th>Ref</th><th>Applicant</th><th>Course</th><th>Completed by</th><th>When</th></tr>${completedFiles}</table>`
    : `<div class="empty"><p>No completed files yet — approvals appear here as cases finish.</p></div>`}
</section>

<section class="card nopad">
  <div class="card-head"><h2>Courses &amp; ownership</h2><a class="small" href="/config#courses">manage →</a></div>
  ${programmes.length
    ? `<table>
        <tr><th>Course</th><th>Handled by</th><th>Requirements</th><th>Applicants</th></tr>
        ${courseRows}
      </table>`
    : `<div class="empty">${flowLine(150, 26)}<p>No courses configured yet.</p><a class="btn small" href="/config#courses">Add courses</a></div>`}
</section>

<div class="cols wide">
  <section class="card nopad">
    <div class="card-head"><h2>Recent activity</h2></div>
    ${audit.length
      ? `<div class="feed">${activityRows}</div>`
      : `<div class="empty"><p>No activity yet — it appears here as your team works.</p></div>`}
  </section>
  <section class="card">
    <h2>System</h2>
    <div class="kv">
      <div><span>Gmail</span><b>${gmailConnected ? `connected${lastSync ? ` · synced ${esc(fmtDate(lastSync))}` : ""}` : "not connected"} <a class="small" href="/config#gmail">manage</a></b></div>
      <div><span>Document AI (Gemini)</span><b>${repo.getSetting("gemini_api_key", "") ? "key saved · live" : "not set"} <a class="small" href="/config#gemini">manage</a></b></div>
      <div><span>Automation</span><b>${globalMode === "draft" ? "draft-first" : "auto"} · <a class="small" href="/settings#automation">change</a></b></div>
      <div><span>Team</span><b>${team.filter((t) => t.active).length}/${team.length} active · <a class="small" href="/staff">staff</a></b></div>
      <div><span>Replies to date</span><b>${(() => { const ac = repo.accuracyStats(); return Number(ac.autoSends) + Number(ac.humanSends); })()}</b></div>
    </div>
  </section>
</div>

<section class="card nopad" id="alerts">
  <div class="card-head"><h2>Alerts${c.unread ? ` <span class="badge b-purple">${c.unread} new</span>` : ""}</h2>
    ${c.unread ? `<form method="post" action="/notifications/read-all" style="margin:0"><input type="hidden" name="_csrf" value="${esc(c.csrf)}"><button class="btn small ghost">Mark all read</button></form>` : ""}
  </div>
  ${alerts.length
    ? `<div class="feed">${alerts
        .map((n) => `<div class="feed-row ${n.read ? "read" : ""}">
          <span class="badge ${n.kind === "escalation" ? "b-red" : n.kind === "review_needed" ? "b-orange" : "b-blue"}">${esc(kindLabel(n.kind))}</span>
          <span class="feed-msg">${esc(n.message)}</span>
          ${n.applicant_id ? `<a class="small nowrap" href="/case/${n.applicant_id}">open →</a>` : ""}
          <span class="feed-when right">${esc(fmtDate(n.at))}</span>
        </div>`)
        .join("")}</div>`
    : `<div class="empty"><p>No alerts. Escalations appear here.</p></div>`}
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
  const s = repo.dashboardStats(realm);
  const stage = repo.stageCounts(realm);
  const today = repo.todayStats(realm);
  const accuracy = repo.accuracyStats(realm);
  const queue = repo.queueView(realm);
  const unanswered = repo.unansweredCases();
  const target = Number(repo.getSetting("unanswered_target_hours", "4"));
  const categories = repo.categoryCounts();
  const alerts = repo.notificationsFor(c.user.id, 6);

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
      <span class="badge ${n.kind === "escalation" ? "b-red" : n.kind === "review_needed" ? "b-orange" : "b-blue"}">${esc(kindLabel(n.kind))}</span>
      <span class="feed-msg">${esc(n.message.replace(/^\u26a0\ufe0f\s*/, ""))}</span>
      ${n.applicant_id ? `<a class="small nowrap" href="/case/${n.applicant_id}">open →</a>` : ""}
      <span class="feed-when right">${esc(fmtDate(n.at))}</span>
    </div>`)
    .join("");

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

<div class="cols wide">
  <section class="card nopad">
    <div class="card-head"><h2>Needs attention</h2><a class="small" href="/queue">full queue →</a></div>
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

<div class="cols wide">
  <section class="card nopad">
    <div class="card-head"><h2>What needs my attention</h2></div>
    ${queue.length
      ? `<table><tr><th>Ref</th><th>Applicant</th><th>Verdict</th><th>Flags</th><th>SLA</th></tr>${needsAttention}</table>`
      : `<div class="empty"><p>Queue is empty — every case is handled.</p></div>`}
  </section>
  <section class="card nopad" id="alerts">
    <div class="card-head"><h2>Alerts${c.unread ? ` <span class="badge b-purple">${c.unread} new</span>` : ""}</h2>
      ${c.unread ? `<form method="post" action="/notifications/read-all" style="margin:0"><input type="hidden" name="_csrf" value="${esc(c.csrf)}"><button class="btn small ghost">Mark all read</button></form>` : ""}
    </div>
    ${alerts.length
      ? `<div class="feed">${alertRows}</div>`
      : `<div class="empty"><p>No alerts. Escalations and new review cases appear here.</p></div>`}
  </section>
</div>

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

// ── Queue (feature 11) ─────────────────────────────────────────────────────

export function queuePage(c: Ctx, filter: string): string {
  let rows = c.repo.queueView(c.user.demo);
  if (filter === "urgent") rows = rows.filter((r) => r.priority === "urgent");
  if (filter === "overdue") rows = rows.filter((r) => r.sla_due_at && !r.sla_handled_at && r.sla_due_at < new Date().toISOString());

  const urgent = rows.filter((r) => r.priority === "urgent").length;
  const review = rows.length;

  const cards = rows
    .map((r) => {
      const overdue = r.sla_due_at && !r.sla_handled_at && r.sla_due_at < new Date().toISOString();
      return `<div class="card">
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          ${avatar(r.full_name ?? r.ref_number, 38)}
          <span class="mono" style="font-weight:700;font-size:14px">${esc(r.ref_number)}</span>
          ${triageBadge(r.computed_status)} ${priorityBadge(r.priority)} ${lifecycleBadge(r.lifecycle)}
          ${overdue ? `<span class="badge b-red">${esc(slaText(r.sla_due_at, r.sla_handled_at))}</span>` : ""}
          <span style="margin-left:auto"><a class="btn small" href="/case/${r.id}">Open case →</a></span>
        </div>
        <p style="margin:10px 0 2px"><b>${esc(r.full_name ?? "—")}</b> <span class="muted small">&lt;${esc(r.email_address)}&gt; ${r.programme ? `· ${esc(r.programme)}` : ""} ${r.intake ? `· ${esc(r.intake)}` : ""}</span></p>
        <p class="small muted" style="margin:4px 0 0">${esc(r.flag_summary ? humanizeFlagSummary(r.flag_summary) : "No active flags")}</p>
      </div>`;
    })
    .join("");

  return head(
    c,
    "Queue",
    "queue",
    `
<h1>Human review queue</h1>
<div class="sub">${urgent} urgent · ${review} awaiting review</div>
<p>
  <a class="btn small ${filter === "all" ? "" : "ghost"}" href="/queue">All</a>
  <a class="btn small ${filter === "urgent" ? "" : "ghost"}" href="/queue?filter=urgent">Urgent</a>
  <a class="btn small ${filter === "overdue" ? "" : "ghost"}" href="/queue?filter=overdue">Overdue</a>
</p>
${cards || `<div class="card muted">Queue is empty.</div>`}`
  );
}

// ── Admissions: the pipeline split into its levels ──────────────────────────
// Every dashboard gauge lands here. Staff see who is at each level, open case
// files, and act without leaving the page.

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
  const counts = repo.stageCounts(realm);
  const start = new Date(); start.setHours(0, 0, 0, 0);
  // ONE query for today's enquiry applicants — never one per applicant.
  const enquiryIds = repo.enquiryApplicantIdsToday(start.toISOString());
  const all = repo.allApplicants(realm);
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

export function applicantsPage(
  c: Ctx,
  q: { search?: string; filter?: string; programme?: string; intake?: string }
): string {
  const { repo } = c;
  const rows = repo.searchApplicants({
    q: q.search,
    filter: (q.filter as never) || "all",
    programme: q.programme || undefined,
    intake: q.intake || undefined,
    demo: c.user.demo,
  });
  const programmes = repo.listProgrammes();
  const intakes = repo.listIntakes();

  const trs = rows
    .map((r) => `<tr>
      <td class="mono"><a href="/case/${r.id}">${esc(r.ref_number)}</a></td>
      <td><div class="nameline">${avatar(r.full_name ?? r.ref_number, 28)}<span>${esc(r.full_name ?? "—")}</span></div></td>
      <td class="small">${esc(r.email_address)}${r.phone ? `<br><span class="muted">${esc(r.phone)}</span>` : ""}</td>
      <td>${esc(r.programme ?? "—")}</td>
      <td>${esc(r.intake ?? "—")}</td>
      <td>${lifecycleBadge(r.lifecycle)}</td>
      <td>${triageBadge(r.triage)}</td>
      <td>${priorityBadge(r.priority)}</td>
      <td class="small muted nowrap">${esc(fmtDate(r.created_at))}</td>
    </tr>`)
    .join("");

  const opt = (v: string, label: string, sel?: string) =>
    `<option value="${esc(v)}" ${sel === v ? "selected" : ""}>${esc(label)}</option>`;

  return head(
    c,
    "Applicants",
    "applicants",
    `
<h1>Applicants</h1>
<div class="sub">${rows.length} case file(s)${q.filter && q.filter !== "all" ? " · filtered" : ""}</div>
${(() => {
    const filters: Array<[string, string]> = [
      ["all", "All applicants"],
      ["awaiting_docs", "Awaiting documents"],
      ["human_review", "Needs human review"],
      ["complete", "Complete"],
      ["overdue", "Overdue"],
    ];
    const current = q.filter && q.filter !== "all" ? q.filter : "all";
    const link = (f: string): string => {
      const params = new URLSearchParams();
      if (q.search) params.set("q", q.search);
      if (q.programme) params.set("programme", q.programme);
      if (q.intake) params.set("intake", q.intake);
      if (f !== "all") params.set("filter", f);
      const qs = params.toString();
      return `/applicants${qs ? `?${qs}` : ""}`;
    };
    const count = (f: string): number =>
      repo.searchApplicants({ ...q, filter: f === "all" ? undefined : (f as NonNullable<ApplicantSearchQuery["filter"]>), limit: 100000, demo: c.user.demo }).length;
    return `<div class="tabs">${filters
      .map(([f, label]) => `<a href="${esc(link(f))}" class="${current === f ? "on" : ""}">${label}<span class="cnt">${count(f)}</span></a>`)
      .join("")}</div>`;
  })()}
<form class="card formrow" method="get" action="/applicants">
  <div style="flex:2"><label>Search</label><input type="text" name="q" placeholder="Reference, name, email, phone…" value="${esc(q.search ?? "")}"></div>
  <input type="hidden" name="filter" value="${esc(q.filter ?? "")}">
  <div><label>Programme</label><select name="programme">${opt("", "All programmes", q.programme || "")}${programmes.map((p) => opt(p.code, `${p.code} — ${p.name}`, q.programme)).join("")}</select></div>
  <div><label>Intake</label><select name="intake">${opt("", "All intakes", q.intake || "")}${intakes.map((i) => opt(i, i, q.intake)).join("")}</select></div>
  <div style="flex:0"><label>&nbsp;</label><button class="btn">Apply</button></div>
</form>
<div class="card">
<table>
  <tr><th>Ref</th><th>Name</th><th>Contact</th><th>Prog.</th><th>Intake</th><th>Lifecycle</th><th>Triage</th><th>Priority</th><th>Opened</th></tr>
  ${trs || `<tr><td colspan="9" class="muted">No applicants match.</td></tr>`}
</table>
</div>`
  );
}

// ── Case file (feature 12) ─────────────────────────────────────────────────

/** Flags mentioned in a decision-log reasoning block ("[type] detail" lines). */
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

  const checklist = requirements
    .filter((r) => r.required)
    .map((r) => {
      const doc = activeDocs.find((d) => d.document_type === r.document_type);
      const gradeBits: string[] = [];
      if (r.meanGrade) gradeBits.push(`min ${esc(r.meanGrade)}`);
      if (r.subjectGrades) gradeBits.push(esc(r.subjectGrades));
      return doc
        ? `<div><span class="ok">✓</span> <span>${esc(docLabel(r.document_type))} <span class="muted small">(${doc.confidence_score ?? 0}% readable · ${esc(doc.extraction_method)})</span>${gradeBits.length ? `<br><span class="muted small" style="margin-left:23px">rule: ${gradeBits.join(" · ")}</span>` : ""}</span></div>`
        : `<div><span class="no">✗</span> <span>${esc(docLabel(r.document_type))}${gradeBits.length ? ` <span class="muted small">— rule: ${gradeBits.join(" · ")}</span>` : ""}</span></div>`;
    })
    .join("");

  const docRows = allDocs
    .map((d) => {
      const fields = Object.entries(d.extracted_fields)
        .filter(([, v]) => v !== null && v !== undefined && v !== "" && JSON.stringify(v) !== "{}")
        .map(([k, v]) => `${esc(k)}: <b>${esc(typeof v === "object" ? Object.entries(v as Record<string, string>).map(([sk, sv]) => `${sk} ${sv}`).join(", ") : String(v))}</b>`)
        .join(" · ");
      const status = d.is_duplicate
        ? `<span class="badge b-gray">duplicate of #${d.duplicate_of}</span>`
        : d.superseded_by
          ? `<span class="badge b-gray">superseded by #${d.superseded_by}</span>`
          : `<span class="badge b-purple">active</span>`;
      return `<tr>
        <td class="mono small">#${d.id}</td>
        <td>${esc(docLabel(d.document_type))}<br><span class="muted small">${fields || "no fields extracted"}</span></td>
        <td>${status}</td>
        <td>${readabilityScore(d.confidence_score)}<br><span class="muted small">${esc(d.extraction_method)} · ${d.confidence}</span></td>
        <td class="small">${esc(fmtDate(d.received_at))}<br><span class="muted">email ${esc(d.source_email_id)}</span></td>
        <td><details class="excerpt"><summary class="small">text</summary><pre>${esc(d.extracted_text.slice(0, 1200))}</pre></details></td>
      </tr>`;
    })
    .join("");

  const emailCards = emails
    .map((e) => `<div class="emailcard ${e.direction === "out" ? "out" : ""}">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <span class="badge ${e.direction === "in" ? "b-blue" : "b-purple"}">${e.direction === "in" ? "← from applicant" : "→ to applicant"}</span>
        ${categoryBadge(e.category)}
        ${e.channel && e.channel !== "email" ? `<span class="badge b-blue">via ${esc(e.channel)}</span>` : ""}
        ${e.auto ? `<span class="badge b-gray">automated</span>` : ""}
        <span class="small muted" style="margin-left:auto" title="${esc(fmtDate(e.at))}"><span data-rel="${esc(e.at)}">${esc(fmtDate(e.at))}</span></span>
      </div>
      <p style="margin:10px 0 0"><b>${esc(e.subject)}</b></p>
      <pre>${esc(e.body.slice(0, 900))}</pre>
    </div>`)
    .reverse()
    .join("");

  const flagRows = flags.length
    ? flags.map((f) => `<li><span class="badge ${f.type === "watcher_flag" ? "b-red" : "b-orange"}">${esc(flagLabel(f.type))}</span> ${esc(f.detail)}</li>`).join("")
    : `<li class="muted">No active flags.</li>`;

  const historyRows = history
    .map((h) => `<tr><td class="small nowrap">${esc(fmtDate(h.at))}</td><td>${esc(LIFECYCLE_LABELS[(h.from_status as never)] ?? h.from_status ?? "—")} → <b>${esc(LIFECYCLE_LABELS[(h.to_status as never)] ?? h.to_status)}</b></td><td class="mono small">${esc(h.actor)}</td><td class="small">${esc(h.reason)}</td></tr>`)
    .join("");

  const auditRows = audit
    .map((ev) => `<div class="ev"><span class="t"><span data-rel="${esc(ev.at)}">${esc(fmtDate(ev.at))}</span> · ${esc(ev.actor)}</span><br><b>${esc(ev.event)}</b> — ${esc(ev.detail)}</div>`)
    .join("");

  const noteCards = notes
    .map((n) => `<div class="note"><div>${esc(n.body)}</div><div class="meta">${esc(n.display_name ?? "system")} · ${esc(fmtDate(n.at))}</div></div>`)
    .join("");

  const lastDecision = decisions.at(-1);
  const staffOptions = staff.map((s) => `<option value="${s.id}" ${a.assigned_to === s.id ? "selected" : ""}>${esc(s.display_name)}</option>`).join("");
  const tplOptions = templates.map((t) => `<option value="${esc(t.key)}">${esc(t.name)}</option>`).join("");
  const nextStage = LIFECYCLE_ORDER[LIFECYCLE_ORDER.indexOf(a.lifecycle) + 1];

  return head(
    c,
    `${a.ref_number} — case file`,
    "applicants",
    `
${flash ? `<div class="flash">${esc(flash)}</div>` : ""}
<div class="hero">
  <div class="row">
    ${avatar(a.full_name ?? a.ref_number, 58)}
    <div style="min-width:0">
      <h1 style="margin:0;display:flex;align-items:center;gap:14px;flex-wrap:wrap">${esc(a.full_name ?? "Unknown applicant")}${lifecycleBadge(a.lifecycle)}</h1>
      <div class="sub" style="margin:4px 0 8px"><span class="mono">${esc(a.ref_number)}</span> · opened ${esc(fmtDate(a.created_at))}${handledBy ? ` · handled by <b>${esc(handledBy)}</b>` : ""}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        ${triageBadge(a.triage)} ${priorityBadge(a.priority)}
        ${a.escalated ? `<span class="badge b-red">escalated</span>` : ""}
      </div>
    </div>
    <div style="margin-left:auto;display:flex;gap:8px;flex-wrap:wrap" class="no-print">
      <a class="btn ghost small" href="/case/${a.id}/replay">Decision replay</a>
      <button class="btn ghost small" onclick="window.print()">Print case brief</button>
    </div>
  </div>
</div>
${lifecycleStepper(a.lifecycle)}

${changed ? `<div class="changed"><b>What changed since the last triage:</b> ${changed}</div>` : ""}

<div class="case-grid">
  <div class="case-main">

    <div class="card">
      <h2>Details &amp; what they applied for</h2>
      <dl class="kv" style="margin-top:6px">
        <dt>Name</dt><dd>${esc(a.full_name ?? "—")}</dd>
        <dt>Email</dt><dd>${esc(a.email_address)}</dd>
        <dt>Phone</dt><dd>${esc(a.phone ?? "—")}</dd>
        <dt>Applied for</dt><dd>${programme ? `<b>${esc(programme.code)} — ${esc(programme.name)}</b>${programme.school ? `<br><span class="muted small">${esc(programme.school)}</span>` : ""}` : `<span class="muted">not identified yet — the latest email decides it</span>`}</dd>
        <dt>Intake</dt><dd>${esc(a.intake ?? "—")}</dd>
        <dt>Reference no.</dt><dd class="mono">${esc(a.ref_number)}</dd>
        <dt>Current level</dt><dd>${lifecycleBadge(a.lifecycle)} <span class="muted small">moved through ${history.length} change${history.length === 1 ? "" : "s"}</span></dd>
        <dt>Threads</dt><dd>${threads.length} linked conversation${threads.length === 1 ? "" : "s"}</dd>
        <dt>Follow-up ladder</dt><dd>${a.followup_next_at ? `rung ${a.followup_rung} — next reminder ${esc(fmtDate(a.followup_next_at))}` : "not armed"}</dd>
        <dt>SLA</dt><dd>${a.sla_due_at ? `${esc(slaText(a.sla_due_at, a.sla_handled_at))} (due ${esc(fmtDate(a.sla_due_at))})` : "—"}</dd>
        <dt>Assigned to</dt><dd>
          <form method="post" action="/case/${a.id}/assign" style="display:flex;gap:6px">
            <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
            <select name="staff_id" style="max-width:220px"><option value="">Unassigned</option>${staffOptions}</select>
            <button class="btn small">Assign</button>
          </form>
        </dd>
        <dt>Priority</dt><dd>
          <form method="post" action="/case/${a.id}/priority" style="display:flex;gap:6px">
            <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
            <select name="priority" style="max-width:140px">${["normal", "high", "urgent"].map((p) => `<option value="${p}" ${a.priority === p ? "selected" : ""}>${p}</option>`).join("")}</select>
            <button class="btn small">Set</button>
          </form>
        </dd>
      </dl>
      ${programme?.entry_requirements ? `<p class="small muted" style="margin:14px 0 0"><b>Published entry requirements for ${esc(programme.code)}:</b> ${esc(programme.entry_requirements)} <span class="muted">— editable in Configuration.</span></p>` : ""}
    </div>

    <div class="card">
      <h2>Document checklist</h2>
      <div class="checklist" style="margin-top:6px">${checklist}</div>
      <p class="small muted" style="margin-top:14px">${a.requirements_snapshot ? "Judged by the requirement set frozen at first triage (rule changes don't move goalposts)." : `Resolved for ${esc(a.programme ?? "all programmes")} / ${esc(a.intake ?? "all intakes")}`} — grade rules are editable in Configuration.</p>
    </div>

    <div class="card">
      <h2>Email history <span class="muted small" style="text-transform:none;letter-spacing:0">— everything exchanged with ${esc(a.full_name ?? "this applicant")}</span></h2>
      ${emailCards || `<p class="muted">No emails recorded.</p>`}
    </div>

    <div class="card">
      <h2>Documents (${allDocs.length} received, ${activeDocs.length} active)</h2>
      <table><tr><th>#</th><th>Type &amp; extracted fields</th><th>State</th><th>PDF readability</th><th>Received</th><th></th></tr>
      ${docRows || `<tr><td colspan="6" class="muted">No documents received yet.</td></tr>`}</table>
    </div>

    <div class="cols">
      <div class="card">
        <h2>Status history</h2>
        <table><tr><th>When</th><th>Change</th><th>By</th><th>Why</th></tr>
        ${historyRows || `<tr><td colspan="4" class="muted">No changes recorded.</td></tr>`}</table>
      </div>
      <div class="card">
        <h2>Audit log</h2>
        <div class="timeline">${auditRows || `<p class="muted">Empty.</p>`}</div>
      </div>
    </div>
  </div>

  <div class="case-side no-print">

    <div class="card">
      <h2>Actions</h2>
      <div class="actionlist">
        ${nextStage ? `<form method="post" action="/case/${a.id}/action" style="margin:0"><input type="hidden" name="_csrf" value="${esc(c.csrf)}"><button class="btn" name="action" value="advance">Advance → ${esc(LIFECYCLE_LABELS[nextStage])}</button></form>` : ""}
        ${a.lifecycle !== "completed" ? `<form method="post" action="/case/${a.id}/action" style="margin:0"><input type="hidden" name="_csrf" value="${esc(c.csrf)}"><button class="btn ghost" name="action" value="complete">Mark completed</button></form>` : ""}
        <a class="btn ghost" href="/case/${a.id}/compose?template=missing_documents">Request missing documents <span class="muted small">→ ready template</span></a>
        <a class="btn ghost" href="/case/${a.id}/compose?template=status_answer">Answer status question</a>
        <a class="btn ghost" href="/case/${a.id}/compose?template=ack_received">Acknowledge receipt</a>
      </div>
      <p class="small muted" style="margin:10px 0 0">Every action opens a <b>ready, pre-filled reply</b> — nothing is sent until you press Send.</p>
    </div>

    <div class="card">
      <h2>Responses</h2>
      <p class="small muted">Pick a reply template — it is rendered with this applicant's details. Preview first; nothing is sent without your click.</p>
      <form method="post" action="/case/${a.id}/send">
        <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
        <label>Template</label><select name="template">${tplOptions}</select>
        <div style="display:flex;gap:8px;margin-top:12px">
          <button class="btn ghost" name="preview" value="1">Preview</button>
          <button class="btn" onclick="return confirm('Send this reply now?')">Send now</button>
        </div>
      </form>
      ${preview ? `<div class="resp-preview"><b>${esc(preview.subject)}</b>\n\n${esc(preview.body)}</div>` : ""}
      <p class="small muted" style="margin-top:12px">Or open any template in the full composer: ${templates.slice(0, 3).map((t) => `<a href="/case/${a.id}/compose?template=${esc(t.key)}">${esc(t.name)}</a>`).join(" · ")}</p>
      <p class="small muted" style="margin:6px 0 0">Auto-response toggles per category live in <a href="/settings#automation">Settings → Automation</a>. Current modes: ${esc(autoSummary || "defaults")}</p>
    </div>

    ${c.user.role === "admin" || c.user.role === "manager" ? `<div class="card" id="packs">
      <h2>Official document packs</h2>
      <p class="small muted" style="margin-top:-6px">The <b>application pack</b> (application form + brochure) goes to anyone who asks about applying. The <b>admission pack</b> sends the official admission letter with all seven accompanying documents.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <form method="post" action="/case/${a.id}/send-pack" onsubmit="return confirm('Send the application pack — form and brochure attached?')" style="margin:0">
          <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
          <input type="hidden" name="kind" value="application">
          <button class="btn">Send application pack</button>
        </form>
        <form method="post" action="/case/${a.id}/send-pack" onsubmit="return confirm('Send the admission pack — letter plus seven documents?')" style="margin:0">
          <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
          <input type="hidden" name="kind" value="admission">
          <button class="btn">Send admission pack</button>
        </form>
        <form method="post" action="/case/${a.id}/send-pack" onsubmit="return confirm('Send the credit transfer form to this applicant?')" style="margin:0">
          <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
          <input type="hidden" name="kind" value="transfer">
          <button class="btn ghost">Send credit transfer form</button>
        </form>
      </div>
    </div>` : ""}

    ${outbox ? `<div class="card" style="border-left:6px solid var(--orange)">
      <h2>Draft held for approval <span class="heldnote">not sent</span></h2>
      <p class="small muted">${draftView && draftView.held
        ? "The system is holding this reply pending your review — there is no suggested text yet, so write the response below."
        : "The system prepared this reply but did not send it — approve, edit, or discard."}</p>
      <form method="post" action="/case/${a.id}/draft">
        <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
        <label>Subject</label>
        <input type="text" name="subject" value="${esc(outbox.subject)}">
        <label>Body</label>
        <textarea name="body" style="min-height:160px" placeholder="Write the reply to the applicant…">${esc(draftView ? draftView.text : outbox.body)}</textarea>
        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
          <button class="btn" name="decision" value="send">Send</button>
          <button class="btn ghost" name="decision" value="edit">Save changes</button>
          <button class="btn ghost danger" name="decision" value="discard" onclick="return confirm('Discard this draft?')">Discard</button>
        </div>
      </form>
    </div>` : ""}

    <div class="card">
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

    <div class="card">
      <h2>Flags</h2>
      <ul style="margin:0;padding-left:18px">${flagRows}</ul>
    </div>

    <div class="card">
      <h2>Internal notes <span class="muted small">(not visible to applicant)</span></h2>
      ${noteCards || `<p class="muted small">No notes yet.</p>`}
      <form method="post" action="/case/${a.id}/note">
        <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
        <label>Add note</label>
        <textarea name="body" style="min-height:60px" placeholder="e.g. Applicant called. Waiting for original certificate."></textarea>
        <p><button class="btn small">Save note</button></p>
      </form>
    </div>

    ${c.user.role === "admin" || c.user.role === "manager" ? `<div class="card">
      <h2>Re-categorise latest incoming email</h2>
      <p class="small muted">If triage put the newest email in the wrong bucket, move it after your review. The change is recorded in the audit trail${latestIncoming ? ` — currently <b>${esc(latestIncoming.category ?? "uncategorised")}</b>` : ""}.</p>
      <form method="post" action="/case/${a.id}/category" class="formrow" style="align-items:end">
        <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
        <div style="flex:2"><label>Category</label><select name="category">
          ${Object.entries(EMAIL_CATEGORY_LABELS).map(([k, v]) => `<option value="${k}" ${latestIncoming?.category === k ? "selected" : ""}>${v}</option>`).join("")}
        </select></div>
        <div style="flex:0"><button class="btn ghost">Save category</button></div>
      </form>
    </div>` : ""}

    ${lastDecision ? `<div class="card"><h2>Latest triage reasoning (${esc(lastDecision.computed_status)}${lastDecision.auto_sent ? ", auto-sent" : ", queued"})</h2><pre style="white-space:pre-wrap;font-size:12.5px">${esc(lastDecision.reasoning)}</pre></div>` : ""}
  </div>
</div>`
  );
}

// ── Compose: a ready, pre-filled reply — one obvious path to Send ───────────

export function composePage(c: Ctx, a: ApplicantRow, tpl: { key: string; name: string; subject: string; body: string; include_banner: number }, rendered: { subject: string; body: string }, error?: string): string {
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
    </div>
  </form>
</div>`
  );
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
  <p class="small">You are signed in as <b>${esc(u.display_name)}</b> (${esc(capFirst(u.role))}).${u.demo ? " This is a demo account that works with the sample dataset." : ""} Some areas — such as Configuration, Settings and Staff management — are only available to administrators and managers.</p>
</div>`
  );
}

// ── Entry requirements editor (structured, per qualification system) ──────

const LEVELS: Array<{ level: CourseLevel; label: string }> = [
  { level: "degree", label: "University-wide — degree programmes" },
  { level: "diploma", label: "University-wide — diploma programmes" },
  { level: "certificate", label: "University-wide — certificate programmes" },
  { level: "postgrad", label: "University-wide — postgraduate programmes" },
];

const CLASS_OPTIONS: Record<string, string[]> = {
  minClass_diploma: ["Pass", "Credit", "Distinction"],
  minClass_degree: ["Pass", "Second Class Honours (Lower Division)", "Second Class Honours (Upper Division)", "First Class Honours"],
};

function systemOverallInputs(meta: (typeof EXAM_SYSTEMS)[number], block: SystemBlock | undefined): string {
  const parts: string[] = [];
  for (const f of meta.fields) {
    if (f === "overall") {
      parts.push(`<div><label>Minimum mean grade</label><input type="text" name="overall" maxlength="2" style="text-transform:uppercase;width:70px" placeholder="C+" value="${esc(block?.overall ?? "")}"></div>`);
    } else if (f === "minCredits") {
      parts.push(`<div><label>Min passes at C or better</label><input type="number" name="min_credits" min="0" max="12" style="width:80px" value="${block?.minCredits ?? ""}"></div>`);
    } else if (f === "minPrincipals") {
      parts.push(`<div><label>Min principal passes</label><input type="number" name="min_principals" min="0" max="5" style="width:80px" value="${block?.minPrincipals ?? ""}"></div>`);
    } else if (f === "minSubsidiaries") {
      parts.push(`<div><label>Min subsidiary passes</label><input type="number" name="min_subsidiaries" min="0" max="5" style="width:80px" value="${block?.minSubsidiaries ?? ""}"></div>`);
    } else if (f === "minPoints") {
      parts.push(`<div><label>Min total points</label><input type="number" name="min_points" min="0" max="45" style="width:80px" value="${block?.minPoints ?? ""}"></div>`);
    } else if (f === "minGpa") {
      parts.push(`<div><label>Min GPA</label><input type="number" name="min_gpa" step="0.01" min="0" max="4" style="width:90px" value="${block?.minGpa ?? ""}"></div>`);
    } else if (f === "minClass") {
      const opts = meta.system === "DEGREE" ? CLASS_OPTIONS.minClass_degree : CLASS_OPTIONS.minClass_diploma;
      parts.push(`<div><label>Min award class</label><select name="min_class"><option value="">—</option>${opts.map((o) => `<option value="${esc(o)}"${block?.minClass === o ? " selected" : ""}>${esc(o)}</option>`).join("")}</select></div>`);
    }
  }
  return parts.join("");
}

function subjectMatrix(meta: (typeof EXAM_SYSTEMS)[number], block: SystemBlock | undefined): string {
  if (!meta.gradeOptions) return "";
  const reqs = block?.subjects ?? [];
  const rows = SUBJECT_CATALOG.map((subj, i) => {
    const hit = reqs.find((r) => r.subject === subj);
    const gradeOpts = meta.gradeOptions!.map((g) => `<option value="${esc(g)}"${hit?.grade === g ? " selected" : ""}>${esc(g)}</option>`).join("");
    const altOpts = SUBJECT_CATALOG.filter((x) => x !== subj).map((x) => `<option value="${esc(x)}"${hit?.alts?.[0] === x ? " selected" : ""}>${esc(x)}</option>`).join("");
    return `<tr>
      <td style="width:34px"><input type="checkbox" name="sub_${i}"${hit ? " checked" : ""} aria-label="Require ${esc(subj)}"></td>
      <td>${esc(subj)}</td>
      <td><select name="grade_${i}" style="min-width:74px"><option value="">—</option>${gradeOpts}</select></td>
      <td><select name="alt_${i}" style="min-width:150px"><option value="">no alternative</option>${altOpts}</select></td>
    </tr>`;
  }).join("");
  return `<details style="margin-top:8px"><summary class="small">Subject requirements — tick the required subjects and set the minimum grade (${reqs.length} ticked)</summary>
    <table style="margin-top:8px"><tr><th></th><th>Subject</th><th>Minimum grade</th><th>Or alternative (one of the two is enough)</th></tr>${rows}</table>
  </details>`;
}

function entryRequirementsEditor(c: Ctx, programmes: Programme[], target: string): string {
  const isBase = target.startsWith("BASE:");
  const level = (isBase ? target.slice(5) : "degree") as CourseLevel;
  const programme = isBase ? null : target;
  const blocks = c.repo.listSystemBlocks(programme).filter((b) => isBase ? b.level === level : true);
  const title = isBase
    ? LEVELS.find((l) => l.level === level)?.label ?? target
    : `${target} — ${esc(programmes.find((p) => p.code === target)?.name ?? "")}`;

  const picker = `<form method="get" action="/config#entryreqs" class="formrow" style="align-items:flex-end">
    <div style="flex:2"><label>Edit requirements for</label><select name="reqs" onchange="this.form.submit()">
      ${LEVELS.map((l) => `<option value="BASE:${l.level}"${target === `BASE:${l.level}` ? " selected" : ""}>${esc(l.label)}</option>`).join("")}
      ${programmes.map((p) => `<option value="${esc(p.code)}"${target === p.code ? " selected" : ""}>${esc(p.code)} — ${esc(p.name)}</option>`).join("")}
    </select></div>
  </form>`;

  const forms = EXAM_SYSTEMS.map((meta) => {
    const block = blocks.find((b) => b.system === meta.system);
    const cfg = block && block.enabled;
    return `<form method="post" action="/config/entry-requirements" style="border-top:1px solid var(--line2);padding:12px 0 6px">
      <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
      <input type="hidden" name="target" value="${esc(target)}">
      <input type="hidden" name="system" value="${meta.system}">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <label style="display:flex;gap:8px;align-items:center;min-width:320px"><input type="checkbox" name="enabled"${cfg ? " checked" : ""}> <b>${esc(meta.label)}</b></label>
        ${systemOverallInputs(meta, block)}
        <span style="flex:1"></span>
        <button class="btn small ghost">Save ${esc(meta.system)}</button>
      </div>
      ${subjectMatrix(meta, block)}
    </form>`;
  }).join("");

  return `${picker}
    <p class="small muted" style="margin-top:10px">Tick the subjects this course requires, set the minimum grade for each, and save — the engine checks newly processed files against it immediately (already-submitted files keep the requirements they applied under). Untick <i>enabled</i> and save to drop this route for the course and fall back to the ${isBase ? "defaults" : "university-wide minimum"} for that qualification. A ticked subject with an <i>or alternative</i> is satisfied by either subject reaching the grade.</p>
    <h3 style="margin:14px 0 2px">${title}</h3>
    ${forms}`;
}

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

export function configPage(c: Ctx, selectedTemplate?: string, flash?: string, reqsTarget?: string, tabChoice?: string): string {
  const { repo } = c;
  const settings = repo.allSettings();
  const rules = repo.listRules();
  const programmes = repo.listProgrammes();
  const intakes = repo.listIntakes();
  const templates = repo.listTemplates();
  const staff = repo.listStaff().filter((m) => m.active);

  const ruleRows = rules
    .map((r) => `<tr>
      <td>${r.programme ? esc(r.programme) : "<i>all</i>"}</td>
      <td>${r.intake ? esc(r.intake) : "<i>all</i>"}</td>
      <td>${esc(docLabel(r.document_type))}</td>
      <td>${r.required ? "required" : "optional"}</td>
      <td>${r.meanGrade ? esc(r.meanGrade) : "—"}${r.subjectGrades ? `<br><span class="muted small">${esc(r.subjectGrades)}</span>` : ""}</td>
      <td><form method="post" action="/settings/rules/delete"><input type="hidden" name="_csrf" value="${esc(c.csrf)}"><input type="hidden" name="id" value="${r.id}"><button class="btn small ghost">Remove</button></form></td>
    </tr>`)
    .join("");

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
  const courseRows = groupBySchool(programmes)
    .map(([school, rows]) => `<tr class="schoolrow"><td colspan="3">${esc(school)}</td></tr>` + rows
      .map((p) => `<tr>
        <td><b>${esc(p.code)}</b><br><span class="small muted">${esc(p.name)}</span></td>
        <td>
          <form method="post" action="/config/programme/edit" style="display:flex;gap:6px;align-items:flex-start;max-width:640px">
            <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
            <input type="hidden" name="programme" value="${esc(p.code)}">
            <div style="flex:1">
              <input type="text" name="name" value="${esc(p.name)}" title="Course name" style="margin-bottom:6px">
              <input type="text" name="school" value="${esc(p.school)}" title="School (faculty)" style="margin-bottom:6px">
              <textarea name="entry_requirements" rows="3" title="Entry requirements" style="min-height:64px;font-size:12.5px">${esc(p.entry_requirements)}</textarea>
            </div>
            <button class="btn small ghost" title="Save course details">Save</button>
          </form>
        </td>
        <td>${assignForm(p)}</td>
      </tr>`).join("")).join("");

  const first = templates[0];

  const gAddress = settings["gmail_address"] ?? "";
  const gClientId = settings["gmail_client_id"] ?? "";
  const gClientSecret = settings["gmail_client_secret"] ?? "";
  const gRefresh = settings["gmail_refresh_token"] ?? "";
  const connected = Boolean(gAddress && gClientId && gClientSecret && gRefresh);

  const tab = tabChoice === "replies" ? "replies" : "courses";
  const tabBar = `<div class="tabs" style="margin:0 0 20px">
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
  <p class="small muted" style="padding:0 24px;margin:8px 0 0">Every course is handled by someone — assign the responsible officer here or straight from the administration overview. The notes column is free-text reference; the <b>enforced</b> subject-and-grade rules for each course live in the entry-requirements editor below.</p>
  ${programmes.length
    ? `<table><tr><th>Programme</th><th>Course details &amp; reference notes</th><th>Handled by</th></tr>${courseRows}</table>`
    : `<div class="empty"><p>No courses yet — add the first one below.</p></div>`}
  <div style="padding:18px 24px 22px;border-top:1px solid var(--line2);margin-top:14px">
    <h2 id="entryreqs">Entry requirements by qualification</h2>
    ${entryRequirementsEditor(c, programmes, reqsTarget && reqsTarget.length ? reqsTarget : "BASE:degree")}

    <h2 style="margin-top:20px">Requirement rules (all courses)</h2>
    <p class="small muted" style="margin-top:-6px">Most specific rule wins: programme+intake → programme → intake → base (all).</p>
    <table><tr><th>Programme</th><th>Intake</th><th>Document</th><th>Required?</th><th>Grades</th><th></th></tr>${ruleRows}</table>
    <form method="post" action="/settings/rules/add" class="formrow" style="margin-top:14px">
      <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
      <div><label>Programme</label><select name="programme"><option value="">All programmes</option>${programmes.map((p) => `<option value="${esc(p.code)}">${esc(p.code)}</option>`).join("")}</select></div>
      <div><label>Intake</label><select name="intake"><option value="">All intakes</option>${intakes.map((i) => `<option value="${esc(i)}">${esc(i)}</option>`).join("")}</select></div>
      <div><label>Document</label><select name="document_type">${(["academic_cert", "kcpe_cert", "id", "birth_cert", "application_form"] as DocType[]).map((d) => `<option value="${d}">${esc(docLabel(d))}</option>`).join("")}</select></div>
      <div><label>Required</label><select name="required"><option value="1">required</option><option value="0">optional</option></select></div>
      <div style="flex:2"><label>&nbsp;</label><span class="small muted">Grade checks live in the entry-requirements editor above — this table only controls which documents must be present.</span></div>
      <div style="flex:0"><label>&nbsp;</label><button class="btn">Add rule</button></div>
    </form>
    <h2 style="margin-top:26px" id="addcourse">Add a course or intake</h2>
    <p class="small muted" style="margin-top:-6px">Create a new programme — it appears immediately in the picker above, in course ownership and across the admissions pipeline — or add another intake for existing courses.</p>
    <form method="post" action="/settings/lists/add" class="formrow" style="margin-top:10px">
      <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
      <div><label>New programme code</label><input type="text" name="prog_code" placeholder="e.g. MED"></div>
      <div style="flex:2"><label>Programme name</label><input type="text" name="prog_name" placeholder="e.g. Bachelor of Medicine"></div>
      <div><label>New intake</label><input type="text" name="intake" placeholder="e.g. May 2027"></div>
      <div style="flex:0"><label>&nbsp;</label><button class="btn">Add course</button></div>
    </form>
  </div>
</div>

${intakesCard}`;

  const replyHtml = `
${documentsPackCard(c)}

<div class="card" id="gemini">
  <h2>Document AI (Gemini) ${settings["gemini_api_key"]
    ? `<span class="badge b-green">key saved — AI reads what OCR can't</span>`
    : `<span class="badge b-gray">optional</span>`}</h2>
  <p class="small muted" style="margin-top:-6px">When a document beats text extraction and OCR (bad scans, photos, handwriting), Gemini reads it as a vision model. Paste your API key — get one free at <b>aistudio.google.com/apikey</b>. The key is tested with one real call and goes live <b>immediately</b>, no restart. Without a key the console still works; unreadable files simply land in the review queue.</p>
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

<div class="card" id="gmail">
  <h2>Gmail connection ${connected
    ? `<span class="badge b-green">connected — live sorting on</span>`
    : `<span class="badge b-orange">not connected</span>`}</h2>
  <p class="small muted" style="margin-top:-6px">Connect the admissions mailbox so incoming mail is fetched, triaged and sorted automatically every minute. In Google Cloud Console, enable the <b>Gmail API</b>, create an <b>OAuth client ID</b> (type: Web application) and add this server's <span class="mono">/settings/gmail/callback</span> URL to its authorised redirect URIs.</p>
  <form method="post" action="/settings/gmail/credentials">
    <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
    <div class="formrow">
      <div><label>Gmail address</label><input type="email" name="gmail_address" value="${esc(gAddress)}" placeholder="admissions@institution.ac.ke"></div>
      <div><label>OAuth client ID</label><input type="text" name="gmail_client_id" value="${esc(gClientId)}" placeholder="…apps.googleusercontent.com"></div>
      <div><label>OAuth client secret</label><input type="password" name="gmail_client_secret" value="" placeholder="${gClientSecret ? "saved — enter a new value to replace" : "GOCSPX-…"}" autocomplete="new-password"></div>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <button class="btn ghost">Save credentials</button>
      ${gClientId && gClientSecret ? `<a class="btn" href="/settings/gmail/connect">Connect with Google…</a>` : ""}
      ${connected ? `<form method="post" action="/settings/gmail/sync" style="margin:0"><input type="hidden" name="_csrf" value="${esc(c.csrf)}"><button class="btn ghost">Sync now</button></form>` : ""}
      ${connected ? `<form method="post" action="/settings/gmail/disconnect" style="margin:0"><input type="hidden" name="_csrf" value="${esc(c.csrf)}"><button class="btn ghost danger">Disconnect</button></form>` : ""}
    </div>
  </form>
  <p class="small muted" style="margin-top:10px">${connected
    ? `Signed in as <b>${esc(gAddress)}</b>. New mail is fetched automatically — no restart needed.${settings["gmail_last_sync_at"] ? ` Last successful sync: <b>${esc(fmtDate(settings["gmail_last_sync_at"]))}</b>.` : " First sync pending (runs every minute)."}`
    : "Mail is not being fetched yet. Emails can still be replayed through the simulator."}</p>
  ${settings["gmail_last_error"] ? `<p class="small" style="color:var(--red)">Last sync failed: ${esc(settings["gmail_last_error"])}<br><span class="muted">If this says <span class="mono">invalid_grant</span>, the refresh token expired — press “Connect with Google…” again. If new mail still doesn’t appear after a good sync, check that the message is in the inbox of <b>${esc(gAddress || "the connected address")}</b> and within the lookback window.</span></p>` : ""}
  <p class="small muted">Receiving works both ways: staff replies and automated replies are recorded on the case, and anything the applicant sends lands here within a minute of arriving in the mailbox (or immediately after <b>Sync now</b>).</p>
</div>

<div class="card" id="templates">
  <h2>Email templates</h2>
  <p class="small muted" style="margin-top:-6px">Placeholders: <span class="mono">{ref} {name} {first_name} {missing_docs} {missing_docs_section} {checklist} {status} {institution} {programme} {reg_date} {orientation_dates}</span></p>
  <form method="get" action="/config" class="formrow">
    <input type="hidden" name="tab" value="replies">
    <div style="flex:2"><label>Template</label><select name="template" onchange="this.form.submit()">${templates
      .map((t) => `<option value="${esc(t.key)}" ${selectedTemplate === t.key ? "selected" : ""}>${esc(t.name)} (${esc(t.key)})</option>`)
      .join("")}</select></div>
  </form>
  ${templateEditor(c, (selectedTemplate ? c.repo.getTemplate(selectedTemplate) : undefined) ?? first)}
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
${tab === "courses" ? courseHtml : replyHtml}
`
  );
}

function templateEditor(c: Pick<Ctx, "csrf">, t: { key: string; name: string; subject: string; body: string; include_banner?: number } | undefined): string {
  if (!t) return `<p class="muted">No templates.</p>`;
  return `<form method="post" action="/settings/template">
    <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
    <input type="hidden" name="key" value="${esc(t.key)}">
    <label>Display name</label><input type="text" name="name" value="${esc(t.name)}">
    <label>Subject (reference number is prepended automatically)</label><input type="text" name="subject" value="${esc(t.subject)}">
    <label>Body</label><textarea name="body" style="min-height:220px">${esc(t.body)}</textarea>
    <label style="display:flex;gap:8px;align-items:center;margin-top:8px"><input type="checkbox" name="include_banner" style="width:auto" ${t.include_banner === 0 ? "" : "checked"}> Attach the email banner to this template</label>
    <p><button class="btn">Save template</button></p>
  </form>`;
}

// ── Staff (team performance + account management, merged) ──────────────────

export function staffPage(c: Ctx, flash?: string): string {
  const { repo } = c;
  const isAdmin = c.user.role === "admin";

  // Passwords the system itself seeds. Demo-dataset accounts may keep
  // theirs (they are samples); real accounts must not.
  const KNOWN_DEFAULTS: Record<string, string> = {
    admin: "admin123", demo_admin: "demo123", demo_user: "demo123",
  };
  const onDefaultPassword = (username: string): boolean => {
    const known = KNOWN_DEFAULTS[username];
    if (!known) return false;
    const full = repo.getStaffByUsername(username);
    return Boolean(full && !full.demo && verifyPassword(known, full.password_hash));
  };

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
${repo.listStaff().some((st) => onDefaultPassword(st.username))
  ? `<div class="flash err" style="position:static;margin-bottom:16px">One or more real accounts still use their seeded starting passwords. Reset them below before going live.</div>`
  : ""}
<section class="card nopad">
  <div class="card-head"><h2>Accounts</h2></div>
  <table>
    <tr><th>Username</th><th>Name</th><th>Role</th><th>Status</th><th>Actions</th></tr>
    ${repo.listStaff()
      .map((st) => `<tr>
        <td class="mono">${esc(st.username)}${st.demo ? ` <span class="badge b-purple" title="Sample account from the demo dataset">demo</span>` : ""}${onDefaultPassword(st.username) ? ` <span class="badge b-red" title="This account still uses its seeded password">default password</span>` : ""}</td>
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
    <div><label>Role</label><select name="role"><option value="officer">officer</option><option value="it">it</option><option value="manager">manager</option><option value="admin">admin</option></select></div>
    <div style="flex:0"><label>&nbsp;</label><button class="btn">Create</button></div>
  </form>
  <p class="small muted" style="margin-bottom:0">Roles: <b>admin</b> (everything) · <b>manager</b> (cases + configuration) · <b>officer</b> (cases only) · <b>it</b> (cases + automation/settings, no staff management)</p>
</section>`
    : `<p class="small muted">Account management is limited to administrators — you are seeing the team report only.</p>`;

  return head(
    c,
    "Staff",
    "staff",
    `
<h1>Staff</h1>
<div class="sub">Who handles what — workload, responsiveness and accounts.</div>
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

${accountsSection}`
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
