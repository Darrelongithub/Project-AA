/**
 * Page renderers — mail window. Extracted verbatim from pages.ts;
 * pages.ts re-exports the page API unchanged.
 */
import { ApplicantRow, EmailRecord } from "../../types";
import { avatar, esc, icon, lifecycleBadge } from "../views";
import { head } from "./shared";
import type { Ctx } from "./shared";

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
      <td style="width:26px;padding-right:0">${unread ? `<span title="Unread" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--wine)"></span>` : ""}</td>
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
        ${t.imp_n ? `<span title="Important" style="color:var(--wine)">${icon("flag", 12)}</span>` : ""}
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
  const prog = a && a.programme ? c.repo.programmeByCode(a.programme) : undefined;
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
    return `<div class="card" style="margin-bottom:14px;border-left:3px solid ${out ? "var(--wine)" : "var(--line)"}">
      <div class="row" style="justify-content:space-between;gap:12px;flex-wrap:wrap">
        <div class="small muted">
          <span class="badge ${out ? "b-purple" : ""}">${out ? (e.auto ? "Sent · automatic" : "Sent") : "Received"}</span>
          ${out ? `to <b>${esc(e.to_addr || a?.email_address || "—")}</b>` : `from <b>${esc(e.from_addr || a?.email_address || "—")}</b>`}
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
