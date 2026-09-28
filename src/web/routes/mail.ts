/**
 * mail routes. Extracted verbatim from server.ts createApp;
 * shared closure state arrives via RouteCtx — behavior unchanged.
 */
import type { Express } from "express";
import { Repo } from "../../db/repo";
import { mailPage, mailThreadPage } from "../pages";
import { layout } from "../views";
import { csrfCheck, requireLogin } from "../auth";
import type { RouteCtx } from "./ctx";

export function registerMail(app: Express, rt: RouteCtx): void {
  // ── Gmail-style mail window ─────────────────────────────────────────────────
  // Every conversation (received AND sent), grouped by thread, newest first.
  // Incoming mail arrives unread; opening a conversation reads it. Scoped by
  // school and demo realm exactly like every other case surface.
  const MAIL_FOLDERS = new Set(["inbox", "unread", "starred", "important", "sent", "all", "spam", "bin"]);
  /** Only local /mail… paths ever go into the `back` round-trip — open-redirect guard. */
  const mailBack = (raw: unknown, fallback: string): string =>
    typeof raw === "string" && raw.startsWith("/mail") ? raw : fallback;

  app.get("/mail", requireLogin, (req, res) => {
    const q = req.query.q !== undefined ? String(req.query.q).trim() : undefined;
    const f = String(req.query.f ?? "inbox");
    const folder = MAIL_FOLDERS.has(f) && f !== "unread" ? f : "inbox";
    const unreadOnly = f === "unread";
    // Round 9: All Mail is paginated (newest first) — the whole history,
    // not just the new. Invalid/missing page numbers clamp to page one.
    const pageRaw = Number(req.query.page ?? 1);
    const page = Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1;
    const baseOpts = { schools: rt.repo.caseScopeFor(req.staff!), demo: req.staff!.demo };
    const threads = rt.repo.mailThreads({ ...baseOpts, q: q || undefined, unreadOnly, folder, page });
    const counts = rt.repo.mailFolderCounts(baseOpts);
    const backUrl = `/mail?f=${unreadOnly ? "unread" : folder}${q ? `&q=${encodeURIComponent(q)}` : ""}`;
    res.send(mailPage(rt.c(req), { threads, q, folder, unreadOnly, counts, backUrl, page, hasMore: threads.length === Repo.MAIL_PAGE_SIZE }));
  });

  app.get("/mail/thread/:tkey", requireLogin, (req, res) => {
    const tkey = String(req.params.tkey);
    const emails = rt.repo.emailsForThread(tkey);
    if (!emails.length) {
      return res.status(404).send(layout({
        title: "Conversation not found",
        institution: rt.instName(req),
        user: req.staff,
        unread: rt.repo.unreadCount(req.staff!.id, req.staff!.demo, rt.repo.caseScopeFor(req.staff!)),
        csrf: req.csrfToken,
        content: `<div class="card" style="max-width:560px;margin:60px auto;text-align:center">
          <h1>Conversation not found</h1>
          <p class="sub">That conversation does not exist (or has no messages yet).</p>
          <p><a class="btn" href="/mail">← Back to mail</a></p>
        </div>`,
      }));
    }
    const a = emails[0].applicant_id != null ? (rt.repo.getApplicant(emails[0].applicant_id) ?? null) : null;
    if (a) {
      if (!rt.repo.applicantVisibleTo(req.staff!, a)) return rt.refuseScope(req, res, "/mail", "← Back to mail");
    } else if ((req.staff!.demo ?? 0) !== 0) {
      // Parked mail (no applicant) belongs to the live realm — demo accounts never see it.
      return rt.refuseScope(req, res, "/mail", "← Back to mail");
    }
    rt.repo.markThreadRead(tkey);
    const labels = rt.repo.threadLabelState(tkey);
    const backUrl = mailBack(req.query.back, labels.bin ? "/mail?f=bin" : labels.spam ? "/mail?f=spam" : "/mail");
    res.send(mailThreadPage(rt.c(req), { applicant: a, emails, tkey, labels, backUrl }));
  });

  /** Gmail conversation actions: star, important, spam, bin, unread. Labels
   *  live on the conversation; bin/spam are exclusive until restore. */
  const THREAD_ACTIONS: Record<string, { label: string; on: boolean } | { unread: true }> = {
    star: { label: "starred", on: true },
    unstar: { label: "starred", on: false },
    important: { label: "important", on: true },
    unimportant: { label: "important", on: false },
    spam: { label: "spam", on: true },
    notspam: { label: "spam", on: false },
    bin: { label: "bin", on: true },
    restore: { label: "restore", on: true },
    unread: { unread: true },
  };
  app.post("/mail/thread/:tkey/action", requireLogin, csrfCheck, (req, res) => {
    const tkey = String(req.params.tkey);
    const emails = rt.repo.emailsForThread(tkey);
    if (!emails.length) return res.status(404).send("Conversation not found.");
    const a = emails[0].applicant_id != null ? (rt.repo.getApplicant(emails[0].applicant_id) ?? null) : null;
    if (a) {
      if (!rt.repo.applicantVisibleTo(req.staff!, a)) return rt.refuseScope(req, res, "/mail", "← Back to mail");
    } else if ((req.staff!.demo ?? 0) !== 0) {
      // Parked mail (no applicant) belongs to the live realm — demo accounts never see it.
      return rt.refuseScope(req, res, "/mail", "← Back to mail");
    }
    const action = THREAD_ACTIONS[String(req.body.action ?? "")];
    if (!action) return res.redirect(`/mail/thread/${encodeURIComponent(tkey)}`);
    const refBit = a ? ` (${a.ref_number})` : " (no case)";
    if ("unread" in action) {
      rt.repo.markThreadUnread(tkey);
      rt.repo.audit(a?.id ?? null, req.staff!.username, "mail_marked_unread", a?.ref_number ?? "no case");
      return res.redirect(mailBack(req.body.back, "/mail"));
    }
    rt.repo.setThreadLabel(tkey, action.label, action.on);
    rt.repo.audit(a?.id ?? null, req.staff!.username, "mail_label", `${action.label} ${action.on ? "added" : "removed"}${refBit}`);
    res.redirect(mailBack(req.body.back, `/mail/thread/${encodeURIComponent(tkey)}`));
  });
}
