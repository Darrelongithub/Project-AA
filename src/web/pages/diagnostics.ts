/**
 * Page renderers — diagnostic pages (replay, intake test). Extracted verbatim from pages.ts;
 * pages.ts re-exports the page API unchanged.
 */
import { ApplicantRow, RuleNode } from "../../types";
import { esc, flagLabel, fmtDate } from "../views";
import { capFirst, head } from "./shared";
import type { Ctx } from "./shared";
import { badge, csrfField, flash } from "../tpl";

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
        .map((f) => `<li>${badge("orange", flagLabel(f.type))} ${esc(f.detail)}</li>`)
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
${opts.msg ? flash("ok", opts.msg, "position:static;margin-bottom:16px") : ""}
<div class="card">
  <form method="get" action="/intake/test" class="formrow" style="align-items:end">
    <div><label>CaseType</label><select name="case_type" onchange="this.form.submit()">${types.map((t) => `<option value="${esc(t.code)}"${t.code === selected.code ? " selected" : ""}>${esc(t.name)}</option>`).join("")}</select></div>
    <noscript><div style="flex:0"><button class="btn ghost">Load</button></div></noscript>
  </form>
</div>
<form method="post" action="/intake/test" class="card">
  ${csrfField(c.csrf)}
  <input type="hidden" name="case_type" value="${esc(selected.code)}">
  <h2>${esc(selected.name)}</h2>
  <div class="formrow">
    <div><label>Contact name</label><input name="from_name" value="Jordan Rivera" required maxlength="80"></div>
    <div><label>Contact email</label><input name="from" type="email" value="jordan.rivera@example.test" required maxlength="120"></div>
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
