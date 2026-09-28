/**
 * Page renderers — staff management. Extracted verbatim from pages.ts;
 * pages.ts re-exports the page API unchanged.
 */
import { describeRuleTree } from "../../admissions/engine";
import { SYSTEM_LABELS } from "../../admissions/systems";
import { Repo } from "../../db/repo";
import { docLabel } from "../../rules";
import { DOC_TYPES, PERMISSIONS, PERMISSION_LABELS } from "../../types";
import { avatar, esc } from "../views";
import { capFirst, formatDuration, head } from "./shared";
import type { Ctx } from "./shared";
import { badge, csrfField, emptyState } from "../tpl";

type LegacyAcademicProgramme = ReturnType<Repo["listProgrammes"]>[number];


// ── Staff (team performance + account management, merged) ──────────────────
// OR-8: the ONE place visibility scopes are edited — a staff × schools
// matrix. Each row saves the member's ENTIRE school set in a single action;
// tick nothing and save to restore full visibility.
function scopeMatrix(c: Ctx): string {
  const { repo } = c;
  // DEMO: school scopes belong to the education module's catalogue; an
  // organization without it scopes staff by CaseType instead.
  if (!repo.hasEducationModule(c.user.organization_id ?? 1)) return "";
  const schools = repo.listSchools();
  // H-2: the matrix lists the acting organization's members only.
  const members = repo.listStaff(c.user.organization_id ?? 1).filter((m) => m.active);
  const rows = members.map((m) => {
    if (m.role === "admin") {
      return `<tr>
        <td><b>${esc(m.display_name)}</b><br><span class="muted small">@${esc(m.username)}</span></td>
        <td colspan="${schools.length + 1}">${badge("purple", "admin")} <span class="small muted">always sees every school — admins cannot be scoped</span></td>
      </tr>`;
    }
    const current = new Set(repo.scopesFor(m.id));
    const mode = repo.scopeModeFor(m.id);
    const state = mode === "none" ? "no access" : mode === "scoped" ? "assigned schools only" : "unscoped — sees everything";
    return `<tr>
      <td><b>${esc(m.display_name)}</b><br><span class="muted small">@${esc(m.username)}</span></td>
      <form method="post" action="/staff/scopes"><td colspan="${schools.length + 1}" style="display:table-cell">
        <div style="display:flex;flex-wrap:wrap;gap:10px 18px;align-items:center">
          ${csrfField(c.csrf)}
          <input type="hidden" name="staff_id" value="${m.id}">
          ${schools.map((s) => `<label style="display:flex;gap:6px;align-items:center"><input type="checkbox" name="schools" value="${esc(s)}" style="width:auto" ${current.has(s) ? "checked" : ""}> ${esc(s)}</label>`).join("")}
          <button class="btn small ghost">Save assigned schools</button>
          <button class="btn small ghost" name="scope_mode" value="unscoped">Restore full visibility</button>
          <span class="muted small">${esc(state)}</span>
        </div>
      </td></form>
    </tr>`;
  }).join("");
  return `<section class="card nopad" id="scopes">
    <div class="card-head"><h2>Visibility scope</h2></div>
    <p class="small muted" style="padding:0 24px;margin:8px 0 0">Tick the schools each officer handles and press <b>Save assigned schools</b> — one action per person. From then on they see only cases from those schools, everywhere: queues, levels, search, direct links and the API. Saving an empty selection gives <b>no case access</b>; use <b>Restore full visibility</b> when that is intentional. Schools are managed in <a href="/config?tab=courses#schools">Configuration</a>.</p>
    ${schools.length ? `<table><tr><th>Staff member</th><th>Schools they may see</th></tr>${rows}</table>` : emptyState(`<p>Add a school in Configuration first.</p>`)}
  </section>`;
}


/**
 * Round 3 — course configuration lives in ONE place: the staff area.
 * Everything that used to sit behind Configuration → "Course configuration"
 * (schools, course details, ownership, enforced rules, intakes, add forms)
 * plus the NEW per-course document checklists (checkboxes).
 */
function coursesConfigHtml(c: Ctx): string {
  // Compatibility surface: the migrated Organization #1 may still inspect
  // academic catalogue data, but new tenants only see the generic CaseType
  // editor. This prevents academic labels from becoming a runtime default.
  if ((c.user.organization_id ?? 1) !== 1) {
    return `<section class="card"><h2>CaseTypes</h2><p class="small muted">This organization has no academic catalogue. Configure its document matrix and rule trees in <a href="/config?tab=case-types">CaseTypes</a>.</p></section>`;
  }
  const { repo } = c;
  const programmes = repo.listProgrammes();
  // H-2: this academic surface is org-1 only (guarded above) — keep the
  // picker pinned to organization 1 rather than global.
  const staffList = repo.listStaff(1).filter((m) => m.active);

  const assignForm = (p: { code: string; owner_id: number | null }) =>
    `<form method="post" action="/config/course-owner" style="display:flex;gap:6px;margin:0;align-items:center">
      ${csrfField(c.csrf)}
      <input type="hidden" name="programme" value="${esc(p.code)}">
      <select name="owner" style="width:auto;min-width:190px">
        <option value="">Unassigned</option>
        ${staffList.map((m) => `<option value="${m.id}" ${p.owner_id === m.id ? "selected" : ""}>${esc(m.display_name)} (${capFirst(m.role)})</option>`).join("")}
      </select>
      <button class="btn small ghost">Assign</button>
    </form>`;
  // OR-6: schools and courses live together. Every school exists even before
  // it has courses; renaming a school moves every course with it.
  const schools = repo.listSchools();
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
          ${csrfField(c.csrf)}
          <input type="hidden" name="from" value="${esc(school)}">
          <input type="text" name="to" value="${esc(school)}" title="New school name" style="width:auto;min-width:220px;margin:0">
          <button class="btn small ghost" title="Rename this school for every course in it">Rename school</button>
        </form>` : ""}
      </div>
    </td></tr>`;
  const courseRow = (pr: LegacyAcademicProgramme): string => `<tr>
        <td><b>${esc(pr.code)}</b><br><span class="small muted">${esc(pr.name)}</span><br><span class="badge ${pr.level === "phd" || pr.level === "masters" ? "b-purple" : "b-gray"}" style="margin-top:4px">${pr.level === "phd" ? "PhD" : capFirst(pr.level)}</span></td>
        <td>
          <form method="post" action="/config/programme/edit" style="display:flex;gap:6px;align-items:flex-start;max-width:640px">
            ${csrfField(c.csrf)}
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
  const unaffiliated = programmes.filter((x) => !x.school);
  const courseRows = schools.map((school) => {
    const rows = programmes.filter((x) => (x.school || "") === school);
    return schoolHeader(school) + (rows.length
      ? rows.map(courseRow).join("")
      : `<tr><td colspan="3" class="small muted" style="padding-left:26px">No courses yet — add one below and set its school to “${esc(school)}”.</td></tr>`);
  }).join("") + (unaffiliated.length
    ? schoolHeader("") + unaffiliated.map(courseRow).join("")
    : "");

  // Round 3 — per-course document checklist. The generated matrix is the
  // default; ticking (or un-ticking) boxes and saving configures THIS course
  // only. Conditional items are "asked for, never assumed" and are not
  // toggled here.
  const courseDocChecklist = (pr: LegacyAcademicProgramme): string => {
    const configured = repo.courseDocConfig(pr.code);
    const defaults = new Set(
      repo.resolveRequirements(pr.code, null, {}).filter((e) => e.required).map((e) => e.document_type)
    );
    const typed = DOC_TYPES.filter((t) => t !== "unknown");
    const rows = typed
      .map((t) => {
        const checked = configured ? configured.has(t) : defaults.has(t);
        return `<label style="display:flex;gap:8px;align-items:center;padding:4px 0;font-size:13.5px">
          <input type="checkbox" name="docs" value="${t}"${checked ? " checked" : ""}>
          <span>${esc(docLabel(t))}${!configured && defaults.has(t) ? ` <span class="muted small">(generated default)</span>` : ""}</span>
        </label>`;
      })
      .join("");
    return `<details id="docs-${esc(pr.code)}" style="margin:10px 0;border:1px solid var(--line2);border-radius:8px">
      <summary style="cursor:pointer;padding:10px 14px"><b>${esc(pr.code)}</b> — ${esc(pr.name)}
        ${configured
          ? `<span class="badge b-purple" style="margin-left:8px">customised checklist</span>`
          : `<span class="badge b-gray" style="margin-left:8px">generated checklist</span>`}</summary>
      <div style="padding:6px 16px 14px">
        <p class="small muted">Tick exactly the documents this course requires — untick a default to drop it, tick anything else to add it. New applicants are checked against this list; cases that already froze their requirement set keep theirs.</p>
        <div style="display:flex;gap:24px;flex-wrap:wrap">
          <form method="post" action="/staff/course-docs" style="flex:1;min-width:280px">
            ${csrfField(c.csrf)}
            <input type="hidden" name="programme" value="${esc(pr.code)}">
            ${rows}
            <div style="margin-top:10px"><button class="btn small" type="submit">Save required documents</button></div>
          </form>
          ${configured ? `<form method="post" action="/staff/course-docs/reset" style="align-self:flex-end;padding-bottom:4px">${csrfField(c.csrf)}<input type="hidden" name="programme" value="${esc(pr.code)}"><button class="btn small ghost" type="submit">Reset to generated</button></form>` : ""}
        </div>
      </div>
    </details>`;
  };

  const intakesCard = `<div class="card" id="intakes">
  <h2>Intake deadlines</h2>
  <p class="small muted" style="margin-top:-6px">Submissions arriving after the deadline are flagged <b>late_submission</b> for a human — the system never auto-rejects on deadline alone.</p>
  <table><tr><th>Intake</th><th>Deadline</th><th></th></tr>
    ${c.repo.listIntakeRows().map((i) => `<tr>
      <td>${esc(i.name)}</td>
      <td><form method="post" action="/settings/intake-deadline" style="display:flex;gap:6px;margin:0">
        ${csrfField(c.csrf)}
        <input type="hidden" name="name" value="${esc(i.name)}">
        <input type="date" name="deadline" value="${esc(i.deadline ? i.deadline.slice(0, 10) : "")}" style="width:auto">
        <button class="btn small ghost">Save</button>
      </form></td>
      <td class="small muted">${i.deadline ? "" : "no deadline set"}</td>
    </tr>`).join("")}
  </table>
</div>`;

  return `
<section class="card nopad" id="courses">
  <div class="card-head"><h2>Courses &amp; ownership</h2></div>
  <p class="small muted" style="padding:0 24px;margin:8px 0 0">Every course is handled by someone — assign the responsible officer here. The notes column is free-text reference; the <b>enforced</b> subject-and-grade rules for each course live in the <a href="/config?tab=requirements">Requirements tab</a>.</p>
  ${programmes.length
    ? `<table><tr><th>Programme</th><th>Course details &amp; reference notes</th><th>Handled by</th></tr>${courseRows}</table>`
    : emptyState(`<p>No courses yet — add the first one below.</p>`)}
  <div style="padding:18px 24px 22px;border-top:1px solid var(--line2);margin-top:14px">
    <h2>Required documents — per course</h2>
    <p class="small muted" style="margin-top:-2px">Each course starts on the <b>generated checklist</b> (level × curriculum, from the official application form). Open a course and tick exactly the documents it requires — saving customises that course only; “Reset to generated” puts it back. Conditional items (e.g. credit-transfer forms) are asked for automatically and are not toggled here.</p>
    ${programmes.map(courseDocChecklist).join("")}

    <h2 style="margin-top:26px" id="entryreqs">Entry requirements (grades)</h2>
    <p class="small muted" style="margin-top:-6px">Entry requirements are structured, machine-evaluable rules — built visually per programme and qualification system, with a preview before activation. <a href="/config?tab=requirements">Open the Requirements tab →</a></p>

    <h2 style="margin-top:26px" id="addcourse">Add a course or intake</h2>
    <p class="small muted" style="margin-top:-6px">Create a new programme — it appears immediately in the table above, in course ownership and across the admissions pipeline — or add another intake for existing courses. Master's and PhD are separate levels, each judged by its own university-wide defaults.</p>
    <form method="post" action="/settings/lists/add" class="formrow" style="margin-top:10px">
      ${csrfField(c.csrf)}
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
      ${csrfField(c.csrf)}
      <div style="flex:2"><label>New school name</label><input type="text" name="name" placeholder="e.g. School of Aviation"></div>
      <div style="flex:0"><label>&nbsp;</label><button class="btn">Add school</button></div>
    </form>
  </div>
</section>

${intakesCard}`;
}


export function staffPage(c: Ctx, flash?: string, resetCode?: string): string {
  const { repo } = c;
  const isAdmin = c.user.role === "admin";

  // H-2: the staff surface resolves against the ACTING admin's organization.
  const orgId = c.user.organization_id ?? 1;
  const stats = repo.staffStats(c.user.demo, orgId);
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
<section class="card">
  <h2>Automation permissions</h2>
  <p class="small muted" style="margin-top:-6px">The four automation actions are distinct permissions (PPR P1-8) — not a role split. Admins hold all four automatically; regular staff hold what is ticked here (with no ticks, they may send replies and approve automation, as staff always could).</p>
  <form method="post" action="/staff/permissions">
    ${csrfField(c.csrf)}
    <table>
      <tr><th>Staff</th>${PERMISSIONS.map((p) => `<th style="text-align:left">${esc(PERMISSION_LABELS[p])}</th>`).join("")}</tr>
      ${repo.listStaff(orgId).map((st) => {
        const grants = st.role === "admin" ? PERMISSIONS.slice() : (repo.permissionsFor(st.id).length ? repo.permissionsFor(st.id) : ["send_automated", "approve_automation"]);
        return `<tr>
        <td><b>${esc(st.display_name)}</b><br><span class="muted small">@${esc(st.username)} · ${esc(st.role)}</span></td>
        ${PERMISSIONS.map((p) => `<td>${st.role === "admin"
          ? `${badge("green", "always")}<input type="hidden" name="perm_${st.id}_${p}" value="1">`
          : `<input type="checkbox" name="perm_${st.id}_${p}" value="1" ${grants.includes(p) ? "checked" : ""} style="width:auto">`}</td>`).join("")}
      </tr>`;
      }).join("")}
    </table>
    <div style="margin-top:10px"><button class="btn">Save permissions</button></div>
  </form>
</section>
<section class="card nopad">
  <div class="card-head"><h2>Accounts</h2></div>
  <table>
    <tr><th>Username</th><th>Name</th><th>Role</th><th>Status</th><th>Actions</th></tr>
    ${repo.listStaff(orgId)
      .map((st) => `<tr>
        <td class="mono">${esc(st.username)}</td>
        <td>${esc(st.display_name)}</td>
        <td>${badge("gray", capFirst(st.role))}</td>
        <td>${st.active ? badge("green", "active") : badge("red", "disabled")}</td>
        <td>
          <form method="post" action="/staff/toggle" style="display:inline">${csrfField(c.csrf)}<input type="hidden" name="id" value="${st.id}"><button class="btn small ghost">${st.active ? "Disable" : "Enable"}</button></form>
          <form method="post" action="/staff/password" style="display:inline">${csrfField(c.csrf)}<input type="hidden" name="id" value="${st.id}"><input type="password" name="password" placeholder="new password" style="width:150px;display:inline-block"><input type="password" name="confirm" placeholder="confirm" style="width:150px;display:inline-block"><button class="btn small ghost">Reset</button></form>
          <form method="post" action="/staff/reset-code" style="display:inline">${csrfField(c.csrf)}<input type="hidden" name="id" value="${st.id}"><button class="btn small ghost" title="Issue a one-time code the member can use on the public “Forgot password” page (no email involved)">Reset code</button></form>
        </td>
      </tr>`)
      .join("")}
  </table>
</section>
<section class="card">
  <h2>Add staff member</h2>
  <form method="post" action="/staff/add" class="formrow">
    ${csrfField(c.csrf)}
    <div><label>Username</label><input type="text" name="username" required></div>
    <div><label>Display name</label><input type="text" name="display_name" required></div>
    <div><label>Password</label><input type="password" name="password" required></div>
    <div><label>Role</label><select name="role"><option value="user" selected>user</option><option value="admin">admin</option></select></div>
    <div style="flex:0"><label>&nbsp;</label><button class="btn">Create</button></div>
  </form>
  <p class="small muted" style="margin-bottom:0">Roles: <b>admin</b> (everything — configuration, settings, staff, cases) · <b>user</b> (cases, replies and queues).</p>
</section>`
    : `<p class="small muted">Account management is limited to administrators — you are seeing the team report only.</p>`;

  // Round 3: the full course configuration (details, ownership, schools,
  // intakes, per-course document checklists) lives in this one section —
  // see coursesConfigHtml above.

  return head(
    c,
    "Staff Configuration",
    "staff",
    `
<h1>Staff Configuration</h1>
<div class="sub">Who handles what — workload, responsiveness, accounts and course ownership.</div>
${flash ? `<div class="flash ok" style="position:static;margin-bottom:16px">${esc(flash)}</div>` : ""}
${resetCode ? `
<div class="card" id="reset-code" style="position:static;margin-bottom:16px;border-left:4px solid var(--green)">
  <b>One-time reset code issued</b>
  <div class="mono" style="font-size:1.5em;letter-spacing:0.2em;margin:8px 0;user-select:all">${esc(resetCode)}</div>
  <span class="muted small">Works once, expires in 30 minutes. Give it to the member — they enter it on the public “Forgot password” page (linked under Sign in). A new issue voids this code. It is shown nowhere else and never appears in a URL.</span>
</div>` : ""}

<div class="staff-performance">
  <section class="card">
    <h2>Team at a glance</h2>
    <div class="metric-ribbon">
      <div class="stat"><div class="n">${stats.reduce((n, r) => n + r.assignedCases, 0)}</div><div class="l">Assigned cases</div><div class="context">Across ${stats.length} team member${stats.length === 1 ? "" : "s"}</div></div>
      <div class="stat"><div class="n">${totals.received}</div><div class="l">Emails received</div><div class="context">On currently assigned cases</div></div>
      <div class="stat"><div class="n">${totals.sent}</div><div class="l">Replies sent</div><div class="context">Human responses to contacts</div></div>
      <div class="stat"><div class="n">${totals.completed}</div><div class="l">Completed</div><div class="context">${c.repo.hasEducationModule(c.user.organization_id ?? 1) ? "Admissions closed by the team" : "Cases closed by the team"}</div></div>
      <div class="stat"><div class="n">${(() => { const values = stats.map((r) => r.avgResponseMinutes).filter((n): n is number => n !== null); return values.length ? esc(formatDuration(values.reduce((sum, n) => sum + n, 0) / values.length)) : "—"; })()}</div><div class="l">Avg response</div><div class="context">Average for measured staff</div></div>
    </div>
    <h2>Performance by staff member</h2>
    <div class="table-scroll"><table>
      <tr><th>Staff member</th><th>Assigned cases</th><th>Emails received</th><th>Replies sent</th><th>Avg response</th><th>Completed</th></tr>
      ${perfRows || `<tr><td colspan="6" class="muted">No staff yet.</td></tr>`}
    </table></div>
    <p class="small muted" style="margin:16px 0 0">“Emails received” counts incoming mail on cases currently assigned to the person. Response time is measured from an incoming email to the next outgoing reply on their cases.</p>
  </section>
</div>

${accountsSection}

${isAdmin ? scopeMatrix(c) : ""}

${coursesConfigHtml(c)}`
  );
}
