/**
 * Page renderers — applicant list. Extracted verbatim from pages.ts;
 * pages.ts re-exports the page API unchanged.
 */
import { QUEUES, QueueKey, SUB_LABELS, queueOf } from "../../admissions/queues";
import { avatar, esc, fmtDate } from "../views";
import { decisionBadge, head, resultBadge } from "./shared";
import type { Ctx } from "./shared";

export function applicantsPage(
  c: Ctx,
  q: { search?: string; queue?: string; sub?: string; programme?: string; intake?: string }
): string {
  const { repo } = c;
  const rows = repo.searchApplicants({
    q: q.search,
    programme: q.programme || undefined,
    intake: q.intake || undefined,
    demo: c.user.demo,
    schools: repo.caseScopeFor(c.user), // OR-8
  });
  const programmes = repo.listProgrammes();
  const intakes = repo.listIntakes();

  // OR-1: a completely fresh installation gets the next concrete step, not a
  // silent dead end. (Any filter/search in play means "nothing matched".)
  if (rows.length === 0 && !q.search && !q.programme && !q.intake && !q.queue && !q.sub) {
    return head(
      c,
      "Queues",
      "applicants",
      `<div class="empty" style="padding:56px 24px;text-align:center">
        ${repo.hasEducationModule(c.user.organization_id ?? 1)
          ? `<p style="font-size:17px;font-weight:700;margin-bottom:6px">No applications yet.</p>
        <p class="small muted">Connect Gmail in <a href="/settings">Settings</a> and applicant emails will land here as cases.</p>`
          : `<p style="font-size:17px;font-weight:700;margin-bottom:6px">No cases yet.</p>
        <p class="small muted">Cases for ${esc(c.institution)} appear here once a message arrives for one of its CaseTypes.</p>`}
        ${c.user.role === "admin" && repo.listCaseTypes(c.user.organization_id ?? 1).length ? `<p style="margin-top:14px"><a class="btn" href="/intake/test">Submit a test message</a></p>` : ""}
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

  // PPR P0-2/P1-9: a workspace without the education module never sees the
  // academic queue tab, programme catalogue or admission-decision column.
  const eduWorkspace = c.repo.hasEducationModule(c.user.organization_id ?? 1);
  const visibleQueues = QUEUES.filter((qm) => eduWorkspace || qm.key !== "decision");
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
      <td><div class="case-person">${avatar(r.full_name ?? r.ref_number, 34)}<span><b>${esc(r.full_name ?? "—")}</b><span class="muted small">${esc(r.email_address)}</span></span></div></td>
      <td class="small">${eduWorkspace ? `<b>${esc(r.programme ?? "—")}</b>${r.intake ? `<br><span class="muted">${esc(r.intake)}</span>` : ""}` : `<b>${esc(r.queue || "—")}</b>`}</td>
      <td class="small"><span class="queue-state"><i class="state-dot" aria-hidden="true"></i>${esc(SUB_LABELS[place.sub] ?? place.sub)}</span><br><span class="muted">${why}</span></td>
      <td>${resultBadge(r.req_result)}</td>
      ${eduWorkspace ? `<td>${decisionBadge(r.admission_decision)}</td>` : ""}
      <td class="small muted nowrap">${esc(fmtDate(r.created_at))}</td>
      <td><a class="btn small" href="/case/${r.id}">Open</a></td>
    </tr>`;
    })
    .join("");

  const opt = (v: string, label: string, sel?: string) =>
    `<option value="${esc(v)}" ${sel === v ? "selected" : ""}>${esc(label)}</option>`;

  return head(
    c,
    searchMode ? "Search — Queues" : `${active.label} — Queues`,
    "applicants",
    `
<h1>Queues</h1>
<div class="sub">${searchMode
    ? `${shown.length} match${shown.length === 1 ? "" : "es"} across all queues.`
    : `${esc(active.caption)} — the subcategory says why a case is here.`}</div>

<div class="queue-tabs">${tabs}</div>

<form class="inline" method="get" action="/applicants">
  <input type="hidden" name="queue" value="${esc(activeKey)}">
  <input name="q" value="${esc(q.search ?? "")}" placeholder="Search name, email, reference…">
  ${eduWorkspace ? `<select name="programme"><option value="">All programmes</option>${programmes.map((p) => opt(p.code, p.name, q.programme)).join("")}</select>
  <select name="intake"><option value="">All intakes</option>${intakes.map((i) => opt(i, i, q.intake)).join("")}</select>` : ""}
  <button class="btn ghost">Filter</button>
  ${c.user.role === "admin" ? `<a class="btn small ghost" href="/applicants/export.csv">Export CSV</a>` : ""}
  ${c.user.role === "admin" && repo.listCaseTypes(c.user.organization_id ?? 1).length ? `<a class="btn small ghost" href="/intake/test">Test intake</a>` : ""}
</form>

<section class="card">
  ${searchMode ? "" : `<div class="chips">${chips}</div>`}
  ${shown.length
    ? `<table>
        <tr><th>Ref</th><th>${eduWorkspace ? "Applicant" : "Contact"}</th><th>${eduWorkspace ? "CaseType" : "Queue"}</th><th>Why it's here</th><th>Requirement result</th>${eduWorkspace ? "<th>Admission decision</th>" : ""}<th>Opened</th><th></th></tr>
        ${trs}
      </table>`
    : searchMode
      ? `<div class="empty"><h3>No matches</h3><p>Nothing matches that search in this dataset.</p></div>`
      : `<div class="empty"><h3>Nothing in this queue</h3><p>Cases move here automatically as their situation changes.</p></div>`}
</section>`
  );
}
