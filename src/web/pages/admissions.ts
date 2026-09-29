/**
 * Page renderers — admissions board. Extracted verbatim from pages.ts;
 * pages.ts re-exports the page API unchanged.
 */
import { LIFECYCLE_LABELS } from "../../types";
import { avatar, esc, flowLine, fmtDate, gaugeRow } from "../views";
import { head } from "./shared";
import type { Ctx } from "./shared";
import { emptyState } from "../tpl";

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
      const courseOwner = a.programme ? repo.programmeByCode(a.programme)?.owner_name : null;
      const stageTone = a.lifecycle === "completed" ? "green" : a.lifecycle === "awaiting_review" ? "orange" : a.lifecycle === "verification" ? "blue" : "purple";
      return `<tr class="case-row b-${stageTone}">
        <td><a class="case-ref" href="/case/${a.id}">${esc(a.ref_number)}</a></td>
        <td><div class="case-person">${avatar(a.full_name ?? a.ref_number, 34)}<span><b>${esc(a.full_name ?? "Unknown")}</b><span class="muted small">${esc(a.email_address)}</span></span></div></td>
        <td>${a.programme ? `<b>${esc(a.programme)}</b>` : `<span class="muted">—</span>`}<br><span class="muted small">${esc(a.intake ?? "no intake yet")}</span></td>
        <td><span class="queue-state"><i class="state-dot" aria-hidden="true"></i>${esc(LIFECYCLE_LABELS[a.lifecycle])}</span></td>
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
    : emptyState(`${flowLine(150, 26)}<p>Nobody at this level right now.</p><p class="small muted">New applications land at <b>Application received</b> and move down the pipeline as your team works them.</p>`)}
</section>`
  );
}
