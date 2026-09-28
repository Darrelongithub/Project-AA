/**
 * Page renderers — case file, evaluation panel and compose windows. Extracted verbatim from pages.ts;
 * pages.ts re-exports the page API unchanged.
 */
import { SYSTEM_LABELS } from "../../admissions/systems";
import { Repo } from "../../db/repo";
import { admissionsPreset } from "../../presets/loader";
import { docLabel } from "../../rules";
import { ApplicantRow, EMAIL_CATEGORY_LABELS, LIFECYCLE_LABELS, LIFECYCLE_ORDER } from "../../types";
import { avatar, categoryBadge, esc, flagLabel, fmtDate, lifecycleBadge, lifecycleStepper, priorityBadge, readabilityScore, slaText, triageBadge } from "../views";
import { DECISION_BADGES, capFirst, decisionBadge, head, resultBadge } from "./shared";
import type { Ctx } from "./shared";
import { badge, csrfField } from "../tpl";

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


// ── Admission eligibility panel (round 18) ─────────────────────────────────
// Structured evaluation: per-rule rows (applicant value vs required), the
// automated routing verdict, and the human-decision form. The word "rejected"
// never appears anywhere — a failed rule means HUMAN REVIEW, nothing else.
const ROUTING_TEXT: Record<string, [string, string, string]> = {
  auto_admit: ["b-green", "Auto-admit", "Every configured requirement is satisfied — the system may progress this file and send the admission letter."],
  human_review: ["b-orange", "Human Review Required", "The automated path cannot decide this case. A person must review it before anything is decided."],
  waiting_documents: ["b-blue", "Waiting for Documents", "Missing information is waiting on the applicant — absence is never interpreted as failure."],
};


/**
 * PPR P1-1: terminology — the five surface words (case / contact / category /
 * stage / outcome) are profile data. Defaults are the current education
 * wording, so nobody sees a change until an admin renames something.
 * Internal keys and DB columns never move.
 */
export function terminologyFor(c: Ctx, a?: ApplicantRow): { case: string; contact: string; category: string; stage: string; outcome: string } {
  const caseType = a ? c.repo.caseTypeForCase(a.id) : undefined;
  const t = (caseType?.terminology ?? {}) as Record<string, string>;
  return {
    case: t.case || "Applicant",
    contact: t.contact || "Contact",
    category: t.category || "Category",
    stage: t.stage || "Current level",
    outcome: t.outcome || "Admission decision",
  };
}


/** PPR P1-2: a profile's stage labels override the shipped ones (ids stable). */
export function stageLabelFor(c: Ctx, a: ApplicantRow): string {
  const caseType = c.repo.caseTypeForCase(a.id);
  const custom = caseType?.stages?.find((s) => s.id === a.lifecycle);
  return custom?.label ?? LIFECYCLE_LABELS[a.lifecycle];
}


function evaluationPanel(c: Ctx, a: ApplicantRow): string {
  const { repo } = c;
  // PPR P0-2: a non-education case never sees admission eligibility, grade
  // routes or decision vocabulary — only its configured evidence checklist.
  if (!repo.educationCaseFor(a)) {
    const requirements = repo.effectiveRequirements(a).filter((r) => r.required);
    const activeDocs = repo.listDocuments(a.id, { activeOnly: true });
    const present = new Set(activeDocs.map((d) => d.document_type));
    // P1-4: the profile's own document-slot labels win over built-in wording.
    const caseType = repo.caseTypeForCase(a.id);
    const slotLabel = (t: string): string =>
      (caseType ? repo.listDocumentDefinitions(caseType.id).find((d) => d.key === String(t))?.label : undefined) ?? docLabel(t);
    const rows = requirements.length
      ? requirements.map((r) => `<div class="field"><span class="lbl">${esc(slotLabel(r.document_type))}</span><span class="val">${present.has(r.document_type) ? badge("green", "on file") : badge("orange", "outstanding")}</span></div>`).join("")
      : `<div class="small muted">No required-information list is configured for this case type — configure one in Configuration → Case types.</div>`;
    return `<section class="sec">
      <div class="sec-head"><h2>Required information</h2></div>
      <div class="meta-grid">${rows}</div>
    </section>`;
  }
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
    ? `<div class="small" style="margin-top:8px">Still missing: ${ev.missingDocuments.map((m) => badge("blue", m)).join(" ")}</div>`
    : "";
  const blocking = ev.blockingFlags.length
    ? `<div class="small" style="margin-top:8px">Blocking flags: ${ev.blockingFlags.map((f) => badge("orange", flagLabel(f))).join(" ")}</div>`
    : "";
  const [toneCls, toneLabel, toneText] = ROUTING_TEXT[ev.routing] ?? ROUTING_TEXT.human_review;
  const reasonLine = ev.routing !== "auto_admit" && ev.reason ? `<div style="margin-top:6px"><b>Why:</b> ${esc(ev.reason)}</div>` : "";

  const decided = a.admission_decision !== "undecided";
  // M-3: an AUTOMATED decision (the provisional auto-admit) is reversible —
  // the registrar records not_admitted through the same decision path a human
  // review uses, and the reversal carries their name on the audit trail.
  const autoDecided = decided && a.admission_route !== "human";
  const copy = admissionsPreset().decisionCopy;
  const routeOptions = admissionsPreset().decisionRoutes
    .map((r) => `<option value="${r.value}">${r.label}</option>`)
    .join("\n              ");
  const reversalForm = autoDecided
    ? `<form class="decision-form" method="post" action="/case/${a.id}/admission-decision" style="margin-top:10px">
        ${csrfField(c.csrf)}
        <h3 style="margin:0 0 8px">${copy.reverseTitle}</h3>
        <p class="small muted" style="margin:0 0 10px">${copy.reverseBody}</p>
        <div class="row">
          <input name="reason" required placeholder="${copy.reasonPlaceholder}" style="flex:1">
          <button class="btn danger" name="decision" value="decline">${copy.reverseButton}</button>
        </div>
      </form>`
    : "";
  const decisionBlock = decided
    ? `<div class="routing-block ${a.admission_decision === "not_admitted" ? "b-red" : a.admission_decision === "auto_admitted" ? "b-green" : "b-purple"}">
        <b>${esc((DECISION_BADGES[a.admission_decision] ?? [a.admission_decision])[0])}</b>
        · ${a.admission_route === "human" ? "decided by a person" : "decided automatically"}${a.decision_by ? ` — ${esc(a.decision_by)}` : ""}
        ${a.decision_reason ? `<div class="small" style="margin-top:4px">${esc(a.decision_reason)}</div>` : ""}
       </div>${reversalForm}`
    : `<form class="decision-form" method="post" action="/case/${a.id}/admission-decision">
          ${csrfField(c.csrf)}
          <h3 style="margin:0 0 8px">${copy.formTitle}</h3>
          <p class="small muted" style="margin:0 0 10px">${copy.formBody}</p>
          <div class="row">
            <select name="route">
              ${routeOptions}
            </select>
            <input name="reason" required placeholder="${copy.reasonPlaceholder}" style="flex:1">
          </div>
          <div class="row" style="margin-top:10px">
            <button class="btn" name="decision" value="admit">${copy.admitButton}</button>
            <button class="btn danger" name="decision" value="decline">${copy.declineButton}</button>
          </div>
        </form>`;

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
      <form method="post" action="/case/${a.id}/reevaluate" style="margin:0">${csrfField(c.csrf)}<button class="btn small ghost">Re-run evaluation</button></form>
    </div>
  </section>`;
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
  // PPR P1-9: a non-education case never sees academic reply templates or
  // pack vocabulary — its page speaks only generic wording.
  const educationCasePage = repo.educationCaseFor(a);
  const ACADEMIC_TEMPLATE_KEYS = new Set(["admission_letter", "admission_docs"]);
  const templates = repo.listTemplates(c.user.organization_id ?? 1)
    .filter((t) => educationCasePage || !ACADEMIC_TEMPLATE_KEYS.has(t.key));
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
          ? badge("purple", "Required")
          : badge("gray", "Optional")
        : badge("gray", "—");
      const state = d.is_duplicate
        ? `<span class="badge b-gray">duplicate of #${d.duplicate_of}</span>`
        : d.superseded_by
          ? badge("gray", "superseded by #", d.superseded_by)
          : d.extraction_method === "none"
            ? badge("orange", "Unreadable")
            : badge("green", "Received");
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
        ? `<p class="small muted" style="margin:0 0 6px"><b>Attached (${attached.length}):</b> ${attached.map((f) => badge("gray", f)).join(" ")}</p>`
        : "";
      return `<details class="mail-item ${e.direction === "out" ? "out" : ""}">
      <summary>
        <span class="badge ${e.direction === "in" ? "b-blue" : "b-purple"}">${e.direction === "in" ? `← From ${esc(terms.contact.toLowerCase())}` : `→ To ${esc(terms.contact.toLowerCase())}`}</span>
        ${categoryBadge(e.category)}
        ${e.auto ? badge("gray", "automated") : ""}
        ${attached.length ? badge("purple", attached.length, " file(s) attached") : ""}
        ${e.channel && e.channel !== "email" ? badge("blue", "via ", e.channel) : ""}
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
        ${a.escalated ? badge("red", "escalated") : ""}
      </div>
    </div>
  </div>
  <div class="head-actions no-print">
    <a class="btn ghost small" href="/case/${a.id}/replay">Decision replay</a>
    <button class="btn ghost small" onclick="window.print()">Print case brief</button>
    <form method="post" action="/case/${a.id}/assign" class="ops-inline" style="margin:0">
      ${csrfField(c.csrf)}
      <select name="staff_id" style="max-width:160px"><option value="">Assign to…</option>${staffOptions}</select>
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
        <div class="field"><span class="lbl">Name</span><span class="val">${esc(a.full_name ?? "—")}</span></div>
        <div class="field"><span class="lbl">Email</span><span class="val"><a href="mailto:${esc(a.email_address)}">${esc(a.email_address)}</a></span></div>
        <div class="field"><span class="lbl">Phone</span><span class="val">${esc(a.phone ?? "—")}</span></div>
        <div class="field"><span class="lbl">${esc(terms.contact)}</span><span class="val">${esc(a.full_name ?? a.email_address)}${a.phone ? ` · ${esc(a.phone)}` : ""}</span></div>
        ${repo.educationCaseFor(a)
          ? `<div class="field"><span class="lbl">Applied programme</span><span class="val">${programme ? `${esc(programme.code)} — ${esc(programme.name)}` : `<span class="muted">not identified yet — the latest email decides it</span>`}</span></div>
        <div class="field"><span class="lbl">School</span><span class="val">${programme?.school ? esc(programme.school) : "—"}</span></div>
        <div class="field"><span class="lbl">Intake</span><span class="val">${esc(a.intake ?? "—")}</span></div>`
          : `<div class="field"><span class="lbl">${esc(terms.category)}</span><span class="val">${esc(a.category ?? "—")}</span></div>`}
        <div class="field"><span class="lbl">Reference number</span><span class="val mono">${esc(a.ref_number)}</span></div>
        ${a.queue ? `<div class="field"><span class="lbl">Queue</span><span class="val">${esc((repo.caseTypeForCase(a.id)?.queues ?? []).find((q) => q.id === a.queue)?.label ?? a.queue)}</span></div>` : ""}
        <div class="field"><span class="lbl">${esc(terms.stage)}</span><span class="val">${lifecycleBadge(a.lifecycle, stageLabels)} <span class="muted small" style="font-weight:500">moved through ${history.length} change${history.length === 1 ? "" : "s"}</span></span></div>
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
      <div class="sec-head"><h2>Email history</h2><span class="small muted">everything exchanged with ${esc(a.full_name ?? `this ${terms.contact.toLowerCase()}`)}</span></div>
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
        ${nextStage ? `<form method="post" action="/case/${a.id}/action" style="margin:0">${csrfField(c.csrf)}<button class="btn ghost" name="action" value="advance">Advance → ${esc(LIFECYCLE_LABELS[nextStage])}</button></form>` : ""}
        ${a.lifecycle !== "completed" ? `<form method="post" action="/case/${a.id}/action" style="margin:0">${csrfField(c.csrf)}<button class="btn ghost" name="action" value="complete">Mark completed</button></form>` : ""}
      </div>
      <hr class="ops-divider">
      <form method="post" action="/case/${a.id}/priority" class="ops-inline" style="margin:0">
        ${csrfField(c.csrf)}
        <select name="priority" style="flex:1">${["normal", "high", "urgent"].map((p) => `<option value="${p}" ${a.priority === p ? "selected" : ""}>${p} priority</option>`).join("")}</select>
        <button class="btn small ghost">Set</button>
      </form>
      <p class="small muted" style="margin:12px 0 0">Every action opens a <b>ready, pre-filled reply</b> — nothing is sent until you press Send.</p>
    </div>

    <!-- Response composer -->
    <div class="ops-card">
      <h2>Responses</h2>
      <p class="ops-sub">Pick a reply template — it is rendered with this ${esc(terms.contact.toLowerCase())}'s details. Preview first; nothing is sent without your click.</p>
      ${preview ? `<div class="resp-preview"><b>${esc(preview.subject)}</b>\n\n${esc(preview.body)}</div>` : ""}
      <form method="post" action="/case/${a.id}/send">
        ${csrfField(c.csrf)}
        <label>Template</label>
        <select name="template">${tplOptions}</select>
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
          <button class="btn ghost" name="preview" value="1">Preview</button>
          <button class="btn" onclick="return confirm('Send this reply now?')">Send now</button>
        </div>
      </form>
      <p class="small muted" style="margin-top:12px">Or open any template in the full composer: ${templates.slice(0, 3).map((t) => `<a href="/case/${a.id}/compose?template=${esc(t.key)}">${esc(t.name)}</a>`).join(" · ")}</p>
      <p class="small muted" style="margin:6px 0 0"><a href="/case/${a.id}/compose">Open the composer for this ${esc(terms.contact.toLowerCase())}</a> — same tab; after sending you land back on this case file.</p>
      <p class="small muted" style="margin:6px 0 0">Auto-response toggles per category live in <a href="/settings#automation">Settings → Automation</a>. Current modes: ${esc(autoSummary || "defaults")}</p>
    </div>

    ${isMgr && educationCasePage ? `<div class="ops-card" id="packs">
      <h2>Official packs</h2>
      <p class="small" style="margin:0 0 8px"><a href="/config?tab=pack">Manage the document library (sets &amp; files) →</a></p>
      <details style="margin-bottom:12px"><summary class="small" style="cursor:pointer;font-weight:700">What's included?</summary>
        <p class="small muted" style="margin:6px 0 0">The <b>application pack</b> (application form + brochure) goes to anyone who asks about applying. The <b>admission pack</b> sends the official admission letter with its accompanying documents. The <b>credit transfer form</b> goes to transferring applicants.</p>
      </details>
      <div class="ops-secondary">
        <form method="post" action="/case/${a.id}/send-pack" onsubmit="return confirm('Send the application pack — form and brochure attached?')" style="margin:0">
          ${csrfField(c.csrf)}<input type="hidden" name="kind" value="application">
          <button class="btn">Send application pack</button>
        </form>
        <form method="post" action="/case/${a.id}/send-pack" onsubmit="return confirm('Send the admission pack — letter plus accompanying documents?')" style="margin:0">
          ${csrfField(c.csrf)}<input type="hidden" name="kind" value="admission">
          <button class="btn">Send admission pack</button>
        </form>
        <form method="post" action="/case/${a.id}/send-pack" onsubmit="return confirm('Send the credit transfer form to this applicant?')" style="margin:0">
          ${csrfField(c.csrf)}<input type="hidden" name="kind" value="transfer">
          <button class="btn ghost">Send credit transfer form</button>
        </form>
      </div>
    </div>` : ""}

    ${isMgr && !educationCasePage ? `<div class="ops-card" id="packs">
      <h2>Document sets</h2>
      <p class="small" style="margin:0 0 8px"><a href="/config?tab=pack">Manage the document library (sets &amp; files) →</a></p>
      ${repo.listAttachmentSets(c.user.organization_id ?? 1).length
        ? `<div class="ops-secondary">${repo.listAttachmentSets(c.user.organization_id ?? 1).map((s) => `<form method="post" action="/case/${a.id}/send-pack" onsubmit="return confirm('Send the “${esc(s.name)}” set to this requester?')" style="margin:0">
          ${csrfField(c.csrf)}<input type="hidden" name="kind" value="${esc(s.name)}">
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
        ${csrfField(c.csrf)}
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
          ${csrfField(c.csrf)}
          <input type="hidden" name="task_id" value="${t.id}">
          <button class="btn small ghost" title="toggle">${t.done ? "☑" : "☐"}</button>
        </form>
        <span class="t">${esc(t.title)}</span>
        <span class="small muted" style="margin-left:auto">${t.done ? "done" : ""} ${esc(t.display_name ?? "")}</span>
      </div>`).join("") : `<p class="muted small">No tasks yet.</p>`}
      <form method="post" action="/case/${a.id}/task/add" style="display:flex;gap:6px;margin-top:10px">
        ${csrfField(c.csrf)}
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
        ${csrfField(c.csrf)}
        <label>Add note</label>
        <textarea name="body" style="min-height:60px" placeholder="e.g. Applicant called. Waiting for original certificate."></textarea>
        <p style="margin-top:8px"><button class="btn small">Add note</button></p>
      </form>
    </div>

    ${isMgr ? `<div class="ops-card">
      <h2>Re-categorise</h2>
      <p class="ops-sub">If triage put the newest incoming email in the wrong bucket, move it after your review. Recorded in the audit trail${latestIncoming ? ` — currently <b>${esc(latestIncoming.category ?? "uncategorised")}</b>` : ""}.</p>
      <form method="post" action="/case/${a.id}/category" class="ops-inline" style="align-items:center;margin:0">
        ${csrfField(c.csrf)}
        <select name="category" style="flex:1">
          ${Object.entries(EMAIL_CATEGORY_LABELS).filter(([k]) => educationCasePage || k !== "admission_enquiry").map(([k, v]) => `<option value="${k}" ${latestIncoming?.category === k ? "selected" : ""}>${v}</option>`).join("")}
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
    ${csrfField(c.csrf)}
    <input type="hidden" name="template" value="${esc(tpl.key)}">
    <label>Subject</label>
    <input type="text" name="subject" value="${esc(rendered.subject)}">
    <label>Message</label>
    <textarea name="body" style="min-height:380px;font-size:14px;line-height:1.7">${esc(rendered.body)}</textarea>
    <div style="display:flex;gap:10px;margin-top:18px;align-items:center">
      <button class="btn">Send now</button>
      <a class="btn ghost" href="/case/${a.id}">Cancel — don't send</a>
      ${tpl.include_banner === 0 ? `<span class="muted small">sends without the branded banner</span>` : `<span class="muted small">branded banner is attached automatically</span>`}
      ${tpl.attach_pack && tpl.attach_pack !== "none" ? badge("purple", tpl.attach_pack, " set PDFs will be attached") : ""}
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
    <div style="flex:1"><label>Search contacts</label>
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
  // Same shape as the case-file composer: one form, ONE submit (Send now), so
  // Enter sends. Template choice is a link that re-renders the draft — it
  // never competes with the send button and can never wipe typed text.
  const a = opts.applicant;
  const templates = repo.listTemplates(c.user.organization_id ?? 1);
  const tpl = opts.templateKey ? templates.find((t) => t.key === opts.templateKey) : undefined;
  const prog = a.programme ? repo.programmeByCode(a.programme) : undefined;
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
  <p class="small muted" style="margin-top:0">Everything below is editable — nothing is sent until you press Send. Pick a template to pre-fill the draft:</p>
  <p style="margin:0 0 14px;line-height:2.1">${chips}</p>
  <form method="post" action="/compose">
    ${csrfField(c.csrf)}
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
      ${tpl && tpl.attach_pack && tpl.attach_pack !== "none" ? badge("purple", tpl.attach_pack, " set PDFs will be attached") : ""}
    </div>
  </form>
</div>`);
}
