/**
 * Page renderers — message templates. Extracted verbatim from pages.ts;
 * pages.ts re-exports the page API unchanged.
 */
import { renderTemplate } from "../../drafting";
import { admissionsPreset } from "../../presets/loader";
import { esc } from "../views";
import { head } from "./shared";
import type { Ctx } from "./shared";

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
  generic_enquiry: "Fallback reply SUGGESTED to staff when a rule-driven profile has a reply gap (or a rule's fallback names it) — queued for approval like every human-bound draft, never sent automatically.",
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


/** DEMO: organizations without the education module see neutral token help
 *  and no academic-only tokens. */
function placeholderDocsFor(c: Ctx): Array<[string, string]> {
  if (c.repo.hasEducationModule(c.user.organization_id ?? 1)) return PLACEHOLDER_DOCS;
  const academicOnly = new Set(["{programme}", "{reg_date}", "{orientation_dates}", "{read_back}"]);
  return PLACEHOLDER_DOCS.filter(([k]) => !academicOnly.has(k)).map(([k, v]): [string, string] =>
    k === "{institution}" ? [k, "the organization name"] : k === "{ref}" ? [k, "the case reference number"] : k === "{name}" ? [k, "full name of the contact"] : [k, v]);
}


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

  // Live preview against a sample applicant — exactly what renderTemplate
  // will produce, so staff see the real output before anyone receives it.
  const preview = renderTemplate(tpl.subject, tpl.body, {
    ref: `${repo.organizationRefPrefix(c.user.organization_id ?? 1)}-${new Date().getFullYear()}-000001`,
    institution: c.institution,
    name: "Wanjiku Kamau",
    missingLabels: ["Leaving Certificate", "Passport Photo"],
    checklist: "✓ Application Form\n✗ Leaving Certificate\n✗ Passport Photo",
    statusLabel: "Documents received",
    programme: "Bachelor of Laws",
    regDate: repo.getSetting("reg_date", ""),
    orientationDates: repo.getSetting("orientation_dates", ""),
    readBack: admissionsPreset().pageSamples.readBackSample,
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
      <div><label>Attach an attachment set</label><select name="attach_pack">
        <option value="none" ${packFlag === "none" ? "selected" : ""}>No attachments</option>
        ${c.repo.listAttachmentSets(c.user.organization_id ?? 1).map((s) => `<option value="${esc(s.name)}" ${packFlag === s.name ? "selected" : ""}>${esc(s.name)} (${s.file_count} file${s.file_count === 1 ? "" : "s"})</option>`).join("")}
        ${["application", "admission"].filter((legacy) => packFlag === legacy && !c.repo.listAttachmentSets(c.user.organization_id ?? 1).some((s) => s.name === legacy)).map((legacy) => `<option value="${legacy}" selected>${legacy} (missing set — create it in the Document library)</option>`).join("")}
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
          <option value="0" ${!tpl.case_type_id ? "selected" : ""}>Organization-wide (all profiles)</option>
          ${c.repo.listCaseTypes(c.user.organization_id ?? 1).map((t) => `<option value="${t.id}" ${tpl.case_type_id === t.id ? "selected" : ""}>${esc(t.name)} (${esc(t.code)})</option>`).join("")}
        </select></div>
      <div style="flex:2"><label>&nbsp;</label><span class="small muted">A profile-bound template is used only for that profile's cases. Keys are not a fixed list — create whatever a profile needs below.</span></div>
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
          <option value="0">Organization-wide (all profiles)</option>
          ${c.repo.listCaseTypes(c.user.organization_id ?? 1).map((t) => `<option value="${t.id}">${esc(t.name)} (${esc(t.code)})</option>`).join("")}
        </select></div>
      <button class="btn">Create template</button>
    </form>
  </details>`;

  const list = templates.map((t) => `<tr>
      <td><a href="/templates?template=${encodeURIComponent(t.key)}#tpl-${esc(t.key)}"><b>${esc(t.name)}</b></a><br><span class="mono small muted">${esc(t.key)}</span></td>
      <td class="small muted">${esc(TEMPLATE_USAGE[t.key] ?? "Manual staff reply.")}</td>
      <td>${!t.attach_pack || t.attach_pack === "none" ? `<span class="muted small">—</span>` : `<span class="badge b-purple">${esc(t.attach_pack)} set</span>`}</td>
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
        <h3 style="margin:0 0 6px;font-size:13px">Preview (sample contact)</h3>
        <div id="tpl-preview" class="small" style="border:1px solid var(--line2);border-radius:8px;padding:12px;background:var(--card2);white-space:pre-wrap;line-height:1.6"><b>${esc(preview.subject)}</b>\n\n${esc(preview.body)}</div>
        <h3 style="margin:16px 0 6px;font-size:13px">Placeholders</h3>
        <table><tr><th>Token</th><th>Filled with</th></tr>
          ${placeholderDocsFor(c).map(([k, v]) => `<tr><td class="mono small">${esc(k)}</td><td class="small muted">${esc(v)}</td></tr>`).join("")}
        </table>
      </div>
    </div>
  </div>
</section>`
  );
}
