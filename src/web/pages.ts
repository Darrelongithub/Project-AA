/**
 * Page renderers — every page is built server-side from the database.
 * Single source of truth: nothing is rendered that isn't in the DB.
 */
import { DEAD_GEMINI_MODELS, DEFAULT_GEMINI_MODEL } from "../extraction/gemini";
import { envInt } from "../util/envnum";
import { missingGmailCredentials, resolveLookbackDays } from "../ingestion/sync";
import type { Repo } from "../db/repo";
import type { ApplicantRow, CaseType, DocType, EmailRecord, RuleNode, StaffUser } from "../types";
import { EMAIL_CATEGORIES, EMAIL_CATEGORY_LABELS, LIFECYCLE_LABELS, LIFECYCLE_ORDER, PERMISSIONS, PERMISSION_LABELS } from "../types";
import { compareRuleOrder, describeRule } from "../rules/workflow";
import { QUEUES, SUB_LABELS, queueOf, type QueueKey } from "../rules/queues";
import { docLabel } from "../rules";
import { TEMPLATE_PARTIAL_DOCS, inspectTemplate, renderTemplate } from "../drafting";
import { organizationName, organizationTheme, orgSetting } from "../branding";
import { WEBHOOK_PATH_PREFIX } from "./webhook";
import { PROCESS_TEMPLATES } from "../db/seed";
import {
  avatar, categoryBadge, crest, esc, flagLabel, flowLine, fmtDate, gaugeRow,
  heroClock, icon, layout, lifecycleBadge, lifecycleStepper, priorityBadge, readabilityScore, slaText, triageBadge, type Theme,
} from "./views";

interface Ctx {
  repo: Repo;
  user: StaffUser;
  unread: number;
  csrf: string;
  theme?: Theme;
  /** Organization-owned name and theme; case intake remains a configuration, not a code identity. */
  institution: string;
  brand?: { primary: string; accent: string; logo?: string | null; tagline?: string };
  /** The running server may have env-only Gmail credentials. */
  gmailConfigured?: boolean;
  gmailAddress?: string;
  /** Is outgoing mail actually delivered, or only recorded? */
  mailDelivers?: boolean;
  /** Is a Gemini credential present in the installation secret store? */
  geminiAvailable?: boolean;
}

/** The one warning every page carries while mail cannot leave the building. */
function deliveryNotice(c: Ctx): string | undefined {
  // The banner is useful precisely when the sender cannot deliver. The old
  // predicate was inverted, so a healthy Gmail connection showed a scary
  // warning while an offline installation stayed silent.
  if (c.mailDelivers === true) return undefined;
  return `<b>Mail is not connected.</b> Automated replies are held as queued drafts and <b>not sent</b> — connect Gmail under <a href="/settings#connections">Settings &rarr; Connections</a>.`;
}

function head(c: Ctx, title: string, active: string, content: string): string {
  return layout({
    title, content, user: c.user, unread: c.unread, active, csrf: c.csrf, theme: c.theme,
    institution: c.institution, brand: c.brand, notice: deliveryNotice(c),
    // PPR P0-2: the Cases entry appears only for organizations that
    // actually run an generic-module profile.
    organizations: c.user.role === "admin" && c.user.can_switch_org ? c.repo.listOrganizations().map((o) => ({ id: o.id, name: organizationName(c.repo, o.id) })) : undefined,
    activeOrganizationId: c.user.organization_id ?? 1,
  });
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

/** Legacy catalogue grouping | the compatibility shim behind case type codes. */

// ── Login ──────────────────────────────────────────────────────────────────

export function loginPage(error?: string, theme?: Theme, institution = "Organization", loginCsrf?: string, okMsg?: string): string {
  return layout({
    title: `Enter the workspace | ${institution}`,
    institution,
    publicPage: true,
    theme,
    content: `
<div class="loginbox card">
  ${crest(58)}
  <div class="brand-lockup"><span>PROJECT</span><b>a<sup>a</sup></b></div>
  <h1 class="center">Enter the workspace</h1>
  <p class="sub center">${esc(institution)} · Case operations, considered clearly</p>
  ${okMsg ? `<div class="flash ok" style="position:static;margin-bottom:14px">${esc(okMsg)}</div>` : ""}
  ${error ? `<div class="flash err" style="position:static;margin-bottom:14px">${esc(error)}</div>` : ""}
  <form method="post" action="/login">
    ${loginCsrf ? `<input type="hidden" name="_lcsrf" value="${esc(loginCsrf)}">` : ""}
    <label>Username</label>
    <input type="text" name="username" autofocus autocomplete="username" placeholder="your.username">
    <label>Password</label>
    <input type="password" name="password" autocomplete="current-password" placeholder="••••••••">
    <p style="margin-top:18px"><button class="btn" style="width:100%">Enter the workspace to the console</button></p>
  </form>
  <p class="small center" style="margin-top:14px"><a href="/reset-password">Forgot your password? Request a new access code from your administrator.</a></p>
  <p class="small muted center">Access is entrusted by your administrator.</p>
</div>`,
  });
}

/** Forgot-password: redeem an admin-issued single use reset code. Anonymous. */
export function resetPasswordPage(error?: string, theme?: Theme, institution = "Organization", loginCsrf?: string): string {
  return layout({
    title: `Restore access | ${institution}`,
    institution,
    publicPage: true,
    theme,
    content: `
<div class="loginbox card">
  ${crest(58)}
  <div class="brand-lockup"><span>PROJECT</span><b>a<sup>a</sup></b></div>
  <h1 class="center">Restore access</h1>
  <p class="sub center">Enter your username and the single use code issued by your administrator. The code expires after thirty minutes.</p>
  ${error ? `<div class="flash err" style="position:static;margin-bottom:14px">${esc(error)}</div>` : ""}
  <form method="post" action="/reset-password">
    ${loginCsrf ? `<input type="hidden" name="_lcsrf" value="${esc(loginCsrf)}">` : ""}
    <label>Username</label>
    <input type="text" name="username" autofocus autocomplete="username" placeholder="your.username">
    <label>Access code</label>
    <input type="text" name="code" autocomplete="one-time-code" placeholder="e.g. 7KMQ3NP9XW" class="mono" style="text-transform:uppercase">
    <label>New password</label>
    <input type="password" name="password" autocomplete="new-password" placeholder="at least 8 characters">
    <label>Confirm password</label>
    <input type="password" name="confirm" autocomplete="new-password" placeholder="repeat it">
    <p style="margin-top:18px"><button class="btn" style="width:100%">Set new password</button></p>
  </form>
  <p class="small muted center"><a href="/login">← Return to the sign in page</a></p>
</div>`,
  });
}


/** OR-1: single use first run screen | the owner creates their own admin account. */
export function setupPage(token: string, error?: string, theme?: Theme, institution = "Organization"): string {
  return layout({
    title: `First-run setup — ${institution}`,
    institution,
    publicPage: true,
    theme,
    content: `
<div class="loginbox card">
  ${crest(58)}
  <div class="brand-lockup"><span>PROJECT</span><b>a<sup>a</sup></b></div>
  <h1 class="center">Welcome to ${esc(institution)}</h1>
  <p class="sub center">This workspace is ready to be established. Create the administrator account. This page will not appear again.</p>
  ${error ? `<div class="flash err" style="position:static;margin-bottom:14px">${esc(error)}</div>` : ""}
  <form method="post" action="/setup">
    <label for="organization-name">Organization name</label><input id="organization-name" name="organization_name" required maxlength="120" autocomplete="organization" placeholder="Your organization name">
    <input type="hidden" name="_setup" value="${token}">
    <label>Your name</label>
    <input type="text" name="display_name" autofocus autocomplete="name" placeholder="e.g. Darrel">
    <label>Username</label>
    <input type="text" name="username" autocomplete="username" placeholder="your.username">
    <label>Password (at least 8 characters)</label>
    <input type="password" name="password" autocomplete="new-password" placeholder="••••••••">
    <label>Confirm password</label>
    <input type="password" name="confirm" autocomplete="new-password" placeholder="••••••••">
    <p style="margin-top:18px"><button class="btn" style="width:100%">Establish administrator access</button></p>
  </form>
</div>`,
  });
}


// ── Overview landing views ─────────────────────────────────────────────────
// Admins land on administration: case types, ownership, activity, system status.
// Managers/officers land on their casework command center, alerts included.

/** First name for the greeting — empty when the account has no personal name. */
function firstName(display: string): string {
  const w = (display || "").trim().split(/\s+/)[0] || "";
  return w === "Workspace" ? "" : w;
}

function greeting(): string {
  const hour = new Date().getHours();
  return hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
}

/**
 * The one-click starter cards, rendered from `PROCESS_TEMPLATES` rather than
 * hand-written at each call site. The dashboard and the empty-queues page used
 * to carry their own copies of these labels, which is how the constant ended
 * up imported-but-unused and would have let the two lists drift apart.
 */
function processTemplatePicker(c: Ctx, opts: { blurb?: boolean; firstPrimary?: boolean } = {}): string {
  return PROCESS_TEMPLATES.map((t, i) => {
    const primary = opts.firstPrimary === false ? "ghost" : i === 0 ? "" : "ghost";
    const label = opts.blurb ? `${esc(t.name)} — ${esc(t.blurb)}` : esc(t.name);
    return `<form method="post" action="/setup/process-template" style="margin:0${opts.blurb ? " 0 8px" : ""}">
      <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
      <input type="hidden" name="template" value="${esc(t.id)}">
      <button class="btn ${primary}"${opts.blurb ? "" : " style=\"width:100%;text-align:left;justify-content:flex-start\""}>${label}</button>
    </form>`;
  }).join("\n    ");
}

function adminDashboard(c: Ctx): string {
  const { repo } = c;
  const realm = c.user.demo; // live admins see only live data; demo accounts only mock data.
  // OR-8: admins are never scoped, but the same code path serves scoped
  // accounts — visibility is decided in ONE place (repo.visibleCaseTypesFor).
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
  // Same predicate the pipeline uses — a switch the console shows backwards is
  // worse than no switch at all.
  const globalMode = repo.globalAutomationMode();

  const applications = Number(s.applications);
  const completed = Number(s.completed);
  const completion = applications > 0 ? Math.round((completed / applications) * 100) : null;

  // Team practice | the same numbers a staff member sees, per person.
  const teamRows = team
    .map((t) => `<tr${t.active ? "" : ' class="muted"'}>
      <td><div class="nameline">${avatar(t.display_name, 26)}<span><b>${esc(t.display_name)}</b><br><span class="muted small">${esc(capFirst(t.role))}${t.active ? "" : " · deactivated"}</span></span></div></td>
      <td>${t.assignedCases}</td>
      <td>${t.emailsReceived} in · ${t.emailsSent} out</td>
      <td>${t.avgResponseMinutes !== null ? `${t.avgResponseMinutes} min` : "Not recorded"}</td>
      <td>${t.casesCompleted}</td>
    </tr>`)
    .join("");

  // Approvals: completed files with WHO completed them and when — real,
  // attributable work, not vanity counts.
  const completedFiles = all
    .filter((a) => a.lifecycle === "completed")
    .slice(0, 12)
    .map((a) => {
      const appr = repo.approverFor(a.id);
      const decision = a.outcome === "auto_approved"
        ? `<span class="badge b-green">admitted automatically</span>`
        : a.outcome === "approved_after_review"
          ? `<span class="badge b-purple">admitted after review</span>`
          : a.outcome === "not_approved"
            ? `<span class="badge b-red">not admitted</span>`
            : "";
      return `<tr>
        <td class="mono"><a href="/case/${a.id}">${esc(a.ref_number)}</a></td>
        <td>${esc(a.full_name ?? "Not recorded")}</td>
        <td>${esc(a.case_type_code ?? "Not recorded")}</td>
        <td class="small">${decision || esc(appr?.actor ?? "Not recorded")}</td>
        <td class="small nowrap muted">${esc(fmtDate(appr?.at ?? a.updated_at))}</td>
      </tr>`;
    })
    .join("");

  const alertRows = alerts
    .map((n) => `<div class="feed-row ${n.read ? "read" : ""}">
      <span class="badge ${n.kind === "escalation" ? "b-red" : n.kind === "review_needed" ? "b-orange" : n.kind === "auto_case" ? "b-green" : "b-blue"}">${esc(kindLabel(n.kind))}</span>
      <span class="feed-msg">${esc(n.message)}</span>
      ${n.applicant_id ? `<a class="small nowrap" href="/case/${n.applicant_id}">open →</a>` : ""}
      <span class="feed-when right">${esc(fmtDate(n.at))}</span>
    </div>`)
    .join("");

  const hasCaseTypes = repo.listCaseTypes(orgId).length > 0;
  const setupCard = !hasCaseTypes ? `
<section class="card" style="max-width:640px;margin:0 0 28px;padding:28px 32px">
  <div class="kicker">First step</div>
  <h2 style="margin-bottom:8px">Choose how this workspace starts</h2>
  <p class="small muted" style="margin:0 0 16px">Pick a ready process template, or build your own. Everything stays in human review until you decide otherwise. You can change any of this later.</p>
  <div style="display:grid;gap:12px;margin-bottom:16px">
    ${processTemplatePicker(c)}
  </div>
  <p class="small muted" style="margin:0"><a href="/config?tab=case-types">Or build a custom process from scratch</a> · <a href="/config?tab=rules">Configure if/then workflow rules</a></p>
</section>` : "";

  return head(
    c,
    `Overview — ${c.institution}`,
    "dashboard",
    `
<header class="overview-mast">
  <div class="mast-main">
    <div class="mast-index"><span>aᵃ</span><i> / </i>OPERATIONS REGISTER</div>
    <h1>${greeting()}${firstName(c.user.display_name) ? ", " + esc(firstName(c.user.display_name)) : ""}<b>.</b></h1>
    <p class="mast-sub">${applications} cases in the register <span>·</span> all times East Africa</p>
  </div>
  <div class="mast-time">${heroClock()}<span class="mast-live"><i></i> SYSTEM IN OPERATION</span></div>
  <span class="mast-watermark" aria-hidden="true">aᵃ</span>
  <span class="mast-folio">PRIVATE RECORD
CASEWORK
NO. 01</span>
</header>

${setupCard}

<section class="overview-flow">
  <div class="flow-heading"><span class="flow-index">01</span><div><div class="kicker">THE REGISTER</div><h2>Cases presently unfolding</h2><p>${applications} cases · Choose a measure to enter its queue</p></div><a class="flow-link" href="/cases">OPEN THE REGISTER <b>↗</b></a></div>
  <div class="gauge-band"><div class="band-label"><b>At a glance</b><span>WORKLOAD</span></div>
  ${gaugeRow([
    { n: stage.finished, label: "Finished", tone: "green", href: "/cases?stage=completed", caption: `${completion ?? 0}% of all files` },
    { n: stage.unfinished, label: "In progress", tone: "orange", href: "/cases?stage=unfinished", caption: "gathering documents" },
    { n: stage.pending, label: "Awaiting review", tone: "purple", href: "/cases?stage=awaiting_review", caption: "waiting on staff" },
    { n: stage.enquiries, label: "Enquiries today", tone: "blue", href: "/cases?stage=enquiries", caption: "across the team" },
  ])}</div>
  <div class="gauge-band levels-band"><div class="band-label"><b>By stage</b><span>CASE PROGRESSION</span></div>
  ${gaugeRow([
    { n: stage.application_received, label: "Received", href: "/cases?stage=application_received" },
    { n: stage.documents_received, label: "Documents received", href: "/cases?stage=documents_received" },
    { n: stage.documents_checked, label: "Documents checked", href: "/cases?stage=documents_checked" },
    { n: stage.awaiting_review, label: "Awaiting review", href: "/cases?stage=awaiting_review" },
    { n: stage.verification, label: "Verification", href: "/cases?stage=verification" },
    { n: stage.completed, label: "Completed", tone: "green", href: "/cases?stage=completed" },
  ])}</div>
</section>

<section class="card nopad" id="alerts">
  <div class="card-head"><h2>Notices${c.unread ? ` <span class="badge b-purple">${c.unread} new</span>` : ""}</h2>
    ${c.unread ? `<form method="post" action="/notifications/read-all" style="margin:0"><input type="hidden" name="_csrf" value="${esc(c.csrf)}"><button class="btn small ghost">Mark every notice as read</button></form>` : ""}
  </div>
  ${alerts.length
    ? `<div class="feed">${alertRows}</div>`
    : `<div class="empty"><p>There are no notices at present. Escalations and newly opened cases will appear here.</p></div>`}
</section>

${missingDocs.length
  ? `<section class="card" id="missing-docs">
    <h2>Most requested missing documents</h2>
    <p class="small muted" style="margin-top:-6px">These are the documents most frequently awaited by open cases. Begin with the matters at the top of the list.</p>
    <div class="kv">
      ${missingDocs.map((m) => `<div><span>${esc(docLabel(m.type as DocType))}</span><b>${m.count} case${m.count === 1 ? "" : "s"}</b></div>`).join("")}
    </div>
  </section>`
  : ""}

${triageTile(triage)}

<section class="card nopad">
  <div class="card-head"><h2>Team practice <span class="muted small" style="text-transform:none;letter-spacing:0">| How the team is carrying the work</span></h2><a class="small" href="/staff">Staff configuration →</a></div>
  ${team.length
    ? `<table><tr><th>Member of staff</th><th>Cases entrusted</th><th>Emails</th><th>Avg response</th><th>Files concluded</th></tr>${teamRows}</table>`
    : `<div class="empty"><p>No staff accounts have been established yet.</p></div>`}
</section>

<section class="card nopad">
  <div class="card-head"><h2>Completed files and decisions <span class="muted small" style="text-transform:none;letter-spacing:0">| A record of what was completed and when</span></h2></div>
  ${completedFiles
    ? `<table><tr><th>Ref</th><th>Correspondent</th><th>Case</th><th>Decision / completed by</th><th>When</th></tr>${completedFiles}</table>`
    : `<div class="empty"><p>No completed files have entered the register yet. Decisions will appear here as matters reach completion.</p></div>`}
</section>

<section class="card">
  <h2>Workspace</h2>
  <div class="kv">
    <div><span>Gmail</span><b>${gmailConnected ? `connected${lastSync ? ` · synced ${esc(fmtDate(lastSync))}` : ""}` : "not connected"} <a class="small" href="/settings#connections">manage</a></b></div>
    <div><span>Document AI (Gemini)</span><b>${repo.hasSecret("gemini_api_key") ? "key saved · live" : "not set"} <a class="small" href="/settings#connections">manage</a></b></div>
    <div><span>Automation</span><b>${globalMode === "draft" ? "draft first" : "auto"} · <a class="small" href="/settings#automation">change</a></b></div>
    <div><span>Team</span><b>${team.filter((t) => t.active).length}/${team.length} active · <a class="small" href="/staff">Staff configuration</a></b></div>
    <div><span>Replies to date</span><b>${(() => { const ac = repo.accuracyStats(realm); return Number(ac.autoSends) + Number(ac.humanSends); })()}</b></div>
  </div>
</section>`
  );
}

export function dashboardPage(c: Ctx): string { return c.user.role === "admin" ? adminDashboard(c) : officerDashboard(c); }

// ── Cases command center (managers & officers), alerts merged in ──────

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
    <p class="small muted" style="margin-top:-6px">Each case carries a current assessment. Green requires no attention, orange invites review, and red calls for action.</p>
    <div style="display:flex;gap:34px;flex-wrap:wrap;padding-top:6px">
      ${item(t.green, "Green", "Clear, with no human action required", "green")}
      ${item(t.orange, "Orange", "needs a person to look", "orange")}
      ${item(t.red, "Red", "A matter requiring human attention", "red")}
    </div>
  </section>`;
}

function officerDashboard(c: Ctx): string {
  const { repo } = c;
  const realm = c.user.demo;
  // OR-8: every number on this page counts ONLY the officer's case types.
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
    { label: "replies processed automatically to date", n: Number(s.autoHandled), href: "/queue", tone: "green" },
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
        <td><div class="nameline">${avatar(r.full_name ?? r.ref_number, 26)}<span>${esc(r.full_name ?? "Not recorded")}</span></div></td>
        <td>${triageBadge(r.computed_status)} ${priorityBadge(r.priority)}</td>
        <td class="small">${esc(r.flag_summary ? humanizeFlagSummary(r.flag_summary) : "Not recorded")}</td>
        <td class="nowrap small ${overdue ? "overdue" : "muted"}">${esc(slaText(r.sla_due_at, r.sla_handled_at)) || "Not recorded"}</td>
      </tr>`;
    })
    .join("");

  const unansweredRows = unanswered
    .slice(0, 8)
    .map((u) => `<tr>
      <td class="mono"><a href="/case/${u.applicant.id}">${esc(u.applicant.ref_number)}</a></td>
      <td>${esc(u.applicant.full_name ?? "Not recorded")}</td>
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
      <span class="badge ${n.kind === "escalation" ? "b-red" : n.kind === "review_needed" ? "b-orange" : n.kind === "auto_case" ? "b-green" : "b-blue"}">${esc(kindLabel(n.kind))}</span>
      <span class="feed-msg">${esc(n.message.replace(/^\u26a0\ufe0f\s*/, ""))}</span>
      ${n.applicant_id ? `<a class="small nowrap" href="/case/${n.applicant_id}">open →</a>` : ""}
      <span class="feed-when right">${esc(fmtDate(n.at))}</span>
    </div>`)
    .join("");

  // Notices sit IMMEDIATELY after the gauges | the first thing after the
  // pipeline picture is what needs a human right now.
  const alertsCard = `<section class="card nopad" id="alerts">
    <div class="card-head"><h2>Notices${c.unread ? ` <span class="badge b-purple">${c.unread} new</span>` : ""}</h2>
      ${c.unread ? `<form method="post" action="/notifications/read-all" style="margin:0"><input type="hidden" name="_csrf" value="${esc(c.csrf)}"><button class="btn small ghost">Mark every notice as read</button></form>` : ""}
    </div>
    ${alerts.length
      ? `<div class="feed">${alertRows}</div>`
      : `<div class="empty"><p>There are no notices at present. Escalations and newly opened cases will appear here.</p></div>`}
  </section>`;

  return head(
    c,
    `Overview — ${c.institution}`,
    "dashboard",
    `
<header class="overview-mast">
  <div class="mast-main">
    <div class="mast-index"><span>aᵃ</span><i> / </i>${esc(c.institution).toUpperCase()} · CASEWORK IN PROGRESS</div>
    <h1>${greeting()}${firstName(c.user.display_name) ? ", " + esc(firstName(c.user.display_name)) : ""}<b>.</b></h1>
    <p class="mast-sub">${activeCount} active applicant${activeCount === 1 ? "" : "s"} <span>·</span> all times East Africa</p>
  </div>
  <div class="mast-time">${heroClock()}<span class="mast-live"><i></i> SYSTEM IN OPERATION</span></div>
  <span class="mast-watermark" aria-hidden="true">aᵃ</span>
  <span class="mast-folio">PRIVATE RECORD
CASEWORK
NO. 01</span>
</header>

<section class="overview-flow">
  <div class="flow-heading"><span class="flow-index">01</span><div><div class="kicker">THE REGISTER</div><h2>Cases presently unfolding</h2><p>Every dial opens its live queue.</p></div><a class="flow-link" href="/cases">OPEN THE REGISTER <b>↗</b></a></div>
  <div class="gauge-band"><div class="band-label"><b>At a glance</b><span>WORKLOAD</span></div>
  ${gaugeRow([
    { n: stage.finished, label: "Finished", tone: "green", href: "/cases?stage=completed", caption: "completed files" },
    { n: stage.unfinished, label: "In progress", tone: "orange", href: "/cases?stage=unfinished", caption: "still gathering documents" },
    { n: stage.pending, label: "Awaiting review", tone: "purple", href: "/cases?stage=pending", caption: "waiting on a human" },
    { n: stage.enquiries, label: "Enquiries today", tone: "blue", href: "/cases?stage=enquiries", caption: "fee · case · follow ups" },
  ])}</div>
  <div class="gauge-band levels-band"><div class="band-label"><b>By stage</b><span>CASE PROGRESSION</span></div>
  ${gaugeRow([
    { n: stage.application_received, label: "Received", href: "/cases?stage=application_received" },
    { n: stage.documents_received, label: "Documents received", href: "/cases?stage=documents_received" },
    { n: stage.documents_checked, label: "Documents checked", href: "/cases?stage=documents_checked" },
    { n: stage.awaiting_review, label: "Awaiting review", href: "/cases?stage=awaiting_review" },
    { n: stage.verification, label: "Verification", href: "/cases?stage=verification" },
    { n: stage.completed, label: "Completed", tone: "green", href: "/cases?stage=completed" },
  ])}</div>
</section>

${alertsCard}

${missingDocs.length
  ? `<section class="card" id="missing-docs">
    <h2>Most requested missing documents</h2>
    <p class="small muted" style="margin-top:-6px">These are the documents most frequently awaited by open cases. Begin with the matters at the top of the list.</p>
    <div class="kv">
      ${missingDocs.map((m) => `<div><span>${esc(docLabel(m.type as DocType))}</span><b>${m.count} case${m.count === 1 ? "" : "s"}</b></div>`).join("")}
    </div>
  </section>`
  : ""}

${triageTile(triage)}

<div class="cols wide">
  <section class="card nopad">
    <div class="card-head"><h2>Needs attention</h2><a class="small" href="/applicants?queue=human_review">View the full queue →</a></div>
    <div>${attentionRows}</div>
  </section>
  <section class="card">
    <h2>Today</h2>
    <div class="kv">
      <div><span>Emails today</span><b>${today.emailsToday}</b></div>
      <div><span>Documents today</span><b>${today.docsToday}</b></div>
      <div><span>Cases completed today</span><b>${today.completedToday}</b></div>
      <div><span>Avg automatic response (7 days)</span><b>${esc(avgAuto)}</b></div>
      <div><span>Avg review time</span><b>${esc(avgReview)}</b></div>
    </div>
  </section>
</div>

<section class="card nopad">
  <div class="card-head"><h2>What needs my attention</h2><a class="small" href="/applicants?queue=human_review">Open the human review queue</a></div>
  ${queue.length
    ? `<table><tr><th>Ref</th><th>Correspondent</th><th>Verdict</th><th>Flags</th><th>SLA</th></tr>${needsAttention}</table>`
    : `<div class="empty"><p>The queue is clear. Every case is presently accounted for.</p></div>`}
</section>

<div class="cols wide">
  <section class="card nopad">
    <div class="card-head"><h2>Correspondence awaiting reply <span class="muted small">(target ${target}h)</span></h2></div>
    ${unanswered.length
      ? `<table><tr><th>Ref</th><th>Correspondent</th><th>Awaiting reply</th></tr>${unansweredRows}</table>`
      : `<div class="empty"><p>Every applicant message has received a reply.</p></div>`}
  </section>
  <section class="card">
    <h2>Where applicants get stuck</h2>
    <p class="small muted" style="margin-top:-6px">The distribution of incoming correspondence by category. Longer bars reveal where attention gathers.</p>
    ${catRows ? `<table>${catRows}</table>` : `<p class="muted">No correspondence has been recorded yet.</p>`}
  </section>
</div>

<section class="card">
  <h2>Automation accuracy</h2>
  ${reviewed > 0
    ? `<p style="margin:2px 0 12px"><span style="font-family:var(--display);font-size:30px">${accuracyPct}%</span> <span class="muted small">of automation decisions stood uncorrected</span></p>`
    : `<p class="muted">No automated decisions have been recorded yet. The measure will appear once correspondence has been processed.</p>`}
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

// ── Cases: the pipeline split into its levels ──────────────────────────

const STAGE_TABS: Array<{ key: string; label: string }> = [
  { key: "all", label: "All" },
  { key: "application_received", label: "Received" },
  { key: "documents_received", label: "Documents received" },
  { key: "documents_checked", label: "Documents checked" },
  { key: "awaiting_review", label: "Awaiting review" },
  { key: "verification", label: "Verification" },
  { key: "pending", label: "Awaiting review" },
  { key: "completed", label: "Completed" },
];

export function casesPage(c: Ctx, stage: string): string {
  const { repo } = c;
  const realm = c.user.demo;
  // OR-8: levels count only this staff member's case types.
  const scope = repo.caseScopeFor(c.user);
  const counts = repo.stageCounts(realm, scope);
  const start = new Date(); start.setHours(0, 0, 0, 0);
  // ONE query for today's enquiry applicants — never one per applicant.
  const enquiryIds = repo.enquiryApplicantIdsToday(start.toISOString(), scope);
  const all = repo.allApplicants(realm, scope);
  const enquiriesToday = all.filter((a) => enquiryIds.has(a.id));

  // H-2: names/assignees resolve inside the acting user's organization.
  const staffById = new Map(repo.listStaff(c.user.organization_id ?? 1).map((m) => [m.id, m.display_name]));
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
      const legacyOwner = a.case_type_code ? repo.programmeByCode(a.case_type_code)?.owner_name : null;
      const stageTone = a.lifecycle === "completed" ? "green" : a.lifecycle === "awaiting_review" ? "orange" : a.lifecycle === "verification" ? "blue" : "purple";
      return `<tr class="case-row b-${stageTone}">
        <td><a class="case-ref" href="/case/${a.id}">${esc(a.ref_number)}</a></td>
        <td><div class="case-person">${avatar(a.full_name ?? a.ref_number, 34)}<span><b>${esc(a.full_name ?? "Unknown")}</b><span class="muted small">${esc(a.email_address)}</span></span></div></td>
        <td>${a.case_type_code ? `<b>${esc(a.case_type_code)}</b>` : `<span class="muted">Not recorded</span>`}<br><span class="muted small">${esc(a.intake ?? "awaiting intake")}</span></td>
        <td><span class="queue-state"><i class="state-dot" aria-hidden="true"></i>${esc(LIFECYCLE_LABELS[a.lifecycle])}</span></td>
        <td class="small nowrap muted" title="Received">${esc(fmtDate(a.created_at))}</td>
        <td class="small">${owner ? esc(owner) : legacyOwner ? `<span class="muted">case owner: ${esc(legacyOwner)}</span>` : `<span class="muted">unassigned</span>`}</td>
        <td class="nowrap">
          <a class="btn small ghost" href="/case/${a.id}">Open</a>
          <a class="btn small" href="/case/${a.id}/compose?template=missing_documents" title="A prepared request | edit if you like, then send">Request documents</a>
        </td>
      </tr>`;
    })
    .join("");

  return head(
    c,
    `Cases — ${c.institution}`,
    "cases",
    `
<h1>Cases</h1>
<div class="sub">Each applicant occupies one stage of the register. Completed matters are recorded at completion, while active matters remain where their work currently stands. Open a case to continue.</div>

<div style="margin-bottom:26px">
  ${gaugeRow([
    { n: counts.finished, label: "Finished", tone: "green", href: "/cases?stage=completed" },
    { n: counts.unfinished, label: "In progress", tone: "orange", href: "/cases?stage=unfinished" },
    { n: counts.pending, label: "Awaiting review", tone: "purple", href: "/cases?stage=pending" },
    { n: enquiriesToday.length, label: "Enquiries today", tone: "blue", href: "/cases?stage=enquiries" },
  ])}
</div>

<div class="tabs">
  ${STAGE_TABS.concat([{ key: "unfinished", label: "In progress" }, { key: "enquiries", label: "Enquiries" }])
    .map((t) => `<a href="/cases?stage=${t.key}" class="${active === t.key ? "on" : ""}">${esc(t.label)}<span class="cnt">${countFor(t.key)}</span></a>`)
    .join("")}
</div>

<section class="card nopad">
  ${rows.length
    ? `<table>
        <tr><th>Ref</th><th>Correspondent</th><th>Received for</th><th>Level</th><th>Received</th><th>Attended by</th><th></th></tr>
        ${tableRows}
      </table>`
    : `<div class="empty">${flowLine(150, 26)}<p>There are no matters at this stage.</p><p class="small muted">New applications begin at <b>Received</b> and progress as the team attends to them.</p></div>`}
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
  auto_approved: ["Auto-admitted", "b-green"],
  approved_after_review: ["Admitted after human review", "b-purple"],
  not_approved: ["Not admitted", "b-red"],
};

function resultBadge(result: string | null): string {
  const [label, cls] = RESULT_BADGES[result ?? ""] ?? [result ?? "Not recorded", "b-gray"];
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}

function decisionBadge(decision: string): string {
  const [label, cls] = DECISION_BADGES[decision] ?? [decision, "b-gray"];
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}

export function applicantsPage(
  c: Ctx,
  q: { search?: string; queue?: string; sub?: string; caseType?: string; intake?: string }
): string {
  const { repo } = c;
  const rows = repo.searchApplicants({
    q: q.search,
    caseTypeCode: q.caseType || undefined,
    intake: q.intake || undefined,
    demo: c.user.demo,
    caseTypes: repo.caseScopeFor(c.user), // OR-8
  });
  const caseTypes = repo.listCaseTypes(c.user.organization_id ?? 1);
  const intakes = repo.listIntakes(c.user.organization_id ?? 1);

  // OR-1: a completely fresh installation gets the next concrete step, not a
  // silent dead end. (Any filter/search in play means "nothing matched".)
  if (rows.length === 0 && !q.search && !q.caseType && !q.intake && !q.queue && !q.sub) {
    const hasCaseTypes = repo.listCaseTypes(c.user.organization_id ?? 1).length > 0;
    const isAdmin = c.user.role === "admin";
    const simpleSetup = isAdmin && !hasCaseTypes ? `
      <div class="card" style="max-width:560px;margin:0 auto 28px;text-align:left;padding:28px 32px">
        <div class="kicker">Start here</div>
        <h2 style="margin-bottom:8px">Choose a process template</h2>
        <p class="small muted" style="margin:0 0 14px">Ready-made starting points. Human review stays on. Change anything later.</p>
        ${processTemplatePicker(c, { blurb: false })}
        <p class="small muted" style="margin:14px 0 0;text-align:center">Or <a href="/config?tab=case-types">build your own</a> · <a href="/config?tab=rules">if/then workflow rules</a></p>
      </div>` : "";
    return head(
      c,
      "Queues",
      "applicants",
      `<div class="empty" style="padding:48px 24px;text-align:center">
        ${simpleSetup}
        <p style="font-size:17px;font-weight:700;margin-bottom:6px">${hasCaseTypes ? "No cases have entered the register yet." : "Your workspace is ready for its first process."}</p>
        <p class="small muted">${hasCaseTypes
          ? "Cases appear here once applications arrive by email or a test message is submitted."
          : "Choose a process template above, or configure a custom case type."}</p>
        ${isAdmin && hasCaseTypes ? `<p style="margin-top:14px"><a class="btn" href="/intake/test">Submit a test message</a></p>` : ""}
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

  // PPR P0-2/P1-9: a workspace without the generic module never sees the
  // academic queue tab, legacy catalogue or case-decision column.
  const visibleQueues = QUEUES;
  const queueTotals = new Map<QueueKey, number>();
  for (const qm of visibleQueues) queueTotals.set(qm.key, 0);
  for (const p of placed) queueTotals.set(p.place.queue, (queueTotals.get(p.place.queue) ?? 0) + 1);

  const activeKey: QueueKey = (visibleQueues.some((qm) => qm.key === q.queue) ? q.queue : "human_review") as QueueKey;
  const active = visibleQueues.find((qm) => qm.key === activeKey)!;
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

  const tabs = visibleQueues.map((qm) => `
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
      const rowQueue = visibleQueues.find((qm) => qm.key === place.queue) ?? visibleQueues.find((qm) => qm.key === "human_review")!;
      const tone = toneClass(rowQueue.tone);
      return `<tr class="case-row ${tone}">
      <td><a class="case-ref" href="/case/${r.id}">${esc(r.ref_number)}</a></td>
      <td><div class="case-person">${avatar(r.full_name ?? r.ref_number, 34)}<span><b>${esc(r.full_name ?? "Not recorded")}</b><span class="muted small">${esc(r.email_address)}</span></span></div></td>
      <td class="small">${esc(repo.caseTypeForCase(r.id)?.name ?? r.category ?? "Unconfigured")}</td>
      <td class="small"><span class="queue-state"><i class="state-dot" aria-hidden="true"></i>${esc(SUB_LABELS[place.sub] ?? place.sub)}</span><br><span class="muted">${why}</span></td>
      <td>${resultBadge(r.req_result)}</td>
      <td>${decisionBadge(r.outcome ?? "undecided")}</td>
      <td class="small muted nowrap">${esc(fmtDate(r.created_at))}</td>
      <td><a class="btn small" href="/case/${r.id}">Open</a></td>
    </tr>`;
    })
    .join("");

  const opt = (v: string, label: string, sel?: string) =>
    `<option value="${esc(v)}" ${sel === v ? "selected" : ""}>${esc(label)}</option>`;

  return head(
    c,
    searchMode ? "Search the queues" : `${active.label} | Queues`,
    "applicants",
    `
<h1>Queues</h1>
<div class="sub">${searchMode
    ? `${shown.length} match${shown.length === 1 ? "" : "es"} across all queues.`
    : `${esc(active.caption)} — the subcategory says why a case is here.`}</div>

<div class="queue-tabs">${tabs}</div>

<form class="inline" method="get" action="/applicants">
  <input type="hidden" name="queue" value="${esc(activeKey)}">
  <input name="q" value="${esc(q.search ?? "")}" placeholder="Search by name, email, or reference">
  <select name="case_type"><option value="">Every case type</option>${caseTypes.map((p) => opt(p.code, p.name, q.caseType)).join("")}</select>
  <select name="intake"><option value="">Every intake</option>${intakes.map((i) => opt(i, i, q.intake)).join("")}</select>
  <button class="btn ghost">Refine results</button>
  ${c.user.role === "admin" ? `<a class="btn small ghost" href="/applicants/export.csv">Export records</a>` : ""}
  ${c.user.role === "admin" && repo.listCaseTypes(c.user.organization_id ?? 1).length ? `<a class="btn small ghost" href="/intake/test">Test intake</a>` : ""}
</form>

<section class="card">
  ${searchMode ? "" : `<div class="chips">${chips}</div>`}
  ${shown.length
    ? `<table>
        <tr><th>Ref</th><th>Correspondent</th><th>Case type</th><th>Reason for placement</th><th>Requirement assessment</th><th>Outcome</th><th>Opened</th><th></th></tr>
        ${trs}
      </table>`
    : searchMode
      ? `<div class="empty"><h3>No matching records</h3><p>No record answers that search.</p></div>`
      : `<div class="empty"><h3>This queue is presently clear</h3><p>Matters enter this queue as their circumstances change.</p></div>`}
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
      const tone = st === "Green" ? "green" : st === "Orange" ? "orange" : "red";
      return `<span class="triage-dot tiny tone-${tone}" aria-hidden="true"></span>`;
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

/**
 * PPR P1-1: terminology — the five surface words (case / contact / category /
 * stage / outcome) are profile data. Defaults are the current generic
 * wording, so nobody sees a change until an admin renames something.
 * Internal keys and DB columns never move.
 */
export function terminologyFor(c: Ctx, a?: ApplicantRow): { case: string; contact: string; category: string; stage: string; outcome: string } {
  const caseType = a ? c.repo.caseTypeForCase(a.id) : undefined;
  const t = (caseType?.terminology ?? {}) as Record<string, string>;
  return {
    case: t.case || "Case",
    contact: t.contact || "Correspondent",
    category: t.category || "Category",
    stage: t.stage || "Stage",
    outcome: t.outcome || "Outcome",
  };
}

/** PPR P1-2: a profile's stage labels override the shipped ones (ids stable). */
export function stageLabelFor(c: Ctx, a: ApplicantRow): string {
  const caseType = c.repo.caseTypeForCase(a.id);
  const custom = caseType?.stages?.find((s) => s.id === a.lifecycle);
  return custom?.label ?? LIFECYCLE_LABELS[a.lifecycle];
}

function evaluationPanel(c: Ctx, a: ApplicantRow): string {
  const requirements = c.repo.effectiveRequirements(a);
  const active = new Set(c.repo.listDocuments(a.id, { activeOnly: true }).map((document) => document.document_type));
  const evaluation = c.repo.latestEvaluation(a.id);
  const rows = requirements.map((requirement) => `<div class="field"><span class="lbl">${esc(requirement.label ?? docLabel(requirement.document_type))}</span><span class="val">${active.has(requirement.document_type) ? "On file" : requirement.required && requirement.blocking !== false ? "Outstanding" : "Optional"}</span></div>`).join("");
  const allowed = c.repo.hasPermission(c.user.id, "record_outcome");
  const outcomeForm = allowed ? `<form method="post" action="/case/${a.id}/outcome"><input type="hidden" name="_csrf" value="${esc(c.csrf)}"><label for="case-outcome">Record outcome</label><select id="case-outcome" name="outcome"><option value="approved_after_review">Approved after review</option><option value="not_approved">Not approved</option><option value="undecided">Return to review</option></select><label for="outcome-reason">Reason</label><textarea id="outcome-reason" name="reason" required maxlength="2000"></textarea><button class="btn small">Record the considered outcome</button></form>` : "";
  return `<section class="sec"><div class="sec-head"><h2>Required information &amp; outcome</h2></div><div class="meta-grid">${rows || '<p class="small muted">No document checklist has been established. Configure this case type before enabling automation.</p>'}</div><p>Evidence: ${resultBadge(evaluation?.result ?? a.req_result)} · Outcome: ${decisionBadge(a.outcome ?? "undecided")}</p><p class="small muted">${esc(evaluation?.reason ?? "This matter awaits human review. No automated outcome has been recorded.")}</p>${a.decision_reason ? '<p class="small">Last decision: ' + esc(a.decision_reason) + ' | ' + esc(a.decision_by ?? "unknown") + '</p>' : ""}${outcomeForm}</section>`;
}


export function casePage(c: Ctx, a: ApplicantRow, flash?: string, preview?: { subject: string; body: string } | null): string {
  const { repo } = c;
  // PPR P1-1/P1-2: this profile's vocabulary and stage labels (ids stable).
  const terms = terminologyFor(c, a);
  const stageLabels = Object.fromEntries((repo.caseTypeForCase(a.id)?.stages ?? []).map((s) => [s.id, s.label]));
  const stageRequires = (repo.caseTypeForCase(a.id)?.stages ?? []).find((s) => s.id === a.lifecycle)?.requires ?? [];
  const requirements = repo.effectiveRequirements(a);
  const activeDocs = repo.listDocuments(a.id, { activeOnly: true });
  const allDocs = repo.listDocuments(a.id, { activeOnly: false });
  const flags = repo.activeFlags(a.id);
  const emails = repo.emailsForApplicant(a.id);
  const notes = repo.notesForApplicant(a.id);
  const history = repo.statusHistory(a.id);
  const audit = repo.auditForApplicant(a.id);
  const decisions = repo.decisionLogs(a.id);
  // H-2: the assignee picker offers the acting user's organization only.
  const staff = repo.listStaff(c.user.organization_id ?? 1);
  // PPR P1-9: a non-generic case never sees academic reply templates or
  // pack vocabulary — its page speaks only generic wording.
  const templates = repo.listTemplates(c.user.organization_id ?? 1)
;
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
  const staffById = new Map(staff.map((m) => [m.id, m.display_name]));
  const handledBy = a.assigned_to ? staffById.get(a.assigned_to) : null;
  const isMgr = c.user.role === "admin";

  const staffOptions = staff.map((s) => `<option value="${s.id}" ${a.assigned_to === s.id ? "selected" : ""}>${esc(s.display_name)}</option>`).join("");
  const tplOptions = templates.map((t) => `<option value="${esc(t.key)}">${esc(t.name)}</option>`).join("");
  const nextStage = LIFECYCLE_ORDER[LIFECYCLE_ORDER.indexOf(a.lifecycle) + 1];
  const lastDecision = decisions.at(-1);

  // ── Evidence requirements: needed vs supplied, at a glance ──────────────
  const reqByType = new Map(requirements.map((r) => [r.document_type, r]));
  const csrf = `<input type="hidden" name="_csrf" value="${esc(c.csrf)}">`;

  // ── Axes: which variant of the checklist this case is measured against ───
  const orgAxes = c.repo.listOrganizationDocumentAxes(a.organization_id ?? 1);
  const axisSel = c.repo.axisSelections(a);
  const axisCard = orgAxes.length
    ? `<section class="sec" id="case-axes">
      <div class="sec-head"><h2>What applies to this case</h2><span class="small muted">narrows the checklist — never the outcome</span></div>
      <form method="post" action="/case/${a.id}/axes" class="formrow">
        ${csrf}
        ${orgAxes.map((ax) => `<div><label>${esc(ax.label)}</label><select name="axis_${esc(ax.key)}" title="Only the slots pinned to this value — plus every unconditional slot — appear on the checklist">
          <option value="">— not set —</option>
          ${ax.values.map((v) => `<option value="${esc(v)}"${axisSel[ax.key] === v ? " selected" : ""}>${esc(v)}</option>`).join("")}
        </select></div>`).join("")}
        <div style="flex:0"><label>&nbsp;</label><button class="btn">Apply to checklist</button></div>
      </form>
      <p class="small muted" style="margin:8px 0 0">Setting a value re-freezes the checklist this case is measured against. The recorded outcome is untouched: use <b>Re-evaluate</b> to re-check the evidence against it. Clearing a value brings every slot back.</p>
    </section>`
    : "";

  // ── Required documents: every received document, expandable ──────────────
  const docRowsHtml = allDocs
    .map((d, ix) => {
      const req = reqByType.get(d.document_type);
      const reqBadge = req
        ? req.required
          ? `<span class="badge b-purple">Required</span>`
          : `<span class="badge b-gray">Optional</span>`
        : `<span class="badge b-gray">Not recorded</span>`;
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
          <div class="kv2" style="margin-bottom:14px">${fields || `<div><div class="k">Fields recovered</div><div class="v muted">no fields extracted</div></div>`}</div>
          <div class="k" style="font-size:10.5px;text-transform:uppercase;letter-spacing:.11em;color:var(--muted);font-weight:800;margin-bottom:6px">Source extraction</div>
          ${raw ? `<pre class="raw">${esc(raw.slice(0, 1400))}</pre>` : `<p class="small muted" style="margin:0">No readable text could be recovered from this document.</p>`}
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
        <span class="badge ${e.direction === "in" ? "b-blue" : "b-purple"}">${e.direction === "in" ? `← From ${esc(terms.contact.toLowerCase())}` : `→ To ${esc(terms.contact.toLowerCase())}`}</span>
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
    .map((h) => `<tr><td class="small nowrap">${esc(fmtDate(h.at))}</td><td>${esc(LIFECYCLE_LABELS[(h.from_status as never)] ?? h.from_status ?? "Not recorded")} → <b>${esc(LIFECYCLE_LABELS[(h.to_status as never)] ?? h.to_status)}</b></td><td class="mono small">${esc(h.actor)}</td><td class="small">${esc(h.reason)}</td></tr>`)
    .join("");
  const auditRows = audit
    .map((ev) => `<div class="ev"><span class="t"><span data-rel="${esc(ev.at)}">${esc(fmtDate(ev.at))}</span> · ${esc(ev.actor)}</span><br><b>${esc(ev.event)}</b> — ${esc(ev.detail)}</div>`)
    .join("");
  const activityHtml = audit
    .slice()
    .reverse()
    .map((ev) => `<div style="padding:10px 0;border-bottom:1px dashed var(--line);font-size:13px">
      <span class="small muted">${esc(fmtDate(ev.at))} · ${esc(ev.actor)}</span><br>
      <b>${esc(capFirst(ev.event.replace(/_/g, " ")))}</b>${ev.detail ? ` <span class="muted"> | ${esc(ev.detail)}</span>` : ""}
    </div>`)
    .join("") || `<p class="muted">No activity has been recorded yet.</p>`;

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
        ${repo.caseTypeForCase(a.id) ? `<span>${esc(repo.caseTypeForCase(a.id)!.name)}</span><span class="sep">·</span>` : ""}
        <span>${esc(a.intake ?? "intake to be confirmed")}</span><span class="sep">·</span>
        <span>opened ${esc(fmtDate(a.created_at))}</span>
        ${handledBy ? `<span class="sep">·</span><span>handled by <b>${esc(handledBy)}</b></span>` : ""}
      </div>
      ${(() => {
        // Phase D2: the routing safety valve. Re-typing is a person's call and
        // must be visible where the type is shown.
        const types = repo.listCaseTypes(a.organization_id ?? 1);
        if (types.length === 0) return "";
        const current = repo.caseTypeForCase(a.id);
        return `<form method="post" action="/case/${a.id}/case-type" class="inline" id="retype-form" style="margin:8px 0 0;flex-wrap:wrap">
          <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
          <label class="small muted" for="retype-${a.id}">${esc(terms.case)} type</label>
          <select id="retype-${a.id}" name="case_type_id">${types.map((t) => `<option value="${t.id}" ${current?.id === t.id ? "selected" : ""}>${esc(t.name)} (${esc(t.code)})</option>`).join("")}</select>
          <button class="btn small ghost">Re-type this ${esc(terms.case.toLowerCase())}</button>
          <span class="small muted">moves it to that checklist and its rules — sends nothing, decides nothing</span>
        </form>`;
      })()}
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
      <select name="staff_id" style="max-width:160px"><option value="">Assign to</option>${staffOptions}</select>
      <button class="btn small">Assign</button>
    </form>
  </div>
</div>

<!-- Lifecycle progress -->
<div class="stepper-band">${lifecycleStepper(a.lifecycle, stageLabels)}</div>
${stageRequires.length ? `<div class="changed"><b>Required for this stage:</b> ${stageRequires.map((r) => esc(r)).join(" · ")}</div>` : ""}

${changed ? `<div class="changed"><b>What changed since the last triage:</b> ${changed}</div>` : ""}

<div class="case-grid">
  <div class="case-main">

    <!-- Applicant details -->
    <section class="sec">
      <div class="sec-head"><h2>${esc(terms.case)} overview</h2></div>
      <div class="meta-grid">
        <div class="field"><span class="lbl">Name</span><span class="val">${esc(a.full_name ?? "Not recorded")}</span></div>
        <div class="field"><span class="lbl">Email</span><span class="val"><a href="mailto:${esc(a.email_address)}">${esc(a.email_address)}</a></span></div>
        <div class="field"><span class="lbl">Phone</span><span class="val">${esc(a.phone ?? "Not recorded")}</span></div>
        <div class="field"><span class="lbl">${esc(terms.contact)}</span><span class="val">${esc(a.full_name ?? a.email_address)}${a.phone ? ` · ${esc(a.phone)}` : ""}</span></div>
        <div class="field"><span class="lbl">${esc(terms.category)}</span><span class="val">${esc(repo.caseTypeForCase(a.id)?.name ?? a.category ?? "Unconfigured")}</span></div>
        <div class="field"><span class="lbl">Reference number</span><span class="val mono">${esc(a.ref_number)}</span></div>
        ${a.queue ? `<div class="field"><span class="lbl">Queue</span><span class="val">${esc((repo.caseTypeForCase(a.id)?.queues ?? []).find((q) => q.id === a.queue)?.label ?? a.queue)}</span></div>` : ""}
        <div class="field"><span class="lbl">${esc(terms.stage)}</span><span class="val">${lifecycleBadge(a.lifecycle, stageLabels)} <span class="muted small" style="font-weight:500">moved through ${history.length} change${history.length === 1 ? "" : "s"}</span></span></div>
      </div>
      <div class="op-strip">
        <div class="op"><span class="lbl">Threads</span><span class="val">${threads.length} linked conversation${threads.length === 1 ? "" : "s"}</span></div>
        <div class="op"><span class="lbl">Reminder sequence</span><span class="val">${a.followup_next_at ? `rung ${a.followup_rung} | next reminder ${esc(fmtDate(a.followup_next_at))}` : "not armed"}</span></div>
        <div class="op"><span class="lbl">SLA</span><span class="val">${a.sla_due_at ? `${esc(slaText(a.sla_due_at, a.sla_handled_at))} (due ${esc(fmtDate(a.sla_due_at))})` : "Not recorded"}</span></div>
        <div class="op"><span class="lbl">Assigned to</span><span class="val">${handledBy ? esc(handledBy) : "unassigned"}</span></div>
      </div>
    </section>

    ${evaluationPanel(c, a)}

    ${axisCard}

    <!-- Required documents -->
    <section class="sec">
      <div class="sec-head"><h2>Required documents</h2><span class="small muted">${allDocs.length} received · ${activeDocs.length} active</span></div>
      <table class="doctable">
        <thead><tr><th>Document</th><th>Required</th><th>Status</th><th>Readability</th><th>Received</th></tr></thead>
        <tbody>${docRowsHtml || `<tr><td colspan="5" class="muted">No documents received yet.</td></tr>`}</tbody>
      </table>
      <p class="small muted" style="margin:14px 0 0">Select a row to see its extracted fields, provenance and raw text.</p>
    </section>

    <!-- Communication history -->
    <section class="sec">
      <div class="sec-head"><h2>Email history</h2><span class="small muted">everything exchanged with ${esc(a.full_name ?? `this ${terms.contact.toLowerCase()}`)}</span></div>
      ${emailItems || `<p class="muted">No emails recorded.</p>`}
    </section>

    <!-- Activity & audit trail -->
    <section class="sec">
      <div class="sec-head"><h2>Activity and audit record</h2></div>
      <div class="mini-tabs" data-tabs>
        <button class="on" data-tab="act" type="button">Activity</button>
        <button data-tab="stat" type="button">History of status</button>
        <button data-tab="aud" type="button">Audit record</button>
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
      <p class="small muted" style="margin:12px 0 0">Every action opens a <b>ready, prepared reply</b> | nothing is sent until you press Send.</p>
    </div>

    <!-- Response composer -->
    <div class="ops-card">
      <h2>Responses</h2>
      ${c.repo.listTemplates(a.organization_id ?? 1).length === 0 ? `<p class="flash err" style="position:static;margin:0 0 10px"><b>This organization has no reply templates</b> — no reply, automated or manual, can be rendered until one exists. <a href="/templates">Add the starter set</a>.</p>` : ""}
      <p class="ops-sub">Pick a reply template — it is rendered with this ${esc(terms.contact.toLowerCase())}'s details. Preview first; nothing is sent without your click.</p>
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
      <p class="small muted" style="margin:6px 0 0"><a href="/case/${a.id}/compose">Open the composer for this ${esc(terms.contact.toLowerCase())}</a> — same tab; after sending you land back on this case file.</p>
      <p class="small muted" style="margin:6px 0 0">Automatic response controls per category live in <a href="/settings#automation">Settings → Automation</a>. Current modes: ${esc(autoSummary || "defaults")}</p>
    </div>

    ${isMgr ? `<div class="ops-card" id="packs">
      <h2>Document sets</h2>
      <p class="small" style="margin:0 0 8px"><a href="/config?tab=pack">Manage the document library (sets &amp; files) →</a></p>
      ${repo.listAttachmentSets(c.user.organization_id ?? 1).length
        ? `<div class="ops-secondary">${repo.listAttachmentSets(c.user.organization_id ?? 1).map((s) => `<form method="post" action="/case/${a.id}/send-pack" onsubmit="return confirm('Send the “${esc(s.name)}” set to this requester?')" style="margin:0">
          <input type="hidden" name="_csrf" value="${esc(c.csrf)}"><input type="hidden" name="kind" value="${esc(s.name)}">
          <button class="btn">Send “${esc(s.name)}” set</button>
        </form>`).join("")}</div>`
        : `<p class="small muted">No document sets yet — define them in the document library.</p>`}
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
      <span class="note-banner">Internal · not visible to ${esc(terms.contact.toLowerCase())}</span>
      ${noteCards || `<p class="muted small">No notes yet.</p>`}
      <form method="post" action="/case/${a.id}/note">
        <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
        <label>Add note</label>
        <textarea name="body" style="min-height:60px" placeholder="e.g. Applicant called. Awaiting reply for original certificate."></textarea>
        <p style="margin-top:8px"><button class="btn small">Add note</button></p>
      </form>
    </div>

    ${isMgr ? `<div class="ops-card">
      <h2>Reclassify</h2>
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
  // Activity / History of status / Audit record tabs.
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

// ── Compose: a ready, prepared reply | one obvious path to Send ───────────

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
      ${tpl.attach_pack && tpl.attach_pack !== "none" ? `<span class="badge b-purple">${esc(tpl.attach_pack)} set PDFs will be attached</span>` : ""}
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
      const prog = a.case_type_code ? repo.programmeByCode(a.case_type_code) : undefined;
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
    <div style="flex:1"><label>Search contacts</label>
      <input type="text" name="q" value="${esc(opts.q ?? "")}" placeholder="Name, email or reference number…" autofocus>
    </div>
    <div style="flex:0"><button class="btn">Search</button></div>
  </form>
  ${opts.q !== undefined
    ? (rows ? `<div style="margin-top:10px">${rows}</div>` : `<p class="small muted" style="margin:14px 0 0">No cases you can see match “${esc(opts.q ?? "")}”. Scoped staff only see cases of the case types they handle.</p>`)
    : `<p class="small muted" style="margin:14px 0 0">${rows ? "Recent files:" : "No cases yet — replies appear here once applications arrive."}</p>${rows ? `<div style="margin-top:4px">${rows}</div>` : ""}`}
</div>`);
  }

  // ── Shape 2: the draft ────────────────────────────────────────────────────
  // Same shape as the case-file composer: one form, ONE submit (Send now), so
  // Enter sends. Template choice is a link that re-renders the draft — it
  // never competes with the send button and can never wipe typed text.
  const a = opts.applicant;
  const templates = repo.listTemplates(c.user.organization_id ?? 1);
  const tpl = opts.templateKey ? templates.find((t) => t.key === opts.templateKey) : undefined;
  const prog = a.case_type_code ? repo.programmeByCode(a.case_type_code) : undefined;
  const chips = [
    `<a href="/compose?case=${a.id}" ${!opts.templateKey ? `class="badge b-purple"` : `class="small"`}>Blank message</a>`,
    ...templates.map((t) =>
      `<a href="/compose?case=${a.id}&template=${esc(t.key)}" ${opts.templateKey === t.key ? `class="badge b-purple"` : `class="small"`}>${esc(t.name)}</a>`),
  ].join(" · ");
  return head(c, `Compose — ${a.ref_number}`, "compose", `
<div class="hero">
  <div class="row">
    ${avatar(a.full_name ?? a.ref_number, 46)}
    <div style="min-width:0">
      <div class="kicker">Compose reply · new window${tpl ? ` · ${esc(tpl.name)}` : ""}</div>
      <h1 style="margin:0">${esc(a.full_name ?? a.ref_number)}</h1>
      <div class="sub" style="margin:2px 0 0">To <b>${esc(a.email_address)}</b>${prog ? ` · ${esc(prog.name)}` : ""} · ${lifecycleBadge(a.lifecycle)} · <a href="/case/${a.id}">← back to the case file</a></div>
    </div>
  </div>
</div>

<div class="card" style="max-width:880px">
  ${opts.error ? `<div class="flash err" style="position:static;margin-bottom:16px">${esc(opts.error)}</div>` : ""}
  ${opts.flash ? `<div class="flash ok" style="position:static;margin-bottom:16px">${esc(opts.flash)}</div>` : ""}
  <p class="small muted" style="margin-top:0">Everything below is editable | nothing is sent until you press Send. Pick a template to prepare the draft:</p>
  <p style="margin:0 0 14px;line-height:2.1">${chips}</p>
  <form method="post" action="/compose">
    <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
    <input type="hidden" name="case" value="${a.id}">
    <input type="hidden" name="template" value="${esc(tpl?.key ?? "")}">
    <label>Subject</label>
    <input type="text" name="subject" value="${esc(opts.subject ?? "")}">
    <label>Message</label>
    <textarea name="body" style="min-height:340px;font-size:14px;line-height:1.7">${esc(opts.body ?? "")}</textarea>
    <div style="display:flex;gap:10px;margin-top:18px;align-items:center;flex-wrap:wrap">
      <button class="btn">Send now</button>
      <a class="btn ghost" href="/case/${a.id}">Cancel — don’t send</a>
      ${tpl ? (tpl.include_banner === 0 ? `<span class="muted small">sends without the branded banner</span>` : `<span class="muted small">branded banner is attached automatically</span>`) : `<span class="muted small">branded banner is attached automatically</span>`}
      ${tpl && tpl.attach_pack && tpl.attach_pack !== "none" ? `<span class="badge b-purple">${esc(tpl.attach_pack)} set PDFs will be attached</span>` : ""}
    </div>
  </form>
</div>`);
}


/** Gmail-style mail window: folders sidebar + conversation list. */
export function mailPage(
  c: Ctx,
  opts: {
    threads: Array<{ tkey: string; thread_n: number; unread_n: number; star_n: number; imp_n: number; subject: string; body: string; at: string; direction: string; applicant_id: number | null; a_name: string | null; a_email: string | null; ref_number: string | null; lifecycle: string | null }>;
    q?: string;
    folder: string;
    unreadOnly: boolean;
    counts: Record<string, number>;
    backUrl: string;
    page?: number;
    hasMore?: boolean;
  }
): string {
  const folderDefs: Array<{ key: string; href: string; label: string; ic: string; count: number; unread?: boolean }> = [
    { key: "inbox", href: "/mail?f=inbox", label: "Inbox", ic: "inbox", count: opts.counts.unread ?? 0, unread: true },
    { key: "unread", href: "/mail?f=unread", label: "Unread", ic: "bell", count: opts.counts.unread ?? 0, unread: true },
    { key: "starred", href: "/mail?f=starred", label: "Starred", ic: "star-o", count: opts.counts.starred ?? 0 },
    { key: "important", href: "/mail?f=important", label: "Important", ic: "flag", count: opts.counts.important ?? 0 },
    { key: "sent", href: "/mail?f=sent", label: "Sent", ic: "send", count: opts.counts.sent ?? 0 },
    { key: "all", href: "/mail?f=all", label: "All Mail", ic: "archive", count: opts.counts.all ?? 0 },
    { key: "spam", href: "/mail?f=spam", label: "Spam", ic: "alert", count: opts.counts.spam ?? 0 },
    { key: "bin", href: "/mail?f=bin", label: "Bin", ic: "trash", count: opts.counts.bin ?? 0 },
  ];
  const activeKey = opts.unreadOnly ? "unread" : opts.folder;
  const sidebar = folderDefs.map((f) => {
    const href = opts.q ? `${f.href}&q=${encodeURIComponent(opts.q)}` : f.href;
    const active = activeKey === f.key;
    const showCount = f.key === "inbox" || f.key === "unread" ? (f.count > 0) : (f.count > 0 && !["inbox", "unread"].includes(f.key));
    return `<a class="mail-fold${active ? " active" : ""}" href="${href}">${icon(f.ic as "inbox", 15)}${f.label}${showCount ? ` <b class="mail-count">${f.count}</b>` : ""}</a>`;
  }).join("");

  const page = Math.max(1, opts.page ?? 1);
  const pagerHref = (pg: number) => `/mail?f=${activeKey}${opts.q ? `&q=${encodeURIComponent(opts.q)}` : ""}&page=${pg}`;
  const rows = opts.threads.map((t) => {
    const unread = t.unread_n > 0;
    const snippet = (t.body || "").replace(/\s+/g, " ").trim();
    // Parked conversations (round 9: no intake hotword) have no applicant —
    // show the sender and say plainly that no case exists.
    const parked = t.applicant_id == null;
    const name = t.a_name ?? (parked ? (t.a_email ?? "Unknown sender") : (t.ref_number ?? "(no case)"));
    const threadUrl = `/mail/thread/${encodeURIComponent(t.tkey)}`;
    return `<tr style="cursor:pointer" onclick="location.href='${threadUrl}'">
      <td style="width:26px;padding-right:0">${unread ? `<span title="Unread" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--plum)"></span>` : ""}</td>
      <td style="width:34px;padding-right:0">
        <form class="starform" method="post" action="${threadUrl}/action" onclick="event.stopPropagation()" style="margin:0">
          <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
          <input type="hidden" name="action" value="${t.star_n ? "unstar" : "star"}">
          <input type="hidden" name="back" value="${esc(opts.backUrl)}">
          <button class="starbtn${t.star_n ? " on" : ""}" title="${t.star_n ? "Remove star" : "Star"}">${icon(t.star_n ? "star" : "star-o", 15)}</button>
        </form>
      </td>
      <td style="width:34px;padding-right:0">${avatar(name, 28)}</td>
      <td style="${unread ? "font-weight:700" : ""};white-space:nowrap">${esc(name)}</td>
      <td style="min-width:0">
        <span style="${unread ? "font-weight:700" : ""}">${esc(t.subject || "(no subject)")}</span>
        <span class="muted"> — ${esc(snippet.slice(0, 140))}${snippet.length > 140 ? "…" : ""}</span>
        ${t.imp_n ? `<span title="Important" style="color:var(--plum)">${icon("flag", 12)}</span>` : ""}
        ${parked ? `<span class="badge b-gray" title="No intake hotword matched — kept in Mail, never processed as an application">not linked to a case</span>` : ""}
      </td>
      <td class="muted small" style="white-space:nowrap">${t.thread_n > 1 ? `(${t.thread_n})` : ""}</td>
      <td class="muted small" style="white-space:nowrap"><span data-rel="${esc(t.at)}">${esc(t.at.slice(0, 16).replace("T", " "))}</span></td>
    </tr>`;
  }).join("");

  const folderLabel = folderDefs.find((f) => f.key === activeKey)?.label ?? "Inbox";
  const emptyText: Record<string, string> = {
    inbox: "Inbox zero — no new conversations.",
    unread: "Everything is read — inbox zero.",
    starred: "No starred conversations.",
    important: "Nothing marked important.",
    sent: "Nothing sent yet.",
    all: "No mail yet — conversations appear here as they happen.",
    spam: "Spam is empty — that's how it should be.",
    bin: "Bin is empty.",
  };

  return head(c, "Mail", "mail", `
<div class="hero">
  <div class="row">
    <div style="min-width:0;flex:1">
      <div class="kicker">New window · mail · ${esc(folderLabel.toLowerCase())}</div>
      <h1 style="margin:0">Mail</h1>
      <div class="sub" style="margin:2px 0 0">Every conversation with every contact — received and sent, newest first.</div>
    </div>
  </div>
</div>
<div class="mail-wrap">
  <aside class="mail-side">
    <a class="btn" href="/compose" style="display:block;text-align:center;margin-bottom:14px">Compose</a>
    <nav>${sidebar}</nav>
  </aside>
  <div style="flex:1;min-width:0">
    <div class="card" style="padding:14px 20px;margin-bottom:16px">
      <form method="get" action="/mail" class="formrow" style="align-items:end;margin:0">
        ${opts.unreadOnly || opts.folder !== "inbox" ? `<input type="hidden" name="f" value="${activeKey}">` : ""}
        <div style="flex:1"><input type="text" name="q" value="${esc(opts.q ?? "")}" placeholder="Search mail — subject, message, name, email or reference…"></div>
        <div style="flex:0"><button class="btn">Search</button>${opts.q ? ` <a class="btn ghost" href="/mail?f=${activeKey}">Clear</a>` : ""}</div>
      </form>
    </div>
    <div class="card nopad">
      ${rows ? `<table>
        <tbody>${rows}</tbody>
      </table>
      <div class="row" style="justify-content:center;gap:10px;padding:10px 16px;border-top:1px solid var(--line)">
        ${page > 1 ? `<a class="btn small ghost" href="${pagerHref(page - 1)}">← Newer</a>` : ""}
        <span class="small muted">Page ${page} · ${opts.threads.length} conversation(s)${opts.hasMore ? "" : " · end of list"}</span>
        ${opts.hasMore ? `<a class="btn small ghost" href="${pagerHref(page + 1)}">Older →</a>` : ""}
      </div>` : `<p class="small muted" style="padding:22px 24px;margin:0">${opts.q ? `No mail matches “${esc(opts.q)}” in ${esc(folderLabel.toLowerCase())}.` : emptyText[activeKey] ?? emptyText.inbox}</p>`}
    </div>
  </div>
</div>`);
}

/** One conversation, both directions, oldest first — with the gmail action bar. */
export function mailThreadPage(
  c: Ctx,
  opts: { applicant: ApplicantRow | null; emails: EmailRecord[]; tkey: string; labels: { starred: boolean; important: boolean; spam: boolean; bin: boolean }; backUrl: string }
): string {
  const a = opts.applicant;
  const prog = a && a.case_type_code ? c.repo.programmeByCode(a.case_type_code) : undefined;
  const threadPath = `/mail/thread/${encodeURIComponent(opts.tkey)}`;
  const actionForm = (action: string, label: string, ic: Parameters<typeof icon>[0], back = threadPath) => `
    <form method="post" action="${threadPath}/action" style="margin:0">
      <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
      <input type="hidden" name="action" value="${action}">
      <input type="hidden" name="back" value="${esc(back)}">
      <button class="btn small ghost">${icon(ic, 13)} ${label}</button>
    </form>`;
  const L = opts.labels;
  const binOrSpam = L.bin || L.spam;
  const actionBar = `<div class="card" style="padding:12px 16px;margin-bottom:16px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
    <a class="btn small ghost" href="${esc(opts.backUrl)}">← Back</a>
    ${actionForm(L.starred ? "unstar" : "star", L.starred ? "Unstar" : "Star", L.starred ? "star" : "star-o")}
    ${actionForm(L.important ? "unimportant" : "important", L.important ? "Remove important" : "Mark important", "flag")}
    ${actionForm("unread", "Mark unread", "inbox", "/mail")}
    ${L.spam ? actionForm("notspam", "Not spam", "alert") : actionForm("spam", "Report spam", "alert")}
    ${L.bin ? actionForm("restore", "Move back to Inbox", "archive", "/mail?f=bin") : actionForm("bin", "Move to Bin", "trash")}
    ${binOrSpam ? `<span class="small muted" style="margin-left:auto">${L.bin ? "This conversation is in the Bin." : "This conversation is in Spam."}</span>` : ""}
  </div>`;
  const msgs = opts.emails.map((e) => {
    const out = e.direction === "out";
    let attached: string[] = [];
    try { attached = e.attachments ? (JSON.parse(e.attachments) as string[]) : []; } catch { attached = []; }
    return `<div class="card" style="margin-bottom:14px;border-left:3px solid ${out ? "var(--plum)" : "var(--line)"}">
      <div class="row" style="justify-content:space-between;gap:12px;flex-wrap:wrap">
        <div class="small muted">
          <span class="badge ${out ? "b-purple" : ""}">${out ? (e.auto ? "Sent · automatic" : "Sent") : "Received"}</span>
          ${out ? `to <b>${esc(e.to_addr || a?.email_address || "Not recorded")}</b>` : `from <b>${esc(e.from_addr || a?.email_address || "Not recorded")}</b>`}
        </div>
        <div class="small muted">${esc(e.at.slice(0, 16).replace("T", " "))} UTC</div>
      </div>
      <h3 style="margin:10px 0 6px">${esc(e.subject || "(no subject)")}</h3>
      <div style="white-space:pre-wrap;font-size:14px;line-height:1.7">${esc(e.body)}</div>
      ${attached.length ? `<p style="margin:12px 0 0">${attached.map((f) => `<span class="badge" style="margin-right:6px">${icon("clip", 11)} ${esc(f)}</span>`).join("")}</p>` : ""}
    </div>`;
  }).join("");
  const hero = a
    ? `<div class="hero">
  <div class="row">
    ${avatar(a.full_name ?? a.ref_number, 46)}
    <div style="min-width:0;flex:1">
      <div class="kicker">Mail · conversation</div>
      <h1 style="margin:0">${esc(a.full_name ?? a.ref_number)}</h1>
      <div class="sub" style="margin:2px 0 0">${esc(a.email_address)}${prog ? ` · ${esc(prog.name)}` : ""} · ${lifecycleBadge(a.lifecycle)} · <a href="/case/${a.id}">open the case file</a></div>
    </div>
    <div><a class="btn" href="/compose?case=${a.id}">Reply to this case</a></div>
  </div>
</div>`
    : `<div class="hero">
  <div class="row">
    <div style="min-width:0;flex:1">
      <div class="kicker">Mail · conversation</div>
      <h1 style="margin:0">${esc(opts.emails[0]?.from_addr ?? "(unknown sender)")}</h1>
      <div class="sub" style="margin:2px 0 0">No case linked — no intake hotword matched, so this mail was kept in Mail but never processed as an application. You can still star, flag or bin it like any other conversation.</div>
    </div>
  </div>
</div>`;
  return head(c, `Mail — ${a ? a.ref_number : "no case"}`, "mail", `
${hero}
${actionBar}
${msgs}`);
}


// ── Settings (app behaviour) & Configuration (case intake setup) ────────────

export function settingsPage(c: Ctx, flash?: string, gmailRedirectUri?: string, webhookOrigin?: string, webhookIngestKey?: string | null): string {
  const { repo } = c;
  const settings = repo.allSettings();
  // Effective, not as-stored: with no row for the key the pipeline holds every
  // reply, so the select must show "draft" rather than trusting its own default.
  const globalAutomation = repo.globalAutomationMode();
  const organizationId = c.user.organization_id ?? 1;
  const organization = repo.getOrganization(organizationId);
  const settingInput = (key: string, label: string, fallback = "") =>
    `<div><label>${esc(label)}</label><input type="text" name="${esc(key)}" value="${esc(settings[key] ?? fallback)}"></div>`;
  const organizationInput = (key: string, label: string, value: string) =>
    `<div><label>${esc(label)}</label><input type="text" name="${esc(key)}" value="${esc(value)}"></div>`;

  return head(
    c,
    "Settings",
    "settings",
    `
<h1>Settings</h1>
<div class="sub">How the console behaves — automation, response targets, retention and workspace identity.</div>
${flash ? `<div class="flash ok" style="position:static;margin-bottom:16px">${esc(flash)}</div>` : ""}

${connectionsSection(c, gmailRedirectUri)}

${webhookIngestSection(c, webhookOrigin ?? "", webhookIngestKey ?? null)}

<div class="card" id="intake">
  <h2>Which emails become cases</h2>
  <p class="small muted" style="margin-top:-6px">The inbox gets more than applications — service messages, promos, stray mail, job ads. The engine decides in plain terms:</p>
  <ul class="small muted" style="margin:4px 0 8px 18px">
    <li>It is a reply to a contact you already know (quoted reference number, or a sender on file) → <b>always a case</b>.</li>
    <li>It contains one of the <b>hotwords below</b> (your words — decisive) → a case.</li>
    <li>A configured case type, intake rule or organization hotword matches → a case.</li>
    <li>A known contact continues an existing case → same case and history.</li>
    <li>Unmatched mail is parked, not deleted. A blank organization has no implicit intake rules.</li>
  </ul>
  <p class="small muted" style="margin-top:0">Everything else is <b>parked</b>: kept in <a href="/mail?f=all">All Mail</a> so nothing is ever lost, but no case number, queue placement or automatic reply is created for it. Add a word below whenever mail you wanted as a case gets parked.</p>
  <form method="post" action="/settings/general">
    <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
    <div style="max-width:560px"><label>Intake hotwords (comma separated | your words, always decisive)</label><input type="text" name="intake_hotwords" value="${esc(settings["intake_hotwords"] ?? "")}" style="width:100%"></div>
    <p><button class="btn">Save hotwords</button></p>
  </form>
  ${(() => {
    const parked = c.repo.recentAudit(100).filter((a) => a.event === "email_parked_non_intake").slice(0, 5);
    if (parked.length === 0) return "";
    return `<details style="margin-top:10px">
      <summary class="small"><b>Recently parked</b> <span class="muted"> | the engine score for each, so you can add a hotword when it misjudges</span></summary>
      <ul class="small muted" style="margin:8px 0 4px 18px">
        ${parked.map((a) => `<li>${esc(a.detail)}<br><span style="opacity:.7">${esc(a.at)}</span></li>`).join("")}
      </ul>
    </details>`;
  })()}
</div>

${categoriesCard(c)}

<div class="card" id="automation">
  <h2>Automation mode (draft first)</h2>
  <p class="small muted" style="margin-top:-6px">Two rules always apply. First, automated sending is reserved for <b>fully qualified</b> applicants — a Green verdict with no flags; everyone else gets the reply as a <b>suggested draft</b> for staff to review, edit or discard, because borderline files can still be admitted on special acceptance. Second, the rollout dial: the global mode starts on <b>draft</b> (every automated reply — including reminder rungs — waits for a human, whatever any rule says), and releasing it is not enough on its own: each category must then be <b>added to the allowlist</b> below. The allowlist starts empty, so nothing is ever sent automatically by accident.</p>
  <form method="post" action="/settings/automation/global" class="formrow" style="align-items:end">
    <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
    <div><label>Global mode</label><select name="mode">
      <option value="auto" ${globalAutomation === "auto" ? "selected" : ""}>auto — only the categories allowlisted below may send</option>
      <option value="draft" ${globalAutomation === "draft" ? "selected" : ""}>draft — hold EVERY automated reply for approval</option>
    </select></div>
    <div style="flex:0"><button class="btn">Apply global mode</button></div>
  </form>
  <table style="margin-top:14px"><tr><th>Email category</th><th>Mode</th><th></th></tr>
    ${EMAIL_CATEGORIES
      .map((cat) => {
        const mode = c.repo.automationMode(cat);
        return `<tr><td>${esc(cat.replace(/_/g, " "))}</td>
        <td><span class="badge ${mode === "auto" ? "b-green" : "b-orange"}">${mode === "auto" ? "automatic sending" : "draft for approval"}</span></td>
        <td><form method="post" action="/settings/automation/category" style="margin:0">
          <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
          <input type="hidden" name="category" value="${esc(cat)}">
          <button class="btn small ghost" name="mode" value="${mode === "auto" ? "draft" : "auto"}">switch to ${mode === "auto" ? "draft" : "auto"}</button>
        </form></td></tr>`;
      })
      .join("")}
  </table>
  <p class="small muted">Note: with global mode set to draft, switches for each category take effect once global returns to auto.</p>
</div>

<div class="card" id="sla">
  <h2>Response targets &amp; SLA</h2>
  <p class="small muted" style="margin-top:-6px">How fast the office promises to respond, when a slow case is escalated, and the reminder ladder for missing documents. These numbers drive the SLA clock on every queued case and the scheduled reminders.</p>
  <form method="post" action="/settings/general">
    <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
    <div class="formrow">
      ${settingInput("sla_target_hours", "SLA target (hours to first response)")}
      ${settingInput("escalation_hours", "Escalation (hours before a case is escalated)")}
      ${settingInput("unanswered_target_hours", "Unanswered target (hours)")}
    </div>
    <div class="formrow">
      ${settingInput("followup_ladder_days", "Reminder sequence (days between reminders, e.g. 3,7,10)")}
      ${settingInput("retention_days", "Keep completed cases for (days)")}
    </div>
    <p><button class="btn">Save response targets</button></p>
    <p class="small muted" style="margin-bottom:0">Current ladder: <b>${esc(settings["followup_ladder_days"] ?? "3,7,10")}</b> days — reminders stop as soon as the case is complete. A response rule can switch the ladder off for its own path.</p>
    <p class="small muted" style="margin-bottom:0">Retention is how long a <b>completed</b> case is kept before it is archived and cleared by the retention sweep (<code>npm run retain</code>). Nothing is deleted the moment you lower it — the next sweep picks it up, and every removal is recorded.</p>
  </form>
</div>

<div class="card" id="letters">
  <h2>Letters &amp; identity</h2>
  <p class="small muted" style="margin-top:-6px">Identity and theme belong to this organization. The same values are used by the console, outgoing messages and generated documents.</p>
  <form method="post" action="/settings/organization">
    <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
    <div class="formrow">
      ${organizationInput("organization_name", "Workspace name (shown in the console)", organization?.name ?? c.institution)}
      ${organizationInput("primary_color", "Primary colour", organization ? organizationTheme(repo, organizationId).primary : "#3b1d5f")}
      ${organizationInput("accent_color", "Accent colour", organization ? organizationTheme(repo, organizationId).accent : "#9a78c7")}
      <div><label>Reference prefix</label><input name="ref_prefix" value="${esc(organization?.ref_prefix ?? repo.organizationRefPrefix(c.user.organization_id ?? 1))}" pattern="[A-Za-z]{1,8}" maxlength="8" required></div>
    </div>
    <div class="formrow">
      ${organizationInput("from_name", "From name on outgoing mail", organization?.from_name ?? "")}
      ${organizationInput("reply_to", "Reply-to address", organization?.reply_to ?? "")}
      ${organizationInput("locale", "Locale (dates & numbers)", organization?.locale ?? "en-KE")}
      ${organizationInput("timezone", "Timezone (IANA name)", organization?.timezone ?? "")}
    </div>
    <div class="formrow">
      <div class="field"><span class="lbl">Inbound mailbox address for this organization</span>
        <input name="inbound_address" type="email" value="${esc(organization?.inbound_address ?? "")}" placeholder="intake@yourorganization.example" autocomplete="off">
        <span class="small muted">Mail delivered to this address belongs to this organization. One shared mailbox can serve several organizations — without an address here, incoming mail falls back to the head office and the audit trail says so.</span></div>
    </div>
    <p class="small muted">The From name and Reply address are applied to every message the system sends. Empty From name keeps the sending mailbox's own name; empty Reply address keeps replies on the sending mailbox.</p>
    <p><button class="btn">Save identity &amp; colours</button></p>
  </form>
  <div class="card" style="margin:14px 0 0;padding:14px;background:var(--card2)">
    <b>Logo</b><p class="small muted" style="margin:3px 0 10px">Upload a PNG, JPEG or SVG logo for this organization. It replaces the neutral mark across the workspace.</p>
    <form method="post" action="/config/organization/logo" enctype="application/octet-stream">
      <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
      <input type="file" name="logo" accept="image/png,image/jpeg,image/svg+xml" data-logo-upload>
      <button class="btn small ghost" type="button" data-logo-save>Upload logo</button>
      <span class="small muted" data-logo-message></span>
    </form>
  </div>
  <form method="post" action="/settings/general" style="margin-top:14px">
    <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
    <div class="formrow">
      ${settingInput("institution_name", "Name signed on outgoing mail &amp; documents", settings["institution_name"] ?? organization?.name ?? c.institution)}
    </div>
    <p class="small muted">This is the name that closes an email and heads a generated document. It can read differently from the workspace name above — “Riverdale College” in the console, “Riverdale Admissions Office” on letters — and both start out the same.</p>
    <p><button class="btn ghost">Save response settings</button></p>
  </form>
</div>
<script>
(function () {
  var save = document.querySelector("[data-logo-save]");
  if (!save) return;
  save.addEventListener("click", function () {
    var input = document.querySelector("[data-logo-upload]");
    var msg = document.querySelector("[data-logo-message]");
    if (!input.files[0]) { msg.textContent = "Choose an image first."; return; }
    msg.textContent = "Uploading…";
    fetch("/config/organization/logo", { method: "POST", headers: { "x-csrf-token": "${esc(c.csrf)}", "content-type": input.files[0].type }, body: input.files[0] })
      .then(function (r) { msg.textContent = r.ok ? "Logo saved." : "Upload failed."; if (r.ok) window.location.reload(); })
      .catch(function () { msg.textContent = "Upload failed — network error."; });
  });
})();
</script>

`
  );
}

// ── Web submissions (public ingest key, Phase 18) ──────────────────────────

/**
 * One card for the public ingest surface: the URL an outside system posts to,
 * copy-pasteable examples for the five ways people actually wire it up, the
 * tenant's own delivery log for self-diagnosis, and rotation behind an explicit
 * second click.
 *
 * Markup and class names are the ones Settings already use (`card`, `formrow`,
 * `badge b-*`, `mono`, `btn small ghost`, `table-scroll`, `card-head`): no new
 * styling, no new tokens. The readonly-input-with-`this.select()` copy control
 * and the inline-`<script>` block are the patterns the Gmail URI and the logo
 * uploader above already establish.
 *
 * Why the address is shown in full, unlike the Gmail and Gemini credentials on
 * this same page (presence-only by design, PPR P0-1): a provider secret is never
 * needed back — it is only ever entered. This one is the thing an operator has
 * to paste into a form, a Zap and a Webflow embed, and it grants nothing but the
 * ability to submit, which is exactly why it is rotatable in place.
 */
export function webhookIngestSection(c: Ctx, origin: string, ingestKey: string | null): string {
  const { repo } = c;
  const url = ingestKey ? `${origin}${WEBHOOK_PATH_PREFIX}${ingestKey}` : "";
  const deliveries = repo.listWebhookDeliveries(c.user.organization_id ?? 1, 10);
  const rate = repo.webhookRateLimitPerMinute(c.user.organization_id ?? 1);

  const outcomeBadge = (outcome: string, statusCode: number): string => {
    if (outcome === "accepted") return `<span class="badge b-green">accepted</span>`;
    if (outcome === "duplicate") return `<span class="badge b-blue">duplicate</span>`;
    if (outcome === "parked") return `<span class="badge b-orange">parked by policy</span>`;
    if (outcome === "rate_limited") return `<span class="badge b-orange">throttled ${statusCode}</span>`;
    if (outcome === "rejected") return `<span class="badge b-orange">refused ${statusCode}</span>`;
    return `<span class="badge b-red">failed ${statusCode}</span>`;
  };

  const rows = deliveries.map((row) => `<tr>
    <td>${esc(fmtDate(row.received_at))}<br><span class="muted small mono">${esc(row.sender_email || "no address")}</span></td>
    <td>${outcomeBadge(row.outcome, row.status_code)}</td>
    <td class="small">${row.applicant_id
      ? `<a href="/case/${row.applicant_id}"><b>${esc(row.ref_number || "case")}</b></a>${row.case_type_code ? `<br><span class="muted">${esc(row.case_type_code)}</span>` : ""}`
      : row.ref_number ? `<b>${esc(row.ref_number)}</b>` : `<span class="muted">no case opened</span>`}</td>
    <td class="small mono">${row.external_id ? esc(row.external_id) : '<span class="muted">—</span>'}</td>
    <td class="small">${securityDetail(row.detail)}</td>
  </tr>`).join("");

  const snippets: Array<{ title: string; note: string; code: string }> = [
    {
      title: "Plain HTML form",
      note: "Works from any page on any host. The sender lands in the queue exactly like an email from that address.",
      code: `<form method="POST" action="${url}">
  <input type="email" name="email" required placeholder="you@example.org">
  <input type="text" name="full_name" placeholder="Your name">
  <select name="case_type"><option value="SERVICE_REQUEST">Service request</option></select>
  <textarea name="message" rows="5">What do you need?</textarea>
  <button type="submit">Send</button>
</form>
<!-- external_id is optional. Set it to a number only your backend knows (an
     order id, a post id) and a double submit cannot open a second case. -->`,
    },
    {
      title: "WordPress",
      note: "Add to your child theme's functions.php (or a code-snippets plugin) and post from a form with an ID. wp_remote_post is core, so no plugin is required.",
      code: `add_action( 'rest_api_init', function () {
  register_rest_route( 'aa', '/intake', function () {
    return function ( $request ) {
      $body = [
        'email'       => sanitize_email( $request['email'] ),
        'full_name'   => sanitize_text_field( $request['name'] ),
        'message'     => sanitize_textarea_field( $request['message'] ),
        'case_type'   => 'SERVICE_REQUEST',
        'external_id' => 'wp-' . $request->get_param( 'post_id' ),
      ];
      $result = wp_remote_post( '${url}', [
        'headers' => [ 'Content-Type' => 'application/json' ],
        'body'    => wp_json_encode( $body ),
        'timeout' => 20,
      ] );
      return new WP_REST_Response( [
        'ref' => json_decode( wp_remote_retrieve_body( $result ) )->ref_number ?? null,
      ] );
    };
  } );
} );`,
    },
    {
      title: "Zapier",
      note: "Zapier → Create Zap → trigger (Form, Google Sheet, anything) → action <b>Webhooks by Zapier</b>.",
      code: `Action      Webhooks by Zapier
Method      POST
URL         ${url}
Payload type  Json
Data        {
  "email":     "{{contact_email}}",
  "full_name": "{{first_name}} {{last_name}}",
  "case_type": "SERVICE_REQUEST",
  "message":   "{{notes}}",
  "external_id": "{{zap_id}}-{{id}}"
}
Unmarshal Response  true   ← so the ref_number comes back into the Zap`,
    },
    {
      title: "Make (Integromat)",
      note: "A scenario module: <b>Webhooks → Send data</b>. Use the record ID as external_id so a re-run cannot open a second case.",
      code: `Module      Webhooks: Send data
URL         ${url}
HTTP method POST
Headers     Content-Type: application/json
Payload     {
  "email":      "{{email}}",
  "full_name":  "{{name}}",
  "case_type":  "SERVICE_REQUEST",
  "message":    "{{comment}}",
  "external_id": "{{id}}"
}
→ read ref_number straight out of the response for the next module`,
    },
    {
      title: "Webflow",
      note: "Webflow's native Forms block posts to Webflow only. Use an Embed Code block with this handler on the page that carries your button, or call it from your custom code after submit.",
      code: `<script>
async function submitToCaseOffice(fields) {
  const res = await fetch('${url}', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: fields.email,
      full_name: fields.name,
      case_type: 'SERVICE_REQUEST',
      message: fields.message,
      external_id: 'webflow-' + fields.id,
      metadata: { source: 'webflow', page: location.pathname }
    })
  });
  const reply = await res.json();
  if (res.ok) console.log('case', reply.ref_number, reply.reply);
  else console.warn('not accepted:', reply.error);
  return reply;
}
</script>`,
    },
  ];

  const exampleBlocks = snippets.map((block) => `<div style="margin-top:14px">
      <b class="small">${block.title}</b>
      <p class="small muted" style="margin:3px 0 6px">${block.note}</p>
      <textarea class="mono" rows="${Math.min(14, block.code.split("\n").length + 1)}" readonly style="width:100%;font-size:12px" onclick="this.select()" spellcheck="false">${esc(block.code)}</textarea>
      <p style="margin:6px 0 0"><button type="button" class="btn small ghost" data-aa-copy="${esc(block.code)}">Copy</button> <span class="small muted" data-aa-copy-message></span></p>
    </div>`).join("");

  return `
<div id="webhook">
<h1 style="margin-top:34px">Web submissions</h1>
<div class="sub">One address that your site, form builder or automation tool posts to. A submission becomes a case through the same rules as an inbound email — nothing can be decided from outside.</div>

<div class="card" id="webhook-url">
  <h2>Your webhook URL ${ingestKey ? `<span class="badge b-green">live now</span>` : `<span class="badge b-orange">not issued</span>`}</h2>
  <p class="small muted" style="margin-top:-6px">Accepts <span class="mono">JSON</span> or plain form fields: <span class="mono">email</span> (required), <span class="mono">full_name</span>, <span class="mono">external_id</span>, <span class="mono">case_type</span>, <span class="mono">message</span>, <span class="mono">metadata</span>. The reply carries the case's reference number.</p>
  ${ingestKey ? `
  <div class="formrow" style="margin-top:10px">
    <div style="flex:1;min-width:280px"><label>Submission address</label>
      <input class="mono" style="width:100%" readonly value="${esc(url)}" onclick="this.select()" spellcheck="false" data-aa-webhook-url>
    </div>
    <div style="align-self:flex-end"><button type="button" class="btn small ghost" data-aa-copy="${esc(url)}">Copy</button> <span class="small muted" data-aa-copy-message></span></div>
  </div>
  <p class="small" style="color:var(--red);margin:8px 0 0"><b>Treat this address like a password.</b> Anyone who has it can submit on your behalf; they cannot read, change or decide anything, and every call they make is listed below. Do not put it in a public repository or a screenshot.</p>
  <p class="small muted" style="margin:6px 0 0">This address is built from the one your browser used to reach this page${repo.getSetting("gmail_public_base_url", "").trim() ? ", and the public base URL pinned in Connections takes precedence" : ""}. If you open the console through a tunnel or an internal hop, check it is the address the public will use before you copy it into a form.</p>

  <details style="margin-top:12px">
    <summary class="small"><b>Rotate the key</b> — the current address stops working immediately</summary>
    <p class="small muted" style="margin:8px 0">Every form, Zap and scenario that still posts to the old address starts getting <span class="mono">404 not found</span> the moment you rotate, and stays broken until it is updated. There is deliberately no grace period: a key you wanted gone is gone. Nothing else changes — the cases, the queue and the rules are untouched.</p>
    <form method="post" action="/settings/webhook" style="margin:0">
      <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
      <input type="hidden" name="action" value="rotate">
      <p style="margin:0"><button class="btn small">Rotate key now</button></p>
    </form>
  </details>` : `
  <p class="small" style="color:var(--red)">No ingest key is recorded for this organization yet. It is issued the first time this page is opened — reload to pick it up.</p>`}
</div>

<div class="card" id="webhook-settings">
  <h2>Request budget</h2>
  <div class="formrow" style="align-items:flex-end">
    <div><label>Requests per minute, per key</label>
      <input type="number" name="webhook_rate_limit_per_minute" min="1" max="10000" step="1" value="${rate}" form="aa-webhook-budget" style="width:120px">
    </div>
    <div style="align-self:flex-end">
      <form method="post" action="/settings/webhook" id="aa-webhook-budget" style="margin:0">
        <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
        <input type="hidden" name="action" value="limit">
        <button class="btn small ghost">Save</button>
      </form>
    </div>
  </div>
  <p class="small muted" style="margin:8px 0 0">Applied on the next request, no restart. A caller over the limit gets <span class="mono">429</span> with a <span class="mono">Retry-After</span>, and the attempt is listed below. Everything that arrives with a valid key counts against it — including payloads this endpoint refuses, because a flood of garbage is what the budget is for. The window is a fixed 60 seconds, so a throttled caller waits at most a minute. The counter belongs to this organization, so rotating the key does not reset it, and one tenant's traffic cannot slow another's. The value you save here belongs to this organization — a tenant that has never set one follows the installation default.</p>
</div>

<div class="card" id="webhook-examples">
  <h2>Ways to send</h2>
  <p class="small muted" style="margin-top:-6px">Each example already carries your own address. <span class="mono">case_type</span> must name a category this organization has configured — an unknown one is refused, never invented.</p>
  ${exampleBlocks}
</div>

<div class="card nopad" id="webhook-deliveries">
  <div class="card-head"><h2>Recent deliveries</h2><a class="small" href="/admin/security">Security console</a></div>
  ${deliveries.length ? `<p class="small muted" style="padding:0 24px">The last ${deliveries.length} calls to this address, newest first — including the ones refused before a case was opened. Distinct from mail: these rows exist only for the public endpoint.</p>
  <div class="table-scroll"><table>
    <tr><th>When / from</th><th>Result</th><th>Case</th><th>external_id</th><th>What happened</th></tr>
    ${rows}
  </table></div>` : `<div class="empty"><p>Nothing has been posted to this address yet. Once a form or Zap is wired up, every call — accepted, refused, throttled or duplicated — shows here.</p></div>`}
</div>
</div>
<script>
(function () {
  document.querySelectorAll("[data-aa-copy]").forEach(function (button) {
    button.addEventListener("click", function () {
      var value = button.getAttribute("data-aa-copy") || "";
      var done = function (ok) {
        var slot = button.parentNode.querySelector("[data-aa-copy-message]");
        if (slot) slot.textContent = ok ? "Copied." : "Select the box and copy by hand.";
      };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(value).then(function () { done(true); }, function () { done(false); });
      else done(false);
    });
  });
})();
</script>`;
}

// ── Account (self-service settings, available to every signed-in user) ─────


/**
 * OR-4: Gmail + Gemini connection setup — ONE home, in Settings.
 * Step-by-step Google Cloud guide (exact scope, redirect URI,
 * OAuth-Playground fallback) plus live status and test buttons.
 */
export function connectionsSection(c: Ctx, gmailRedirectUri?: string): string {
  const { repo } = c;
  const settings = repo.allSettings();
  const gAddress = settings["gmail_address"] || c.gmailAddress || "";
  const gClientId = settings["gmail_client_id"] ?? "";
  // PPR P0-1: secrets are presence-only here — a settings page can never
  // read the stored credential value back out.
  const gClientSecret = repo.hasSecret("gmail_client_secret") ? "saved" : "";
  const gRefresh = repo.hasSecret("gmail_refresh_token") ? "saved" : "";
  const geminiKeySaved = repo.hasSecret("gemini_api_key");
  // Settings-backed OAuth is the primary source of truth. Runtime env
  // credentials are also valid, but must not hide a disabled connection.
  const connected = repo.getSetting("gmail_disabled", "") !== "1" &&
    (Boolean(gAddress && gClientId && gClientSecret && gRefresh) || Boolean(c.gmailConfigured));
  // AUX-2: a plain-`http://` redirect URI on a NON-LOOPBACK host can never
  // be registered with a Google OAuth web client — the classic
  // behind-a-proxy trap (the app sees the plain HTTP hop to the proxy,
  // not the public https address). Instead of letting the admin hit
  // Google's opaque 400, name it and point at the Public base URL field.
  let proxyUriWarning = "";
  if (gmailRedirectUri) {
    try {
      const u = new URL(gmailRedirectUri);
      const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname);
      if (u.protocol === "http:" && !loopback && !(settings["gmail_public_base_url"] ?? "").trim()) {
        proxyUriWarning = `<p class="small" style="color:var(--red);margin-top:10px"><b>You're behind a proxy | set the <i>Public base URL</i> below before connecting.</b><br>The app currently hands Google <span class="mono">http://${esc(u.host)}/settings/gmail/callback</span>, and Google's OAuth console refuses plain HTTP (non local host) redirect addresses for web clients. Enter your public address (e.g. <span class="mono">https://cases.example.ac.ke</span>), save, and step&nbsp;4 below will show the correct https URI to register.</p>`;
      }
    } catch {
      /* unparseable URI — nothing to warn about */
    }
  }
  return `
<div id="connections">
<h1 style="margin-top:34px">Connections</h1>
<div class="sub">Gmail inbox and Gemini document AI — set up once, live immediately, no restarts.</div>

<div class="card" id="gmail">
  <h2>Gmail connection ${connected
    ? `<span class="badge b-green">connected — live sorting on</span>`
    : `<span class="badge b-orange">not connected</span>`}</h2>
  <p class="small muted" style="margin-top:-6px">Connect the case intake mailbox so incoming mail is fetched, triaged and sorted automatically every minute.</p>
  ${proxyUriWarning}
  ${!connected && (gAddress || gClientId || gClientSecret || gRefresh)
    ? `<p class="small" style="color:var(--red);margin-top:10px"><b>Connection incomplete — mail is NOT being fetched until every piece is saved.</b> Missing: <b>${esc(missingGmailCredentials(repo).join(", "))}</b>. Add what's missing in the fields below (or via the OAuth connect) and save.</p>`
    : ""}
  <ol class="small" style="margin:0 0 14px 18px;line-height:1.7">
    <li>In <b>Google Cloud Console</b> (console.cloud.google.com) create or pick a project for the case intake mailbox.</li>
    <li><b>APIs &amp; Services → Library</b>: enable the <b>Gmail API</b>.</li>
    <li><b>APIs &amp; Services → Credentials → Create credentials → OAuth client ID</b>, application type <b>Web application</b>.</li>
    <li>Under <b>Authorised redirect URIs</b> add exactly this address (copy it — Google rejects placeholders such as <span class="mono">0.0.0.0</span>):<br><input class="mono" style="width:100%;margin-top:4px" readonly value="${esc(gmailRedirectUri ?? "")}" onclick="this.select()"></li>
    <li>Paste the <b>Client ID</b> and <b>Client secret</b> below, save, then press <b>Connect with Google…</b> and approve. Exactly two scopes are requested — <span class="mono">gmail.readonly</span> (read this mailbox) and <span class="mono">gmail.send</span> (send as it). Nothing else: the app cannot delete, label, move or mark mail as read, and it never asks for the broader <span class="mono">gmail.modify</span>.</li>
    <li>No OAuth client of your own? Use the <b>OAuth Playground</b> (developers.google.com/oauthplayground) with your own client ID and the same two scopes (<span class="mono">gmail.readonly</span> + <span class="mono">gmail.send</span>), then paste the resulting refresh token into the advanced field.</li>
  </ol>
  <form method="post" action="/settings/gmail/credentials">
    <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
    <div class="formrow">
      <div><label>Gmail address</label><input type="email" name="gmail_address" value="${esc(gAddress)}" placeholder="case intake@institution.ac.ke"></div>
      <div><label>OAuth client ID</label><input type="text" name="gmail_client_id" value="${esc(gClientId)}" placeholder="…apps.googleusercontent.com"></div>
      <div><label>OAuth client secret</label><input type="password" name="gmail_client_secret" value="" placeholder="${gClientSecret ? "saved — enter a new value to replace" : "GOCSPX-…"}" autocomplete="new-password"></div>
    </div>
    <div class="formrow" style="margin-top:10px">
      <div style="flex:2"><label>Public base URL <span class="muted small">(advanced | only for reverse proxy / HTTPS deployments)</span></label><input type="text" name="gmail_public_base_url" value="${esc(settings["gmail_public_base_url"] ?? "")}" placeholder="https://cases.example.ac.ke"></div>
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
    <form method="post" action="/settings/gmail/backfill" style="margin:0"><input type="hidden" name="_csrf" value="${esc(c.csrf)}"><select name="days" class="small"><option value="30">30 days</option><option value="90" selected>90 days</option><option value="365">365 days</option></select> <button class="btn ghost">Pull older mail</button></form>
    <form method="post" action="/settings/gmail/disconnect" style="margin:0"><input type="hidden" name="_csrf" value="${esc(c.csrf)}"><button class="btn ghost danger">Disconnect</button></form>
  </div>` : ""}
  <p class="small muted" style="margin-top:10px">${connected
    ? `Signed in as <b>${esc(gAddress)}</b>. New incoming mail is fetched automatically every minute from <b>All Mail</b> (excluding sent, spam and trash), covering the last ${resolveLookbackDays(repo, undefined)} days — older mail is brought in with “Pull older mail”.${settings["gmail_last_sync_at"] ? ` Last successful sync: <b>${esc(fmtDate(settings["gmail_last_sync_at"]))}</b>.` : " First sync pending (runs every minute)."}`
    : "Mail is not being fetched yet — the console still works; process mail manually or connect when ready."}</p>
  ${settings["gmail_last_error"] ? `<p class="small" style="color:var(--red)">Last sync failed: ${esc(settings["gmail_last_error"])}<br><span class="muted">If this says <span class="mono">invalid_grant</span>, the refresh token expired — press “Connect with Google…” again (or paste a fresh refresh token). If new mail still doesn’t appear after a good sync, check that it is in <b>All Mail</b> for ${esc(gAddress || "the connected address")} and within the lookback window.</span></p>` : ""}
</div>

<div class="card" id="gemini">
  <h2>Document AI (Gemini) ${geminiKeySaved
    ? `<span class="badge b-green">key saved — AI reads what OCR can't</span>`
    : `<span class="badge b-gray">optional</span>`}</h2>
  <p class="small muted" style="margin-top:-6px">When a document beats text extraction and OCR (bad scans, photos, handwriting), Gemini reads it as a vision model. Get a free key at <b>aistudio.google.com/apikey</b> (Google account → “Get API key”). The key is tested with one real call on save and goes live <b>immediately</b>, no restart. Without a key the console still works; unreadable files simply land in the review queue.</p>
  <form method="post" action="/settings/gemini">
    <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
    <div class="formrow">
      <div style="flex:2"><label>Gemini API key ${geminiKeySaved ? "(saved — paste a new value to replace)" : ""}</label><input type="password" name="gemini_api_key" value="" placeholder="AIza…" autocomplete="new-password"></div>
      ${(() => {
    const storedModel = settings["gemini_model"] ?? "";
    const dead = DEAD_GEMINI_MODELS.has(storedModel);
    return `<div><label>Model</label><input type="text" name="gemini_model" value="${esc(storedModel || DEFAULT_GEMINI_MODEL)}" placeholder="${esc(DEFAULT_GEMINI_MODEL)}"></div>
    ${dead ? `<p class="small" style="color:var(--red)">Please note: <span class="mono">${esc(storedModel)}</span> no longer exists in the Gemini API | that is the 404 you are seeing. The current Flash model is <span class="mono">${esc(DEFAULT_GEMINI_MODEL)}</span> (GA 2026-09-02) | put it in the field and test again.</p>` : ""}`;
  })()}
      <div style="flex:0"><label>&nbsp;</label><button class="btn">Save &amp; test key</button></div>
    </div>
  </form>
  ${geminiKeySaved ? `<form method="post" action="/settings/gemini" style="margin-top:8px"><input type="hidden" name="_csrf" value="${esc(c.csrf)}"><button class="btn ghost danger small" name="clear" value="1">Remove key</button></form>` : ""}
  ${settings["gemini_last_error"] ? `<p class="small" style="color:var(--red)">Last test failed: ${esc(settings["gemini_last_error"])}</p>` : ""}
</div>
</div>`;
}

export function accountPage(c: Ctx, msg?: string): string {
  const u = c.user;
  const theme: Theme = c.theme === "light" ? "light" : "dark";
  return head(
    c,
    "Account",
    "account",
    `
<h1>Account settings</h1>
<div class="sub">Your sign in and appearance. These apply only to your account.</div>
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
      <div><label>Confirm password</label><input type="password" name="confirm" required minlength="8" autocomplete="new-password"></div>
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

/**
 * PPR P0-5: Attachment sets — the files this organization attaches to its
 * replies. Sets are ordinary organization data: create one, upload PDFs,
 * name it on a template or workflow rule. Nothing here references another
 * organization's files; a new organization starts empty and defines its own.
 */
function attachmentSetsCard(c: Ctx): string {
  const orgId = c.user.organization_id ?? 1;
  const sets = c.repo.listAttachmentSets(orgId);
  const fmt = (b: number) => b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`;
  const setBlocks = sets.map((s) => {
    const files = c.repo.listAttachmentSetFiles(s.id);
    return `<details id="aset-${s.id}" style="margin:10px 0;border:1px solid var(--line2);border-radius:8px">
      <summary style="cursor:pointer;padding:10px 14px"><b>${esc(s.name)}</b>
        <span class="badge b-gray" style="margin-left:8px">${files.length} file${files.length === 1 ? "" : "s"}${s.bytes ? `, ${fmt(s.bytes)}` : ""}</span>
        ${s.description ? `<span class="small muted" style="margin-left:8px">${esc(s.description)}</span>` : ""}</summary>
      <div style="padding:6px 16px 14px">
        <p class="small muted">Templates and workflow rules attach this set by name (<span class="mono">${esc(s.name)}</span>). Replacing a file here swaps it in every future send.</p>
        <table><tr><th>File</th><th>Size</th><th>Origin</th><th></th></tr>
          ${files.length ? files.map((f) => `<tr>
            <td>${esc(f.filename)}</td>
            <td class="small">${fmt(f.content.length)}</td>
            <td class="small muted">${esc(f.provenance)}</td>
            <td><form method="post" action="/config/attachment-sets/file-delete" style="margin:0">
              <input type="hidden" name="_csrf" value="${esc(c.csrf)}"><input type="hidden" name="file_id" value="${f.id}">
              <button class="btn small ghost" onclick="return confirm('Remove this file from the set?')">Remove</button></form></td>
          </tr>`).join("") : `<tr><td colspan="4" class="small muted">No files yet — upload a PDF below.</td></tr>`}
        </table>
        <div style="display:flex;gap:8px;align-items:center;margin-top:10px">
          <input type="file" accept="application/pdf" id="aset-file-${s.id}" style="max-width:230px">
          <button class="btn small" data-aset-upload="${s.id}">Upload PDF</button>
          <span class="small muted" id="aset-msg-${s.id}" role="status"></span>
        </div>
        <form method="post" action="/config/attachment-sets/delete" style="margin-top:10px">
          <input type="hidden" name="_csrf" value="${esc(c.csrf)}"><input type="hidden" name="set_id" value="${s.id}">
          <button class="btn small ghost" onclick="return confirm('Delete this entire set?')">Delete set</button>
        </form>
      </div>
    </details>`;
  }).join("");

  return `<div class="card" id="attachment-sets">
  <div class="card-head"><h2>Attachment sets</h2></div>
  <div style="padding:14px 24px 22px">
    <p class="small muted" style="margin-top:-4px">Named groups of PDFs that ride along with replies. A template or workflow rule attaches exactly the set it names — nothing else. Each organization defines its own sets from its own files.</p>
    ${setBlocks || `<p class="muted small">No attachment sets yet — create one below.</p>`}
    <h3 style="margin-top:16px">Create a set</h3>
    <form method="post" action="/config/attachment-sets/create" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
      <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
      <div class="field" style="min-width:200px"><span class="lbl">Set name</span><input name="name" required placeholder="e.g. Enquiry pack"></div>
      <div class="field" style="min-width:260px"><span class="lbl">Description</span><input name="description" placeholder="What this set is for"></div>
      <button class="btn">Create set</button>
    </form>
  </div>
</div>
<script>
(function () {
  document.querySelectorAll("[data-aset-upload]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var setId = btn.getAttribute("data-aset-upload");
      var file = document.getElementById("aset-file-" + setId).files[0];
      var msg = document.getElementById("aset-msg-" + setId);
      if (!file) { msg.textContent = "Choose a PDF first."; return; }
      if (file.type !== "application/pdf") { msg.textContent = "PDF files only."; return; }
      msg.textContent = "Uploading…";
      fetch("/config/attachment-sets/upload?set=" + encodeURIComponent(setId) + "&filename=" + encodeURIComponent(file.name || "document.pdf"), {
        method: "POST",
        headers: { "x-csrf-token": "${esc(c.csrf)}", "content-type": "application/pdf" },
        body: file,
      }).then(function (res) {
        if (res.ok) { location.reload(); }
        else { res.text().then(function (t) { msg.textContent = t || "Upload failed."; }); }
      });
    });
  });
})();
</script>`;
}

function documentsPackCard(c: Ctx): string {
  const slots = c.repo.listOrganizationPackSlots(c.user.organization_id ?? 1).filter((slot) => slot.content);
  return `<section class="card"><h2>Organization document library</h2><p class="small muted">Upload your own files to a named attachment set above. No sample files or fixed packs are provided.</p>${slots.length ? '<p class="small">Imported organization files: ' + slots.map((slot) => esc(slot.filename ?? slot.key)).join(', ') + '</p>' : '<p class="small muted">No imported files.</p>'}</section>`;
}


/**
 * Message categories | the allowed list a message may be labelled with, and the
 * list a Gemini key may choose from. ONE home (Settings), because it describes
 * how this organization reads its mail, not one case type's configuration.
 */
function categoriesCard(c: Ctx): string {
  const csrf = `<input type="hidden" name="_csrf" value="${esc(c.csrf)}">`;
  const categoryRows = c.repo.listEmailCategories(c.user.organization_id ?? 1);
  const geminiKeySaved = Boolean(c.geminiAvailable);
  return `<div class="card" id="categories">
  <h2>Message categories</h2>
  <p class="small muted" style="margin-top:-6px">The labels an incoming message may be given. ${geminiKeySaved
    ? "A Gemini key is reachable, so each message is offered to the model with <b>this list only</b> — an answer that is not on it is rejected and the deterministic matcher decides instead."
    : "No Gemini key is saved (see Connections below), so categorization is deterministic keyword matching."}
  A label is <b>routing metadata for people</b>: it never approves, rejects or decides anything. Only these eight keys guide workflow routing |
  <span class="mono">application</span>, <span class="mono">document_submission</span>, <span class="mono">missing_document</span>,
  <span class="mono">fee_enquiry</span>, <span class="mono">general_enquiry</span>, <span class="mono">follow_up</span>,
  <span class="mono">complaint</span>, <span class="mono">other</span> — a custom label is still recorded on the message and routes as <span class="mono">other</span>.</p>
  <p class="small muted">Keys are stable routing identifiers; edit the staff-facing label without changing existing message history.</p>
  ${categoryRows.length ? `<table><tr><th>Key</th><th>Staff label</th><th></th></tr>${categoryRows.map((row) => `<tr>
      <td class="mono small">${esc(row.key)}</td>
      <td><form method="post" action="/settings/categories/edit" style="display:flex;gap:8px;align-items:center;margin:0">${csrf}
        <input type="hidden" name="key" value="${esc(row.key)}">
        <input name="label" value="${esc(row.label)}" required maxlength="60" aria-label="Label for ${esc(row.key)}">
        <button class="btn small ghost">Save label</button></form></td>
      <td><form method="post" action="/settings/categories/remove" style="margin:0">${csrf}
        <input type="hidden" name="key" value="${esc(row.key)}">
        <button class="btn small ghost" onclick="return confirm('Retire this category? Messages already labelled keep it.')">Retire</button></form></td>
    </tr>`).join("")}</table>`
    : '<p class="small muted">No categories configured — every message is categorized by the deterministic matcher.</p>'}
  <form method="post" action="/settings/categories/create" class="formrow" style="margin-top:10px">${csrf}
    <div><label>Key</label><input name="key" placeholder="general_enquiry" required pattern="[A-Za-z0-9_]{2,40}"></div>
    <div style="flex:2"><label>Label staff see</label><input name="label" placeholder="General enquiry" required maxlength="60"></div>
    <div style="flex:0"><label>&nbsp;</label><button class="btn small">Add category</button></div>
  </form>
</div>`;
}

function requirementsTab(c: Ctx, _target?: string, _system?: string): string {
  const types = c.repo.listCaseTypes(c.user.organization_id ?? 1);
  const csrf = `<input type="hidden" name="_csrf" value="${esc(c.csrf)}">`;
  const windowRows = c.repo.listIntakeRows(c.user.organization_id ?? 1);
  const windows = windowRows.length
    ? `<table><tr><th>Window</th><th>Closes</th><th></th></tr>${windowRows.map((w) => `<tr>
        <td>${esc(w.name)}</td>
        <td><form method="post" action="/settings/intake-deadline" style="display:flex;gap:8px;align-items:center;margin:0">${csrf}
          <input type="hidden" name="name" value="${esc(w.name)}">
          <input type="date" name="deadline" value="${esc((w.deadline ?? "").slice(0, 10))}">
          <button class="btn small ghost">Save deadline</button></form></td>
        <td class="small muted">${w.deadline ? "arrivals after this date are flagged late" : "no deadline — arrivals are never flagged late"}</td>
      </tr>`).join("")}</table>`
    : '<p class="small muted">No windows yet — they appear here as soon as mail names one.</p>';
  const addWindow = `<form method="post" action="/settings/intake-deadline" class="formrow" style="margin-top:10px">${csrf}
    <div><label>Window name</label><input name="name" placeholder="September 2026" required></div>
    <div><label>Closes</label><input type="date" name="deadline"></div>
    <div style="flex:0"><label>&nbsp;</label><button class="btn small">Add window</button></div>
  </form>`;
  return `<section class="card"><h2>Configured requirements</h2><p>Required documents and scalar AND / OR / NOT rules belong to each case type. Existing cases keep their frozen configuration until someone runs an explicit re-evaluation.</p>${types.length ? types.map((type) => '<h3>' + esc(type.name) + '</h3><p>' + esc(ruleTreeText(c.repo.caseTypeRules(type))) + '</p><p class="small">' + c.repo.listDocumentDefinitions(type.id).map((definition) => esc(definition.label) + (definition.required && definition.blocking ? ' (required)' : ' (optional)')).join(', ') + '</p>').join('') : '<p class="small muted">No case types configured.</p>'}<a class="btn ghost" href="/config?tab=case-types">Configure case types</a></section><section class="card" id="rules-ops"><h2>Rule operations</h2><form method="post" action="/config/reevaluate-open">${csrf}<button class="btn ghost">Review all open cases</button></form></section><section class="card" id="categories-pointer"><h2>Message categories</h2><p class="small muted">Categories live in Settings: the labels an incoming message may be given | and the allowed list a Gemini key may choose from | are managed <a href="/settings#categories">there</a>.</p></section><section class="card" id="intakes"><h2>Submission windows</h2><p class="small muted">A window named in an incoming message is attached to its case. A deadline here turns an arrival after that date into a <span class="mono">late_submission</span> flag | a person decides whether to accept it; nothing is rejected automatically. Windows are inferred from real mail or added below.</p>${windows}${addWindow}</section><section class="card" id="deadletters"><h2>Parked mail</h2>${c.repo.listDeadLetters().map((letter) => '<div style="display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap;border-top:1px solid var(--line2);padding:10px 0"><div style="flex:1;min-width:240px"><b>' + esc(letter.subject || letter.message_id) + '</b><br><span class="small muted">' + esc(letter.error.slice(0,220)) + '</span></div><div style="display:flex;gap:6px"><form method="post" action="/config/dead-letter/retry" style="margin:0">' + csrf + '<input type="hidden" name="id" value="' + letter.id + '"><button class="btn small">Retry</button></form><form method="post" action="/config/dead-letter/delete" style="margin:0">' + csrf + '<input type="hidden" name="id" value="' + letter.id + '"><button class="btn small ghost" onclick="return confirm(\'Drop this parked message for good? It will not be retried.\')">Drop</button></form></div></div>').join('') || '<p>Nothing parked.</p>'}<p class="small muted" style="margin:10px 0 0">Retry re-queues the message for the next sync. Drop discards it — for mail that can never be ingested, such as an attachment no reader can open.</p></section>`;
}


/** Plain-English one-line reading of a CaseType rule tree. */
export function ruleTreeText(nodes: RuleNode[]): string {
  const one = (n: RuleNode): string => {
    if (n.kind === "condition") return `${n.subject ?? n.field ?? "?"} ${n.comparator ?? ">="} ${n.value ?? "?"}`;
    const kids = (n.children ?? []).map(one);
    if (n.logic === "NOT") return `NOT (${kids.join(" AND ")})`;
    const joined = kids.join(` ${n.logic ?? "AND"} `);
    return kids.length > 1 ? `(${joined})` : joined;
  };
  const text = nodes.map(one).join(" AND ");
  return text.startsWith("(") && text.endsWith(")") && nodes.length === 1 ? text.slice(1, -1) : text;
}

function caseTypesTab(c: Ctx, selectedOrganizationId?: number): string {
  const organizations = c.repo.listOrganizations();
  const organizationId = selectedOrganizationId && organizations.some((o) => o.id === selectedOrganizationId)
    ? selectedOrganizationId
    : c.user.organization_id ?? 1;
  const organization = c.repo.getOrganization(organizationId);
  const caseTypes = c.repo.listCaseTypes(organizationId);
  const csrf = `<input type="hidden" name="_csrf" value="${esc(c.csrf)}">`;
  const orgPicker = `<form method="get" action="/config" class="inline" style="margin-bottom:16px">
    <input type="hidden" name="tab" value="case-types">
    <label class="small muted">Organization</label>
    <select name="organization" onchange="this.form.submit()">${organizations.map((o) => `<option value="${o.id}" ${o.id === organizationId ? "selected" : ""}>${esc(o.name)} · ${esc(o.ref_prefix)}</option>`).join("")}</select>
  </form>`;
  const axes = c.repo.listOrganizationDocumentAxes(organizationId);
  const typeCard = (ct: CaseType): string => {
    const definitions = c.repo.listDocumentDefinitions(ct.id);
    const rules = c.repo.caseTypeRules(ct);
    // Every slot is editable in place: the key is the stable identifier (it is
    // what an uploaded document's type is matched against), while the label,
    // the required/blocking behaviour and the display order are configuration
    // an office is expected to revisit.
    const axisOpts = (selected?: string | null) =>
      `<option value=""${selected ? "" : " selected"}>always applies</option>` +
      axes.map((ax) => `<option value="${esc(ax.key)}"${selected === ax.key ? " selected" : ""}>only for ${esc(ax.label)}</option>`).join("");
    const documentRows = definitions.map((d) => `<tr>
      <td class="mono small">${esc(d.key)}</td>
      <td><form method="post" action="/config/case-types/document" style="display:flex;gap:6px;align-items:center;margin:0;flex-wrap:wrap">
        ${csrf}<input type="hidden" name="organization_id" value="${organizationId}"><input type="hidden" name="case_type_id" value="${ct.id}">
        <input type="hidden" name="key" value="${esc(d.key)}">
        <input name="label" value="${esc(d.label)}" required aria-label="Label for ${esc(d.key)}" style="flex:2;min-width:160px">
        <select name="required" aria-label="Required for ${esc(d.key)}"><option value="1"${d.required ? " selected" : ""}>required</option><option value="0"${d.required ? "" : " selected"}>optional</option></select>
        <select name="blocking" aria-label="Blocking for ${esc(d.key)}"><option value="1"${d.blocking ? " selected" : ""}>blocks</option><option value="0"${d.blocking ? "" : " selected"}>non-blocking</option></select>
        <input type="number" name="position" value="${d.position}" aria-label="Display order for ${esc(d.key)}" title="Shown in this order on the checklist" style="width:74px">
        ${axes.length ? `<select name="axis" aria-label="Axis for ${esc(d.key)}" title="Make this slot conditional on an organization axis">${axisOpts(d.axis)}</select>
        <input name="axis_values" value="${esc((d.axis_values ?? []).join(", "))}" aria-label="Values for ${esc(d.key)}" placeholder="${d.axis ? "values, comma separated" : "—"}" title="The values of that axis this slot applies to" style="width:150px">` : ""}
        <button class="btn small ghost">Save</button>
      </form></td>
      <td class="small">${d.required ? "required" : "optional"} · ${d.blocking ? "blocks gate" : "non-blocking"}${d.axis ? `<br><span class="muted">when ${esc(d.axis)} is ${(d.axis_values ?? []).length ? esc((d.axis_values ?? []).join(" / ")) : "anything"}</span>` : ""}</td>
      <td><form method="post" action="/config/case-types/document-delete" style="margin:0">${csrf}<input type="hidden" name="organization_id" value="${organizationId}"><input type="hidden" name="case_type_id" value="${ct.id}"><input type="hidden" name="key" value="${esc(d.key)}"><button class="btn small ghost">Remove</button></form></td>
    </tr>`).join("");
    return `<details class="card type-card" id="case-type-${ct.id}">
      <summary class="type-card-summary"><span>${esc(ct.name)}</span><span class="mono small muted">${esc(ct.code)}</span><span class="type-card-hint">Edit CaseType</span></summary>
      <div class="type-content">
      <p class="small muted">Category: ${esc(ct.category)} · Every requirement below is this CaseType's own — nothing is inherited.</p>
      ${ownTenant ? `<details style="margin:0 0 12px;border:1px solid var(--line2);border-radius:8px">
        <summary style="cursor:pointer;padding:8px 12px"><b>Rename or retire this case type</b></summary>
        <div style="padding:4px 14px 14px">
          <form method="post" action="/config/case-types/update" class="formrow" style="margin:0">
            ${csrf}<input type="hidden" name="organization_id" value="${organizationId}"><input type="hidden" name="case_type_id" value="${ct.id}">
            <div><label>CaseType name</label><input name="name" value="${esc(ct.name)}" required></div>
            <div><label>CaseType code</label><input name="code" value="${esc(ct.code)}" required pattern="[A-Za-z][A-Za-z0-9_-]{0,63}" title="Letters, digits, _ and - — start with a letter"></div>
            <div><label>Category</label><input name="category" value="${esc(ct.category)}" placeholder="general"></div>
            <div style="flex:0"><label>&nbsp;</label><button class="btn small">Save case type</button></div>
          </form>
          <p class="small muted" style="margin:8px 0 0">Renaming is safe: cases keep the checklist and rules they froze until someone re-evaluates them. Changing the code changes what inbound aliases and web submissions must send.</p>
          <form method="post" action="/config/case-types/retire" style="margin-top:10px">
            ${csrf}<input type="hidden" name="organization_id" value="${organizationId}"><input type="hidden" name="case_type_id" value="${ct.id}">
            <button class="btn small ghost" onclick="return confirm('Retire “${esc(ct.name)}”? It leaves every picker and stops routing mail. Existing cases keep their history.')">Retire this case type</button>
          </form>
        </div>
      </details>` : ""}
      <h3>Document matrix</h3>
      ${definitions.length ? `<table><tr><th>Key</th><th>Label, gate behaviour &amp; order</th><th>Currently</th><th></th></tr>${documentRows}</table>` : `<p class="small muted">No document slots configured yet.</p>`}
      <form method="post" action="/config/case-types/document" class="formrow" style="margin-top:10px">
        ${csrf}<input type="hidden" name="organization_id" value="${organizationId}"><input type="hidden" name="case_type_id" value="${ct.id}">
        <div><label>Document key</label><input name="key" placeholder="employee_id" required></div>
        <div style="flex:2"><label>Label shown to the correspondent</label><input name="label" placeholder="Signed employee ID" required></div>
        <div><label>Required</label><select name="required"><option value="1">Yes</option><option value="0">No</option></select></div>
        <div><label>Blocking</label><select name="blocking"><option value="1">Yes</option><option value="0">No</option></select></div>
        <div style="flex:0"><label>Display order</label><input type="number" name="position" value="${definitions.length}" style="width:90px" title="Lower numbers appear first on the checklist"></div>
        ${axes.length ? `<div><label>Applies</label><select name="axis" title="Make this slot conditional on an organization axis">${axisOpts()}</select></div>
        <div><label>…for these values</label><input name="axis_values" placeholder="comma separated" title="Comma-separated values of the chosen axis this slot applies to"></div>` : ""}
        <div style="flex:0"><label>&nbsp;</label><button class="btn small">Save document slot</button></div>
      </form>
      <h3 style="margin-top:20px">Rule tree</h3>
      ${rules.length ? `<p class="rule-summary" style="font-family:monospace;background:var(--line2, rgba(127,127,127,.12));padding:8px 10px;border-radius:8px">${esc(ruleTreeText(rules))}</p>` : `<p class="small muted">Empty rule tree — every case is undecided and goes to a human.</p>`}
      <p class="small muted">Use defined by the organization fact keys. The evaluator supports nested AND, OR and NOT groups; a failed or incomplete tree routes to human review, never an automatic rejection.</p>
      <form method="post" action="/config/case-types/rules" style="margin:0">
        ${csrf}<input type="hidden" name="organization_id" value="${organizationId}"><input type="hidden" name="case_type_id" value="${ct.id}">
        <textarea name="rules_json" style="min-height:180px;font-family:monospace" spellcheck="false">${esc(JSON.stringify(rules, null, 2))}</textarea>
        <button class="btn small" style="margin-top:8px">Save rule tree</button>
      </form>
      <p class="small muted" style="margin-top:8px">This tree holds ${rules.length} rule${rules.length === 1 ? "" : "s"} at the top level. Any fact key your organization supplies is valid — for example <span class="mono">employment_type</span> or <span class="mono">start_date</span>.</p>
      </div>
    </details>`;
  };
  // Phase D3 (Q7 step 2): inbound address -> case type. Read-only for another
  // organization; only the acting admin's own tenant gets the forms.
  const aliases = c.repo.listCaseTypeAliases(organizationId, { includeRetired: true });
  const ownTenant = organizationId === (c.user.organization_id ?? 1);
  const aliasesCard = `<section class="card" id="aliases">
    <h2>Inbound addresses (routing aliases)</h2>
    <p class="small muted">Mail delivered to one of these addresses opens the case type it points at: the sender chose the route by picking an address, so nothing is guessed. Matching is without regard to case and honours plus-addressing (<span class="mono">intake+billing@yourorganization.example</span> routes like <span class="mono">billing@yourorganization.example</span>). An address belongs to ONE organization across the whole installation. If one message carries two of your addresses that point at different case types, the case is left unconfigured for a person to choose | the case page has a change type control for exactly that. Precedence: a connector's declaration, then these addresses, then a tenant with exactly one case type.</p>
    ${aliases.length ? `<table><tr><th>Address</th><th>Case type</th><th>State</th>${ownTenant ? "<th></th>" : ""}</tr>${aliases.map((alias) => `<tr>
      <td class="mono small">${esc(alias.address)}</td>
      <td>${esc(alias.case_type_code ?? "(unknown)")}</td>
      <td class="small">${alias.active ? "routing" : "retired (kept for history)"}</td>
      ${ownTenant ? `<td>${alias.active ? `<form method="post" action="/config/case-type-aliases/retire" style="margin:0">${csrf}<input type="hidden" name="address" value="${esc(alias.address)}"><button class="btn small ghost" onclick="return confirm('Stop routing this address? The record is kept.')">Retire</button></form>` : ""}</td>` : ""}
    </tr>`).join("")}</table>` : '<p class="small muted">No addresses configured | inbound mail falls back to the single case type default, or to a person.</p>'}
    ${ownTenant ? `<form method="post" action="/config/case-type-aliases/create" class="formrow" style="margin-top:10px">
      ${csrf}
      <div style="flex:2"><label>Inbound address</label><input name="address" type="email" placeholder="billing@yourorganization.example" required></div>
      <div><label>Opens this CaseType</label><select name="case_type_id" required>${caseTypes.map((ct) => `<option value="${ct.id}">${esc(ct.name)} (${esc(ct.code)})</option>`).join("")}</select></div>
      <div style="flex:0"><label>&nbsp;</label><button class="btn small">Add address</button></div>
    </form>` : '<p class="small muted">Another organization’s addresses can only be viewed here.</p>'}
  </section>`;
  const groupedCaseTypes = new Map<string, CaseType[]>();
  for (const ct of caseTypes) {
    const category = ct.category?.trim() || "Uncategorised";
    groupedCaseTypes.set(category, [...(groupedCaseTypes.get(category) ?? []), ct]);
  }
  const caseTypeGroups = [...groupedCaseTypes.entries()].map(([category, types]) => `<details class="type-group">
    <summary><span class="type-group-name">${esc(category)}</span><span class="type-group-count">${types.length} CaseType${types.length === 1 ? "" : "s"}</span></summary>
    <div class="type-group-body">${types.map(typeCard).join("")}</div>
  </details>`).join("");
  // Retiring is reversible: a retired type only disappears from the pickers,
  // so it has to be reachable again from here rather than only in the database.
  const retired = c.repo.listRetiredCaseTypes(organizationId);
  const retiredCard = retired.length ? `<section class="card" id="retired-case-types">
    <h2>Retired case types</h2>
    <p class="small muted" style="margin-top:-6px">Hidden from every picker and no longer routing mail. Existing cases keep the checklist and rules they froze.</p>
    <table><tr><th>Code</th><th>Name</th><th></th></tr>${retired.map((ct) => `<tr>
      <td class="mono small">${esc(ct.code)}</td><td>${esc(ct.name)}</td>
      <td>${ownTenant ? `<form method="post" action="/config/case-types/reactivate" style="margin:0">${csrf}<input type="hidden" name="organization_id" value="${organizationId}"><input type="hidden" name="case_type_id" value="${ct.id}"><button class="btn small ghost">Restore</button></form>` : ""}</td>
    </tr>`).join("")}</table>
  </section>` : "";
  return `<div id="case-types">
    <section class="card">
      <h2>Organizations &amp; CaseTypes</h2>
      <p class="small muted">Organizations own their CaseTypes, document definitions, rule trees and reference prefixes. A new organization starts empty — nothing is copied from another tenant, and no configuration is bundled with the product.</p>
      ${orgPicker}
      <form method="post" action="/config/organizations/create" class="formrow">
        ${csrf}<div style="flex:2"><label>New organization</label><input name="name" placeholder="People Operations" required></div>
        <div><label>Reference prefix</label><input name="ref_prefix" placeholder="HR" pattern="[A-Za-z]{1,8}" required></div>
        <div style="flex:0"><label>&nbsp;</label><button class="btn">Create organization</button></div>
      </form>
      <form method="post" action="/config/case-types/create" class="formrow" style="border-top:1px solid var(--line2);padding-top:14px;margin-top:14px">
        ${csrf}<input type="hidden" name="organization_id" value="${organizationId}">
        <div><label>CaseType code</label><input name="code" placeholder="HR_ONBOARDING" required></div>
        <div style="flex:2"><label>CaseType name</label><input name="name" placeholder="HR onboarding" required></div>
        <div><label>Category</label><input name="category" value="general"></div>
        <div style="flex:0"><label>&nbsp;</label><button class="btn">Create CaseType</button></div>
      </form>
      <h3 style="margin-top:20px">Configurable axes</h3>
      <p class="small muted">Axes are organization vocabulary, not hardcoded level, curriculum or status fields: the dimensions two similar cases differ along — country, funding route, delivery mode. Save one JSON array of <span class="mono">{key,label,values}</span> objects.</p>
      <form method="post" action="/config/case-types/axes" style="margin:0">
        ${csrf}<input type="hidden" name="organization_id" value="${organizationId}">
        <textarea name="axes_json" style="min-height:80px;font-family:monospace" spellcheck="false">${esc(JSON.stringify(c.repo.listOrganizationDocumentAxes(organizationId), null, 2))}</textarea>
        <button class="btn small" style="margin-top:8px">Save axes</button>
      </form>
      <p class="small muted">Once an axis exists, each document slot gains an <b>Applies</b> dropdown: a slot can be pinned to some values of an axis instead of applying to everyone. On a case, set the axes under <b>Evidence</b> and the checklist narrows to the slots that apply — and re-freezing is an explicit, audited action, never a surprise.</p>
      <p class="small muted" style="margin-bottom:0">Configure the selected organization, then create a CaseType such as <b>HR_ONBOARDING</b>. Empty rule trees remain undecided and are sent to a human.</p>
    </section>
    ${caseTypes.length ? `<div class="type-groups">${caseTypeGroups}</div>` : `<div class="empty"><p>No CaseTypes yet for ${esc(organization?.name ?? "this organization")}.</p></div>`}
    ${retiredCard}
    ${aliasesCard}
  </div>`;
}

/**
 * PPR P0-4: Workflow rules — first-email and response behaviour as DATA.
 * The tab is the admin's control room: intake rules say which mail becomes a
 * case (create/attach/ignore/review); response rules say how the case replies
 * (send/draft/hold, which template, reminder sequence, SLA, audit code).
 * Rules are evaluated in order; the first match wins.
 */
function workflowRulesTab(c: Ctx, editRuleId?: number): string {
  const { repo } = c;
  const orgId = c.user.organization_id ?? 1;
  const rules = repo.listWorkflowRules(orgId);
  const caseTypes = repo.listCaseTypes(orgId);
  const templates = repo.listTemplates(orgId);
  const staff = repo.listStaff(orgId); // H-2: own-tenant members only
  const editing = editRuleId ? rules.find((r) => r.id === editRuleId) : undefined;
  const templateOpts = (sel?: string | null) =>
    `<option value=\"\">(no template)</option>` +
    templates.map((t) => `<option value=\"${esc(t.key)}\" ${sel === t.key ? "selected" : ""}>${esc(t.name)}</option>`).join("");

  const conditionFieldOpts = (field?: string) =>
    [
      ["", "(choose…)"],
      ["always", "any message"],
      ["sender_state", "sender is (known/unknown)"],
      ["text", "text contains"],
      ["subject", "subject contains"],
      ["body", "body contains"],
      ["has_attachments", "has attachments (yes/no)"],
      ["category", "category in (comma list)"],
      ["body_is_ref", "body is just the case reference"],
      ["docs_state", "documents (complete/empty/missing/any/dirty)"],
      ["signals", "built-in generic intake signals"],
    ].map(([v, l]) => `<option value="${v}" ${field === v ? "selected" : ""}>${l}</option>`).join("");

  // The edit form (used for both create and edit). Conditions are built from
  // three simple rows — or paste raw JSON in the advanced box for anything
  // the rows cannot express.
  const condRows = [0, 1, 2].map((i) => {
    const cond = editing?.conditions[i];
    const field = cond ? (cond as { field: string }).field : "";
    const value = cond
      ? (cond as { value?: unknown; values?: unknown[]; op?: string }).values
        ? ((cond as { values: unknown[] }).values ?? []).join(", ")
        : String((cond as { value?: unknown }).value ?? (cond as { op?: string }).op ?? "")
      : "";
    return `<div class=\"cond-row\" style=\"display:flex;gap:8px;margin:4px 0\">
      <select name=\"cond_field_${i}\" style=\"flex:2\">${conditionFieldOpts(field)}</select>
      <input name=\"cond_value_${i}\" placeholder=\"value (comma list ok)\" value=\"${esc(value)}\" style=\"flex:3\">
    </div>`;
  }).join("");

  const act = editing?.action ?? {};
  const form = `<div class=\"card\" id=\"workflow-rule-form\">
  <h2>${editing ? `Edit rule “${esc(editing.name)}”` : "Add a workflow rule"}</h2>
  <p class=\"small muted\" style=\"margin-top:-6px\">Rules run in order — the first match wins. Intake rules decide whether a message becomes a case; response rules decide what the case does next. This is a draft until you enable and save it.</p>
  <form method=\"post\" action=\"/config/workflow-rules/save\">
    <input type=\"hidden\" name=\"_csrf\" value=\"${esc(c.csrf)}\">
    ${editing ? `<input type=\"hidden\" name=\"id\" value=\"${editing.id}\">` : ""}
    <div style=\"display:flex;gap:12px;flex-wrap:wrap\">
      <div class=\"field\" style=\"flex:2;min-width:220px\"><span class=\"lbl\">Rule name</span>
        <input name=\"name\" required value=\"${esc(editing?.name ?? "")}\" placeholder=\"e.g. Volunteer applications open a case\"></div>
      <div class=\"field\" style=\"flex:1;min-width:140px\"><span class=\"lbl\">Kind</span>
        <select name=\"kind\">
          <option value=\"intake\" ${editing?.kind === "intake" || !editing ? "selected" : ""}>Intake (first email)</option>
          <option value=\"response\" ${editing?.kind === "response" ? "selected" : ""}>Response (case replies)</option>
        </select></div>
      <div class=\"field\" style=\"flex:2;min-width:200px\"><span class=\"lbl\">Applies to profile</span>
        <select name=\"case_type_id\">
          <option value=\"\">Across the organization (every case type)</option>
          ${caseTypes.map((t) => `<option value=\"${t.id}\" ${editing?.case_type_id === t.id ? "selected" : ""}>${esc(t.name)} (${esc(t.code)})${""}</option>`).join("")}
        </select></div>
      <div class=\"field\" style=\"flex:1;min-width:120px\"><span class=\"lbl\">Position (order)</span>
        <input name=\"position\" type=\"number\" value=\"${editing?.position ?? ""}\" placeholder=\"auto\"></div>
    </div>
    <h3 style=\"margin:14px 0 4px\">When (conditions — all must match)</h3>
    ${condRows}
    <details style=\"margin:6px 0\"><summary class=\"small muted\">Advanced: raw conditions JSON (overrides the rows above when filled)</summary>
      <textarea name=\"conditions_json\" rows=\"3\" style=\"width:100%\" placeholder='[{\"field\":\"text\",\"op\":\"contains_any\",\"values\":[\"volunteer\"]}]'>${editing && editing.conditions.length > 3 ? esc(JSON.stringify(editing.conditions)) : ""}</textarea>
    </details>
    <h3 style=\"margin:14px 0 4px\">Then (actions)</h3>
    <div style=\"display:flex;gap:12px;flex-wrap:wrap\">
      <div class=\"field\" style=\"flex:1;min-width:160px\"><span class=\"lbl\">Intake decision</span>
        <select name=\"decision\">
          <option value=\"\">(none)</option>
          ${["create", "attach", "ignore", "review"].map((d) => `<option value=\"${d}\" ${act.decision === d ? "selected" : ""}>${{ create: "open a case", attach: "continue the case", ignore: "park (no case)", review: "send to human review" }[d]}</option>`).join("")}
        </select></div>
      <div class=\"field\" style=\"flex:1;min-width:160px\"><span class=\"lbl\">Reply action</span>
        <select name=\"reply_action\">
          <option value=\"\">(none)</option>
          ${["send", "draft", "approve", "hold"].map((d) => `<option value=\"${d}\" ${act.reply_action === d ? "selected" : ""}>${{ send: "send (subject to gates)", draft: "draft for staff", approve: "draft for approval (permission-gated)", hold: "hold for staff" }[d]}</option>`).join("")}
        </select></div>
      <div class=\"field\" style=\"flex:2;min-width:200px\"><span class=\"lbl\">Template</span>
        <select name=\"template_key\">${templateOpts(act.template_key)}</select></div>
    </div>
    <div style=\"display:flex;gap:12px;flex-wrap:wrap\">
      <div class=\"field\" style=\"flex:1;min-width:150px\"><span class=\"lbl\">…when complete (green)</span>
        <select name=\"map_green\">${templateOpts(act.template_map?.green)}</select></div>
      <div class=\"field\" style=\"flex:1;min-width:150px\"><span class=\"lbl\">…when no documents</span>
        <select name=\"map_empty\">${templateOpts(act.template_map?.empty)}</select></div>
      <div class=\"field\" style=\"flex:1;min-width:150px\"><span class=\"lbl\">…when incomplete</span>
        <select name=\"map_missing\">${templateOpts(act.template_map?.missing)}</select></div>
    </div>
    <div style=\"display:flex;gap:12px;flex-wrap:wrap\">
      <div class=\"field\" style=\"flex:1;min-width:130px\"><span class=\"lbl\">Stage</span>
        <select name=\"stage\"><option value=\"\">(keep default)</option>
          ${Object.keys(LIFECYCLE_LABELS).map((s) => `<option value=\"${s}\" ${act.stage === s ? "selected" : ""}>${esc((LIFECYCLE_LABELS as Record<string, string>)[s])}</option>`).join("")}
        </select></div>
      <div class=\"field\" style=\"flex:1;min-width:130px\"><span class=\"lbl\">Queue</span>
        <input name=\"queue\" value=\"${esc(act.queue ?? "")}\" placeholder=\"(keep default)\"></div>
      <div class=\"field\" style=\"flex:1;min-width:120px\"><span class=\"lbl\">Priority</span>
        <select name=\"priority\"><option value=\"\">(keep)</option>
          <option value=\"high\" ${act.priority === "high" ? "selected" : ""}>high</option></select></div>
      <div class=\"field\" style=\"flex:1;min-width:150px\"><span class=\"lbl\">Assign to</span>
        <select name=\"assign\"><option value=\"\">(nobody)</option>
          ${staff.map((s) => `<option value=\"${s.id}\" ${act.assign === s.id ? "selected" : ""}>${esc(s.display_name)}</option>`).join("")}
        </select></div>
    </div>
    <div style=\"display:flex;gap:12px;flex-wrap:wrap\">
      <div class=\"field\" style=\"flex:1;min-width:150px\"><span class=\"lbl\">SLA target (hours)</span>
        <input name=\"sla_hours\" type=\"number\" min=\"1\" value=\"${esc(act.sla_hours ?? "")}\" placeholder=\"(profile default)\"></div>
      <div class=\"field\" style=\"flex:1;min-width:150px\"><span class=\"lbl\">Reminder policy</span>
        <select name=\"followup\">
          <option value=\"\">none</option>
          <option value=\"ladder\" ${act.followup === "ladder" ? "selected" : ""}>reminder ladder (3/7/10 days)</option>
        </select></div>
      <div class=\"field\" style=\"flex:1;min-width:170px\"><span class=\"lbl\">Reminder response</span>
        <select name=\"followup_action\">
          ${["hold", "send", "draft", "approve", "none"].map((d) => `<option value=\"${d}\" ${(act.followup_action ?? "hold") === d ? "selected" : ""}>${{ hold: "hold for staff (default)", send: "request send (qualification still applies)", draft: "draft for staff", approve: "draft for approval", none: "do nothing (cancel ladder)" }[d]}</option>`).join("")}
        </select></div>
      <div class=\"field\" style=\"flex:1;min-width:150px\"><span class=\"lbl\">Attachment set</span>
        <input name=\"attachment_set\" value=\"${esc(act.attachment_set ?? "")}\" placeholder=\"(none)\"></div>
      <div class=\"field\" style=\"flex:1;min-width:180px\"><span class=\"lbl\">Audit code</span>
        <input name=\"audit_code\" value=\"${esc(act.audit_code ?? "")}\" placeholder=\"e.g. rule_volunteer_intake\"></div>
    </div>
    <div style=\"display:flex;gap:12px;align-items:center;flex-wrap:wrap\">
      <div class=\"field\" style=\"flex:1;min-width:200px\"><span class=\"lbl\">If no template resolves</span>
        <select name=\"fallback\">
          <option value=\"human_draft\" ${act.fallback !== "none" ? "selected" : ""}>human draft (internal note)</option>
          <option value=\"none\" ${act.fallback === "none" ? "selected" : ""}>do nothing</option>
        </select></div>
      <div class=\"field\" style=\"flex:1;min-width:120px\"><span class=\"lbl\">Requested info</span>
        <label class=\"small\" style=\"display:flex;gap:6px;align-items:center;padding-top:22px\">
          <input type=\"checkbox\" name=\"request_info\" value=\"1\" ${act.request_info ? "checked" : ""}> list missing documents</label></div>
    </div>
    <h3 style=\"margin:16px 0 4px\">Test with a sample email (before publishing)</h3>
    <p class=\"small muted\" style=\"margin:0 0 6px\">Run a message against the rule AS DRAFTED — including unsaved changes — and see exactly what would fire. Nothing is saved or sent.</p>
    <div style=\"display:flex;gap:12px;flex-wrap:wrap\">
      <div class=\"field\" style=\"flex:2;min-width:200px\"><span class=\"lbl\">Sample sender</span>
        <input name=\"sample_from\" placeholder=\"applicant@example.com\"></div>
      <div class=\"field\" style=\"flex:1;min-width:130px\"><span class=\"lbl\">Sender state</span>
        <select name=\"sample_sender_state\"><option value=\"unknown\">unknown</option><option value=\"known\">known contact</option></select></div>
      <div class=\"field\" style=\"flex:1;min-width:140px\"><span class=\"lbl\">Documents on file</span>
        <select name=\"sample_docs_state\"><option value=\"missing\">some missing</option><option value=\"empty\">none</option><option value=\"complete\">complete</option><option value=\"dirty\">flagged</option></select></div>
      <div class=\"field\" style=\"flex:1;min-width:110px\"><span class=\"lbl\">Attachments</span>
        <select name=\"sample_attachments\"><option value=\"0\">no</option><option value=\"1\">yes</option></select></div>
    </div>
    <div style=\"display:flex;gap:12px;flex-wrap:wrap\">
      <div class=\"field\" style=\"flex:1;min-width:220px\"><span class=\"lbl\">Sample subject</span>
        <input name=\"sample_subject\" placeholder=\"Volunteer application\"></div>
      <div class=\"field\" style=\"flex:2;min-width:260px\"><span class=\"lbl\">Sample message</span>
        <textarea name=\"sample_body\" rows=\"2\" style=\"width:100%\" placeholder=\"The message text\"></textarea></div>
    </div>
    <button type=\"button\" class=\"btn ghost\" id=\"rule-preview-btn\">Preview against this sample</button>
    <div id=\"rule-preview-out\" style=\"margin-top:8px\" role=\"status\"></div>
    <div style=\"margin-top:12px;display:flex;gap:8px\">
      <button class=\"btn\" type=\"submit\">${editing ? "Save rule" : "Add rule"}</button>
      <a class=\"btn ghost\" href=\"/config?tab=rules\">Cancel</a>
    </div>
  </form>
  <script>
  (function () {
    var btn = document.getElementById(\"rule-preview-btn\");
    if (!btn) return;
    btn.addEventListener(\"click\", function () {
      var form = btn.closest(\"form\");
      var out = document.getElementById(\"rule-preview-out\");
      out.textContent = "Running preview\u2026";
      var params = new URLSearchParams(new FormData(form));
      fetch(\"/config/workflow-rules/preview\", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-csrf-token": params.get("_csrf") || "" },
        body: params,
      }).then(function (res) { return res.text(); }).then(function (html) {
        out.innerHTML = html;
      }).catch(function () { out.textContent = "Preview failed — network error."; });
    });
  })();
  </script>
</div>`;

  const ruleTable = (kind: "intake" | "response") => {
    const list = rules.filter((r) => r.kind === kind);
    return `<table style=\"margin-top:8px\">
      <tr><th style=\"width:36px\">On</th><th>Rule</th><th>Scope</th><th>Behaviour</th><th></th></tr>
      ${list.length ? list.map((r) => `<tr>
        <td><form method=\"post\" action=\"/config/workflow-rules/toggle\" style=\"margin:0\">
          <input type=\"hidden\" name=\"_csrf\" value=\"${esc(c.csrf)}\"><input type=\"hidden\" name=\"id\" value=\"${r.id}\">
          <input type=\"checkbox\" ${r.enabled ? "checked" : ""} onchange=\"this.form.submit()\" aria-label=\"enable rule\"></form></td>
        <td><b>${esc(r.name)}</b></td>
        <td class=\"small\">${r.case_type_id === null ? "organization wide" : esc(caseTypes.find((t) => t.id === r.case_type_id)?.name ?? `type #${r.case_type_id}`)}</td>
        <td class=\"small\">${esc(describeRule(r))}</td>
        <td style=\"white-space:nowrap\">
          <a class=\"btn small ghost\" href=\"/config?tab=rules&edit=${r.id}\">Edit</a>
          <form method=\"post\" action=\"/config/workflow-rules/delete\" style=\"display:inline\">
            <input type=\"hidden\" name=\"_csrf\" value=\"${esc(c.csrf)}\"><input type=\"hidden\" name=\"id\" value=\"${r.id}\">
            <button class=\"btn small ghost\" onclick=\"return confirm('Delete this rule?')\">Delete</button></form>
        </td>
      </tr>`).join("") : `<tr><td colspan=\"5\" class=\"small muted\">No ${kind} rules yet.</td></tr>`}
    </table>`;
  };

  const profileCard = `<div class=\"card\">
  <h2>Workflow profile settings</h2>
  <p class=\"small muted\" style=\"margin-top:-6px\">Each CaseType is a workflow profile. New profiles default to <b>draft</b> automation (every suggested reply waits for staff). Automatic outcomes are not supported.</p>
  ${caseTypes.map((t) => {
    const term = (t.terminology ?? {}) as Record<string, string>;
    const stageText = (t.stages ?? []).map((s) => `${s.id}|${s.label}${s.requires?.length ? `|${s.requires.join(", ")}` : ""}`).join("\n");
    const queueText = (t.queues ?? []).map((q) => `${q.id}|${q.label}`).join("\n");
    return `<details style="margin:8px 0;border:1px solid var(--line2);border-radius:8px">
      <summary style="cursor:pointer;padding:10px 14px"><b>${esc(t.name)}</b> — vocabulary, stages &amp; queues <span class="muted small">(PPR P1-1/P1-2)</span></summary>
      <form method="post" action="/config/case-types/vocabulary" style="padding:10px 16px 16px">
        <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
        <input type="hidden" name="id" value="${t.id}">
        <p class="small muted">Five surface words, defaulted to the current generic wording. Internal keys and database columns never move — only what staff and applicants read.</p>
        <div class="formrow">
          <div><label>Case</label><input name="term_case" value="${esc(term.case ?? "Case")}"></div>
          <div><label>Correspondent</label><input name="term_contact" value="${esc(term.contact ?? "Correspondent")}"></div>
          <div><label>Category</label><input name="term_category" value="${esc(term.category ?? "Category")}"></div>
          <div><label>Stage</label><input name="term_stage" value="${esc(term.stage ?? "Stage")}"></div>
          <div><label>Outcome</label><input name="term_outcome" value="${esc(term.outcome ?? "Outcome")}"></div>
        </div>
        <div class="formrow">
          <div style="flex:1"><label>Stages (one per line: id|label|required info items — ids stay stable)</label>
            <textarea name="stages_text" rows="7" style="width:100%">${esc(stageText)}</textarea></div>
          <div style="flex:1"><label>Queues (one per line: id|label)</label>
            <textarea name="queues_text" rows="7" style="width:100%">${esc(queueText)}</textarea></div>
        </div>
        <button class="btn">Save vocabulary, stages &amp; queues</button>
      </form>
    </details>`;
  }).join("")}
  <table>
    <tr><th>Profile</th><th>Automation default</th><th>Evidence gate</th><th></th></tr>
    ${caseTypes.map((t) => `<tr>
      <td><b>${esc(t.name)}</b> <span class=\"small muted\">${esc(t.code)}</span></td>

      <td><form method=\"post\" action=\"/config/case-types/profile\" style=\"display:flex;gap:6px;margin:0\">
        <input type=\"hidden\" name=\"_csrf\" value=\"${esc(c.csrf)}\"><input type=\"hidden\" name=\"id\" value=\"${t.id}\">
        <select name=\"default_reply_action\">
          <option value=\"draft\" ${t.default_reply_action !== "auto" ? "selected" : ""}>draft (recommended)</option>
          <option value=\"auto\" ${t.default_reply_action === "auto" ? "selected" : ""}>automatic sending when a rule says so</option>
        </select>
        <select name=\"evidence_gate\">
          <option value=\"1\" ${t.evidence_gate !== 0 ? "selected" : ""}>hold non-Green replies</option>
          <option value=\"0\" ${t.evidence_gate === 0 ? "selected" : ""}>rules decide (Green still required)</option>
        </select>
        <button class=\"btn small ghost\">Save</button>
      </form></td>
      <td>${t.evidence_gate !== 0 ? "on" : "off (Green still required)"}</td>
      <td></td>
    </tr>`).join("")}
  </table>
</div>`;



  // ── Interactive flowchart editor (centrepiece) ─────────────────────────
  //
  // Two rules govern this block. Both exist because earlier versions broke
  // them (BUG-04 … BUG-09), and both are assertions the tests pin:
  //
  //   1. WHAT IS DRAWN IS WHAT RUNS. The chain is grouped and sorted with the
  //      engine's own comparator — `compareRuleOrder`, the same function
  //      `firstMatchingRule` sorts with — and split into the same scopes
  //      `rulesForCaseScope` uses. A plain `ORDER BY position` picture used to
  //      disagree with the engine whenever a case-type rule and an
  //      organization-wide rule coexisted.
  //
  //   2. WHAT IS NOT SHOWN IS NOT LOST. Every condition row and every action
  //      field this panel does not surface is submitted as a hidden input
  //      carrying its current value, so a save from here can no longer reset
  //      an SLA, an attachment set, a follow-up ladder or a template map —
  //      and it can no longer re-enable a rule that was switched off.
  // Rows the panel can express on its own. `parseRuleConditions` reads
  // cond_field_0..7, so this number and the server's loop must move together:
  // a rule with MORE conditions than this is still fully editable, but through
  // the raw-JSON box the panel switches to rather than through rows.
  const FLOW_MAX_CONDITIONS = 8;
  const FLOW_COND_FIELDS = ["always", "sender_state", "text", "subject", "body", "has_attachments", "docs_state", "category", "body_is_ref", "signals"];
  /** Empty when the flowchart can faithfully round-trip a rule; otherwise why not. */
  const flowUnsupported = (r: (typeof rules)[0]): string => {
    const conds = r.conditions || [];
    if (conds.length > FLOW_MAX_CONDITIONS) return `this rule has ${conds.length} conditions and the flowchart edits up to ${FLOW_MAX_CONDITIONS}`;
    const bad = conds.find((cc) => !FLOW_COND_FIELDS.includes((cc as { field: string }).field));
    if (bad) return `this rule uses a “${(bad as { field: string }).field}” condition the flowchart cannot edit`;
    return "";
  };
  /** Settings the panel preserves but does not surface — shown as a chip so staff know they exist. */
  /**
   * Settings beyond "if / then" that this step also carries. They used to be
   * listed as things the flowchart preserved but could not change; every one
   * of them now has an input in the panel, so the chip is a summary of what
   * is set rather than a warning that it is out of reach.
   */
  const extrasOf = (r: (typeof rules)[0]): string[] => {
    const a = r.action || {};
    const out: string[] = [];
    if (a.sla_hours != null) out.push(`SLA ${a.sla_hours}h`);
    if (a.attachment_set) out.push(`attachments: ${a.attachment_set}`);
    if (a.followup === "ladder") out.push(`follow-up ladder (${a.followup_action ?? "hold"})`);
    if (a.template_map) out.push("template map");
    if (a.priority === "high") out.push("high priority");
    if (a.assign) out.push(`assigned to ${staff.find((s) => s.id === Number(a.assign))?.display_name ?? `#${a.assign}`}`);
    if (a.request_info) out.push("lists missing documents");
    if (a.fallback === "none") out.push("silent when no template");
    if (a.audit_code) out.push(`audit ${a.audit_code}`);
    return out;
  };
  const describeCond = (c: any): string => {
    if (!c || !c.field) return "";
    if (c.field === "always") return "Any message";
    if (c.field === "sender_state") return `Sender is ${c.value ?? "?"}`;
    if (c.field === "has_attachments") return c.value ? "Has attachments" : "No attachments";
    if (c.field === "docs_state") {
      const v = c.values || c.value;
      return `Documents: ${Array.isArray(v) ? v.join(", ") : v}`;
    }
    if (c.field === "category") return `Category ${(c.values || []).join(", ")}`;
    if (c.field === "text" || c.field === "subject" || c.field === "body")
      return `${c.field} contains “${(c.values || []).slice(0, 3).join(", ")}”`;
    if (c.field === "body_is_ref") return "Body is only a case reference";
    if (c.field === "signals") return "Built-in intake signals match";
    return String(c.field);
  };
  const describeAction = (r: (typeof rules)[0]): string => {
    const a = r.action || {};
    const bits: string[] = [];
    if (a.decision) bits.push(({ create: "Open a case", attach: "Continue case", ignore: "Park (no case)", review: "Human review" } as Record<string, string>)[String(a.decision)] || String(a.decision));
    if (a.reply_action) bits.push(({ send: "Send reply", draft: "Draft for staff", approve: "Draft for approval", hold: "Hold for staff" } as Record<string, string>)[String(a.reply_action)] || String(a.reply_action));
    if (a.template_key) bits.push(`Template: ${a.template_key}`);
    if (a.stage) bits.push(`Stage → ${a.stage}`);
    return bits.join(" · ") || "No actions yet — click to set";
  };
  const nodeClass = (r: (typeof rules)[0]): string => {
    const a = r.action || {};
    if (a.decision === "ignore") return "park";
    if (a.decision === "review" || a.reply_action === "hold" || a.reply_action === "draft") return "review";
    if (a.reply_action === "send") return "send";
    return "action";
  };
  const rulesPayload = JSON.stringify(rules.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    enabled: !!r.enabled,
    case_type_id: r.case_type_id,
    position: r.position,
    conditions: r.conditions,
    action: r.action,
    unsupported: flowUnsupported(r),
  }))).replace(/</g, "\\u003c");
  const templateOptions = templates.map((t) => ({ key: t.key, name: t.name }));
  const caseTypeOptions = [{ id: null as number | null, name: "All case types" }, ...caseTypes.map((t) => ({ id: t.id, name: t.name }))];

  /**
   * One node. `conditions: []` never matches (see `ruleMatches`), so it is
   * labelled as parked rather than as "Any message" — the label that used to
   * make a click on Save turn a dead rule into a catch-all (BUG-08).
   */
  const renderRuleNode = (r: (typeof rules)[0], i: number, total: number): string => {
    const conds = (r.conditions || []).map(describeCond).filter(Boolean);
    const ifText = (r.conditions || []).length === 0
      ? "Never matches — no conditions yet"
      : (conds.length ? conds.join(" AND ") : "Any message");
    const off = r.enabled ? "" : " style=\"opacity:.55\"";
    const extras = extrasOf(r);
    const unsupported = flowUnsupported(r);
    // "First match wins" is only meaningful if the order can be changed here,
    // so every step carries its own up/down control. The first step cannot go
    // up and the last cannot go down — both are rendered disabled rather than
    // silently doing nothing.
    const moveBtn = (dir: "up" | "down", enabled: boolean, label: string) =>
      enabled
        ? `<form method=\"post\" action=\"/config/workflow-rules/move\" style=\"margin:0\" onclick=\"event.stopPropagation()\">
            <input type=\"hidden\" name=\"_csrf\" value=\"${esc(c.csrf)}\"><input type=\"hidden\" name=\"id\" value=\"${r.id}\">
            <input type=\"hidden\" name=\"dir\" value=\"${dir}\">
            <button type=\"submit\" title=\"Move ${dir} (tried ${dir === "up" ? "earlier" : "later"})\" aria-label=\"Move ${esc(r.name)} ${dir}\">${dir === "up" ? "↑" : "↓"}</button>
          </form>`
        : `<button type=\"button\" disabled title=\"Already ${label}\" aria-label=\"${esc(r.name)} is already ${label}\">${dir === "up" ? "↑" : "↓"}</button>`;
    return `${i ? `<div class=\"flow-connector\" aria-hidden=\"true\"></div>` : ""}
      <div class=\"flow-node editable ${nodeClass(r)}${unsupported ? " advanced" : ""}\" data-rule-id=\"${r.id}\" tabindex=\"0\" role=\"button\" aria-label=\"Edit rule ${esc(r.name)}\"${off}>
        <div class=\"fn-actions\">
          ${moveBtn("up", i > 0, "first in this chain")}
          ${moveBtn("down", i < total - 1, "last in this chain")}
          <form method=\"post\" action=\"/config/workflow-rules/toggle\" style=\"margin:0\" onclick=\"event.stopPropagation()\">
            <input type=\"hidden\" name=\"_csrf\" value=\"${esc(c.csrf)}\"><input type=\"hidden\" name=\"id\" value=\"${r.id}\">
            <button type=\"submit\" title=\"Toggle on/off\">${r.enabled ? "On" : "Off"}</button>
          </form>
        </div>
        <div class=\"fn-kicker\">step ${i + 1} of ${total}${r.enabled ? "" : " · off"}</div>
        <div class=\"fn-title\">${esc(r.name)}</div>
        <div class=\"fn-if\"><b>If</b> ${esc(ifText)}</div>
        <div class=\"fn-then\"><b>Then</b> ${esc(describeAction(r))}</div>
        ${extras.length ? `<div class=\"fn-extras\">${esc(extras.join(" · "))}</div>` : ""}
        ${unsupported ? `<div class=\"fn-warn\">${esc(unsupported)} — this step opens in the raw-JSON editor below, so nothing is lost or silently shortened.</div>` : ""}
      </div>`;
  };

  /**
   * The whole chain for one kind, drawn in evaluation order: every CaseType
   * that owns rules (alphabetical, so the picture is stable), then the
   * organization-wide bucket last — because `compareRuleOrder` sorts
   * `case_type_id IS NULL` rules after case-type rules whatever their position.
   */
  const renderRuleChain = (kind: "intake" | "response") => {
    const ofKind = rules.filter((r) => r.kind === kind);
    const groups: Array<{ scope: string; label: string; note: string; list: typeof ofKind }> = [];
    const seen = new Set<number>();
    for (const ct of [...caseTypes].sort((a, b) => a.name.localeCompare(b.name))) {
      const list = ofKind.filter((r) => r.case_type_id === ct.id).sort(compareRuleOrder);
      seen.add(ct.id);
      if (list.length) groups.push({ scope: String(ct.id), label: ct.name, note: "this case type only", list });
    }
    // Rules pinned to a case type this tenant no longer lists: keep them
    // visible rather than dropping them from the picture.
    const orphanIds = [...new Set(ofKind.map((r) => r.case_type_id).filter((id): id is number => id != null && !seen.has(id)))];
    for (const id of orphanIds.sort((a, b) => a - b)) {
      const list = ofKind.filter((r) => r.case_type_id === id).sort(compareRuleOrder);
      groups.push({ scope: String(id), label: `Case type #${id}`, note: "no longer listed", list });
    }
    const wide = ofKind.filter((r) => r.case_type_id === null).sort(compareRuleOrder);
    if (wide.length) groups.push({ scope: "", label: "All case types", note: "organization-wide", list: wide });

    /**
     * The "add" bar. It is drawn even when the chain is empty — a group only
     * exists once it owns a rule, so an empty organization used to show
     * "use + Add step in a group below" with no group and no button anywhere
     * on the page. The scope picker covers every case type plus the
     * organization-wide bucket, so the very first step is creatable here.
     */
    const addBar = `
      <div class=\"flow-add flow-add-bar\">
        <label class=\"small muted\" for=\"flow-scope-${kind}\">Add a ${kind} step to</label>
        <select id=\"flow-scope-${kind}\">
          ${caseTypeOptions.map((o) => `<option value=\"${o.id == null ? "" : o.id}\"${o.id == null ? " selected" : ""}>${esc(o.name)}</option>`).join("")}
        </select>
        <button type=\"button\" data-add=\"${kind}\" data-scope-source=\"flow-scope-${kind}\">+ Add ${kind} step</button>
      </div>`;

    return `${groups.length
      ? groups.map((g) => `
      <div class=\"flow-group\">
        <div class=\"flow-group-head\">
          <span class=\"fg-name\">${esc(g.label)}</span>
          <span class=\"fg-note\">${esc(g.note)} · ${g.list.length} step${g.list.length === 1 ? "" : "s"}</span>
        </div>
        ${g.list.map((r, i) => renderRuleNode(r, i, g.list.length)).join("")}
        <div class=\"flow-add\"><button type=\"button\" data-add=\"${kind}\" data-scope=\"${esc(g.scope)}\">+ Add ${kind} step</button></div>
      </div>`).join("")
      : `<div class=\"flow-empty-hint\">No ${kind} steps yet — nothing runs, so every message is left for a person. Add the first one below.</div>`}
      ${addBar}`;
  };

  const flowchartHtml = `
<div class="card" style="padding-bottom:8px">
  <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap">
    <div>
      <h2 style="margin-bottom:4px">Flowchart editor</h2>
      <p class="small muted" style="margin:0">Click a step to edit it. A case runs its <b>own case type's</b> chain first, then the <b>organization-wide</b> chain. Inside a group, top to bottom — <b>first match wins</b>.</p>
    </div>
    <div class="flow-legend">
      <span><i class="lg-action"></i> Open / continue</span>
      <span><i class="lg-review"></i> Human review</span>
      <span><i class="lg-send"></i> Send</span>
      <span><i class="lg-park"></i> Park</span>
    </div>
  </div>
  <div class="flow-editor" id="flow-editor" data-csrf="${esc(c.csrf)}">
    <div class="flow-canvas">
      <div class="flow-node start">
        <div class="fn-kicker">Start</div>
        <div class="fn-title">Email received</div>
        <div class="fn-meta">Subject, body, attachments, and sender are read.</div>
      </div>
      <div class="flow-connector" aria-hidden="true"></div>
      <div class="flow-section-label">Intake — does this become a case?</div>
      ${renderRuleChain("intake")}
      <div class="flow-connector" aria-hidden="true"></div>
      <div class="flow-node start">
        <div class="fn-kicker">Next</div>
        <div class="fn-title">Documents &amp; facts checked</div>
        <div class="fn-meta">Extraction and checklists run. Response steps choose the reply.</div>
      </div>
      <div class="flow-connector" aria-hidden="true"></div>
      <div class="flow-section-label">Response — how do we reply?</div>
      ${renderRuleChain("response")}
    </div>
    <aside class="flow-panel" id="flow-panel">
      <div class="fp-placeholder" id="flow-panel-empty">
        <b>Select a step</b>
        Click any coloured card on the left, or add a new step with the <b>+ Add step</b> button. Everything a step can do is editable right here.
      </div>
      <form method="post" action="/config/workflow-rules/save" id="flow-panel-form" style="display:none">
        <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
        <input type="hidden" name="id" id="fp-id" value="">
        <input type="hidden" name="kind" id="fp-kind" value="intake">
        <input type="hidden" name="enabled" id="fp-enabled" value="1">
        <h3 id="fp-heading">Edit step</h3>
        <p class="fp-sub" id="fp-sub">If this matches, do that. First match wins.</p>
        <label>Name</label>
        <input name="name" id="fp-name" required placeholder="e.g. Known contact continues case">
        <div class="fp-row">
          <div>
            <label>Applies to</label>
            <select name="case_type_id" id="fp-case-type">
              ${caseTypeOptions.map((o) => `<option value="${o.id == null ? "" : o.id}">${esc(o.name)}</option>`).join("")}
            </select>
          </div>
          <div>
            <label>Position (order)</label>
            <input type="number" name="position" id="fp-position" placeholder="auto" title="Lower runs first. The arrows on the card reorder a step without typing a number.">
          </div>
        </div>
        <label>If (conditions)</label>
        <div id="fp-conds"></div>
        <div class="fp-cond-actions">
          <button type="button" id="fp-cond-add">+ Add condition</button>
          <button type="button" id="fp-cond-remove">− Remove condition</button>
        </div>
        <p class="small muted" style="margin:6px 0 0">Examples: sender → <code>known</code> or <code>unknown</code>; attachments → <code>yes</code>/<code>no</code>; documents → <code>complete</code>, <code>empty</code>, <code>missing</code>, <code>dirty</code>. Up to ${FLOW_MAX_CONDITIONS} conditions, all must match.</p>
        <details id="fp-json-wrap" style="margin-top:8px">
          <summary class="small muted" style="cursor:pointer">Conditions as raw JSON (for anything the rows cannot express)</summary>
          <p class="small muted" style="margin:6px 0 0">Filled in, this replaces the rows above when you save. It is the exact structure the engine stores, so a step with more than ${FLOW_MAX_CONDITIONS} conditions opens straight into this box instead of being refused.</p>
          <textarea name="conditions_json" id="fp-conditions-json" rows="5" style="width:100%;font-family:monospace" spellcheck="false" placeholder='[{"field":"text","op":"contains_any","values":["invoice"]}]'></textarea>
        </details>
        <label>Then — intake decision</label>
        <select name="decision" id="fp-decision">
          <option value="">(none — for response-only steps)</option>
          <option value="create">Open a new case</option>
          <option value="attach">Continue existing case</option>
          <option value="review">Send to human review</option>
          <option value="ignore">Park (no case)</option>
        </select>
        <label>Then — reply action</label>
        <select name="reply_action" id="fp-reply">
          <option value="">(none)</option>
          <option value="draft">Draft for staff</option>
          <option value="hold">Hold for staff</option>
          <option value="approve">Draft for approval</option>
          <option value="send">Send (subject to gates)</option>
        </select>
        <label>Template</label>
        <select name="template_key" id="fp-template">
          <option value="">(no template)</option>
          ${templateOptions.map((t) => `<option value="${esc(t.key)}">${esc(t.name)}</option>`).join("")}
        </select>
        <div class="fp-row">
          <div>
            <label>Stage (optional)</label>
            <input name="stage" id="fp-stage" placeholder="e.g. awaiting_review">
          </div>
          <div>
            <label>Queue (optional)</label>
            <input name="queue" id="fp-queue" placeholder="e.g. human_review">
          </div>
        </div>
        <div class="fp-row">
          <div>
            <label>Priority</label>
            <select name="priority" id="fp-priority">
              <option value="">normal</option>
              <option value="high">high</option>
            </select>
          </div>
          <div>
            <label>Assign to</label>
            <select name="assign" id="fp-assign">
              <option value="">nobody</option>
              ${staff.map((s) => `<option value="${s.id}">${esc(s.display_name)}</option>`).join("")}
            </select>
          </div>
        </div>
        <div class="fp-row">
          <div>
            <label>SLA hours (optional)</label>
            <input type="number" min="1" name="sla_hours" id="fp-sla" placeholder="e.g. 48">
          </div>
          <div>
            <label>Attachment set (optional)</label>
            <input name="attachment_set" id="fp-attachset" placeholder="named set">
          </div>
        </div>
        <div class="fp-row">
          <div>
            <label>Reminder ladder</label>
            <select name="followup" id="fp-followup">
              <option value="">none</option>
              <option value="ladder">reminder ladder (${esc(c.repo.getSetting("followup_ladder_days", "3,7,10"))} days)</option>
            </select>
          </div>
          <div>
            <label>Each reminder</label>
            <select name="followup_action" id="fp-followup-action">
              <option value="hold">hold for staff</option>
              <option value="draft">draft for staff</option>
              <option value="approve">draft for approval</option>
              <option value="send">request send (gates still apply)</option>
              <option value="none">do nothing (cancel ladder)</option>
            </select>
          </div>
        </div>
        <details style="margin-top:12px">
          <summary class="small muted" style="cursor:pointer">Template by document state &amp; housekeeping</summary>
          <label>…when the file is complete</label>
          <select name="map_green" id="fp-map-green">
            <option value="">(no template)</option>
            ${templateOptions.map((t) => `<option value="${esc(t.key)}">${esc(t.name)}</option>`).join("")}
          </select>
          <label>…when no documents have arrived</label>
          <select name="map_empty" id="fp-map-empty">
            <option value="">(no template)</option>
            ${templateOptions.map((t) => `<option value="${esc(t.key)}">${esc(t.name)}</option>`).join("")}
          </select>
          <label>…when the checklist is incomplete</label>
          <select name="map_missing" id="fp-map-missing">
            <option value="">(no template)</option>
            ${templateOptions.map((t) => `<option value="${esc(t.key)}">${esc(t.name)}</option>`).join("")}
          </select>
          <label>If no template resolves</label>
          <select name="fallback" id="fp-fallback">
            <option value="human_draft">human draft (internal note)</option>
            <option value="none">do nothing</option>
          </select>
          <label>Audit code (optional)</label>
          <input name="audit_code" id="fp-audit" placeholder="e.g. rule_volunteer_intake">
          <label class="fp-check"><input type="checkbox" name="request_info" id="fp-request-info" value="1" style="width:auto"> List the missing documents in the reply</label>
        </details>
        <div class="fp-preserve" id="fp-preserve"></div>
        <div class="fp-actions">
          <button class="btn" type="submit">Save step</button>
          <button class="btn ghost" type="button" id="fp-cancel">Cancel</button>
          <button class="btn ghost" type="submit" formaction="/config/workflow-rules/delete" formmethod="post" id="fp-delete" style="margin-left:auto;color:var(--red)">Delete</button>
        </div>
      </form>
    </aside>
  </div>
</div>
<script>
(function () {
  var MAX = ${FLOW_MAX_CONDITIONS};
  var rules = ${rulesPayload};
  var editor = document.getElementById("flow-editor");
  if (!editor) return;
  var form = document.getElementById("flow-panel-form");
  var empty = document.getElementById("flow-panel-empty");
  var conds = document.getElementById("fp-conds");
  var preserve = document.getElementById("fp-preserve");
  var csrf = editor.getAttribute("data-csrf") || "";

  var FIELDS = ["always","sender_state","text","subject","body","has_attachments","docs_state","category","body_is_ref","signals"];
  var LABELS = {
    "": "(no condition)",
    always: "Any message",
    sender_state: "Sender is known / unknown",
    text: "Text contains words",
    subject: "Subject contains words",
    body: "Body contains words",
    has_attachments: "Has attachments",
    docs_state: "Documents state",
    category: "Category in list",
    body_is_ref: "Body is only a case reference",
    signals: "Built-in intake signals",
    never: "Never matches (park this rule)"
  };
  var HINTS = {
    sender_state: "known or unknown",
    has_attachments: "yes / no",
    docs_state: "complete, empty, missing, any, dirty",
    category: "comma-separated categories",
    text: "comma-separated words",
    subject: "comma-separated words",
    body: "comma-separated words"
  };

  var NEGATABLE = { text: 1, subject: 1, body: 1, category: 1 };

  function condRow(i) {
    var wrap = document.createElement("div");
    wrap.className = "fp-row fp-cond-row";
    wrap.setAttribute("data-cond-index", String(i));
    var sel = document.createElement("select");
    sel.name = "cond_field_" + i;
    sel.id = "fp-cond-field-" + i;
    Object.keys(LABELS).forEach(function (k) {
      if (i > 0 && k === "never") return; // "never" only makes sense as the sole condition
      var o = document.createElement("option");
      o.value = k; o.textContent = LABELS[k]; sel.appendChild(o);
    });
    var op = document.createElement("select");
    op.name = "cond_op_" + i;
    op.id = "fp-cond-op-" + i;
    [{ v: "", t: "matches" }, { v: "not", t: "does NOT match" }].forEach(function (o2) {
      var o = document.createElement("option");
      o.value = o2.v; o.textContent = o2.t; op.appendChild(o);
    });
    var inp = document.createElement("input");
    inp.name = "cond_value_" + i;
    inp.id = "fp-cond-value-" + i;
    inp.placeholder = "e.g. known · or words, comma-separated";
    wrap.appendChild(sel);
    wrap.appendChild(op);
    wrap.appendChild(inp);
    sel.addEventListener("change", function () {
      inp.placeholder = HINTS[sel.value] || "e.g. known · or words, comma-separated";
      // Negation only means something for word and category lists.
      op.style.display = NEGATABLE[sel.value] ? "" : "none";
      if (!NEGATABLE[sel.value]) op.value = "";
      sync();
    });
    conds.appendChild(wrap);
    return wrap;
  }

  function clearRow(i) {
    var sel = document.getElementById("fp-cond-field-" + i);
    var inp = document.getElementById("fp-cond-value-" + i);
    var op = document.getElementById("fp-cond-op-" + i);
    if (!sel) return;
    // A hidden input still submits, so clear it as well as hiding it —
    // parseRuleConditions skips a row whose field is empty.
    sel.value = "";
    inp.value = "";
    if (op) op.value = "";
    sel.parentNode.style.display = "none";
  }

  function visibleCount() {
    var n = 0;
    for (var i = 0; i < MAX; i++) {
      var w = conds.querySelector('[data-cond-index="' + i + '"]');
      if (w && w.style.display !== "none") n++;
    }
    return n;
  }

  /**
   * Two editing modes for conditions, and only one is ever submitted:
   *  - rows:  up to MAX condition rows (what almost every step needs);
   *  - json:  the raw array, for a step the rows cannot express (more than
   *           MAX conditions, or an operator the rows do not offer).
   * "never" is a third state that submits an empty array, so a step with no
   * conditions stays unable to match instead of becoming a catch-all (BUG-08).
   */
  function jsonMode() {
    var json = document.getElementById("fp-conditions-json");
    var wrap = document.getElementById("fp-json-wrap");
    var rows = document.getElementById("fp-conds");
    var add = document.getElementById("fp-cond-add");
    var remove = document.getElementById("fp-cond-remove");
    var first = document.getElementById("fp-cond-field-0");
    var isNever = first && first.value === "never";
    var isJson = !isNever && json.value.trim() !== "";
    if (wrap) wrap.open = isJson;
    if (rows) rows.style.display = isNever || isJson ? "none" : "";
    if (add) add.style.display = isNever || isJson ? "none" : "";
    if (remove) remove.style.display = isNever || isJson ? "none" : "";
    if (isNever) json.value = "[]";
    return { never: isNever, json: isJson };
  }

  function sync() {
    var state = jsonMode();
    var firstVal = document.getElementById("fp-cond-value-0");
    if (firstVal) {
      firstVal.style.display = state.never ? "none" : "";
      if (state.never) firstVal.value = "";
    }
    for (var i = 1; i < MAX; i++) {
      var w = conds.querySelector('[data-cond-index="' + i + '"]');
      if (!w) continue;
      if (state.never || state.json) { clearRow(i); }
      else if (w.style.display === "none" && document.getElementById("fp-cond-field-" + i).value) w.style.display = "";
    }
  }

  function showForm(rule, kind, scope) {
    empty.style.display = "none";
    form.style.display = "block";
    conds.innerHTML = "";
    document.getElementById("fp-id").value = rule && rule.id ? rule.id : "";
    document.getElementById("fp-kind").value = (rule && rule.kind) || kind || "intake";
    document.getElementById("fp-position").value = rule && rule.position != null ? rule.position : "";
    // BUG-06: a rule that is switched off stays switched off.
    document.getElementById("fp-enabled").value = rule ? (rule.enabled ? "1" : "0") : "1";
    document.getElementById("fp-conditions-json").value = "";
    document.getElementById("fp-name").value = rule && rule.name ? rule.name : (kind === "response" ? "New response step" : "New intake step");
    document.getElementById("fp-heading").textContent = rule && rule.id ? "Edit step" : "New step";
    document.getElementById("fp-sub").textContent = ((rule && rule.kind) || kind) === "response"
      ? "After documents are checked — choose how to reply."
      : "When mail arrives — decide if it becomes a case.";
    var ct = document.getElementById("fp-case-type");
    var wantScope = rule && rule.case_type_id != null ? String(rule.case_type_id) : (scope || "");
    ct.value = wantScope;
    if (ct.value !== wantScope) ct.value = "";

    // Conditions: every stored condition gets its own row, so nothing is
    // dropped on save (BUG-04). An empty condition list is preserved as
    // "never matches" (BUG-08) instead of being upgraded to "any message".
    // A step the rows cannot express opens in the raw-JSON box instead of
    // being refused — flagging it and walking away left it uneditable here.
    var stored = (rule && rule.conditions) || [];
    var rowAble = stored.length <= MAX && stored.every(function (c) { return FIELDS.includes(String(c.field)); });
    if (stored.length && !rowAble) {
      document.getElementById("fp-conditions-json").value = JSON.stringify(stored, null, 2);
    }
    for (var i = 0; i < MAX; i++) {
      var row = condRow(i);
      var cond = rowAble ? stored[i] : undefined;
      if (cond) {
        var sel = document.getElementById("fp-cond-field-" + i);
        var opSel = document.getElementById("fp-cond-op-" + i);
        if (!FIELDS.includes(String(cond.field))) { clearRow(i); continue; }
        sel.value = String(cond.field);
        var val = "";
        if (cond.field === "sender_state") val = cond.value || "unknown";
        else if (cond.field === "has_attachments") val = cond.value ? "yes" : "no";
        else if (cond.values) val = (cond.values || []).join(", ");
        else if (cond.value != null && cond.field !== "always") val = String(cond.value);
        document.getElementById("fp-cond-value-" + i).value = val;
        if (opSel) {
          var neg = cond.op === "not_contains" || cond.op === "not_in";
          opSel.value = neg ? "not" : "";
          opSel.style.display = NEGATABLE[cond.field] ? "" : "none";
        }
        row.style.display = "";
      } else if (i === 0 && !stored.length) {
        document.getElementById("fp-cond-field-0").value = "never";
        row.style.display = "";
      } else {
        row.style.display = "none";
      }
    }
    if (!stored.length) document.getElementById("fp-cond-field-0").value = "never";
    sync();

    // Actions: every field the engine understands has a real input here, so
    // a save from this panel can neither reset nor silently preserve a
    // setting the administrator never saw.
    var act = (rule && rule.action) || {};
    var set = function (id, value) { var el = document.getElementById(id); if (el) el.value = value == null ? "" : String(value); };
    set("fp-decision", act.decision || "");
    set("fp-reply", act.reply_action || "");
    set("fp-template", act.template_key || "");
    set("fp-stage", act.stage || "");
    set("fp-queue", act.queue || "");
    set("fp-sla", act.sla_hours == null ? "" : act.sla_hours);
    set("fp-attachset", act.attachment_set || "");
    set("fp-priority", act.priority || "");
    set("fp-assign", act.assign == null || act.assign === "none" ? "" : act.assign);
    set("fp-followup", act.followup || "");
    set("fp-followup-action", act.followup_action || "hold");
    set("fp-fallback", act.fallback || "human_draft");
    set("fp-audit", act.audit_code || "");
    set("fp-map-green", (act.template_map && act.template_map.green) || "");
    set("fp-map-empty", (act.template_map && act.template_map.empty) || "");
    set("fp-map-missing", (act.template_map && act.template_map.missing) || "");
    var reqInfo = document.getElementById("fp-request-info");
    if (reqInfo) reqInfo.checked = act.request_info === true;

    var noted = [];
    if (stored.length && !rowAble) noted.push("its conditions are shown as raw JSON below");
    if (act.sla_hours != null) noted.push("SLA " + act.sla_hours + "h");
    if (act.attachment_set) noted.push("attachment set “" + act.attachment_set + "”");
    if (act.followup === "ladder") noted.push("reminder ladder");
    if (act.template_map) noted.push("green/empty/missing template map");
    if (act.audit_code) noted.push("audit code " + act.audit_code);
    preserve.innerHTML = noted.length
      ? '<p class="small muted" style="margin:10px 0 0">This step has: ' + noted.map(function (s) { return document.createTextNode(s).nodeValue; }).join(" · ") + '.</p>'
      : "";

    document.getElementById("fp-delete").style.display = rule && rule.id ? "inline-flex" : "none";
    document.querySelectorAll(".flow-node.editable").forEach(function (n) {
      n.classList.toggle("selected", rule && rule.id && n.getAttribute("data-rule-id") === String(rule.id));
    });
    document.getElementById("fp-name").focus();
  }
  }

  function hideForm() {
    form.style.display = "none";
    empty.style.display = "block";
    document.querySelectorAll(".flow-node.selected").forEach(function (n) { n.classList.remove("selected"); });
  }

  editor.addEventListener("click", function (e) {
    var addBtn = e.target.closest("[data-add]");
    if (addBtn) {
      // The add bar under each chain carries its own scope picker, so the very
      // first step in a scope is creatable from the diagram — a group only
      // exists once it owns a rule, which used to leave an empty workspace
      // with an instruction pointing at a button that was never rendered.
      var source = addBtn.getAttribute("data-scope-source");
      var scope = source
        ? (document.getElementById(source) || {}).value || ""
        : addBtn.getAttribute("data-scope") || "";
      showForm(null, addBtn.getAttribute("data-add"), scope);
      return;
    }
    var node = e.target.closest(".flow-node.editable");
    if (!node) return;
    var id = Number(node.getAttribute("data-rule-id"));
    var rule = rules.find(function (r) { return r.id === id; });
    if (!rule) return;
    showForm(rule, rule.kind, "");
  });

  // BUG-09: the nodes claim to be buttons (role="button", tabindex="0"), so
  // they have to respond to the keyboard as well as the mouse.
  editor.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
    var node = e.target.closest && e.target.closest(".flow-node.editable");
    if (!node) return;
    e.preventDefault();
    node.click();
  });

  document.getElementById("fp-cond-add").addEventListener("click", function () {
    for (var i = 0; i < MAX; i++) {
      var w = conds.querySelector('[data-cond-index="' + i + '"]');
      if (w && w.style.display === "none") {
        w.style.display = "";
        document.getElementById("fp-cond-field-" + i).value = "";
        document.getElementById("fp-cond-value-" + i).value = "";
        var op = document.getElementById("fp-cond-op-" + i);
        if (op) { op.value = ""; op.style.display = "none"; }
        document.getElementById("fp-cond-value-" + i).focus();
        this.disabled = false;
        return;
      }
    }
    this.disabled = true;
  });

  // Typing in the raw-JSON box switches the panel to JSON mode (and emptying
  // it switches back), so the two editors can never both be submitted.
  document.getElementById("fp-conditions-json").addEventListener("input", function () { sync(); });

  document.getElementById("fp-cond-remove").addEventListener("click", function () {
    if (visibleCount() <= 1) return;
    for (var i = MAX - 1; i >= 0; i--) {
      var w = conds.querySelector('[data-cond-index="' + i + '"]');
      if (w && w.style.display !== "none") { clearRow(i); return; }
    }
  });

  document.getElementById("fp-cancel").addEventListener("click", function (e) {
    e.preventDefault();
    hideForm();
  });
})();
</script>
`;
  return `${flowchartHtml}
${profileCard}
<details class=\"card\" style=\"padding:16px 20px\">
  <summary style=\"cursor:pointer;font-weight:750\">Advanced — rule table &amp; full form</summary>
  <p class=\"small muted\">Use the flowchart above for everyday edits. This table and form are for power users (JSON conditions, SLA, attachment sets, preview).</p>
  <h2>Intake rules</h2>
  ${ruleTable("intake")}
  <h2 style=\"margin-top:22px\">Response rules</h2>
  ${ruleTable("response")}
  ${form}
</details>`;
}

function configurationChecklist(c: Ctx): string {
  const orgId = c.user.organization_id ?? 1;
  const types = c.repo.listCaseTypes(orgId);
  const docs = types.reduce((n, type) => n + c.repo.listDocumentDefinitions(type.id).length, 0);
  const rules = types.filter((type) => c.repo.caseTypeRules(type).length > 0).length;
  const templates = c.repo.listTemplates(orgId).length;
  const hasGmail = c.repo.getSetting("gmail_disabled", "") !== "1" &&
    Boolean(c.repo.getSetting("gmail_address", "").trim() && c.repo.getSetting("gmail_client_id", "").trim() && c.repo.hasSecret("gmail_client_secret") && c.repo.hasSecret("gmail_refresh_token"));
  const hasGemini = c.repo.hasSecret("gemini_api_key");
  const checks: Array<{ label: string; detail: string; href: string; done: boolean }> = [
    { label: "Name the organization", detail: "Give the workspace its identity", href: "/settings#organization", done: Boolean(c.institution && c.institution !== "Organization") },
    { label: "Create a case type", detail: "For example, Job application or Registration", href: "/config?tab=case-types", done: types.length > 0 },
    { label: "Add the document checklist", detail: "Define what contacts must provide", href: "/config?tab=case-types", done: docs > 0 },
    { label: "Define the requirements rules", detail: "Rules stay deterministic; uncertain cases go to staff", href: "/config?tab=case-types", done: rules > 0 },
    { label: "Review response templates", detail: `${templates} template${templates === 1 ? "" : "s"} available`, href: "/templates", done: templates > 0 },
    { label: "Connect Gmail", detail: "Use Gmail as an intake channel", href: "/settings#connections", done: hasGmail },
    { label: "Add Gemini (optional)", detail: "Classify messy messages and documents first", href: "/settings#gemini", done: hasGemini },
  ];
  const complete = checks.filter((item) => item.done).length;
  return `<section class="readiness-card" aria-label="Configuration checklist">
    <div class="readiness-head"><div><span class="kicker">READY WHEN YOU ARE</span><h2>Configuration checklist</h2><p class="small muted">Complete these in order. The console will not reject a contact automatically; incomplete or uncertain cases stay with a human.</p></div><div class="readiness-progress"><strong>${complete}/${checks.length}</strong><span>ready</span></div></div>
    <div class="readiness-list">${checks.map((item, index) => `<a href="${item.href}" class="readiness-item ${item.done ? "done" : ""}"><span class="readiness-number">${item.done ? "✓" : index + 1}</span><span><strong>${item.label}</strong><small>${item.detail}</small></span><span class="readiness-arrow">→</span></a>`).join("")}</div>
  </section>`;
}

export function configPage(c: Ctx, _selectedTemplate?: string, flash?: string, reqsTarget?: string, tabChoice?: string, reqsWorkspace?: string, caseTypesOrganizationId?: number, editRuleId?: number): string {

  // Round 3: the legacy courses tab is gone — case types are configured under
  // Configuration; /config?tab=courses redirects to the staff area.
  // Branding on this page (signature, banner) belongs to the signed-in
  // administrator's organization, so it is read and written per tenant.
  const settingsOrgId = c.user.organization_id ?? 1;
  const tab = tabChoice === "replies" || tabChoice === "pack" || tabChoice === "requirements" || tabChoice === "rules" ? tabChoice : "case-types";
  const tabBar = `<div class="tabs" style="margin:0 0 20px">
    <a href="/config?tab=case-types" class="${tab === "case-types" ? "on" : ""}">CaseTypes</a>
    <a href="/config?tab=rules" class="${tab === "rules" ? "on" : ""}">Workflow rules</a>
    <a href="/config?tab=requirements" class="${tab === "requirements" ? "on" : ""}">Requirements &amp; repairs</a>
    <a href="/config?tab=replies" class="${tab === "replies" ? "on" : ""}">Reply configuration</a>
    <a href="/config?tab=pack" class="${tab === "pack" ? "on" : ""}">Document library</a>
  </div>`;

  // Round 11: the pack files have their OWN tab (they were hiding inside
  // "Reply configuration", which is why staff thought they couldn't be
  // changed).
  // ── Reply behaviour ────────────────────────────────────────────────────
  // These are the four dials that decide what a reply looks like, who it
  // comes from, how fast it is due and whether it may leave without a human.
  // They used to live only under Settings, which left "Reply configuration"
  // with a signature box and a link — the most-asked-about screen in the
  // product with almost nothing on it. Same endpoints, so there is still one
  // source of truth for each value.
  const org = c.repo.getOrganization(settingsOrgId);
  const automation = c.repo.getSetting("automation_mode", "draft");
  const replyBehaviourHtml = `
<div class="card" id="reply-identity">
  <h2>Who the reply is from</h2>
  <p class="small muted" style="margin-top:-6px">Applied to every message this workspace sends — automated replies, reminders, approved drafts and manual replies alike. Also editable under <a href="/settings#letters">Settings → Letters &amp; identity</a>.</p>
  <form method="post" action="/settings/organization">
    <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
    <input type="hidden" name="organization_name" value="${esc(org?.name ?? c.institution)}">
    <input type="hidden" name="primary_color" value="${esc(org ? organizationTheme(c.repo, settingsOrgId).primary : "#3b1d5f")}">
    <input type="hidden" name="accent_color" value="${esc(org ? organizationTheme(c.repo, settingsOrgId).accent : "#9a78c7")}">
    <input type="hidden" name="ref_prefix" value="${esc(org?.ref_prefix ?? c.repo.organizationRefPrefix(settingsOrgId))}">
    <input type="hidden" name="locale" value="${esc(org?.locale ?? "")}">
    <input type="hidden" name="timezone" value="${esc(org?.timezone ?? "")}">
    <div class="formrow">
      <div><label>From name on outgoing mail</label><input name="from_name" value="${esc(org?.from_name ?? "")}" placeholder="${esc(org?.name ?? c.institution)}"></div>
      <div><label>Reply-to address</label><input name="reply_to" value="${esc(org?.reply_to ?? "")}" placeholder="replies land in the sending mailbox"></div>
      <div style="flex:0"><label>&nbsp;</label><button class="btn small">Save sender identity</button></div>
    </div>
  </form>
  <p class="small muted" style="margin-bottom:0">Leave the From name empty to keep the sending mailbox's own name; leave Reply-to empty to keep replies on the sending mailbox. The name signed at the bottom of a message is <b>${esc(c.repo.getSetting("institution_name", org?.name ?? c.institution))}</b> — change it under <a href="/settings#letters">Settings → Letters &amp; identity</a>.</p>
</div>

<div class="card" id="reply-targets">
  <h2>How fast a reply is due</h2>
  <p class="small muted" style="margin-top:-6px">The SLA clock on every queued case, when a slow case is escalated, and the reminder ladder for missing documents. Also editable under <a href="/settings#sla">Settings → Response targets</a>.</p>
  <form method="post" action="/settings/general">
    <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
    <div class="formrow">
      <div><label>SLA target (hours to first response)</label><input name="sla_target_hours" value="${esc(c.repo.getSetting("sla_target_hours", "4"))}"></div>
      <div><label>Escalation (hours before escalation)</label><input name="escalation_hours" value="${esc(c.repo.getSetting("escalation_hours", "8"))}"></div>
      <div><label>Unanswered target (hours)</label><input name="unanswered_target_hours" value="${esc(c.repo.getSetting("unanswered_target_hours", "4"))}"></div>
      <div><label>Reminder sequence (days, e.g. 3,7,10)</label><input name="followup_ladder_days" value="${esc(c.repo.getSetting("followup_ladder_days", "3,7,10"))}"></div>
      <div style="flex:0"><label>&nbsp;</label><button class="btn small">Save response targets</button></div>
    </div>
  </form>
</div>

<div class="card" id="reply-automation">
  <h2>Automatic sending</h2>
  <p class="small muted" style="margin-top:-6px">Two switches, both safe by default. The global dial starts on <b>draft</b> — nothing leaves without a person — and releasing it is not enough on its own: a category must also be on the allow-list below. A case that is not fully qualified <b>never</b> gets an automatic reply, whatever these say.</p>
  <form method="post" action="/settings/automation/global" class="formrow" style="align-items:end">
    <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
    <div><label>Global mode</label><select name="mode">
      <option value="auto" ${automation === "auto" ? "selected" : ""}>auto — only the categories allow-listed below may send</option>
      <option value="draft" ${automation === "draft" ? "selected" : ""}>draft — hold EVERY automated reply for approval</option>
    </select></div>
    <div style="flex:0"><label>&nbsp;</label><button class="btn small">Apply global mode</button></div>
  </form>
  <table style="margin-top:14px"><tr><th>Message category</th><th>Mode</th><th></th></tr>
    ${EMAIL_CATEGORIES.map((cat) => {
      const mode = c.repo.automationMode(cat);
      return `<tr><td>${esc(cat.replace(/_/g, " "))}</td>
      <td><span class="badge ${mode === "auto" ? "b-green" : "b-orange"}">${mode === "auto" ? "automatic sending" : "draft for approval"}</span></td>
      <td><form method="post" action="/settings/automation/category" style="margin:0">
        <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
        <input type="hidden" name="category" value="${esc(cat)}">
        <button class="btn small ghost" name="mode" value="${mode === "auto" ? "draft" : "auto"}">switch to ${mode === "auto" ? "draft" : "auto"}</button>
      </form></td></tr>`;
    }).join("")}
  </table>
  <p class="small muted" style="margin-bottom:0">With the global mode on draft, the per-category switches take effect once it returns to auto.</p>
</div>

<div class="card" id="reply-sources">
  <h2>Where the wording and the routing come from</h2>
  <p class="small muted" style="margin-top:-6px">A reply is a template chosen by a workflow rule. Both are configured elsewhere; these are the two doors.</p>
  <p style="display:flex;gap:8px;flex-wrap:wrap;margin:4px 0 0">
    <a class="btn ghost small" href="/templates">Templates — the words</a>
    <a class="btn ghost small" href="/config?tab=rules">Workflow rules — which template, when</a>
    <a class="btn ghost small" href="/settings#categories">Message categories</a>
  </p>
</div>`;

  const replyHtml = `
<div class="card" id="templates-home">
  <h2>Email templates</h2>
  <p class="small muted" style="margin-top:-6px">OR-7: every outgoing email type | automated replies, reminders and staff messages | is edited in the dedicated <a href="/templates">Templates section</a>, with placeholders documented, a live preview, return to the default and optional pack attachments.</p>
  <p><a class="btn" href="/templates">Open the Templates section →</a></p>
</div>

<div class="card" id="branding">
  <h2>Email branding</h2>
  <p class="small muted" style="margin-top:-6px">The banner below is placed at the top of <b>every</b> outgoing email — automated replies, template sends and document packs alike. Replace it any time; individual templates can also opt out in the editor above.</p>
  <img id="banner-preview" src="/assets/email-banner" alt="Email banner" style="width:100%;max-width:720px;border:1px solid var(--plum-line);border-radius:8px;display:block">
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

<div class="card" id="signature">
  <h2>Email signature</h2>
  <p class="small muted" style="margin-top:-6px">Shown under every outgoing reply (name, title, phone, extra line). Leave blank to use the organization name only.</p>
  <form method="post" action="/config/branding/signature">
    <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
    <div class="formrow">
      <div><label>Name</label><input name="signature_name" value="${esc(orgSetting(c.repo, "signature_name", settingsOrgId))}" placeholder="e.g. Jane Wanjiku"></div>
      <div><label>Title</label><input name="signature_title" value="${esc(orgSetting(c.repo, "signature_title", settingsOrgId))}" placeholder="e.g. Operations lead"></div>
    </div>
    <div class="formrow">
      <div><label>Phone</label><input name="signature_phone" value="${esc(orgSetting(c.repo, "signature_phone", settingsOrgId))}" placeholder="+254 …"></div>
      <div><label>Extra line</label><input name="signature_line" value="${esc(orgSetting(c.repo, "signature_line", settingsOrgId))}" placeholder="Optional"></div>
    </div>
    <p style="margin-top:12px"><button class="btn">Save signature</button></p>
  </form>
</div>

<div class="card" id="classifier">
  <h2>Classifier guidance (Gemini)</h2>
  <p class="small muted" style="margin-top:-6px">Optional free-text instructions for what Gemini should look for when labelling incoming mail. Categories still come from Settings; this only steers the model. Leave blank for default behaviour.</p>
  <form method="post" action="/config/classifier-prompt">
    <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
    <label>Prompt / guidance</label>
    <textarea name="classifier_prompt" rows="4" style="width:100%" placeholder="e.g. Prefer document_submission when PDFs are attached. Treat short status questions as follow_up.">${esc(c.repo.getSetting("classifier_prompt", ""))}</textarea>
    <p style="margin-top:12px"><button class="btn">Save classifier guidance</button></p>
  </form>
</div>

<div class="card" id="export">
  <h2>Export (CSV)</h2>
  <p style="display:flex;gap:8px;flex-wrap:wrap;margin:4px 0 0">
    <a class="btn ghost small" href="/export/applicants.csv">Cases</a>
    <a class="btn ghost small" href="/export/queue.csv">Review queue</a>
    <a class="btn ghost small" href="/export/audit.csv">Audit record</a>
  </p>
</div>`;

  return head(
    c,
    "Configuration",
    "config",
    `
<h1>Configuration</h1>
<div class="sub">Requirements, deadlines and reply behaviour | case type configuration (checklists, rules, windows) lives under <a href="/config?tab=case-types">Case types</a>. Changes apply to newly processed email immediately.</div>
${flash ? `<div class="flash ok" style="position:static;margin-bottom:16px">${esc(flash)}</div>` : ""}
${configurationChecklist(c)}
${tabBar}
${tab === "rules" ? workflowRulesTab(c, editRuleId) : tab === "case-types" ? caseTypesTab(c, caseTypesOrganizationId) : tab === "pack" ? attachmentSetsCard(c) + documentsPackCard(c) : tab === "requirements" ? requirementsTab(c, reqsTarget, reqsWorkspace) : replyBehaviourHtml + replyHtml}
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
  generic_enquiry: "Fallback reply SUGGESTED to staff when a rule-driven case type has a reply gap (or a rule's fallback names it) — queued for approval like every human-bound draft, never sent automatically.",
};

const PLACEHOLDER_DOCS: Array<[string, string]> = [
  ["{ref}", "the case reference number"],
  ["{name}", "full name (falls back to “Correspondent”)"],
  ["{first_name}", "first name only"],
  ["{missing_docs}", "bulleted list of still-missing documents"],
  ["{missing_docs_section}", "the missing list wrapped in a polite paragraph"],
  ["{checklist}", "the full requirement checklist with ✓ / ✗ per item"],
  ["{status}", "current lifecycle status in plain language"],
  ["{institution}", "the organization name"],
  ["{case_type}", "the configured case type"],
  ["{category}", "the case category"],
  ["{read_back}", "document receipt information, when available"],
  ["{document_issues}", "per-document quality issues (unreadable pages etc.)"],
];

function placeholderDocsFor(_c: Ctx): Array<[string, string]> { return PLACEHOLDER_DOCS; }

export function templatesPage(c: Ctx, selectedKey?: string, flash?: string): string {
  const { repo } = c;
  const templates = repo.listTemplates(c.user.organization_id ?? 1);
  const emptyTemplate = { key: "generic", name: "Generic reply", subject: "Your enquiry", body: "Hello {name},\\n\\nThank you for contacting {institution}. We will review your enquiry and reply shortly.\\n\\nKind regards,\\n{institution}", include_banner: 0, attach_pack: "none", case_type_id: 0 };
  const tpl = (selectedKey ? templates.find((t) => t.key === selectedKey) : undefined) ?? templates[0] ?? emptyTemplate;

  const picker = `<form class="inline" method="get" action="/templates" style="margin-bottom:6px">
    <label class="small muted">Template</label>
    <select name="template" onchange="this.form.submit()">
      ${templates.map((t) => `<option value="${esc(t.key)}" ${tpl.key === t.key ? "selected" : ""}>${esc(t.name)} (${esc(t.key)})</option>`).join("")}
    </select>
  </form>`;

  const usage = TEMPLATE_USAGE[tpl.key] ?? "Manual staff reply.";
  const packFlag = tpl.attach_pack ?? "none";

  // Live preview against a sample contact — exactly what renderTemplate
  // will produce, so staff see the real output before anyone receives it.
  const inspection = inspectTemplate(`${tpl.subject}\n${tpl.body}`);
  let preview: { subject: string; body: string };
  try {
    preview = renderTemplate(tpl.subject, tpl.body, {
      ref: `${repo.organizationRefPrefix(c.user.organization_id ?? 1)}-${new Date().getFullYear()}-000001`,
      institution: c.institution,
      name: "Alex Morgan",
      missingLabels: ["Identity document", "Request form"],
      checklist: "✓ Supporting information\n✗ Identity document\n✗ Request form",
      statusLabel: "Documents received",
      caseType: "Service request",
      readBack: "Your information was received and read successfully.",
      documentIssues: "",
    });
  } catch (error) {
    preview = { subject: "Preview unavailable", body: error instanceof Error ? error.message : String(error) };
  }
  const unknown = inspection.unknownTokens.map((token) => `{${token}}`);
  const partialProblems = [
    ...inspection.unknownPartials.map((partial) => `{{> ${partial}}}`),
    ...inspection.malformedIncludes,
  ];

  const editor = `<form method="post" action="/templates/save">
    <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
    <input type="hidden" name="key" value="${esc(tpl.key)}">
    <label>Display name</label><input type="text" name="name" value="${esc(tpl.name)}">
    <label>Subject (the reference number is prepended automatically)</label><input type="text" name="subject" value="${esc(tpl.subject)}">
    <label>Body</label><textarea name="body" style="min-height:260px">${esc(tpl.body)}</textarea>
    <div class="formrow" style="margin-top:10px">
      <div><label>Attach an attachment set</label><select name="attach_pack">
        <option value="none" ${packFlag === "none" ? "selected" : ""}>No attachments</option>
        ${c.repo.listAttachmentSets(c.user.organization_id ?? 1).map((s) => `<option value="${esc(s.name)}" ${packFlag === s.name ? "selected" : ""}>${esc(s.name)} (${s.file_count} file${s.file_count === 1 ? "" : "s"})</option>`).join("")}
        ${c.repo.listAttachmentSets(c.user.organization_id ?? 1).map((set) => set.name).filter((legacy) => packFlag === legacy && !c.repo.listAttachmentSets(c.user.organization_id ?? 1).some((s) => s.name === legacy)).map((legacy) => `<option value="${legacy}" selected>${legacy} (missing set — create it in the Document library)</option>`).join("")}
      </select></div>
      <div style="flex:2"><label>&nbsp;</label><span class="small muted">Applies to automated and manual sends alike. Sets are managed in Configuration → Document library. Missing set files are audited, never skipped silently.</span></div>
    </div>
    <label style="display:flex;gap:8px;align-items:center;margin-top:8px"><input type="checkbox" name="include_banner" style="width:auto" ${tpl.include_banner === 0 ? "" : "checked"}> Attach the email banner to this template</label>
    <div style="display:flex;gap:10px;margin-top:14px;align-items:center">
      <button class="btn">Save template</button>
    </div>
    <div class="formrow" style="margin-top:10px">
      <div><label>Belongs to profile</label>
        <select name="case_type_id">
          <option value="0" ${!tpl.case_type_id ? "selected" : ""}>Across the organization (all profiles)</option>
          ${c.repo.listCaseTypes(c.user.organization_id ?? 1).map((t) => `<option value="${t.id}" ${tpl.case_type_id === t.id ? "selected" : ""}>${esc(t.name)} (${esc(t.code)})</option>`).join("")}
        </select></div>
      <div style="flex:2"><label>&nbsp;</label><span class="small muted">A profile specific template is used only for that profile's cases. Keys are not a fixed list | create whatever a profile needs below.</span></div>
    </div>
  </form>
  <form method="post" action="/templates/reset" style="margin-top:10px" onsubmit="return confirm('Reset this template to its own saved default? Your edits will be lost.')">
    <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
    <input type="hidden" name="key" value="${esc(tpl.key)}">
    <button class="btn ghost">Reset to this template's own default</button>
  </form>
  <details style="margin-top:14px"><summary class="small" style="cursor:pointer">Create a new template key</summary>
    <form method="post" action="/templates/create" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-top:8px">
      <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
      <div class="field" style="min-width:180px"><span class="lbl">Machine key</span><input name="key" required placeholder="e.g. scholarship_reply"></div>
      <div class="field" style="min-width:180px"><span class="lbl">Display name</span><input name="name" required placeholder="e.g. Scholarship reply"></div>
      <div class="field" style="min-width:180px"><span class="lbl">Belongs to profile</span>
        <select name="case_type_id">
          <option value="0">Across the organization (all profiles)</option>
          ${c.repo.listCaseTypes(c.user.organization_id ?? 1).map((t) => `<option value="${t.id}">${esc(t.name)} (${esc(t.code)})</option>`).join("")}
        </select></div>
      <button class="btn">Create template</button>
    </form>
  </details>`;

  const list = templates.map((t) => `<tr>
      <td><a href="/templates?template=${encodeURIComponent(t.key)}#tpl-${esc(t.key)}"><b>${esc(t.name)}</b></a><br><span class="mono small muted">${esc(t.key)}</span></td>
      <td class="small muted">${esc(TEMPLATE_USAGE[t.key] ?? "Manual staff reply.")}</td>
      <td>${!t.attach_pack || t.attach_pack === "none" ? `<span class="muted small">Not recorded</span>` : `<span class="badge b-purple">${esc(t.attach_pack)} set</span>`}</td>
    </tr>`).join("");

  return head(
    c,
    "Templates",
    "templates",
    `
<div class="hero">
  <h1>Templates</h1>
  <div class="sub">Every email this system sends — automated replies, reminders and staff messages — is built from one of these templates. Edit the words, pick the attachments, reset any time.</div>
</div>
${flash ? `<div class="flash">${esc(flash)}</div>` : ""}

${templates.length === 0 ? `<section class="card" id="templates-empty">
  <h2>No reply templates yet</h2>
  <p class="small muted">This organization has no outgoing wording, so <b>nothing can be replied — automatically or from a case</b>. The pipeline holds every case for a person and says why in the audit trail.</p>
  <p class="small muted">Add the neutral starter set — the seven keys the pipeline and workflow rules refer to (information received, missing information, information request, case status, under review, verification, general enquiry) — then edit every line. Starter copy is a starting point, not your voice; each template can also be reset to its own default later.</p>
  <form method="post" action="/templates/seed-starters" style="margin:12px 0">
    <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
    <button class="btn">Add the starter templates</button>
  </form>
  <p class="small muted">Or create one template of your own with the form below.</p>
</section>` : ""}
<section class="card nopad">
  <div class="card-head"><h2>All outgoing types</h2></div>
  <table><tr><th>Template</th><th>Who sends it</th><th>Attachments</th></tr>${list}</table>
</section>

<section class="card nopad" id="tpl-${esc(tpl.key)}">
  <div class="card-head"><h2>Edit — ${esc(tpl.name)}</h2></div>
  <div style="padding:16px 24px 22px">
    ${picker}
    <p class="small muted" style="margin-top:6px"><b>Who sends this:</b> ${esc(usage)}</p>
    ${unknown.length ? `<div class="flash err" style="position:static;margin:10px 0">Unknown placeholder${unknown.length === 1 ? "" : "s"} in this template: ${unknown.map(esc).join(", ")} — contacts will see it as literal text.</div>` : ""}
    ${partialProblems.length ? `<div class="flash err" style="position:static;margin:10px 0">Invalid partial include${partialProblems.length === 1 ? "" : "s"}: ${partialProblems.map(esc).join(", ")} — preview is disabled and the template must be corrected before it can be saved.</div>` : ""}
    <div style="display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:22px">
      <div>${editor}</div>
      <div>
        <h3 style="margin:0 0 6px;font-size:13px">Preview (sample contact)</h3>
        <div id="tpl-preview" class="small" style="border:1px solid var(--line2);border-radius:8px;padding:12px;background:var(--card2);white-space:pre-wrap;line-height:1.6"><b>${esc(preview.subject)}</b>\n\n${esc(preview.body)}</div>
        <h3 style="margin:16px 0 6px;font-size:13px">Placeholders</h3>
        <table><tr><th>Token</th><th>Filled with</th></tr>
          ${placeholderDocsFor(c).map(([k, v]) => `<tr><td class="mono small">${esc(k)}</td><td class="small muted">${esc(v)}</td></tr>`).join("")}
        </table>
        <h3 style="margin:16px 0 6px;font-size:13px">Reusable partials</h3>
        <p class="small muted">Insert a shared fragment with <span class="mono">{{&gt; partial_name}}</span>. Partials may contain placeholders and are composed before values are filled.</p>
        <table><tr><th>Include</th><th>Renders</th></tr>
          ${TEMPLATE_PARTIAL_DOCS.map(([name, detail]) => `<tr><td class="mono small">${esc(`{{> ${name}}}`)}</td><td class="small muted">${esc(detail)}</td></tr>`).join("")}
        </table>
      </div>
    </div>
  </div>
</section>`
  );
}

// ── Staff (team performance + account management, merged) ──────────────────

// OR-8: the ONE place visibility scopes are edited | a staff × case type
// matrix. Each row saves the member's ENTIRE case type set in a single action;
// tick nothing and save for no access, or press "Restore full visibility".
function scopeMatrix(c: Ctx): string {
  const { repo } = c;
  // H-2: the matrix lists the acting organization's members and case types.
  const orgId = c.user.organization_id ?? 1;
  const caseTypes = repo.listCaseTypes(orgId);
  const members = repo.listStaff(orgId).filter((m) => m.active);
  const rows = members.map((m) => {
    if (m.role === "admin") {
      return `<tr>
        <td><b>${esc(m.display_name)}</b><br><span class="muted small">@${esc(m.username)}</span></td>
        <td colspan="${caseTypes.length + 1}"><span class="badge b-purple">admin</span> <span class="small muted">always sees every case type — admins cannot be scoped</span></td>
      </tr>`;
    }
    const current = new Set(repo.caseTypeScopesFor(m.id));
    const mode = repo.caseTypeScopeModeFor(m.id);
    const state = mode === "none" ? "no access" : mode === "scoped" ? "assigned case types only" : "unscoped — sees everything";
    return `<tr>
      <td><b>${esc(m.display_name)}</b><br><span class="muted small">@${esc(m.username)}</span></td>
      <form method="post" action="/staff/scopes"><td colspan="${caseTypes.length + 1}" style="display:table-cell">
        <div style="display:flex;flex-wrap:wrap;gap:10px 18px;align-items:center">
          <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
          <input type="hidden" name="staff_id" value="${m.id}">
          ${caseTypes.map((t) => `<label style="display:flex;gap:6px;align-items:center"><input type="checkbox" name="case_types" value="${esc(t.code)}" style="width:auto" ${current.has(t.code.toUpperCase()) ? "checked" : ""}> ${esc(t.name)}</label>`).join("")}
          <button class="btn small ghost">Save assigned case types</button>
          <button class="btn small ghost" name="scope_mode" value="unscoped">Restore full visibility</button>
          <span class="muted small">${esc(state)}</span>
        </div>
      </td></form>
    </tr>`;
  }).join("");
  return `<section class="card nopad" id="scopes">
    <div class="card-head"><h2>Visibility scope</h2></div>
    <p class="small muted" style="padding:0 24px;margin:8px 0 0">Tick the case types each officer handles and press <b>Save assigned case types</b> — one action per person. From then on they see only cases of those types, everywhere: queues, levels, search, direct links and the API. Saving an empty selection gives <b>no case access</b>; use <b>Restore full visibility</b> when that is intentional. Case types are managed in <a href="/config?tab=case-types">Configuration</a>.</p>
    ${caseTypes.length ? `<table><tr><th>Member of staff</th><th>Case types they may see</th></tr>${rows}</table>` : `<div class="empty"><p>Create a case type in Configuration first | scopes are case types.</p></div>`}
  </section>`;
}

function workflowConfigHtml(c: Ctx): string {
  return `<section class="card"><h2>Workflow configuration</h2><p class="small muted">Case types, document requirements, routing rules and stages are owned by the organization.</p><a class="btn ghost" href="/config?tab=case-types">Configure case types</a><p>${c.repo.listCaseTypes(c.user.organization_id ?? 1).length} configured case types.</p></section>`;
}


export function staffPage(c: Ctx, flash?: string, resetCode?: string): string {
  const { repo } = c;
  const isAdmin = c.user.role === "admin";

  // H-2: the staff surface resolves against the ACTING admin's organization.
  const orgId = c.user.organization_id ?? 1;
  const stats = repo.staffStats(c.user.demo, orgId);
  const totals = stats.reduce(
    (acc, r) => ({ received: acc.received + r.emailsReceived, sent: acc.sent + r.emailsSent, completed: acc.completed + r.casesCompleted }),
    { received: 0, sent: 0, completed: 0 }
  );
  const perfRows = stats
    .map((r) => `<tr>
      <td>${avatar(r.display_name, 28)} <b>${esc(r.display_name)}</b><br><span class="muted small">@${esc(r.username)} · ${esc(r.role)}${r.active ? "" : " · disabled"}</span></td>
      <td>${r.assignedCases}</td>
      <td>${r.emailsReceived}</td>
      <td>${r.emailsSent}</td>
      <td>${r.avgResponseMinutes === null ? `<span class="muted">Not recorded</span>` : esc(formatDuration(r.avgResponseMinutes))}</td>
      <td>${r.casesCompleted}</td>
    </tr>`)
    .join("");

  const accountsSection = isAdmin
    ? `
<section class="card">
  <h2>Automation permissions</h2>
  <p class="small muted" style="margin-top:-6px">The four automation actions are distinct permissions (PPR P1-8) — not a role split. Admins hold all four automatically; regular staff hold what is ticked here (with no ticks, they may send replies and approve automation, as staff always could).</p>
  <form method="post" action="/staff/permissions">
    <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
    <table>
      <tr><th>Staff</th>${PERMISSIONS.map((p) => `<th style="text-align:left">${esc(PERMISSION_LABELS[p])}</th>`).join("")}</tr>
      ${repo.listStaff(orgId).map((st) => {
        const grants = st.role === "admin" ? PERMISSIONS.slice() : (repo.permissionsFor(st.id).length ? repo.permissionsFor(st.id) : ["send_automated", "approve_automation"]);
        return `<tr>
        <td><b>${esc(st.display_name)}</b><br><span class="muted small">@${esc(st.username)} · ${esc(st.role)}</span></td>
        ${PERMISSIONS.map((p) => `<td>${st.role === "admin"
          ? `<span class="badge b-green">always</span><input type="hidden" name="perm_${st.id}_${p}" value="1">`
          : `<input type="checkbox" name="perm_${st.id}_${p}" value="1" ${grants.includes(p) ? "checked" : ""} style="width:auto">`}</td>`).join("")}
      </tr>`;
      }).join("")}
    </table>
    <div style="margin-top:10px"><button class="btn">Save permissions</button></div>
  </form>
</section>
<section class="card">
  <h2>Which case types each person sees</h2>
  <p class="small muted" style="margin-top:-6px">By default everyone sees every case type in this organization. Narrow a person to the types they actually handle — a reviewer who only reads one stream should not have the rest on their desk. Administrators always see everything.</p>
  ${(() => {
    // listCaseTypes() is the active set; retired profiles have their own list.
    const types = repo.listCaseTypes(orgId);
    if (!types.length) return `<p class="small muted" style="margin-bottom:0">No case types yet — add one under <a href="/config?tab=case-types">Configuration → CaseTypes</a> and scoping becomes available here.</p>`;
    const members = repo.listStaff(orgId).filter((st) => st.role !== "admin");
    if (!members.length) return `<p class="small muted" style="margin-bottom:0">Only administrators exist so far, and they always see everything. Add a user account below to scope it.</p>`;
    const modeOf = (id: number) => repo.caseTypeScopeModeFor(id);
    const scopesOf = (id: number) => repo.caseTypeScopesFor(id);
    return `<table>
      <tr><th>Person</th><th>Sees</th><th>Case types</th><th></th></tr>
      ${members.map((st) => {
        const mode = modeOf(st.id);
        const scopes = scopesOf(st.id);
        return `<tr>
        <td><b>${esc(st.display_name)}</b><br><span class="muted small">@${esc(st.username)}</span></td>
        <td>${mode === "unscoped"
          ? `<span class="badge b-green">all case types</span>`
          : mode === "none"
            ? `<span class="badge b-red">no case types</span>`
            : `<span class="badge b-purple">${scopes.length} of ${types.length}</span>`}</td>
        <td><details><summary style="cursor:pointer">Choose case types</summary>
          <div style="padding:8px 0 0">
            <label class="small" style="display:block;margin-bottom:6px"><input type="radio" name="mode" value="unscoped" form="scopes-${st.id}" ${mode === "unscoped" ? "checked" : ""} style="width:auto"> Every case type (the default)</label>
            ${types.map((t) => `<label class="small" style="display:block;margin-bottom:4px"><input type="checkbox" name="scope_${esc(t.code)}" value="1" form="scopes-${st.id}" ${scopes.includes(t.code.toUpperCase()) ? "checked" : ""} style="width:auto"> ${esc(t.name)} <span class="mono muted">${esc(t.code)}</span></label>`).join("")}
            <label class="small" style="display:block;margin-top:6px"><input type="radio" name="mode" value="none" form="scopes-${st.id}" ${mode === "none" ? "checked" : ""} style="width:auto"> No case types (sees the queues but no cases)</label>
          </div>
        </details></td>
        <td><form method="post" action="/staff/case-type-scopes" id="scopes-${st.id}" style="margin:0">
          <input type="hidden" name="_csrf" value="${esc(c.csrf)}"><input type="hidden" name="id" value="${st.id}">
          <button class="btn small ghost">Save scope</button></form></td>
      </tr>`;
      }).join("")}
    </table>
    <p class="small muted" style="margin:10px 0 0">Choosing “every case type” or “no case types” overrides the ticks; ticking any box switches that person to the selected case types only. A retired case type stops counting as soon as it is retired.</p>`;
  })()}
</section>
<section class="card nopad">
  <div class="card-head"><h2>Accounts</h2></div>
  <table>
    <tr><th>Username</th><th>Name</th><th>Role</th><th>Status</th><th>Actions</th></tr>
    ${repo.listStaff(orgId)
      .map((st) => `<tr>
        <td class="mono">${esc(st.username)}</td>
        <td>${esc(st.display_name)}</td>
        <td><span class="badge b-gray">${esc(capFirst(st.role))}</span></td>
        <td>${st.active ? `<span class="badge b-green">active</span>` : `<span class="badge b-red">disabled</span>`}</td>
        <td>
          <form method="post" action="/staff/toggle" style="display:inline"><input type="hidden" name="_csrf" value="${esc(c.csrf)}"><input type="hidden" name="id" value="${st.id}"><button class="btn small ghost">${st.active ? "Disable" : "Enable"}</button></form>
          <form method="post" action="/staff/password" style="display:inline"><input type="hidden" name="_csrf" value="${esc(c.csrf)}"><input type="hidden" name="id" value="${st.id}"><input type="password" name="password" placeholder="new password" style="width:150px;display:inline-block"><input type="password" name="confirm" placeholder="confirm" style="width:150px;display:inline-block"><button class="btn small ghost">Reset</button></form>
          <form method="post" action="/staff/reset-code" style="display:inline"><input type="hidden" name="_csrf" value="${esc(c.csrf)}"><input type="hidden" name="id" value="${st.id}"><button class="btn small ghost" title="Issue a single use code the member can use on the public “Forgot password” page (no email involved)">Reset code</button></form>
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

  // Round 3: workflow configuration (case types, checklists, rules, windows)
  // lives in ONE place — Configuration. The staff area links to it; see
  // workflowConfigHtml above.

  return head(
    c,
    "Staff Configuration",
    "staff",
    `
<h1>Staff Configuration</h1>
<div class="sub">Who handles what — workload, responsiveness, accounts and case ownership.</div>
${flash ? `<div class="flash ok" style="position:static;margin-bottom:16px">${esc(flash)}</div>` : ""}
${resetCode ? `
<div class="card" id="reset-code" style="position:static;margin-bottom:16px;border-left:4px solid var(--green)">
  <b>Single use access code issued</b>
  <div class="mono" style="font-size:1.5em;letter-spacing:0.2em;margin:8px 0;user-select:all">${esc(resetCode)}</div>
  <span class="muted small">Works once, expires in 30 minutes. Give it to the member | they enter it on the public “Forgot password” page (linked under Enter the workspace). A new issue voids this code. It is shown nowhere else and never appears in a URL.</span>
</div>` : ""}

<div class="staff-performance">
  <section class="card">
    <h2>Team at a glance</h2>
    <div class="metric-ribbon">
      <div class="stat"><div class="n">${stats.reduce((n, r) => n + r.assignedCases, 0)}</div><div class="l">Cases entrusted</div><div class="context">Across ${stats.length} team member${stats.length === 1 ? "" : "s"}</div></div>
      <div class="stat"><div class="n">${totals.received}</div><div class="l">Emails received</div><div class="context">On currently assigned cases</div></div>
      <div class="stat"><div class="n">${totals.sent}</div><div class="l">Replies sent</div><div class="context">Human responses to contacts</div></div>
      <div class="stat"><div class="n">${totals.completed}</div><div class="l">Completed</div><div class="context">Cases closed by the team</div></div>
      <div class="stat"><div class="n">${(() => { const values = stats.map((r) => r.avgResponseMinutes).filter((n): n is number => n !== null); return values.length ? esc(formatDuration(values.reduce((sum, n) => sum + n, 0) / values.length)) : "Not recorded"; })()}</div><div class="l">Avg response</div><div class="context">Average for measured staff</div></div>
    </div>
    <h2>Performance by staff member</h2>
    <div class="table-scroll"><table>
      <tr><th>Member of staff</th><th>Cases entrusted</th><th>Emails received</th><th>Replies sent</th><th>Avg response</th><th>Completed</th></tr>
      ${perfRows || `<tr><td colspan="6" class="muted">No staff yet.</td></tr>`}
    </table></div>
    <p class="small muted" style="margin:16px 0 0">“Emails received” counts incoming mail on cases currently assigned to the person. Response time is measured from an incoming email to the next outgoing reply on their cases.</p>
  </section>
</div>

${accountsSection}

${isAdmin ? scopeMatrix(c) : ""}

${workflowConfigHtml(c)}`
  );
}

function securityDetail(value: string, max = 240): string {
  return esc(value
    .replace(/\b(?:AIza[0-9A-Za-z_-]{20,}|ya29\.[0-9A-Za-z._-]{10,})\b/g, "[credential redacted]")
    .replace(/\b((?:password|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, max));
}

function securityEventLabel(event: string): string {
  const labels: Record<string, string> = {
    send_failed: "Outbound send failed",
    email_not_delivered: "Email was not delivered",
    followup_send_failed: "Follow-up send failed",
    gmail_sync_failed: "Gmail sync failed",
    gmail_test_failed: "Gmail test failed",
    gemini_test_failed: "Gemini test failed",
    server_error: "Unhandled web request error",
    process_crash: "Fatal process exception (shared runtime)",
    ingestion_dead_letter: "Ingestion dead-letter",
    human_outcome_recorded: "Human outcome recorded",
    human_override: "Held draft approved by staff",
    case_type_changed: "Case type changed",
    case_config_upgraded: "Case configuration upgraded",
    status_changed: "Case status changed by staff",
    webhook_ingest_accepted: "Webhook submission accepted",
    webhook_rejected: "Webhook submission refused",
    webhook_failed: "Webhook submission failed in processing",
    webhook_key_issued: "Webhook ingest key issued",
    webhook_key_rotated: "Webhook ingest key rotated",
  };
  return labels[event] ?? capFirst(event.replace(/_/g, " "));
}

/** Read-only, organization-scoped operational/security view of existing records. */
export function securityConsolePage(c: Ctx): string {
  const { repo } = c;
  const organizationId = c.user.organization_id ?? 1;
  const demo = c.user.demo === 1 ? 1 : 0;
  const snapshot = repo.securityConsoleSnapshot(organizationId, demo);

  // Gmail and Gemini are shared runtime integrations in the current server
  // architecture. Display configuration/last-recorded health only; this page
  // never calls either provider and never exposes stored credentials.
  const gmailPaused = repo.getSetting("gmail_disabled", "") === "1";
  const gmailStored = Boolean(repo.getSetting("gmail_client_id", "").trim())
    && repo.hasSecret("gmail_client_secret")
    && repo.hasSecret("gmail_refresh_token");
  const gmailConfigured = !gmailPaused && (Boolean(c.gmailConfigured) || gmailStored);
  const gmailLastSync = repo.getSetting("gmail_last_sync_at", "");
  const gmailLastError = repo.getSetting("gmail_last_error", "").trim();
  const geminiConfigured = Boolean(c.geminiAvailable) || repo.hasSecret("gemini_api_key");
  const geminiLastError = repo.getSetting("gemini_last_error", "").trim();

  const loginRows = snapshot.logins.map((row) => `<tr>
    <td><b>${esc(row.display_name)}</b><br><span class="muted small">@${esc(row.username)} · ${esc(row.role)}</span></td>
    <td>${esc(fmtDate(row.at))}</td>
  </tr>`).join("");
  const sessionRows = snapshot.activeSessions.map((row) => `<tr>
    <td><b>${esc(row.display_name)}</b><br><span class="muted small">@${esc(row.username)} · ${esc(row.role)}</span></td>
    <td>${esc(fmtDate(row.created_at))}</td><td>${esc(fmtDate(row.expires_at))}</td>
  </tr>`).join("");
  const runRows = snapshot.pipelineRuns.map((row) => `<tr>
    <td><a href="/case/${row.applicant_id}"><b>${esc(row.ref_number)}</b></a><br><span class="muted small">${esc(row.case_type_code ?? "Unprofiled case")}</span></td>
    <td>${esc(fmtDate(row.timestamp))}<br><span class="muted small mono">${securityDetail(row.triggering_email_id, 72)}</span></td>
    <td><span class="badge ${row.computed_status.toLowerCase() === "green" ? "b-green" : row.computed_status.toLowerCase() === "red" ? "b-red" : "b-orange"}">${esc(row.computed_status)}</span><br><span class="small">${row.auto_sent ? "Automated reply sent" : "No automated reply"}</span></td>
    <td class="small">${securityDetail(row.reasoning)}</td>
  </tr>`).join("");
  const signalRows = snapshot.integritySignals.map((row) => `<tr>
    <td><a href="/case/${row.applicant_id}"><b>${esc(row.ref_number)}</b></a><br><span class="muted small">${securityEventLabel(row.event)}</span></td>
    <td>${esc(row.display_name)}<br><span class="muted small">${esc(fmtDate(row.at))}</span></td>
    <td>${row.latest_computed_status
      ? `<b>${esc(row.latest_computed_status)}</b><br><span class="muted small">Decision ${esc(fmtDate(row.latest_decision_at ?? ""))}</span><br><span class="small">${securityDetail(row.latest_reasoning ?? "", 180)}</span>`
      : `<span class="muted">No earlier decision snapshot is recorded.</span>`}</td>
    <td class="small">${securityDetail(row.detail)}</td>
  </tr>`).join("");
  const errorRows = snapshot.errors.map((row) => `<tr>
    <td><b>${securityEventLabel(row.event)}</b>${row.attempts !== null ? `<br><span class="muted small">${row.attempts} attempt${row.attempts === 1 ? "" : "s"}</span>` : ""}</td>
    <td>${row.ref_number && row.applicant_id
      ? `<a href="/case/${row.applicant_id}">${esc(row.ref_number)}</a>`
      : `<span class="muted">Service / ingestion</span>`}</td>
    <td>${esc(row.display_name)}<br><span class="muted small">${esc(fmtDate(row.at))}</span></td>
    <td class="small">${securityDetail(row.detail)}</td>
  </tr>`).join("");

  const ingestBadge = (outcome: string): string => outcome === "accepted" ? "b-green"
    : outcome === "duplicate" ? "b-blue"
      : outcome === "failed" ? "b-red"
        : outcome === "rate_limited" || outcome === "rejected" || outcome === "parked" ? "b-orange" : "b-gray";
  const ingestRows = snapshot.webhookDeliveries.map((row) => `<tr>
    <td>${esc(fmtDate(row.at))}<br><span class="muted small mono">${securityDetail(row.sender_email || "no address", 60)}</span></td>
    <td><span class="badge ${ingestBadge(row.outcome)}">${esc(row.outcome.replace(/_/g, " "))} · ${row.status_code}</span>${row.external_id ? `<br><span class="muted small mono">${esc(row.external_id)}</span>` : ""}</td>
    <td class="small">${row.applicant_id
      ? `<a href="/case/${row.applicant_id}"><b>${esc(row.ref_number || "case")}</b></a>${row.case_type_code ? `<br><span class="muted">${esc(row.case_type_code)}</span>` : ""}`
      : `<span class="muted">${row.ref_number ? esc(row.ref_number) : "no case"}</span>`}</td>
    <td class="small">${securityDetail(row.detail)}</td>
  </tr>`).join("");

  const metric = (value: number, label: string, detail: string) => `<div class="stat"><div class="n">${value}</div><div class="l">${esc(label)}</div><div class="context">${esc(detail)}</div></div>`;
  const gmailStatus = gmailPaused ? "Paused" : gmailConfigured ? "Configured" : "Not configured";
  const geminiStatus = geminiConfigured ? "Configured" : "Not configured";

  return head(c, "Security Console", "security", `
<div id="security-console">
  <h1>Security Console</h1>
  <p class="sub">View only access, decision provenance, error and integration health for <b>${esc(c.institution)}</b>.</p>
  <div class="card" style="border-left:4px solid var(--plum-mid)">
    <b>Operational view without editing.</b> Activity is limited to this organization and its current live/demo realm. Integrations are shared by the running installation; this page shows stored status only and makes no Gmail or Gemini calls.
  </div>

  <section class="card">
    <h2>Recent activity</h2>
    <div class="metric-ribbon">
      ${metric(snapshot.logins.length, "Recent logins", "latest recorded sign ins")}
      ${metric(snapshot.activeSessions.length, "Active sessions", "valid staff sessions")}
      ${metric(snapshot.pipelineRuns.length, "Decision runs", "latest provenance records")}
      ${metric(snapshot.integritySignals.length, "Change signals", "review indicators, not proof")}
      ${metric(snapshot.errors.length, "Errors", "recorded failed work / requests")}
      ${metric(snapshot.webhookDeliveries.length, "Webhook calls", "recent public ingest attempts")}
    </div>
  </section>

  <section class="card nopad">
    <div class="card-head"><h2>Gemini &amp; Gmail service health</h2><a class="small" href="/settings#connections">Settings → Connections</a></div>
    <p class="small muted" style="padding:0 24px">These integrations are shared across the installation in the current runtime. Status uses saved configuration and the latest recorded result; it is not a live connectivity test.</p>
    <div class="kv" style="padding:0 24px 20px">
      <div><span>Gmail</span><b><span class="badge ${gmailPaused ? "b-orange" : gmailConfigured ? "b-green" : "b-gray"}">${gmailStatus}</span></b></div>
      <div><span>Last successful sync</span><b>${gmailLastSync ? esc(fmtDate(gmailLastSync)) : "Not recorded"}</b></div>
      <div><span>Latest Gmail result</span><b>${gmailLastError ? `<span class="badge b-red">Failure recorded</span>` : `<span class="badge ${gmailConfigured ? "b-green" : "b-gray"}">${gmailConfigured ? "No recorded failure" : "No connection configured"}</span>`}</b></div>
      <div><span>Gemini</span><b><span class="badge ${geminiConfigured ? "b-green" : "b-gray"}">${geminiStatus}</span></b></div>
      <div><span>Latest Gemini result</span><b>${geminiLastError ? `<span class="badge b-red">Failure recorded</span>` : `<span class="badge ${geminiConfigured ? "b-green" : "b-gray"}">${geminiConfigured ? "No recorded failure" : "No connection configured"}</span>`}</b></div>
    </div>
  </section>

  <section class="card nopad">
    <div class="card-head"><h2>Successful staff logins</h2></div>
    ${loginRows ? `<div class="table-scroll"><table><tr><th>Member of staff</th><th>When</th></tr>${loginRows}</table></div>` : `<div class="empty"><p>No sign ins are recorded for this organization and realm yet.</p></div>`}
  </section>

  <section class="card nopad">
    <div class="card-head"><h2>Active staff sessions</h2></div>
    ${sessionRows ? `<div class="table-scroll"><table><tr><th>Member of staff</th><th>Started</th><th>Expires</th></tr>${sessionRows}</table></div>` : `<div class="empty"><p>No active staff sessions are recorded.</p></div>`}
    <p class="small muted" style="padding:0 24px 18px;margin:0">Session tokens and CSRF values are never displayed.</p>
  </section>

  <section class="card nopad">
    <div class="card-head"><h2>Pipeline runs &amp; decision provenance</h2></div>
    ${runRows ? `<div class="table-scroll"><table><tr><th>Case</th><th>Run / source email</th><th>Outcome</th><th>Recorded reasoning</th></tr>${runRows}</table></div>` : `<div class="empty"><p>No decision records are recorded for this organization and realm yet.</p></div>`}
  </section>

  <section class="card nopad">
    <div class="card-head"><h2>Case-tampering / decision-change signals</h2></div>
    <p class="small muted" style="padding:0 24px">Human decisions and outcomes, changes to case type, configuration upgrades and staff status changes are surfaced beside the latest earlier decision record. These are audit indicators for review, not proof of tampering.</p>
    ${signalRows ? `<div class="table-scroll"><table><tr><th>Case / signal</th><th>Actor / time</th><th>Earlier decision provenance</th><th>Recorded change</th></tr>${signalRows}</table></div>` : `<div class="empty"><p>No decision change indicators are recorded for this organization and realm.</p></div>`}
  </section>

  <section class="card nopad">
    <div class="card-head"><h2>Crashes, errors &amp; failed work</h2></div>
    <p class="small muted" style="padding:0 24px">Shows recorded service, sending, intake, and unhandled web request errors attributable to this organization. Fatal process exceptions are marked as shared runtime events; forced shutdowns or failures before the database opens cannot be recorded. Mail failures without a persisted case or organization link are excluded rather than shown across tenants.</p>
    ${errorRows ? `<div class="table-scroll"><table><tr><th>Issue</th><th>Case</th><th>Actor / time</th><th>Recorded detail</th></tr>${errorRows}</table></div>` : `<div class="empty"><p>No attributable errors or failed work are recorded.</p></div>`}
  </section>

  <section class="card nopad">
    <div class="card-head"><h2>Webhook deliveries &amp; public ingest</h2><a class="small" href="/settings#webhook">Settings → Web submissions</a></div>
    <p class="small muted" style="padding:0 24px">Calls to the public ingest address, kept apart from mail ingestion: submissions accepted into the pipeline, refusals stopped before anything was stored, idempotent replays, throttled calls and processing failures. The ingest key is never recorded. A webhook cannot decide a case and cannot bypass an evidence gate — it enters through the same path as an inbound email, and these rows say what that path made of it.</p>
    ${ingestRows ? `<div class="table-scroll"><table><tr><th>Time / sender</th><th>Result</th><th>Case</th><th>Recorded detail</th></tr>${ingestRows}</table></div>` : `<div class="empty"><p>No public ingest calls have been recorded for this organization.</p></div>`}
  </section>
</div>`);
}

export function replayPage(c: Ctx, a: ApplicantRow): string {
  const frozen = c.repo.caseConfigFrozen(a);
  const evaluations = c.repo.evaluationsForApplicant(a.id);
  return head(c, `Evaluation history — ${a.ref_number}`, "applicants", `<h1>Evaluation history</h1><p><a href="/case/${a.id}">Back to case ${esc(a.ref_number)}</a></p><section class="card"><h2>Frozen configuration</h2><p>Version ${frozen?.config_version ?? "unconfigured"} · ${esc(frozen?.frozen_at ?? "not frozen")}</p><pre class="raw">${esc(JSON.stringify(frozen ?? {}, null, 2))}</pre></section><section class="card"><h2>Evaluation runs</h2>${evaluations.map((evaluation) => `<p>${esc(evaluation.result)} · ${esc(evaluation.routing)} · ${esc(fmtDate(evaluation.evaluated_at))}</p><pre class="raw">${esc(evaluation.reason)}</pre>`).join("") || "<p>No evaluations yet.</p>"}</section>`);
}


// ── DEMO: test intake — submit a simulated inbound message to a CaseType ──

/** Prefill "field: value" lines from a CaseType rule tree so a walkthrough
 *  starts from values that satisfy it (editable before submitting). */
export function sampleFactsFromRules(nodes: RuleNode[]): string {
  const out = new Map<string, string>();
  const visit = (n: RuleNode, negated: boolean, firstOnly: boolean): void => {
    if (n.kind === "condition") {
      if (!n.field || out.has(n.field)) return;
      out.set(n.field, negated ? (n.comparator === "=" ? "no" : "0") : String(n.value ?? ""));
      return;
    }
    const kids = n.children ?? [];
    const neg = n.logic === "NOT" ? !negated : negated;
    for (const k of n.logic === "OR" && !firstOnly ? kids.slice(0, 1) : kids) visit(k, neg, false);
  };
  for (const n of nodes) visit(n, false, false);
  return [...out.entries()].map(([k, v]) => `${capFirst(k.replace(/_/g, " "))}: ${v}`).join("\n");
}

export function intakeTestPage(c: Ctx, opts: { caseTypeCode?: string; msg?: string }): string {
  const orgId = c.user.organization_id ?? 1;
  const types = c.repo.listCaseTypes(orgId);
  const selected = types.find((t) => t.code === opts.caseTypeCode) ?? types[0];
  if (!selected) {
    return head(c, "Test intake", "applicants", `<h1>Test intake</h1><div class="card empty"><p>This organization has no CaseTypes yet. Create one under Configuration → CaseTypes.</p></div>`);
  }
  const docs = c.repo.listDocumentDefinitions(selected.id);
  const rules = c.repo.caseTypeRules(selected);
  const facts = sampleFactsFromRules(rules);
  return head(c, "Test intake", "applicants", `
<h1>Test intake — ${esc(c.institution)}</h1>
<div class="sub">Submit a simulated inbound message to one of this organization's CaseTypes. It runs through the real intake pipeline (document matrix, rule tree, human gate) exactly like a mailbox message would, and opens a case in this organization's queues. Nothing is sent to the contact.</div>
${opts.msg ? `<div class="flash ok" style="position:static;margin-bottom:16px">${esc(opts.msg)}</div>` : ""}
<div class="card">
  <form method="get" action="/intake/test" class="formrow" style="align-items:end">
    <div><label>CaseType</label><select name="case_type" onchange="this.form.submit()">${types.map((t) => `<option value="${esc(t.code)}"${t.code === selected.code ? " selected" : ""}>${esc(t.name)}</option>`).join("")}</select></div>
    <noscript><div style="flex:0"><button class="btn ghost">Load</button></div></noscript>
  </form>
</div>
<form method="post" action="/intake/test" class="card">
  <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
  <input type="hidden" name="case_type" value="${esc(selected.code)}">
  <h2>${esc(selected.name)}</h2>
  <div class="formrow">
    <div><label>Correspondent name</label><input name="from_name" value="Jordan Rivera" required maxlength="80"></div>
    <div><label>Correspondent email</label><input name="from" type="email" value="jordan.rivera@example.test" required maxlength="120"></div>
  </div>
  <div class="formrow"><div><label>Subject</label><input name="subject" value="${esc(selected.name)} — Jordan Rivera" required maxlength="200"></div></div>
  <div class="formrow"><div><label>Message body — "Field: value" lines become facts for the rule tree</label>
    <textarea name="body" rows="8" style="width:100%">Hello,

Please find my paperwork attached.

${esc(facts)}

Thanks,
Jordan</textarea></div></div>
  <h3 style="margin-top:14px">Attach documents</h3>
  <p class="small muted">Each ticked slot attaches a generated PDF labelled with that document. Untick one to see the matrix report it missing.</p>
  <table><tr><th></th><th>Document</th><th>Required</th><th>Blocking</th></tr>
  ${docs.map((d) => `<tr><td><input type="checkbox" name="doc" value="${esc(d.key)}"${d.required ? " checked" : ""}></td><td>${esc(d.label)} <span class="mono small muted">${esc(d.key)}</span></td><td>${d.required ? "yes" : "no"}</td><td>${d.blocking ? "yes" : "no"}</td></tr>`).join("")}
  </table>
  <div style="margin-top:14px"><button class="btn">Submit test message</button></div>
</form>
<div class="card"><h2>Rule tree</h2><pre class="mono small" style="white-space:pre-wrap">${esc(JSON.stringify(rules, null, 2))}</pre></div>`);
}
