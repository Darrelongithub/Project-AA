/**
 * Page renderers — configuration console (requirements, case types, workflow rules). Extracted verbatim from pages.ts;
 * pages.ts re-exports the page API unchanged.
 */
import { describeRuleTree, interpretRuleTree } from "../../admissions/engine";
import { SYSTEM_LABELS } from "../../admissions/systems";
import { EXAM_SYSTEMS } from "../../config";
import { documentRequirementsFor } from "../../documents/matrix";
import { packManifest } from "../../pack";
import { admissionsPreset } from "../../presets/loader";
import { describeRule } from "../../rules/workflow";
import { ADMISSION_SYSTEMS, AdmissionSystem, CaseType, LIFECYCLE_LABELS, RuleNode } from "../../types";
import { esc } from "../views";
import { head } from "./shared";
import type { Ctx } from "./shared";
import { badge, csrfField, emptyState, flash as flashBanner } from "../tpl";

type LegacyAcademicLevel = "degree" | "diploma" | "certificate" | "masters" | "phd";


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
              ${csrfField(c.csrf)}<input type="hidden" name="file_id" value="${f.id}">
              <button class="btn small ghost" onclick="return confirm('Remove this file from the set?')">Remove</button></form></td>
          </tr>`).join("") : `<tr><td colspan="4" class="small muted">No files yet — upload a PDF below.</td></tr>`}
        </table>
        <div style="display:flex;gap:8px;align-items:center;margin-top:10px">
          <input type="file" accept="application/pdf" id="aset-file-${s.id}" style="max-width:230px">
          <button class="btn small" data-aset-upload="${s.id}">Upload PDF</button>
          <span class="small muted" id="aset-msg-${s.id}" role="status"></span>
        </div>
        <form method="post" action="/config/attachment-sets/delete" style="margin-top:10px">
          ${csrfField(c.csrf)}<input type="hidden" name="set_id" value="${s.id}">
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
      ${csrfField(c.csrf)}
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
  // PPR P1-4 — Document library. The ten fixed education pack slots are gone
  // from the UI: an organization's sendable PDFs are LIBRARY FILES that live
  // in its own named attachment sets (above). The education pack generator
  // stays where it belongs — the academic matrix on the Requirements tab —
  // and the labelled migration readers (applicationPack/admissionPack) remain
  // readable below as a snapshot, never as editable slots.
  const orgId = c.user.organization_id ?? 1;
  const sets = c.repo.listAttachmentSets(orgId);
  const fmt = (b: number) => b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`;
  const fileRows = sets.flatMap((s) =>
    c.repo.listAttachmentSetFiles(s.id).map((f) => `<tr>
      <td>${esc(f.filename)}</td>
      <td class="small">${fmt(f.content.length)}</td>
      <td class="small">${badge("gray", s.name)}</td>
      <td class="small muted">${esc(f.provenance)}</td>
      <td><form method="post" action="/config/attachment-sets/file-delete" style="margin:0">
        ${csrfField(c.csrf)}<input type="hidden" name="file_id" value="${f.id}">
        <button class="btn small ghost" onclick="return confirm('Remove this file from the library?')">Remove</button></form></td>
    </tr>`));
  const manifest = packManifest(c.repo, orgId);
  const legacyRows = manifest.map((m) => `<tr>
      <td>${esc(m.pretty)}</td>
      <td class="small muted">${esc(m.pack)}</td>
      <td class="small muted">${esc(m.purpose)}</td>
      <td>${m.exists ? fmt(m.bytes) : "<b>MISSING</b>"}</td>
      <td>${m.exists ? `<a class="btn small ghost" href="/pack/${esc(m.key)}" target="_blank" rel="noopener">Open</a>` : ""}</td>
    </tr>`).join("");
  return `<div class="card" id="documents">
  <div class="card-head"><h2>Document library</h2></div>
  <div style="padding:14px 24px 22px">
    <p class="small muted" style="margin-top:-4px">Every PDF this organization can send lives here, inside named <b>attachment sets</b> (managed above). Templates and workflow rules attach a set by name — there is no fixed pack vocabulary. Upload a file into a set below, or create a set first.</p>
    ${fileRows.length ? `<table><tr><th>File</th><th>Size</th><th>Set</th><th>Origin</th><th></th></tr>${fileRows.join("")}</table>`
      : `<p class="muted small">The library is empty — upload a PDF below or create a set above.</p>`}
    <div style="display:flex;gap:8px;align-items:center;margin-top:12px;flex-wrap:wrap">
      <select id="lib-set" style="max-width:190px">
        ${sets.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("")}
      </select>
      <input type="file" accept="application/pdf" id="lib-file" style="max-width:230px">
      <button class="btn small" id="lib-upload">Upload PDF</button>
      <span class="small muted" id="lib-msg" role="status">${sets.length ? "" : "Create a set first."}</span>
    </div>
    <h3 style="margin-top:20px">Legacy education packs (labeled migration snapshot)</h3>
    <p class="small muted" style="margin-top:-4px">Read-only. These are the migrated education files (application / admission groups) kept for the stamped legacy profile — the education document matrix on the <a href="/config?tab=requirements">Requirements</a> tab remains the profile generator for what an education file must hold. New organizations never see this as editable slots.</p>
    <table><tr><th>Document</th><th>Group</th><th>Used for</th><th>Size</th><th></th></tr>${legacyRows}</table>
  </div>
</div>
<script>
(function () {
  var btn = document.getElementById("lib-upload");
  if (!btn) return;
  btn.addEventListener("click", function () {
    var setSel = document.getElementById("lib-set");
    var file = document.getElementById("lib-file").files[0];
    var msg = document.getElementById("lib-msg");
    if (!setSel || !setSel.value) { msg.textContent = "Create a set first."; return; }
    if (!file) { msg.textContent = "Choose a PDF first."; return; }
    if (file.type !== "application/pdf") { msg.textContent = "PDF files only."; return; }
    msg.textContent = "Uploading\u2026";
    fetch("/config/attachment-sets/upload?set=" + encodeURIComponent(setSel.value) + "&filename=" + encodeURIComponent(file.name || "document.pdf"), {
      method: "POST",
      headers: { "x-csrf-token": "${esc(c.csrf)}", "content-type": "application/pdf" },
      body: file,
    }).then(function (res) {
      if (res.ok) { location.reload(); }
      else { res.text().then(function (t) { msg.textContent = t || "Upload failed."; }); }
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


function conditionValuePicker(system: string, level: LegacyAcademicLevel, node: RuleNode): string {
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
function ruleNodeEditor(c: Ctx, target: string, system: string, node: RuleNode, depth: number, subjects: string[], level: LegacyAcademicLevel): string {
  const csrf = csrfField(c.csrf);
  const targetFields = `<input type="hidden" name="target" value="${esc(target)}"><input type="hidden" name="system" value="${esc(system)}">`;
  const pad = depth * 18;

  if (node.kind === "group") {
    const logicForm = `<form class="node-row" method="post" action="/config/requirements/node-save" style="margin-left:${pad}px">
      ${csrf}${targetFields}<input type="hidden" name="node" value="${node.id}">
      ${badge("purple", "Either/or group")}
      <select name="logic" style="width:auto" title="How the options inside this group combine">
        ${["AND", "OR", "NOT"].map((l) => `<option value="${l}" ${node.logic === l ? "selected" : ""}>${l === "OR" ? "any of these (either/or)" : l === "AND" ? "all of these (must all pass)" : "none of these (must all fail)"}</option>`).join("")}
      </select>
      <button class="btn small ghost" title="Save group logic">Save</button>
    </form>`;
    const addButtons = `<div class="node-add" style="margin-left:${pad + 18}px">
      <form method="post" action="/config/requirements/node-add" style="margin:0">${csrf}${targetFields}<input type="hidden" name="parent" value="${node.id}"><input type="hidden" name="kind" value="condition"><button class="btn small ghost">+ Condition</button></form>
      <form method="post" action="/config/requirements/node-add" style="margin:0">${csrf}${targetFields}<input type="hidden" name="parent" value="${node.id}"><input type="hidden" name="kind" value="group"><button class="btn small ghost" title="A nested either/or group inside this one">+ Subgroup (nested either/or)</button></form>
      <form method="post" action="/config/requirements/node-delete" style="margin:0" onsubmit="return confirm('Remove this group and everything inside it?')">${csrf}${targetFields}<input type="hidden" name="node" value="${node.id}"><button class="btn small ghost" style="color:var(--red)">Remove group</button></form>
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
    <form method="post" action="/config/requirements/node-delete" style="margin:0" onsubmit="return confirm('Remove this condition?')">${csrf}${targetFields}<input type="hidden" name="node" value="${node.id}"><button class="btn small ghost" style="color:var(--red)">✕</button></form>
  </form>`;
}


function requirementsTab(c: Ctx, reqsTarget?: string, reqsSystem?: string): string {
  const { repo } = c;
  const programmes = repo.listProgrammes();

  const system = (reqsSystem && (ADMISSION_SYSTEMS as readonly string[]).includes(reqsSystem) ? reqsSystem : admissionsPreset().defaultSystem) as AdmissionSystem;
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
  const level = (isBase ? target.slice(5) : repo.programmeByCode(target)?.level ?? "degree") as LegacyAcademicLevel;
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
    <label class="small muted">CaseType</label>
    <select name="reqs" onchange="this.form.submit()">
      ${targetOptions.map(([v, l]) => `<option value="${esc(v)}" ${target === v ? "selected" : ""}>${esc(l)}</option>`).join("")}
    </select>
    <label class="small muted">Qualification system</label>
    <select name="system" onchange="this.form.submit()">
      ${ADMISSION_SYSTEMS.map((s) => `<option value="${s}" ${system === s ? "selected" : ""}>${esc(SYSTEM_LABELS[s])}</option>`).join("")}
    </select>
  </form>`;

  const csrf = csrfField(c.csrf);
  const tf = `<input type="hidden" name="target" value="${esc(target)}"><input type="hidden" name="system" value="${esc(system)}">`;

  const versionNote = shown
    ? shown.status === "draft"
      ? `${badge("orange", "DRAFT v", shown.version)} <span class="small muted">based on active v${shown.version - 1} — not yet judging anyone</span>`
      : `${badge("green", "ACTIVE v", shown.version)} <span class="small muted">edits create a draft; the active set keeps judging until you activate the replacement</span>`
    : badge("gray", "NO SET YET");

  const builder = shown ? `
    <div class="card" style="margin-bottom:14px;padding:12px 16px">
      <div style="font-size:13px"><b>How to read this list:</b> every requirement below must all be met — unless it sits inside an <b>either/or group</b>, where meeting <b>any one</b> of the options is enough.</div>
      <div class="node-add" style="margin:10px 0 0">
        <form method="post" action="/config/requirements/node-add" style="margin:0">${csrf}${tf}<input type="hidden" name="kind" value="condition"><button class="btn small">+ Add a requirement</button></form>
        <form method="post" action="/config/requirements/node-add" style="margin:0">${csrf}${tf}<input type="hidden" name="kind" value="group"><button class="btn small ghost">+ Add an either/or group</button></form>
      </div>
      <p class="small muted" style="margin:8px 0 0">${admissionsPreset().pageSamples.requirementExample}</p>
    </div>
    ${shownTree.length ? shownTree.map((n) => ruleNodeEditor(c, target, system, n, 0, subjects, level)).join("") : `<p class="small muted">No requirements yet. Start with “+ Add a requirement” — e.g. <b>Mean grade ≥ C+</b>. Everything you add below must all be met for an applicant to qualify; an either/or group passes when any one of its options passes.</p>`}
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
          <td>${r.active ? badge("green", "active") : badge("gray", "retired")}</td>
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
  // OR-6: LegacyAcademicLevel now carries masters/phd directly (legacy "postgrad"
  // rows are migrated on open; keep a defensive alias anyway).
  const genLevel: LegacyAcademicLevel = ((level as string) === "postgrad" ? "masters" : level) as LegacyAcademicLevel;
  const matrixSpecs = documentRequirementsFor({ level: genLevel, route: "fresh", nationality: "unknown", programmeCode: isBase ? null : target });
  const matrixRows = matrixSpecs
    .map((spec) => `<div class="check-item ${spec.blocking ? "required" : "optional"}">
      <span class="check-icon" aria-hidden="true">${spec.blocking ? "✓" : "◇"}</span>
      <span class="check-name">${esc(spec.label)}</span>
      <span class="check-note">${spec.blocking ? "Required" : "Post-admission · does not block"}${spec.conditional ? ` · ${esc(spec.conditional)}` : ""}</span>
    </div>`)
    .join("");
  const matrixCard = `
<section class="card" id="doc-matrix">
  <h2>Document checklist <span class="muted small" style="text-transform:none;letter-spacing:0">— generated deterministically, not staff-configurable</span></h2>
  <p class="small muted" style="margin-top:-4px">What an application file must contain is generated deterministically from the official application-form checklist (data/pack/application-form.pdf, pp. 3–4) — level × curriculum × nationality × route. There are no toggles: conditional items are asked for, never assumed, and post-admission items never block a file. Full matrix: <span class="mono">docs/DOCUMENT_MATRIX.md</span>. Shown for <b>${esc(isBase ? `university-wide ${genLevel}` : `${target} (${genLevel})`)}</b>, fresh applicants:</p>
  <div class="checklist" role="list" aria-label="Required document checklist">${matrixRows}</div>
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
  const csrf = csrfField(c.csrf);
  const orgPicker = `<form method="get" action="/config" class="inline" style="margin-bottom:16px">
    <input type="hidden" name="tab" value="case-types">
    <label class="small muted">Organization</label>
    <select name="organization" onchange="this.form.submit()">${organizations.map((o) => `<option value="${o.id}" ${o.id === organizationId ? "selected" : ""}>${esc(o.name)} · ${esc(o.ref_prefix)}</option>`).join("")}</select>
  </form>`;
  const typeCard = (ct: CaseType): string => {
    const definitions = c.repo.listDocumentDefinitions(ct.id);
    const rules = c.repo.caseTypeRules(ct);
    const documentRows = definitions.map((d) => `<tr>
      <td class="mono small">${esc(d.key)}</td><td>${esc(d.label)}</td>
      <td>${d.required ? "required" : "optional"} · ${d.blocking ? "blocks gate" : "non-blocking"}</td>
      <td><form method="post" action="/config/case-types/document-delete" style="margin:0">${csrf}<input type="hidden" name="organization_id" value="${organizationId}"><input type="hidden" name="case_type_id" value="${ct.id}"><input type="hidden" name="key" value="${esc(d.key)}"><button class="btn small ghost">Remove</button></form></td>
    </tr>`).join("");
    return `<details class="card type-card" id="case-type-${ct.id}">
      <summary class="type-card-summary"><span>${esc(ct.name)}</span><span class="mono small muted">${esc(ct.code)}</span><span class="type-card-hint">Edit CaseType</span></summary>
      <div class="type-content">
      <p class="small muted">Category: ${esc(ct.category)} · This CaseType has no academic qualification picker or inherited document defaults.</p>
      <h3>Document matrix</h3>
      ${definitions.length ? `<table><tr><th>Key</th><th>Label</th><th>Gate behavior</th><th></th></tr>${documentRows}</table>` : `<p class="small muted">No document slots configured yet.</p>`}
      <form method="post" action="/config/case-types/document" class="formrow" style="margin-top:10px">
        ${csrf}<input type="hidden" name="organization_id" value="${organizationId}"><input type="hidden" name="case_type_id" value="${ct.id}">
        <div><label>Document key</label><input name="key" placeholder="employee_id" required></div>
        <div style="flex:2"><label>Contact-facing label</label><input name="label" placeholder="Signed employee ID" required></div>
        <div><label>Required</label><select name="required"><option value="1">Yes</option><option value="0">No</option></select></div>
        <div><label>Blocking</label><select name="blocking"><option value="1">Yes</option><option value="0">No</option></select></div>
        <div style="flex:0"><label>&nbsp;</label><button class="btn small">Save document slot</button></div>
      </form>
      <h3 style="margin-top:20px">Rule tree</h3>
      ${rules.length ? `<p class="rule-summary" style="font-family:monospace;background:var(--line2, rgba(127,127,127,.12));padding:8px 10px;border-radius:8px">${esc(ruleTreeText(rules))}</p>` : `<p class="small muted">Empty rule tree — every case is undecided and goes to a human.</p>`}
      <p class="small muted">Use organization-defined fact keys. The evaluator supports nested AND, OR and NOT groups; a failed or incomplete tree routes to human review, never an automatic rejection.</p>
      <form method="post" action="/config/case-types/rules" style="margin:0">
        ${csrf}<input type="hidden" name="organization_id" value="${organizationId}"><input type="hidden" name="case_type_id" value="${ct.id}">
        <textarea name="rules_json" style="min-height:180px;font-family:monospace" spellcheck="false">${esc(JSON.stringify(rules, null, 2))}</textarea>
        <button class="btn small" style="margin-top:8px">Save rule tree</button>
      </form>
      <p class="small muted" style="margin-top:8px">Currently ${rules.length} top-level node${rules.length === 1 ? "" : "s"}; fields such as <span class="mono">employment_type</span> or <span class="mono">start_date</span> are valid when the organization supplies those facts.</p>
      </div>
    </details>`;
  };
  const groupedCaseTypes = new Map<string, CaseType[]>();
  for (const ct of caseTypes) {
    const category = ct.category?.trim() || "Uncategorised";
    groupedCaseTypes.set(category, [...(groupedCaseTypes.get(category) ?? []), ct]);
  }
  const caseTypeGroups = [...groupedCaseTypes.entries()].map(([category, types]) => `<details class="type-group">
    <summary><span class="type-group-name">${esc(category)}</span><span class="type-group-count">${types.length} CaseType${types.length === 1 ? "" : "s"}</span></summary>
    <div class="type-group-body">${types.map(typeCard).join("")}</div>
  </details>`).join("");
  return `<div id="case-types">
    <section class="card">
      <h2>Organizations &amp; CaseTypes</h2>
      <p class="small muted">Organizations own their CaseTypes, document definitions, rule trees, axes and reference prefixes. A new organization starts empty: no academic catalogue, qualification systems or migrated identity data are copied.</p>
      <p class="small muted">The migrated Organization 1 compatibility matrix remains generated deterministically from its official pack; it is not a default for new CaseTypes.</p>
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
      <p class="small muted">Axes are organization vocabulary, not hardcoded level, curriculum or status fields. Save one JSON array of <span class="mono">{key,label,values}</span> objects.</p>
      <form method="post" action="/config/case-types/axes" style="margin:0">
        ${csrf}<input type="hidden" name="organization_id" value="${organizationId}">
        <textarea name="axes_json" style="min-height:80px;font-family:monospace" spellcheck="false">${esc(JSON.stringify(c.repo.listOrganizationDocumentAxes(organizationId), null, 2))}</textarea>
        <button class="btn small" style="margin-top:8px">Save axes</button>
      </form>
      <p class="small muted" style="margin-bottom:0">Configure the selected organization, then create a CaseType such as <b>HR_ONBOARDING</b>. Empty rule trees remain undecided and are sent to a human.</p>
    </section>
    ${caseTypes.length ? `<div class="type-groups">${caseTypeGroups}</div>` : emptyState(`<p>No CaseTypes yet for ${esc(organization?.name ?? "this organization")}.</p>`)}
  </div>`;
}


/**
 * PPR P0-4: Workflow rules — first-email and response behaviour as DATA.
 * The tab is the admin's control room: intake rules say which mail becomes a
 * case (create/attach/ignore/review); response rules say how the case replies
 * (send/draft/hold, which template, follow-up ladder, SLA, audit code).
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
      ["signals", "built-in education intake signals"],
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
          <option value=\"\">Legacy / education scope (migrated profile)</option>
          ${caseTypes.map((t) => `<option value=\"${t.id}\" ${editing?.case_type_id === t.id ? "selected" : ""}>${esc(t.name)} (${esc(t.code)})${t.education_module ? " · education" : ""}</option>`).join("")}
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
      <div class=\"field\" style=\"flex:1;min-width:150px\"><span class=\"lbl\">Follow-up policy</span>
        <select name=\"followup\">
          <option value=\"\">none</option>
          <option value=\"ladder\" ${act.followup === "ladder" ? "selected" : ""}>reminder ladder (3/7/10 days)</option>
        </select></div>
      <div class=\"field\" style=\"flex:1;min-width:170px\"><span class=\"lbl\">Follow-up rung response</span>
        <select name=\"followup_action\">
          ${["hold", "send", "draft", "approve", "none"].map((d) => `<option value=\"${d}\" ${(act.followup_action ?? "hold") === d ? "selected" : ""}>${{ hold: "hold for staff (default)", send: "send (un-gated profiles)", draft: "draft for staff", approve: "draft for approval", none: "do nothing (cancel ladder)" }[d]}</option>`).join("")}
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
        <td class=\"small\">${r.case_type_id === null ? "legacy / education" : esc(caseTypes.find((t) => t.id === r.case_type_id)?.name ?? `type #${r.case_type_id}`)}</td>
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
  <p class=\"small muted\" style=\"margin-top:-6px\">Each CaseType is a workflow profile. New profiles default to <b>draft</b> automation (every suggested reply waits for staff) and auto-admit off. The migrated education profile keeps its preserved settings.</p>
  ${caseTypes.map((t) => {
    const term = (t.terminology ?? {}) as Record<string, string>;
    const stageText = (t.stages ?? []).map((s) => `${s.id}|${s.label}${s.requires?.length ? `|${s.requires.join(", ")}` : ""}`).join("\n");
    const queueText = (t.queues ?? []).map((q) => `${q.id}|${q.label}`).join("\n");
    return `<details style="margin:8px 0;border:1px solid var(--line2);border-radius:8px">
      <summary style="cursor:pointer;padding:10px 14px"><b>${esc(t.name)}</b> — vocabulary, stages &amp; queues <span class="muted small">(PPR P1-1/P1-2)</span></summary>
      <form method="post" action="/config/case-types/vocabulary" style="padding:10px 16px 16px">
        ${csrfField(c.csrf)}
        <input type="hidden" name="id" value="${t.id}">
        <p class="small muted">Five surface words, defaulted to the current education wording. Internal keys and database columns never move — only what staff and applicants read.</p>
        <div class="formrow">
          <div><label>Case</label><input name="term_case" value="${esc(term.case ?? "Applicant")}"></div>
          <div><label>Contact</label><input name="term_contact" value="${esc(term.contact ?? "Contact")}"></div>
          <div><label>Category</label><input name="term_category" value="${esc(term.category ?? "Category")}"></div>
          <div><label>Stage</label><input name="term_stage" value="${esc(term.stage ?? "Current level")}"></div>
          <div><label>Outcome</label><input name="term_outcome" value="${esc(term.outcome ?? "Admission decision")}"></div>
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
    <tr><th>Profile</th><th>Education module</th><th>Automation default</th><th>Qualification gate</th><th>Auto-admit</th><th></th></tr>
    ${caseTypes.map((t) => `<tr>
      <td><b>${esc(t.name)}</b> <span class=\"small muted\">${esc(t.code)}</span></td>
      <td>${t.education_module ? badge("purple", "on") : badge("gray", "off")}</td>
      <td><form method=\"post\" action=\"/config/case-types/profile\" style=\"display:flex;gap:6px;margin:0\">
        <input type=\"hidden\" name=\"_csrf\" value=\"${esc(c.csrf)}\"><input type=\"hidden\" name=\"id\" value=\"${t.id}\">
        <select name=\"default_reply_action\">
          <option value=\"draft\" ${t.default_reply_action !== "auto" ? "selected" : ""}>draft (recommended)</option>
          <option value=\"auto\" ${t.default_reply_action === "auto" ? "selected" : ""}>auto-send when a rule says so</option>
        </select>
        <select name=\"qualification_gate\">
          <option value=\"1\" ${t.qualification_gate !== 0 ? "selected" : ""}>hold non-qualified replies</option>
          <option value=\"0\" ${t.qualification_gate === 0 ? "selected" : ""}>gate off (rules decide)</option>
        </select>
        <button class=\"btn small ghost\">Save</button>
      </form></td>
      <td>${t.qualification_gate !== 0 ? "on" : "off"}</td>
      <td>${t.auto_admit ? badge("orange", "legacy on") : badge("green", "off")}</td>
      <td></td>
    </tr>`).join("")}
  </table>
</div>`;

  return `<div class=\"card\">
  <h2>Workflow rules</h2>
  <p class=\"small muted\" style=\"margin-top:-6px\">First-email and response behaviour lives here as <b>data</b> — create/attach/ignore/review, send/draft/hold, templates, follow-up and audit codes are all configurable. The migrated education profile's rules reproduce the behaviour staff already know; edit freely.</p>
</div>
${profileCard}
<div class=\"card\">
  <h2>Intake rules — which mail becomes a case</h2>
  ${ruleTable("intake")}
  <h2 style=\"margin-top:22px\">Response rules — how the case replies</h2>
  ${ruleTable("response")}
</div>
${form}`;
}


export function configPage(c: Ctx, _selectedTemplate?: string, flash?: string, reqsTarget?: string, tabChoice?: string, reqsSystem?: string, caseTypesOrganizationId?: number, editRuleId?: number): string {

  // Round 3: the courses tab moved to the staff area (one home for course
  // configuration); /config?tab=courses redirects there at the route level.
  const tab = tabChoice === "replies" || tabChoice === "pack" || tabChoice === "requirements" || tabChoice === "rules" ? tabChoice : "case-types";
  const tabBar = `<div class="tabs" style="margin:0 0 20px">
    <a href="/config?tab=case-types" class="${tab === "case-types" ? "on" : ""}">CaseTypes</a>
    <a href="/config?tab=rules" class="${tab === "rules" ? "on" : ""}">Workflow rules</a>
    <a href="/config?tab=requirements" class="${tab === "requirements" ? "on" : ""}">Legacy requirements</a>
    <a href="/config?tab=replies" class="${tab === "replies" ? "on" : ""}">Reply configuration</a>
    <a href="/config?tab=pack" class="${tab === "pack" ? "on" : ""}">Document library</a>
  </div>`;

  // Round 11: the pack files have their OWN tab (they were hiding inside
  // "Reply configuration", which is why staff thought they couldn't be
  // changed).
  const replyHtml = `
<div class="card" id="templates-home">
  <h2>Email templates</h2>
  <p class="small muted" style="margin-top:-6px">OR-7: every outgoing email type — automated replies, reminders and staff messages — is edited in the dedicated <a href="/templates">Templates section</a>, with placeholders documented, a live preview, reset-to-default and optional pack attachments.</p>
  <p><a class="btn" href="/templates">Open the Templates section →</a></p>
</div>

<div class="card" id="branding">
  <h2>Email branding</h2>
  <p class="small muted" style="margin-top:-6px">The banner below is placed at the top of <b>every</b> outgoing email — automated replies, template sends and document packs alike. Replace it any time; individual templates can also opt out in the editor above.</p>
  <img id="banner-preview" src="/assets/email-banner" alt="Email banner" style="width:100%;max-width:720px;border:1px solid var(--wine-line);border-radius:8px;display:block">
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
<div class="sub">Requirements, deadlines and reply behaviour — course configuration (courses, ownership, document checklists) lives in the <a href="/staff">Staff area</a>. Changes apply to newly processed email immediately.</div>
${flash ? flashBanner("ok", flash, "position:static;margin-bottom:16px") : ""}
${tabBar}
${tab === "rules" ? workflowRulesTab(c, editRuleId) : tab === "case-types" ? caseTypesTab(c, caseTypesOrganizationId) : tab === "pack" ? attachmentSetsCard(c) + documentsPackCard(c) : tab === "requirements" ? requirementsTab(c, reqsTarget, reqsSystem) : replyHtml}
`
  );
}
