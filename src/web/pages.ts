/**
 * Page renderers — every page is built server-side from the database.
 * Single source of truth: nothing is rendered that isn't in the DB.
 */
import type { ApplicantSearchQuery, Repo } from "../db/repo";
import type { ApplicantRow, DocType, StaffUser } from "../types";
import { EMAIL_CATEGORY_LABELS, LIFECYCLE_LABELS, LIFECYCLE_ORDER } from "../types";
import { docLabel } from "../rules";
import { verifyPassword } from "../util/password";
import {
  avatar, categoryBadge, confidenceBadge, crest, esc, flagLabel, fmtDate, fmtTime, layout,
  lifecycleBadge, lifecycleStepper, priorityBadge, slaText, triageBadge, type Theme,
} from "./views";

interface Ctx {
  repo: Repo;
  user: StaffUser;
  unread: number;
  csrf: string;
  theme?: Theme;
  /** Institution name from Settings — drives all branding text. */
  institution: string;
  /** True when outgoing mail is simulated — banner shown to staff. */
  mailMock: boolean;
}

function head(c: Ctx, title: string, active: string, content: string): string {
  return layout({ title, content, user: c.user, unread: c.unread, active, csrf: c.csrf, theme: c.theme, institution: c.institution, mailMock: c.mailMock });
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
  ${crest(64)}
  <h1 class="center">Welcome back</h1>
  <p class="sub center">${esc(institution)} · Automated admissions console</p>
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

// ── Admissions Command Center (v3 homepage) ────────────────────────────────
// Not an inbox clone: greeting → what needs attention → today's counters →
// bottlenecks → automation accuracy.

export function dashboardPage(c: Ctx): string {
  const { repo } = c;
  const s = repo.dashboardStats();
  const today = repo.todayStats();
  const accuracy = repo.accuracyStats();
  const queue = repo.queueView();
  const unanswered = repo.unansweredCases();
  const target = Number(repo.getSetting("unanswered_target_hours", "4"));
  const categories = repo.categoryCounts();
  const inst = repo.getSetting("institution_name", "");

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const activeCount = Number(s.applications) - Number(s.completed);

  const attention = [
    { icon: "⚠️", label: "applicant emails unanswered", n: unanswered.filter((u) => u.hours >= target).length, href: "/applicants?filter=human_review", tone: "orange" },
    { icon: "🔴", label: "cases past their response target", n: Number(s.overdue), href: "/queue?filter=overdue", tone: "red" },
    { icon: "🟠", label: "cases waiting for human review", n: Number(s.humanReview), href: "/queue", tone: "orange" },
    { icon: "📄", label: "files incomplete (documents missing)", n: Number(s.incomplete), href: "/applicants?filter=awaiting_docs", tone: "blue" },
    { icon: "✅", label: "replies auto-processed to date", n: Number(s.autoHandled), href: "/queue", tone: "green" },
  ];
  const banner = attention
    .map((b) => `<a class="attn b-${b.tone}" href="${b.href}"><span class="n">${b.n}</span> ${b.icon} ${esc(b.label)}</a>`)
    .join("");

  const needsAttention = queue.slice(0, 8)
    .map((r) => {
      const overdue = r.sla_due_at && !r.sla_handled_at && r.sla_due_at < new Date().toISOString();
      return `<tr>
        <td class="mono"><a href="/case/${r.id}">${esc(r.ref_number)}</a></td>
        <td><div class="nameline">${avatar(r.full_name ?? r.ref_number, 28)}<span>${esc(r.full_name ?? "—")}</span></div></td>
        <td>${triageBadge(r.computed_status)} ${priorityBadge(r.priority)}</td>
        <td class="small">${esc(r.flag_summary ? humanizeFlagSummary(r.flag_summary) : "—")}</td>
        <td class="nowrap small ${overdue ? "overdue" : "muted"}">${overdue ? "⚠️ " : ""}${esc(slaText(r.sla_due_at, r.sla_handled_at)) || "—"}</td>
      </tr>`;
    })
    .join("");

  const unansweredRows = unanswered.slice(0, 8)
    .map((u) => `<tr>
      <td class="mono"><a href="/case/${u.applicant.id}">${esc(u.applicant.ref_number)}</a></td>
      <td>${esc(u.applicant.full_name ?? "—")}</td>
      <td class="nowrap ${u.hours >= target ? "overdue" : "muted"} small">${u.hours >= target ? "⚠️ " : ""}${u.hours}h waiting</td>
    </tr>`)
    .join("");

  // Bottleneck: where are applicants getting stuck (by enquiry category).
  const totalCat = categories.reduce((n, r) => n + r.n, 0) || 1;
  const catRows = categories.slice(0, 6)
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
  const stat = (n: number | string, l: string, alert = false) =>
    `<div class="stat ${alert ? "alert" : ""}"><div class="n">${esc(n)}</div><div class="l">${esc(l)}</div></div>`;
  // Honest metrics: show "no data" instead of a misleading 0, and keep large
  // values readable (35h 12m rather than 2112.4 min).
  const avgAuto = Number(s.avgResponseMin) > 0 ? formatDuration(Number(s.avgResponseMin)) : "no data";
  const avgReview = Number(s.avgReviewHours) > 0
    ? (Number(s.avgReviewHours) < 48 ? `${s.avgReviewHours} hrs` : formatDuration(Number(s.avgReviewHours) * 60))
    : "no data";

  return head(
    c,
    `Command Center — ${inst}`,
    "dashboard",
    `
<h1>${greeting}, ${esc(c.user.display_name)} 👋</h1>
<div class="sub">${esc(inst)} · ${activeCount} active applicant${activeCount === 1 ? "" : "s"} on the floor</div>

<div class="card attn-banner">
  <h2>Needs attention</h2>
  <div class="attn-grid">${banner}</div>
</div>

<div class="grid stats">
  ${stat(today.emailsToday, "Emails today")}
  ${stat(today.docsToday, "Documents today")}
  ${stat(today.completedToday, "Cases completed today")}
  ${stat(avgAuto, "Avg auto-response (last 7 days)")}
  ${stat(avgReview, "Avg review time")}
</div>

<div class="cols">
  <div class="card">
    <h2>What needs my attention <a class="small" href="/queue">full queue →</a></h2>
    ${queue.length ? `<table><tr><th>Ref</th><th>Applicant</th><th>Verdict</th><th>Flags</th><th>SLA</th></tr>${needsAttention}</table>` : `<p class="muted">Queue is empty. 🎉</p>`}
  </div>
  <div class="card">
    <h2>⚠️ Unanswered emails <span class="muted small">(target ${target}h)</span></h2>
    ${unanswered.length ? `<table><tr><th>Ref</th><th>Applicant</th><th>Waiting</th></tr>${unansweredRows}</table>` : `<p class="muted">Every applicant email has a reply. 🎉</p>`}
  </div>
</div>

<div class="cols">
  <div class="card">
    <h2>Where applicants get stuck</h2>
    <p class="small muted">Share of incoming email by category — the big bars are your bottlenecks.</p>
    ${catRows ? `<table>${catRows}</table>` : `<p class="muted">No emails yet.</p>`}
  </div>
  <div class="card">
    <h2>Automation accuracy</h2>
    ${reviewed > 0
      ? `<p><span class="n" style="font-size:26px;font-weight:800">${accuracyPct}%</span> <span class="muted small">of automation decisions stood uncorrected</span></p>`
      : `<p class="muted">No automation decisions recorded yet — accuracy appears here once the engine has processed mail.</p>`}
    <div class="grid stats">
      ${stat(accuracy.greenCases, "Clean Greens")}
      ${stat(accuracy.watcherCatches, "Watcher catches")}
      ${stat(accuracy.humanOverrides, "Human overrides")}
      ${stat(accuracy.sendErrors, "Send errors", accuracy.sendErrors > 0)}
    </div>
    <p class="small muted">${accuracy.autoSends} automated sends vs ${accuracy.humanSends} human sends · ${accuracy.reopened} cases reopened</p>
  </div>
</div>`
  );
}

// ── Queue (feature 11) ─────────────────────────────────────────────────────

export function queuePage(c: Ctx, filter: string): string {
  let rows = c.repo.queueView();
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
          ${overdue ? `<span class="badge b-red">⚠ ${esc(slaText(r.sla_due_at, r.sla_handled_at))}</span>` : ""}
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
<div class="sub">🔴 ${urgent} urgent · 🟠 ${review} awaiting review</div>
<p>
  <a class="btn small ${filter === "all" ? "" : "ghost"}" href="/queue">All</a>
  <a class="btn small ${filter === "urgent" ? "" : "ghost"}" href="/queue?filter=urgent">Urgent</a>
  <a class="btn small ${filter === "overdue" ? "" : "ghost"}" href="/queue?filter=overdue">Overdue</a>
</p>
${cards || `<div class="card muted">Queue is empty. 🎉</div>`}`
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
      if (q.search) params.set("search", q.search);
      if (q.programme) params.set("programme", q.programme);
      if (q.intake) params.set("intake", q.intake);
      if (f !== "all") params.set("filter", f);
      const qs = params.toString();
      return `/applicants${qs ? `?${qs}` : ""}`;
    };
    const count = (f: string): number =>
      repo.searchApplicants({ ...q, filter: f === "all" ? undefined : (f as NonNullable<ApplicantSearchQuery["filter"]>), limit: 100000 }).length;
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
  for (const d of new Set(newDocs)) parts.push(`📄 <b>${esc(d)}</b> received`);
  for (const f of added) parts.push(`🚩 new flag: <b>${esc(f)}</b>`);
  for (const f of cleared) parts.push(`✅ flag cleared: <b>${esc(f)}</b>`);
  if (prev.computed_status !== last.computed_status) {
    parts.push(`${prev.computed_status === "Green" ? "🟢" : prev.computed_status === "Orange" ? "🟠" : "🔴"} ${esc(prev.computed_status)} → <b>${esc(last.computed_status)}</b>`);
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

  const checklist = requirements
    .filter((r) => r.required)
    .map((r) => {
      const doc = activeDocs.find((d) => d.document_type === r.document_type);
      return doc
        ? `<div><span class="ok">✓</span> ${esc(docLabel(r.document_type))} <span class="muted small">(${esc(doc.extraction_method)} · ${doc.confidence})</span></div>`
        : `<div><span class="no">✗</span> ${esc(docLabel(r.document_type))}</div>`;
    })
    .join("");

  const docRows = allDocs
    .map((d) => {
      const fields = Object.entries(d.extracted_fields)
        .filter(([, v]) => v !== null && v !== undefined && v !== "")
        .map(([k, v]) => `${esc(k)}: <b>${esc(v)}</b>`)
        .join(" · ");
      const status = d.is_duplicate
        ? `<span class="badge b-gray">duplicate of #${d.duplicate_of}</span>`
        : d.superseded_by
          ? `<span class="badge b-gray">superseded by #${d.superseded_by}</span>`
          : `<span class="badge b-blue">active</span>`;
      return `<tr>
        <td class="mono small">#${d.id}</td>
        <td>${esc(docLabel(d.document_type))}<br><span class="muted small">${esc(fields || "no fields extracted")}</span></td>
        <td>${status}</td>
        <td>${confidenceBadge(d.confidence)}<br><span class="muted small">${esc(d.extraction_method)}</span></td>
        <td class="small">${esc(fmtDate(d.received_at))}<br><span class="muted">email ${esc(d.source_email_id)}</span></td>
        <td><details class="excerpt"><summary class="small">text</summary><pre>${esc(d.extracted_text.slice(0, 1200))}</pre></details></td>
      </tr>`;
    })
    .join("");

  const emailCards = emails
    .map((e) => `<div class="emailcard ${e.direction === "out" ? "out" : ""}">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <span class="badge ${e.direction === "in" ? "b-blue" : "b-green"}">${e.direction === "in" ? "⬅ incoming" : "➡ outgoing"}</span>
        ${categoryBadge(e.category)}
        ${e.channel && e.channel !== "email" ? `<span class="badge b-blue">via ${esc(e.channel)}</span>` : ""}
        ${e.auto ? `<span class="badge b-gray">automated</span>` : ""}
        <span class="small muted" style="margin-left:auto" title="${esc(fmtDate(e.at))}"><span data-rel="${esc(e.at)}">${esc(fmtDate(e.at))}</span></span>
      </div>
      <p style="margin:8px 0 0"><b>${esc(e.subject)}</b></p>
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
    ${avatar(a.full_name ?? a.ref_number, 54)}
    <div style="min-width:0">
      <h1 style="margin:0">${esc(a.full_name ?? "Unknown applicant")}</h1>
      <div class="sub" style="margin:2px 0 6px"><span class="mono">${esc(a.ref_number)}</span> · opened ${esc(fmtDate(a.created_at))}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        ${lifecycleBadge(a.lifecycle)} ${triageBadge(a.triage)} ${priorityBadge(a.priority)}
        ${a.escalated ? `<span class="badge b-red">⚠ escalated</span>` : ""}
      </div>
    </div>
    <div style="margin-left:auto;display:flex;gap:8px;flex-wrap:wrap" class="no-print">
      <a class="btn ghost small" href="/case/${a.id}/replay">🔍 Decision replay</a>
      <button class="btn ghost small" onclick="window.print()">🖨 Case brief</button>
    </div>
  </div>
</div>
${lifecycleStepper(a.lifecycle)}

${changed ? `<div class="changed">📌 <b>What changed since the last triage:</b> ${changed}</div>` : ""}

<div class="cols" style="margin-top:18px">
  <div>
    <div class="card">
      <h2>Profile</h2>
      <dl class="kv">
        <dt>Name</dt><dd>${esc(a.full_name ?? "—")}</dd>
        <dt>Email</dt><dd>${esc(a.email_address)}</dd>
        <dt>Phone</dt><dd>${esc(a.phone ?? "—")}</dd>
        <dt>Programme</dt><dd>${esc(a.programme ?? "—")}</dd>
        <dt>Intake</dt><dd>${esc(a.intake ?? "—")}</dd>
        <dt>Reference no.</dt><dd class="mono">${esc(a.ref_number)}</dd>
        <dt>Threads</dt><dd>${threads.length} linked conversation${threads.length === 1 ? "" : "s"} <span class="muted small">(cross-thread reconstruction)</span></dd>
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
    </div>

    <div class="card">
      <h2>Document checklist</h2>
      <div class="checklist">${checklist}</div>
      <p class="small muted">${a.requirements_snapshot ? "Judged by the requirement set frozen at first triage (rule changes don't move goalposts)." : `Resolved for ${esc(a.programme ?? "all programmes")} / ${esc(a.intake ?? "all intakes")}`} — edit rules in Settings.</p>
    </div>

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
  </div>

  <div>
    <div class="card">
      <h2>Actions</h2>
      <div class="formrow">
        <form method="post" action="/case/${a.id}/action">
          <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
          ${nextStage ? `<button class="btn" name="action" value="advance">Advance → ${esc(LIFECYCLE_LABELS[nextStage])}</button>` : ""}
          ${a.lifecycle !== "completed" ? `<button class="btn ghost" name="action" value="complete">Mark completed</button>` : ""}
        </form>
      </div>
      <div class="formrow" style="margin-top:10px">
        <form method="post" action="/case/${a.id}/action" style="display:flex;gap:6px;align-items:center">
          <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
          <button class="btn ghost" name="action" value="request_info">📧 Request missing docs</button>
        </form>
      </div>
    </div>

    <div class="card">
      <h2>💬 Responses</h2>
      <p class="small muted">Pick a reply template — it is rendered with this applicant's details. Preview first; nothing is sent without your click.</p>
      <form method="post" action="/case/${a.id}/send">
        <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
        <div class="formrow" style="align-items:end">
          <div style="flex:2"><label>Template</label><select name="template">${tplOptions}</select></div>
          <div style="flex:0;display:flex;gap:8px">
            <button class="btn ghost" name="preview" value="1">👁 Preview</button>
            <button class="btn" onclick="return confirm('Send this reply now?')">✉️ Send now</button>
          </div>
        </div>
        ${preview ? `<div class="resp-preview"><b>${esc(preview.subject)}</b>\n\n${esc(preview.body)}</div>` : ""}
        <p class="small muted" style="margin-top:12px">Auto-response toggles per category live in <a href="/settings#automation">Settings → Automation</a>. Current modes: ${esc(autoSummary || "defaults")}</p>
      </form>
    </div>

    ${outbox ? `<div class="card" style="border-left:6px solid var(--orange)">
      <h2>📝 Draft held for approval <span class="heldnote">⏸ not sent</span></h2>
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
          <button class="btn" name="decision" value="send">✉️ Send</button>
          <button class="btn ghost" name="decision" value="edit">💾 Save changes</button>
          <button class="btn ghost danger" name="decision" value="discard" onclick="return confirm('Discard this draft?')">🗑 Discard</button>
        </div>
      </form>
    </div>` : ""}

    <div class="card">
      <h2>Documents (${allDocs.length} received, ${activeDocs.length} active)</h2>
      <table><tr><th>#</th><th>Type &amp; extracted fields</th><th>State</th><th>Confidence</th><th>Received</th><th></th></tr>
      ${docRows || `<tr><td colspan="6" class="muted">No documents received yet.</td></tr>`}</table>
    </div>

    ${c.user.role === "admin" || c.user.role === "manager" ? `<div class="card">
      <h2>🏷 Re-categorise latest incoming email</h2>
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
</div>

<div class="card">
  <h2>Email history</h2>
  ${emailCards || `<p class="muted">No emails recorded.</p>`}
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
</div>`
  );
}

// ── Settings (features 8, 35, 36, 37) ──────────────────────────────────────

export function settingsPage(c: Ctx, selectedTemplate?: string, flash?: string): string {
  const { repo } = c;
  const settings = repo.allSettings();
  const rules = repo.listRules();
  const programmes = repo.listProgrammes();
  const intakes = repo.listIntakes();
  const templates = repo.listTemplates();

  const ruleRows = rules
    .map((r) => `<tr>
      <td>${r.programme ? esc(r.programme) : "<i>all</i>"}</td>
      <td>${r.intake ? esc(r.intake) : "<i>all</i>"}</td>
      <td>${esc(docLabel(r.document_type))}</td>
      <td>${r.required ? "✓ required" : "optional"}</td>
      <td>${r.minGradePoints ?? "—"}</td>
      <td><form method="post" action="/settings/rules/delete"><input type="hidden" name="_csrf" value="${esc(c.csrf)}"><input type="hidden" name="id" value="${r.id}"><button class="btn small ghost">remove</button></form></td>
    </tr>`)
    .join("");

  const tplOptions = templates.map((t) => `<option value="${esc(t.key)}">${esc(t.name)} (${esc(t.key)})</option>`).join("");
  const first = templates[0];

  const settingInput = (key: string, label: string) =>
    `<div><label>${esc(label)}</label><input type="text" name="${esc(key)}" value="${esc(settings[key] ?? "")}"></div>`;

  return layout({
    title: "Settings",
    user: c.user,
    unread: c.unread,
    active: "settings",
    csrf: c.csrf,
    institution: c.institution,
    content: `
<h1>Settings</h1>
<div class="sub">Requirements, templates and SLAs — changes apply to newly processed email immediately.</div>
${flash ? `<div class="flash ok" style="position:static;margin-bottom:16px">${esc(flash)}</div>` : ""}

<div class="card">
  <h2>Institution &amp; SLA</h2>
  <form method="post" action="/settings/general">
    <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
    <div class="formrow">
      ${settingInput("institution_name", "Institution name")}
      ${settingInput("ref_prefix", "Reference prefix")}
      ${settingInput("sla_target_hours", "Response target (hours)")}
      ${settingInput("escalation_hours", "Escalate after (hours)")}
      ${settingInput("from_name", "From name")}
    </div>
    <div class="formrow">
      ${settingInput("unanswered_target_hours", "Unanswered-email target (hours)")}
      ${settingInput("followup_ladder_days", "Follow-up ladder (days, e.g. 3,7,10)")}
      ${settingInput("retention_days", "Retention of completed cases (days)")}
    </div>
    <p><button class="btn">Save settings</button></p>
  </form>
</div>

${(() => {
    const gAddress = settings["gmail_address"] ?? "";
    const gClientId = settings["gmail_client_id"] ?? "";
    const gClientSecret = settings["gmail_client_secret"] ?? "";
    const gRefresh = settings["gmail_refresh_token"] ?? "";
    const connected = Boolean(gAddress && gClientId && gClientSecret && gRefresh);
    return `<div class="card" id="gmail">
  <h2>📮 Gmail connection ${connected
    ? `<span class="badge b-green">connected — live sorting on</span>`
    : `<span class="badge b-orange">not connected</span>`}</h2>
  <p class="small muted">Connect the admissions mailbox so incoming mail is fetched, triaged and sorted automatically every minute. In Google Cloud Console, enable the <b>Gmail API</b>, create an <b>OAuth client ID</b> (type: Web application) and add this server's <span class="mono">/settings/gmail/callback</span> URL to its authorised redirect URIs.</p>
  <form method="post" action="/settings/gmail/credentials">
    <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
    <div class="formrow">
      <div><label>Gmail address</label><input type="email" name="gmail_address" value="${esc(gAddress)}" placeholder="admissions@institution.ac.ke"></div>
      <div><label>OAuth client ID</label><input type="text" name="gmail_client_id" value="${esc(gClientId)}" placeholder="…apps.googleusercontent.com"></div>
      <div><label>OAuth client secret</label><input type="password" name="gmail_client_secret" value="" placeholder="${gClientSecret ? "saved — enter a new value to replace" : "GOCSPX-…"}" autocomplete="new-password"></div>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <button class="btn ghost">Save credentials</button>
      ${gClientId && gClientSecret ? `<a class="btn" href="/settings/gmail/connect">🔐 Connect with Google…</a>` : ""}
      ${connected ? `<form method="post" action="/settings/gmail/disconnect" style="margin:0"><input type="hidden" name="_csrf" value="${esc(c.csrf)}"><button class="btn ghost danger">Disconnect</button></form>` : ""}
    </div>
  </form>
  <p class="small muted" style="margin-top:10px">${connected
    ? `Signed in as <b>${esc(gAddress)}</b>. New mail is fetched automatically — no restart needed.${settings["gmail_last_sync_at"] ? ` Last successful sync: <b>${esc(fmtDate(settings["gmail_last_sync_at"]))}</b>.` : " First sync pending (runs every minute)."}`
    : "Mail is not being fetched yet. Emails can still be replayed through the simulator/demo."}</p>
  ${settings["gmail_last_error"] ? `<p class="small" style="color:var(--red)">⚠ Last sync failed: ${esc(settings["gmail_last_error"])}</p>` : ""}
</div>`;
  })()}

<div class="card">
  <h2>Automation mode (draft-first)</h2>
  <p class="small muted">Recommended rollout: keep the global mode on <b>draft</b> (every automated reply waits for a human), then switch automation on category by category as you trust it. Factual replies only — receipts, missing-doc lists, status answers.</p>
  <form method="post" action="/settings/automation/global" class="formrow" style="align-items:end">
    <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
    <div><label>Global mode</label><select name="mode">
      <option value="auto" ${settings["automation_mode"] !== "draft" ? "selected" : ""}>auto — safe categories send automatically</option>
      <option value="draft" ${settings["automation_mode"] === "draft" ? "selected" : ""}>draft — hold EVERY automated reply for approval</option>
    </select></div>
    <div style="flex:0"><button class="btn">Apply global mode</button></div>
  </form>
  <table style="margin-top:10px"><tr><th>Email category</th><th>Mode</th><th></th></tr>
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

<div class="card">
  <h2>Intake deadlines</h2>
  <p class="small muted">Submissions arriving after the deadline are flagged <b>late_submission</b> for a human — the system never auto-rejects on deadline alone.</p>
  <table><tr><th>Intake</th><th>Deadline</th><th></th></tr>
    ${c.repo.listIntakeRows().map((i) => `<tr>
      <td>${esc(i.name)}</td>
      <td><form method="post" action="/settings/intake-deadline" style="display:flex;gap:6px;margin:0">
        <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
        <input type="hidden" name="name" value="${esc(i.name)}">
        <input type="date" name="deadline" value="${esc(i.deadline ? i.deadline.slice(0, 10) : "")}">
        <button class="btn small ghost">Save</button>
      </form></td>
      <td class="small muted">${i.deadline ? "" : "no deadline set"}</td>
    </tr>`).join("")}
  </table>
</div>

<div class="card">
  <h2>Requirement rules</h2>
  <p class="small muted">Most specific rule wins: programme+intake → programme → intake → base (all). Edit per programme/intake for different courses or admission rounds.</p>
  <table><tr><th>Programme</th><th>Intake</th><th>Document</th><th>Required?</th><th>Min points</th><th></th></tr>${ruleRows}</table>
  <form method="post" action="/settings/rules/add" class="formrow" style="margin-top:14px">
    <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
    <div><label>Programme</label><select name="programme"><option value="">All programmes</option>${programmes.map((p) => `<option value="${esc(p.code)}">${esc(p.code)}</option>`).join("")}</select></div>
    <div><label>Intake</label><select name="intake"><option value="">All intakes</option>${intakes.map((i) => `<option value="${esc(i)}">${esc(i)}</option>`).join("")}</select></div>
    <div><label>Document</label><select name="document_type">${(["academic_cert", "kcpe_cert", "id", "birth_cert", "application_form"] as DocType[]).map((d) => `<option value="${d}">${esc(docLabel(d))}</option>`).join("")}</select></div>
    <div><label>Required</label><select name="required"><option value="1">required</option><option value="0">optional</option></select></div>
    <div><label>Min points</label><input type="number" name="min_grade_points" placeholder="optional"></div>
    <div style="flex:0"><label>&nbsp;</label><button class="btn">Add rule</button></div>
  </form>
  <form method="post" action="/settings/lists/add" class="formrow" style="margin-top:10px">
    <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
    <div><label>New programme code</label><input type="text" name="prog_code" placeholder="e.g. MED"></div>
    <div style="flex:2"><label>Programme name</label><input type="text" name="prog_name" placeholder="e.g. Bachelor of Medicine"></div>
    <div><label>New intake</label><input type="text" name="intake" placeholder="e.g. May 2027"></div>
    <div style="flex:0"><label>&nbsp;</label><button class="btn ghost">Add</button></div>
  </form>
</div>

<div class="card">
  <h2>Email templates</h2>
  <p class="small muted">Placeholders: <span class="mono">{ref} {name} {first_name} {missing_docs} {missing_docs_section} {checklist} {status} {institution}</span></p>
  <form method="get" action="/settings" class="formrow">
    <div style="flex:2"><label>Template</label><select name="template" onchange="this.form.submit()">${templates
      .map((t) => `<option value="${esc(t.key)}" ${selectedTemplate === t.key ? "selected" : ""}>${esc(t.name)} (${esc(t.key)})</option>`)
      .join("")}</select></div>
  </form>
  ${templateEditor(c, (selectedTemplate ? c.repo.getTemplate(selectedTemplate) : undefined) ?? first)}
</div>

<div class="card">
  <h2>Export (CSV)</h2>
  <p>
    <a class="btn ghost small" href="/export/applicants.csv">⬇ Applicants</a>
    <a class="btn ghost small" href="/export/queue.csv">⬇ Review queue</a>
    <a class="btn ghost small" href="/export/audit.csv">⬇ Audit log</a>
  </p>
</div>`,
  });
}

function templateEditor(c: Pick<Ctx, "csrf">, t: { key: string; name: string; subject: string; body: string } | undefined): string {
  if (!t) return `<p class="muted">No templates.</p>`;
  return `<form method="post" action="/settings/template">
    <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
    <input type="hidden" name="key" value="${esc(t.key)}">
    <label>Display name</label><input type="text" name="name" value="${esc(t.name)}">
    <label>Subject (reference number is prepended automatically)</label><input type="text" name="subject" value="${esc(t.subject)}">
    <label>Body</label><textarea name="body" style="min-height:220px">${esc(t.body)}</textarea>
    <p><button class="btn">Save template</button></p>
  </form>`;
}

// ── Staff management (feature 31) ──────────────────────────────────────────

export function staffPage(c: Ctx, flash?: string): string {
  // Seed/demo passwords that must not survive in real use.
  const KNOWN_DEFAULTS: Record<string, string> = {
    admin: "admin123", manager: "manager123", jane: "jane123", otis: "otis123", kofi: "kofi123",
  };
  const onDefaultPassword = (username: string): boolean => {
    const known = KNOWN_DEFAULTS[username];
    if (!known) return false;
    const full = c.repo.getStaffByUsername(username);
    return Boolean(full && verifyPassword(known, full.password_hash));
  };
  const rows = c.repo
    .listStaff()
    .map((s) => `<tr>
      <td class="mono">${esc(s.username)}${onDefaultPassword(s.username) ? ` <span class="badge b-red" title="This account still uses its seeded demo password">default password</span>` : ""}</td>
      <td>${esc(s.display_name)}</td>
      <td><span class="badge b-gray">${esc(s.role)}</span></td>
      <td>${s.active ? `<span class="badge b-green">active</span>` : `<span class="badge b-red">disabled</span>`}</td>
      <td>
        <form method="post" action="/staff/toggle" style="display:inline"><input type="hidden" name="_csrf" value="${esc(c.csrf)}"><input type="hidden" name="id" value="${s.id}"><button class="btn small ghost">${s.active ? "disable" : "enable"}</button></form>
        <form method="post" action="/staff/password" style="display:inline"><input type="hidden" name="_csrf" value="${esc(c.csrf)}"><input type="hidden" name="id" value="${s.id}"><input type="password" name="password" placeholder="new password" style="width:150px;display:inline-block"><button class="btn small ghost">reset</button></form>
      </td>
    </tr>`)
    .join("");

  return layout({
    title: "Staff",
    user: c.user,
    unread: c.unread,
    active: "staff",
    institution: c.institution,
    csrf: c.csrf,
    content: `
<h1>Staff accounts</h1>
<div class="sub">Roles: <b>admin</b> (everything) · <b>manager</b> (cases + configuration) · <b>officer</b> (cases only) · <b>it</b> (cases + automation/settings, no staff management)</div>
${flash ? `<div class="flash ok" style="position:static;margin-bottom:16px">${esc(flash)}</div>` : ""}
${c.repo.listStaff().some((s) => { const k: Record<string,string> = { admin: "admin123", manager: "manager123", jane: "jane123", otis: "otis123", kofi: "kofi123" }; const f = c.repo.getStaffByUsername(s.username); return Boolean(k[s.username] && f && verifyPassword(k[s.username], f.password_hash)); })
  ? `<div class="flash err" style="position:static;margin-bottom:16px">⚠️ One or more accounts still use their seeded demo passwords. Reset them below before going live.</div>`
  : ""}
<div class="card">
<table><tr><th>Username</th><th>Name</th><th>Role</th><th>Status</th><th>Actions</th></tr>${rows}</table>
</div>
<div class="card">
  <h2>Add staff member</h2>
  <form method="post" action="/staff/add" class="formrow">
    <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
    <div><label>Username</label><input type="text" name="username" required></div>
    <div><label>Display name</label><input type="text" name="display_name" required></div>
    <div><label>Password</label><input type="password" name="password" required></div>
    <div><label>Role</label><select name="role"><option value="officer">officer</option><option value="it">it</option><option value="manager">manager</option><option value="admin">admin</option></select></div>
    <div style="flex:0"><label>&nbsp;</label><button class="btn">Create</button></div>
  </form>
</div>`,
  });
}

// ── Notifications (feature 39) ─────────────────────────────────────────────

export function notificationsPage(c: Ctx): string {
  const items = c.repo
    .notificationsFor(c.user.id)
    .map((n) => `<div class="card" style="${n.read ? "opacity:.65" : ""}">
      <div style="display:flex;gap:8px;align-items:center">
        <span class="badge ${n.kind === "escalation" ? "b-red" : n.kind === "review_needed" ? "b-orange" : "b-blue"}">${esc(n.kind)}</span>
        ${n.applicant_id ? `<a class="small" href="/case/${n.applicant_id}">open case →</a>` : ""}
        <span class="small muted" style="margin-left:auto">${esc(fmtDate(n.at))}</span>
      </div>
      <p style="margin:8px 0 0">${esc(n.message)}</p>
    </div>`)
    .join("");
  return head(
    c,
    "Alerts",
    "notifications",
    `<h1>Alerts &amp; notifications</h1><div class="sub">Escalations, new review cases and assignments.</div>${items || `<div class="card muted">No notifications.</div>`}`
  );
}

// ── Team performance (staff listener) ──────────────────────────────────────

export function teamPage(c: Ctx): string {
  const rows = c.repo.staffStats();
  const totals = rows.reduce(
    (acc, r) => ({
      received: acc.received + r.emailsReceived,
      sent: acc.sent + r.emailsSent,
      completed: acc.completed + r.admissionsCompleted,
    }),
    { received: 0, sent: 0, completed: 0 }
  );
  const trs = rows
    .map((r) => `<tr>
      <td>${avatar(r.display_name, 30)} <b>${esc(r.display_name)}</b><br><span class="muted small">@${esc(r.username)} · ${esc(r.role)}${r.active ? "" : " · disabled"}</span></td>
      <td>${r.assignedCases}</td>
      <td>${r.emailsReceived}</td>
      <td>${r.emailsSent}</td>
      <td>${r.avgResponseMinutes === null ? `<span class="muted">—</span>` : esc(formatDuration(r.avgResponseMinutes))}</td>
      <td>${r.admissionsCompleted}</td>
    </tr>`)
    .join("");

  return head(
    c,
    "Team",
    "team",
    `
<h1>Team performance</h1>
<div class="sub">Listener workload and responsiveness — computed live from the mail log, audit trail and status history.</div>
<div class="cols" style="grid-template-columns:repeat(3,1fr)">
  <div class="card stat"><div class="n">${totals.received}</div><div class="l">Incoming emails (assigned cases)</div></div>
  <div class="card stat"><div class="n">${totals.sent}</div><div class="l">Replies sent by staff</div></div>
  <div class="card stat"><div class="n">${totals.completed}</div><div class="l">Admissions completed</div></div>
</div>
<div class="card nopad">
<table>
  <tr><th>Staff member</th><th>Assigned cases</th><th>Emails received</th><th>Replies sent</th><th>Avg response time</th><th>Admissions completed</th></tr>
  ${trs || `<tr><td colspan="6" class="muted">No staff yet.</td></tr>`}
</table>
</div>
<p class="small muted">“Emails received” counts incoming mail on cases currently assigned to the person. “Replies sent” counts messages they personally approved or sent. Response time is measured on their assigned cases from an incoming email to the next outgoing reply.</p>`
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
        rows.push(step("", "📥 Case opened", `${t} — ${esc(ev.detail)}`));
        break;
      case "identity_matched":
        rows.push(step("", "🪪 Identity matched", `${t} — ${esc(ev.detail)}`));
        break;
      case "identity_concern":
        rows.push(step("flag", "⚠️ Identity concern", `${t} — ${esc(ev.detail)}`));
        break;
      case "email_received":
        rows.push(step("", "✉️ Email received", `${t} — ${esc(ev.detail)}`));
        break;
      case "duplicate_detected":
        rows.push(step("", "🔁 Duplicate detected", `${t} — ${esc(ev.detail)}`));
        break;
      case "case_enriched":
      case "phone_captured":
        rows.push(step("", "🧬 Enriched", `${t} — ${esc(ev.detail)}`));
        break;
      case "requirements_checked":
        rows.push(step("", "⚖️ Rules engine ran", `${t} — ${esc(ev.detail)}`));
        break;
      case "watcher_downgrade":
        rows.push(step("flag", "👀 Watcher downgraded", `${t} — ${esc(ev.detail)}`));
        break;
      case "late_submission":
      case "priority_raised":
        rows.push(step("flag", "🚩 Flag raised", `${t} — <b>${esc(ev.event)}</b> ${esc(ev.detail)}`));
        break;
      case "automation_held":
        rows.push(step("flag", "🕑 Automation held for approval", `${t} — ${esc(ev.detail)}`));
        break;
      case "email_sent_auto":
        rows.push(step("verdict", "🤖 Auto-reply sent", `${t} — ${esc(ev.detail)}`));
        break;
      case "human_review_triggered":
        rows.push(step("flag", "🧑 Queued for a human", `${t} — ${esc(ev.detail)}`));
        break;
      case "status_changed":
        rows.push(step("", "🔀 Lifecycle changed", `${t} — ${esc(ev.detail)}`));
        break;
      case "case_reopened":
        rows.push(step("", "🔓 Case reopened", `${t} — ${esc(ev.detail)}`));
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
