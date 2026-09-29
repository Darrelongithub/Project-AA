/**
 * Page renderers — dashboards. Extracted verbatim from pages.ts;
 * pages.ts re-exports the page API unchanged.
 */
import { docLabel } from "../../rules";
import { DocType } from "../../types";
import { envInt } from "../../util/envnum";
import { avatar, esc, flagLabel, fmtDate, gaugeRow, heroClock, priorityBadge, slaText, triageBadge } from "../views";
import { capFirst, formatDuration, greeting, head } from "./shared";
import type { Ctx } from "./shared";
import { badge, csrfField, emptyState, raw, statCell } from "../tpl";

/** Alert kinds arrive as snake_case — staff read words, not tokens. */
export function kindLabel(kind: string): string {
  const known: Record<string, string> = {
    review_needed: "Review needed", escalation: "Escalation", assignment: "Assignment",
  };
  return known[kind] ?? capFirst(kind.replace(/_/g, " "));
}


// ── Overview landing views ─────────────────────────────────────────────────
// Admins land on administration: courses, ownership, activity, system status.
// Managers/officers land on their casework command center, alerts included.
/** First name for the greeting — empty when the account has no personal name. */
function firstName(display: string): string {
  const w = (display || "").trim().split(/\s+/)[0] || "";
  return w === "System" ? "" : w;
}


function adminDashboard(c: Ctx): string {
  const { repo } = c;
  const realm = c.user.demo; // live admins see only live data; demo accounts only mock data.
  // OR-8: admins are never scoped, but the same code path serves scoped
  // accounts — visibility is decided in ONE place (repo.visibleSchoolsFor).
  const scope = repo.caseScopeFor(c.user);
  const s = repo.dashboardStats(realm, scope);
  const stage = repo.stageCounts(realm, scope);
  const orgId = c.user.organization_id ?? 1;
  const team = repo.staffStats(realm, orgId).filter((t) => t.demo === realm);
  const alerts = repo.notificationsFor(c.user.id, 6, realm, scope);
  const all = repo.allApplicants(realm, scope);
  const missingDocs = repo.commonMissingDocs(realm, scope, 5);
  const triage = repo.triageCounts(realm, scope);
  const gmailConnected = Boolean(repo.hasSecret("gmail_refresh_token")) || Boolean(c.gmailConfigured);
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
        ? badge("green", "auto-admitted")
        : a.admission_decision === "admitted_after_review"
          ? badge("purple", "admitted after review")
          : a.admission_decision === "not_admitted"
            ? badge("red", "not admitted")
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
<header class="overview-mast">
  <div class="mast-main">
    <div class="mast-index"><span>a²</span><i> / </i>OPERATIONS REGISTER</div>
    <h1>${greeting()}${firstName(c.user.display_name) ? ", " + esc(firstName(c.user.display_name)) : ""}<b>.</b></h1>
    <p class="mast-sub">${applications} applications in the register <span>·</span> all times East Africa</p>
  </div>
  <div class="mast-time">${heroClock()}<span class="mast-live"><i></i> SYSTEM LIVE</span></div>
  <span class="mast-watermark" aria-hidden="true">a²</span>
  <span class="mast-folio">PRIVATE
CASEWORK
NO. 01</span>
</header>

<section class="overview-flow">
  <div class="flow-heading"><span class="flow-index">01</span><div><div class="kicker">THE REGISTER</div><h2>Admissions in motion</h2><p>${applications} applications · choose a dial to open its queue</p></div><a class="flow-link" href="/admissions">OPEN REGISTER <b>↗</b></a></div>
  <div class="gauge-band"><div class="band-label"><b>At a glance</b><span>WORKLOAD</span></div>
  ${gaugeRow([
    { n: stage.finished, label: "Finished", tone: "green", href: "/admissions?stage=completed", caption: `${completion ?? 0}% of all files` },
    { n: stage.unfinished, label: "Unfinished", tone: "orange", href: "/admissions?stage=unfinished", caption: "gathering documents" },
    { n: stage.pending, label: "Pending review", tone: "purple", href: "/admissions?stage=awaiting_review", caption: "waiting on staff" },
    { n: stage.enquiries, label: "Enquiries today", tone: "blue", href: "/admissions?stage=enquiries", caption: "across the team" },
  ])}</div>
  <div class="gauge-band levels-band"><div class="band-label"><b>By stage</b><span>PIPELINE</span></div>
  ${gaugeRow([
    { n: stage.application_received, label: "Application received", href: "/admissions?stage=application_received" },
    { n: stage.documents_received, label: "Documents received", href: "/admissions?stage=documents_received" },
    { n: stage.documents_checked, label: "Documents checked", href: "/admissions?stage=documents_checked" },
    { n: stage.awaiting_review, label: "Awaiting review", href: "/admissions?stage=awaiting_review" },
    { n: stage.verification, label: "Verification", href: "/admissions?stage=verification" },
    { n: stage.completed, label: "Completed", tone: "green", href: "/admissions?stage=completed" },
  ])}</div>
</section>

<section class="card nopad" id="alerts">
  <div class="card-head"><h2>Alerts${c.unread ? ` ${badge("purple", c.unread, " new")}` : ""}</h2>
    ${c.unread ? `<form method="post" action="/notifications/read-all" style="margin:0">${csrfField(c.csrf)}<button class="btn small ghost">Mark all read</button></form>` : ""}
  </div>
  ${alerts.length
    ? `<div class="feed">${alertRows}</div>`
    : emptyState(`<p>No alerts. Escalations and auto-admissions appear here.</p>`)}
</section>

${missingDocs.length
  ? `<section class="card" id="missing-docs">
    <h2>Most requested missing documents</h2>
    <p class="small muted" style="margin-top:-6px">Required documents the most open cases are still waiting on — work down the list.</p>
    <div class="kv">
      ${missingDocs.map((m) => statCell(docLabel(m.type as DocType), raw(`${m.count} case${m.count === 1 ? "" : "s"}`))).join("")}
    </div>
  </section>`
  : ""}

${triageTile(triage)}

<section class="card nopad">
  <div class="card-head"><h2>Team performance <span class="muted small" style="text-transform:none;letter-spacing:0">— how your staff are working</span></h2><a class="small" href="/staff">staff configuration →</a></div>
  ${team.length
    ? `<table><tr><th>Staff member</th><th>Assigned cases</th><th>Emails</th><th>Avg response</th><th>Files completed</th></tr>${teamRows}</table>`
    : emptyState(`<p>No staff accounts yet.</p>`)}
</section>

<section class="card nopad">
  <div class="card-head"><h2>Completed files &amp; approvals <span class="muted small" style="text-transform:none;letter-spacing:0">— who finished what, and when</span></h2></div>
  ${completedFiles
    ? `<table><tr><th>Ref</th><th>Applicant</th><th>Case</th><th>Decision / completed by</th><th>When</th></tr>${completedFiles}</table>`
    : emptyState(`<p>No completed files yet — approvals appear here as cases finish.</p>`)}
</section>

<section class="card">
  <h2>System</h2>
  <div class="kv">
    <div><span>Gmail</span><b>${gmailConnected ? `connected${lastSync ? ` · synced ${esc(fmtDate(lastSync))}` : ""}` : "not connected"} <a class="small" href="/settings#connections">manage</a></b></div>
    ${statCell("Document AI (Gemini)", raw(`${repo.hasSecret("gemini_api_key") ? "key saved · live" : "not set"} <a class="small" href="/settings#connections">manage</a>`))}
    ${statCell("Automation", raw(`${globalMode === "draft" ? "draft-first" : "auto"} · <a class="small" href="/settings#automation">change</a>`))}
    ${statCell("Team", raw(`${team.filter((t) => t.active).length}/${team.length} active · <a class="small" href="/staff">staff configuration</a>`))}
    ${statCell("Replies to date", (() => { const ac = repo.accuracyStats(realm); return Number(ac.autoSends) + Number(ac.humanSends); })())}
  </div>
</section>`
  );
}


export function dashboardPage(c: Ctx): string {
  const html = c.user.role === "admin" ? adminDashboard(c) : officerDashboard(c);
  return c.repo.hasEducationModule(c.user.organization_id ?? 1) ? html : genericDashboardTerms(html);
}


/** DEMO: the overview's fixed copy was written for the education module.
 *  An organization without it gets neutral case vocabulary and links into
 *  its own queues (the education-only register page is not available). */
function genericDashboardTerms(html: string): string {
  const swaps: Array<[RegExp, string]> = [
    [/ applications in the register/g, " cases in the register"],
    [/Admissions in motion/g, "Cases in motion"],
    [/ applications · choose/g, " cases · choose"],
    [/ <span>·<\/span> all times East Africa/g, ""],
    [/href="\/admissions[^"]*"/g, 'href="/applicants"'],
    [/>Application received</g, ">Received<"],
    [/auto-admissions/g, "automated steps"],
    [/<th>Applicant<\/th>/g, "<th>Contact</th>"],
    [/active applicant(s?)/g, "active case$1"],
    [/applicant emails unanswered/g, "emails unanswered"],
    [/fee · admission · follow-ups/g, "questions · follow-ups"],
  ];
  return swaps.reduce((acc, [re, to]) => acc.replace(re, to), html);
}


// ── Admissions command center (managers & officers), alerts merged in ──────
/** Round 10: the one explicit Green/Orange/Red counter (checklist §11). */
function triageTile(t: { green: number; orange: number; red: number }): string {
  const item = (n: number, label: string, sub: string, tone: "green" | "orange" | "red") =>
    `<div style="display:flex;align-items:center;gap:10px">
      <span class="triage-dot tone-${tone}" aria-hidden="true"></span>
      <b style="font-size:20px;min-width:30px">${n}</b>
      <span class="small"><b>${label}</b><br><span class="muted">${sub}</span></span>
    </div>`;
  return `<section class="card" id="triage">
    <h2>Triage right now</h2>
    <p class="small muted" style="margin-top:-6px">Every case's current marking — Green needs nothing, Orange needs a look, Red needs action.</p>
    <div style="display:flex;gap:34px;flex-wrap:wrap;padding-top:6px">
      ${item(t.green, "Green", "clean — nothing needs a person", "green")}
      ${item(t.orange, "Orange", "needs a person to look", "orange")}
      ${item(t.red, "Red", "a problem a person must act on", "red")}
    </div>
  </section>`;
}


function officerDashboard(c: Ctx): string {
  const { repo } = c;
  const realm = c.user.demo;
  // OR-8: every number on this page counts ONLY the officer's schools.
  const scope = repo.caseScopeFor(c.user);
  const s = repo.dashboardStats(realm, scope);
  const stage = repo.stageCounts(realm, scope);
  const missingDocs = repo.commonMissingDocs(realm, scope, 5);
  const today = repo.todayStats(realm, scope);
  const accuracy = repo.accuracyStats(realm, scope);
  const queue = repo.queueView(realm, scope);
  const unanswered = repo.unansweredCases(scope);
  const target = envInt(repo.getSetting("unanswered_target_hours", "4"), 4); // corrupt setting must not NaN the alert math
  const categories = repo.categoryCounts(scope);
  const triage = repo.triageCounts(realm, scope);
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
    <div class="card-head"><h2>Alerts${c.unread ? ` ${badge("purple", c.unread, " new")}` : ""}</h2>
      ${c.unread ? `<form method="post" action="/notifications/read-all" style="margin:0">${csrfField(c.csrf)}<button class="btn small ghost">Mark all read</button></form>` : ""}
    </div>
    ${alerts.length
      ? `<div class="feed">${alertRows}</div>`
      : emptyState(`<p>No alerts. Escalations and auto-admissions appear here.</p>`)}
  </section>`;

  return head(
    c,
    `Overview — ${c.institution}`,
    "dashboard",
    `
<header class="overview-mast">
  <div class="mast-main">
    <div class="mast-index"><span>a²</span><i> / </i>${esc(c.institution).toUpperCase()} · LIVE CASEWORK</div>
    <h1>${greeting()}${firstName(c.user.display_name) ? ", " + esc(firstName(c.user.display_name)) : ""}<b>.</b></h1>
    <p class="mast-sub">${activeCount} active applicant${activeCount === 1 ? "" : "s"} <span>·</span> all times East Africa</p>
  </div>
  <div class="mast-time">${heroClock()}<span class="mast-live"><i></i> SYSTEM LIVE</span></div>
  <span class="mast-watermark" aria-hidden="true">a²</span>
  <span class="mast-folio">PRIVATE
CASEWORK
NO. 01</span>
</header>

<section class="overview-flow">
  <div class="flow-heading"><span class="flow-index">01</span><div><div class="kicker">THE REGISTER</div><h2>Admissions in motion</h2><p>Every dial opens its live queue.</p></div><a class="flow-link" href="/admissions">OPEN REGISTER <b>↗</b></a></div>
  <div class="gauge-band"><div class="band-label"><b>At a glance</b><span>WORKLOAD</span></div>
  ${gaugeRow([
    { n: stage.finished, label: "Finished", tone: "green", href: "/admissions?stage=completed", caption: "completed files" },
    { n: stage.unfinished, label: "Unfinished", tone: "orange", href: "/admissions?stage=unfinished", caption: "still gathering documents" },
    { n: stage.pending, label: "Pending review", tone: "purple", href: "/admissions?stage=pending", caption: "waiting on a human" },
    { n: stage.enquiries, label: "Enquiries today", tone: "blue", href: "/admissions?stage=enquiries", caption: "fee · admission · follow-ups" },
  ])}</div>
  <div class="gauge-band levels-band"><div class="band-label"><b>By stage</b><span>PIPELINE</span></div>
  ${gaugeRow([
    { n: stage.application_received, label: "Application received", href: "/admissions?stage=application_received" },
    { n: stage.documents_received, label: "Documents received", href: "/admissions?stage=documents_received" },
    { n: stage.documents_checked, label: "Documents checked", href: "/admissions?stage=documents_checked" },
    { n: stage.awaiting_review, label: "Awaiting review", href: "/admissions?stage=awaiting_review" },
    { n: stage.verification, label: "Verification", href: "/admissions?stage=verification" },
    { n: stage.completed, label: "Completed", tone: "green", href: "/admissions?stage=completed" },
  ])}</div>
</section>

${alertsCard}

${missingDocs.length
  ? `<section class="card" id="missing-docs">
    <h2>Most requested missing documents</h2>
    <p class="small muted" style="margin-top:-6px">Required documents the most open cases are still waiting on — work down the list.</p>
    <div class="kv">
      ${missingDocs.map((m) => statCell(docLabel(m.type as DocType), raw(`${m.count} case${m.count === 1 ? "" : "s"}`))).join("")}
    </div>
  </section>`
  : ""}

${triageTile(triage)}

<div class="cols wide">
  <section class="card nopad">
    <div class="card-head"><h2>Needs attention</h2><a class="small" href="/applicants?queue=human_review">full queue →</a></div>
    <div>${attentionRows}</div>
  </section>
  <section class="card">
    <h2>Today</h2>
    <div class="kv">
      ${statCell("Emails today", today.emailsToday)}
      ${statCell("Documents today", today.docsToday)}
      ${statCell("Cases completed today", today.completedToday)}
      ${statCell("Avg auto-response (7 days)", avgAuto)}
      ${statCell("Avg review time", avgReview)}
    </div>
  </section>
</div>

<section class="card nopad">
  <div class="card-head"><h2>What needs my attention</h2><a class="small" href="/applicants?queue=human_review">open the Human Review queue →</a></div>
  ${queue.length
    ? `<table><tr><th>Ref</th><th>Applicant</th><th>Verdict</th><th>Flags</th><th>SLA</th></tr>${needsAttention}</table>`
    : emptyState(`<p>Queue is empty — every case is handled.</p>`)}
</section>

<div class="cols wide">
  <section class="card nopad">
    <div class="card-head"><h2>Unanswered emails <span class="muted small">(target ${target}h)</span></h2></div>
    ${unanswered.length
      ? `<table><tr><th>Ref</th><th>Applicant</th><th>Waiting</th></tr>${unansweredRows}</table>`
      : emptyState(`<p>Every applicant email has a reply.</p>`)}
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
    ${statCell("Clean Greens", accuracy.greenCases)}
    ${statCell("Watcher catches", accuracy.watcherCatches)}
    ${statCell("Human overrides", accuracy.humanOverrides)}
    <div><span>Send errors</span><b ${accuracy.sendErrors > 0 ? 'style="color:var(--red)"' : ""}>${accuracy.sendErrors}</b></div>
  </div>
  <p class="small muted" style="margin-bottom:0">${accuracy.autoSends} automated sends vs ${accuracy.humanSends} human sends · ${accuracy.reopened} cases reopened</p>
</section>`
  );
}


/** "name_mismatch,low_confidence" → "Name mismatch, Low confidence". */
function humanizeFlagSummary(summary: string): string {
  return summary.split(",").map((t) => t.trim()).filter(Boolean).map(flagLabel).join(", ");
}
