/**
 * The web console (features 11–21, 27–35, 38–39):
 * staff dashboard, review queue, one-click case files, search/filters,
 * settings & templates, staff management, notifications, exports,
 * and the public applicant self-service status page.
 *
 * Server-rendered, self-contained, DB-backed sessions + CSRF.
 */
import * as crypto from "crypto";
import express, { type Express, type Request, type Response } from "express";
import type { Repo } from "../db/repo";
import type { PipelineContext } from "../pipeline/adapters";
import type { LifecycleStage } from "../types";
import { DOC_TYPES, EMAIL_CATEGORY_LABELS, LIFECYCLE_LABELS, LIFECYCLE_ORDER, type DocType, type EmailCategory } from "../types";
import { checklistText, renderTemplate } from "../drafting";
import { docLabel } from "../rules";
import {
  applicantsPage, casePage, dashboardPage, loginPage, notificationsPage,
  publicStatusForm, publicStatusResult, queuePage, replayPage, settingsPage, staffPage, teamPage,
} from "./pages";
import { portalHomePage, portalOtpPage, portalStartPage } from "./portal";
import { avatar } from "./views";
import { authMiddleware, clearSessionCookie, csrfCheck, loginAttempt, parseCookies, requireLogin, requireRole, sessionCookie } from "./auth";
import { processEmail } from "../pipeline";
import { log } from "../util/log";
import { hashPassword } from "../util/password";

export interface WebDeps {
  repo: Repo;
  ctx: PipelineContext; // reuse the pipeline's sender/vision adapters
}

/**
 * Per-IP sliding-window limiter. Self-pruning: the map never grows past
 * 5000 tracked IPs, and empty windows are dropped on access (previously the
 * maps leaked an entry per distinct IP for the process lifetime).
 */
function makeRateLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (ip: string): boolean => {
    if (hits.size > 5000) hits.clear();
    const now = Date.now();
    const window = (hits.get(ip) ?? []).filter((t) => now - t < windowMs);
    window.push(now);
    hits.set(ip, window);
    return window.length <= limit;
  };
}

export function createApp(deps: WebDeps): Express {
  const { repo, ctx } = deps;
  const app = express();
  /** Institution name for all branding — editable in Settings → General. */
  const instName = (): string => repo.getSetting("institution_name", "Riara University");
  app.disable("x-powered-by");
  // Behind any reverse proxy (the preview environment included) req.ip is the
  // proxy's address unless this is set — which makes every per-IP rate
  // limiter a single global counter for ALL users. Opt in via TRUST_PROXY=1.
  if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);
  app.use(express.urlencoded({ extended: true, limit: "2mb" }));
  app.use(express.json({ limit: "12mb" })); // portal uploads arrive as base64 JSON
  app.use(authMiddleware(repo));

  const c = (req: Request) => ({
    repo,
    user: req.staff!,
    unread: repo.unreadCount(req.staff!.id),
    csrf: req.csrfToken ?? "",
    theme: req.theme,
    institution: instName(),
  });

  const backToCase = (id: string | number, msg: string) => `/case/${id}?msg=${encodeURIComponent(msg)}`;

  /** Staff action helper: stops the SLA clock + audits. */
  const staffAction = (req: Request, applicantId: number, event: string, detail: string) => {
    const a = repo.getApplicant(applicantId);
    if (a && a.sla_due_at && !a.sla_handled_at) {
      repo.updateApplicant(applicantId, { sla_handled_at: new Date().toISOString() });
    }
    repo.audit(applicantId, req.staff!.username, event, detail);
  };

  // ── Auth ─────────────────────────────────────────────────────────────────

  app.get("/login", (req, res) => res.send(loginPage(undefined, req.theme, instName())));

  /** Theme toggle — persisted in a cookie so it survives sessions & works on public pages. */
  app.post("/theme", (req, res) => {
    const next = req.theme === "dark" ? "light" : "dark";
    res.setHeader("Set-Cookie", `theme=${next}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${365 * 86400}`);
    // Redirect back to where the toggle was pressed — but ONLY to a relative
    // path on this host. The raw Referer was an open redirect: any external
    // URL a visitor came from would be sent straight back to the client.
    const back = req.get("referer") ?? "";
    let target = "/";
    try {
      const url = new URL(back);
      if (url.origin === `${req.protocol}://${req.get("host")}` && url.pathname.startsWith("/") && !url.pathname.startsWith("//")) {
        target = url.pathname;
      }
    } catch {
      /* not a URL → stay on "/" */
    }
    res.redirect(target);
  });

  // Failed-logins-only limiter: the portal and status pages already had per-IP
  // limits, but staff login had none — unlimited scrypt brute force. Only
  // FAILURES count, so legitimate users are never locked out by normal use;
  // 10 failures per IP per minute blocks further attempts.
  const loginFails = new Map<string, number[]>();
  const pruneLoginFails = (ip: string): number[] => {
    if (loginFails.size > 5000) loginFails.clear();
    const now = Date.now();
    const w = (loginFails.get(ip) ?? []).filter((t) => now - t < 60_000);
    loginFails.set(ip, w);
    return w;
  };
  const loginBlocked = (ip: string): boolean => pruneLoginFails(ip).length >= 10;
  const loginRecordFail = (ip: string): void => {
    pruneLoginFails(ip).push(Date.now());
  };

  app.post("/login", (req, res) => {
    const ip = req.ip ?? "?";
    if (loginBlocked(ip)) {
      res.status(429).send(loginPage("Too many failed sign-ins from this address — please wait a minute.", req.theme));
      return;
    }
    const staff = loginAttempt(repo, String(req.body.username ?? ""), String(req.body.password ?? ""));
    if (!staff) {
      loginRecordFail(ip);
      res.status(401).send(loginPage("Invalid username or password.", req.theme));
      return;
    }
    const session = repo.createSession(staff.id);
    repo.audit(null, staff.username, "staff_login", "");
    res.setHeader("Set-Cookie", sessionCookie(session.token, 8 * 3600));
    res.redirect("/");
  });

  app.post("/logout", (req, res) => {
    if (req.sessionId) repo.deleteSession(req.sessionId);
    res.setHeader("Set-Cookie", clearSessionCookie());
    res.redirect("/login");
  });

  // ── Dashboard / queue / applicants ───────────────────────────────────────

  app.get("/", requireLogin, (req, res) => res.send(dashboardPage(c(req))));

  app.get("/queue", requireLogin, (req, res) =>
    res.send(queuePage(c(req), String(req.query.filter ?? "all")))
  );

  app.get("/applicants", requireLogin, (req, res) =>
    res.send(
      applicantsPage(c(req), {
        search: req.query.q ? String(req.query.q) : undefined,
        filter: req.query.filter ? String(req.query.filter) : "all",
        programme: req.query.programme ? String(req.query.programme) : undefined,
        intake: req.query.intake ? String(req.query.intake) : undefined,
      })
    )
  );

  // ── Case file ────────────────────────────────────────────────────────────

  app.get("/case/:id", requireLogin, (req, res) => {
    const a = repo.getApplicant(Number(req.params.id));
    if (!a) return res.status(404).send("Case not found.");
    res.send(casePage(c(req), a, req.query.msg ? String(req.query.msg) : undefined));
  });

  /** Decision replay — the step-by-step chain behind any flag/verdict. */
  app.get("/case/:id/replay", requireLogin, (req, res) => {
    const a = repo.getApplicant(Number(req.params.id));
    if (!a) return res.status(404).send("Case not found.");
    res.send(replayPage(c(req), a));
  });

  /** Tasks — turn a case into work items. */
  app.post("/case/:id/task/add", requireLogin, csrfCheck, (req, res) => {
    const id = Number(req.params.id);
    const title = String(req.body.title ?? "").trim();
    if (title) {
      repo.addTask(id, title, req.staff!.id);
      staffAction(req, id, "task_added", title);
    }
    res.redirect(backToCase(id, "Task added."));
  });

  app.post("/case/:id/task/toggle", requireLogin, csrfCheck, (req, res) => {
    const id = Number(req.params.id);
    const taskId = Number(req.body.task_id);
    const tasks = repo.listTasks(id).filter((t) => t.id === taskId);
    if (tasks.length) {
      repo.toggleTask(taskId, !tasks[0].done);
      staffAction(req, id, "task_toggled", `#${taskId} → ${tasks[0].done ? "open" : "done"}`);
    }
    res.redirect(backToCase(id, "Task updated."));
  });

  /**
   * Human handoff on held drafts (v3 feature 16): the system prepared a
   * reply but did not send it. Staff can [Send], [Save changes] or [Discard].
   */
  app.post("/case/:id/draft", requireLogin, csrfCheck, async (req, res) => {
    const id = Number(req.params.id);
    const a = repo.getApplicant(id);
    if (!a) return res.status(404).send("Case not found.");
    const draft = repo.queuedOutbox(id);
    if (!draft) return res.redirect(backToCase(id, "No draft on file."));
    const decision = String(req.body.decision ?? "");
    const subject = String(req.body.subject ?? draft.subject);
    const body = String(req.body.body ?? draft.body);

    if (decision === "discard") {
      repo.deleteOutbox(draft.id);
      staffAction(req, id, "draft_discarded", `"${subject}"`);
      return res.redirect(backToCase(id, "Draft discarded."));
    }
    if (decision === "edit") {
      repo.updateOutbox(draft.id, subject, body);
      staffAction(req, id, "draft_edited", `"${subject}"`);
      return res.redirect(backToCase(id, "Draft saved — send it when ready."));
    }
    if (decision !== "send") {
      return res.redirect(backToCase(id, "Unknown draft action — nothing sent."));
    }
    // Never let internal routing boilerplate ("INTERNAL — DO NOT AUTO-SEND…")
    // leave the building — the officer must replace it with a real reply first.
    if (body.trimStart().startsWith("INTERNAL \u2014 DO NOT AUTO-SEND")) {
      return res.redirect(backToCase(id, "That draft still contains internal routing notes — edit the body before sending."));
    }
    try {
      await ctx.adapters.sender.send(a.email_address, subject, body, a.thread_id);
      repo.insertEmail({
        applicant_id: id, message_id: `handoff-${draft.id}-${Date.now()}`, thread_id: a.thread_id,
        direction: "out", from_addr: "", to_addr: a.email_address, subject, body,
        category: null, auto: 0, at: new Date().toISOString(),
      });
      repo.deleteOutbox(draft.id);
      staffAction(req, id, "human_override", `approved held draft: "${subject}"`);
      res.redirect(backToCase(id, "Reply sent."));
    } catch (e) {
      repo.audit(id, req.staff!.username, "send_failed", (e as Error).message);
      res.redirect(backToCase(id, `Send failed: ${(e as Error).message}`));
    }
  });

  app.post("/case/:id/action", requireLogin, csrfCheck, async (req, res) => {
    const id = Number(req.params.id);
    const a = repo.getApplicant(id);
    if (!a) return res.status(404).send("Case not found.");
    const action = String(req.body.action ?? "");

    if (action === "advance" || action === "complete") {
      const to: LifecycleStage | undefined =
        action === "complete"
          ? "completed"
          : LIFECYCLE_ORDER[LIFECYCLE_ORDER.indexOf(a.lifecycle) + 1];
      if (to) {
        repo.setLifecycle(id, to, req.staff!.username, `advanced by ${req.staff!.display_name}`);
        if (to === "verification" || to === "completed") staffAction(req, id, "case_action", `moved to ${to}`);
        else staffAction(req, id, "case_action", `advanced to ${to}`);
        return res.redirect(backToCase(id, `Status → ${LIFECYCLE_LABELS[to]}.`));
      }
    }

    if (action === "request_info") {
      const activeDocs = repo.listDocuments(id, { activeOnly: true });
      // effectiveRequirements — the FROZEN snapshot — not live rules: a case
      // triaged under the old requirement set must not be chased under a new
      // one just because staff clicked a button.
      const requirements = repo.effectiveRequirements(a).filter((r) => r.required);
      const present = activeDocs.map((d) => d.document_type);
      const missing = requirements.filter((r) => !present.includes(r.document_type));
      const tpl = repo.getTemplate(activeDocs.length === 0 ? "docs_request" : "missing_documents");
      if (tpl) {
        const rendered = renderTemplate(tpl.subject, tpl.body, {
          ref: a.ref_number,
          institution: repo.getSetting("institution_name", "Admissions"),
          name: a.full_name ?? undefined,
          missingLabels: missing.map((m) => docLabel(m.document_type)),
          checklist: checklistText({ requirements, presentTypes: present }),
          statusLabel: LIFECYCLE_LABELS[a.lifecycle],
        });
        try {
          await ctx.adapters.sender.send(a.email_address, rendered.subject, rendered.body, a.thread_id);
        } catch (e) {
          repo.audit(id, req.staff!.username, "send_failed", (e as Error).message);
          return res.redirect(backToCase(id, `Send failed: ${(e as Error).message}`));
        }
        repo.insertEmail({
          applicant_id: id, message_id: `manual-${Date.now()}`, thread_id: a.thread_id, direction: "out",
          from_addr: "", to_addr: a.email_address, subject: rendered.subject, body: rendered.body, category: null, auto: 0,
          at: new Date().toISOString(),
        });
        staffAction(req, id, "email_sent_manual", `requested missing documents: "${rendered.subject}"`);
        return res.redirect(backToCase(id, "Missing-documents request sent."));
      }
    }
    res.redirect(backToCase(id, "No action taken."));
  });

  app.post("/case/:id/send", requireLogin, csrfCheck, async (req, res) => {
    const id = Number(req.params.id);
    const a = repo.getApplicant(id);
    if (!a) return res.status(404).send("Case not found.");
    const tpl = repo.getTemplate(String(req.body.template ?? ""));
    if (!tpl) return res.redirect(backToCase(id, "Unknown template."));
    const activeDocs = repo.listDocuments(id, { activeOnly: true });
    const requirements = repo.effectiveRequirements(a).filter((r) => r.required);
    const present = activeDocs.map((d) => d.document_type);
    const missing = requirements.filter((r) => !present.includes(r.document_type));
    const rendered = renderTemplate(tpl.subject, tpl.body, {
      ref: a.ref_number,
      institution: instName(),
      name: a.full_name ?? undefined,
      missingLabels: missing.map((m) => docLabel(m.document_type)),
      checklist: checklistText({ requirements, presentTypes: present }),
      statusLabel: LIFECYCLE_LABELS[a.lifecycle],
    });
    // "Preview" in the Responses card: show the rendered reply in-page, send nothing.
    if (req.body.preview !== undefined) {
      return res.send(casePage(c(req), a, "Preview only — nothing has been sent.", rendered));
    }
    try {
      await ctx.adapters.sender.send(a.email_address, rendered.subject, rendered.body, a.thread_id);
    } catch (e) {
      repo.audit(id, req.staff!.username, "send_failed", (e as Error).message);
      return res.redirect(backToCase(id, `Send failed: ${(e as Error).message}`));
    }
    repo.insertEmail({
      applicant_id: id, message_id: `manual-${Date.now()}`, thread_id: a.thread_id, direction: "out",
      from_addr: "", to_addr: a.email_address, subject: rendered.subject, body: rendered.body, category: null, auto: 0,
      at: new Date().toISOString(),
    });
    staffAction(req, id, "email_sent_manual", `template ${tpl.key}: "${rendered.subject}"`);
    res.redirect(backToCase(id, `Sent "${tpl.name}".`));
  });

  app.post("/case/:id/note", requireLogin, csrfCheck, (req, res) => {
    const id = Number(req.params.id);
    const body = String(req.body.body ?? "").trim();
    if (body) {
      repo.addNote(id, req.staff!.id, body);
      staffAction(req, id, "note_added", body.slice(0, 120));
    }
    res.redirect(backToCase(id, "Note saved."));
  });

  app.post("/case/:id/assign", requireLogin, csrfCheck, (req, res) => {
    const id = Number(req.params.id);
    const staffId = req.body.staff_id ? Number(req.body.staff_id) : null;
    // An unknown staff id violates the assigned_to FK and would 500 —
    // validate before writing.
    if (staffId !== null && !repo.getStaff(staffId)) {
      return res.redirect(backToCase(id, "Unknown staff member — not assigned."));
    }
    repo.updateApplicant(id, { assigned_to: staffId });
    const who = staffId ? repo.getStaff(staffId)?.display_name : "nobody";
    staffAction(req, id, "case_assigned", `assigned to ${who}`);
    if (staffId) {
      const a = repo.getApplicant(id)!;
      repo.notify("assignment", `${a.ref_number} assigned to you`, id, staffId);
    }
    res.redirect(backToCase(id, `Assigned to ${who ?? "nobody"}.`));
  });

  app.post("/case/:id/priority", requireLogin, csrfCheck, (req, res) => {
    const id = Number(req.params.id);
    const p = String(req.body.priority ?? "normal");
    if (["normal", "high", "urgent"].includes(p)) {
      repo.updateApplicant(id, { priority: p as never });
      staffAction(req, id, "priority_changed", `priority → ${p}`);
    }
    res.redirect(backToCase(id, `Priority set to ${p}.`));
  });

  /**
   * Re-categorise the latest incoming email after review (managers/admins).
   * Audit-logged; the next sync routes its documents with the new category.
   */
  app.post("/case/:id/category", requireLogin, requireRole("admin", "manager"), csrfCheck, (req, res) => {
    const id = Number(req.params.id);
    const a = repo.getApplicant(id);
    if (!a) return res.status(404).send("Case not found.");
    const cat = String(req.body.category ?? "");
    if (!(cat in EMAIL_CATEGORY_LABELS)) {
      return res.redirect(backToCase(id, "Unknown category — nothing changed."));
    }
    if (!repo.updateLatestEmailCategory(id, cat as EmailCategory)) {
      return res.redirect(backToCase(id, "No incoming email to re-categorise yet."));
    }
    staffAction(req, id, "category_changed", `latest incoming email → ${cat}`);
    res.redirect(backToCase(id, `Latest email re-categorised as ${EMAIL_CATEGORY_LABELS[cat as EmailCategory]}.`));
  });

  // ── Team performance (staff listener) ────────────────────────────────────

  app.get("/team", requireLogin, requireRole("admin", "manager"), (req, res) => res.send(teamPage(c(req))));

  // ── Notifications ────────────────────────────────────────────────────────

  app.get("/notifications", requireLogin, (req, res) => {
    res.send(notificationsPage(c(req)));
    repo.markNotificationsRead(req.staff!.id);
  });

  // ── Settings (manager+) ──────────────────────────────────────────────────

  // 'it' role: cases + configuration, but not staff management.
  app.get("/settings", requireLogin, requireRole("admin", "manager", "it"), (req, res) =>
    res.send(
      settingsPage(
        c(req),
        req.query.template ? String(req.query.template) : undefined,
        req.query.msg ? String(req.query.msg) : undefined
      ))
  );

  // ── Gmail connect (OAuth code flow; tokens stored in Settings) ───────────

  const settingsBack = (msg: string) => `/settings?msg=${encodeURIComponent(msg)}`;

  app.post("/settings/gmail/credentials", requireLogin, requireRole("admin", "manager", "it"), csrfCheck, (req, res) => {
    repo.setSetting("gmail_address", String(req.body.gmail_address ?? "").trim());
    repo.setSetting("gmail_client_id", String(req.body.gmail_client_id ?? "").trim());
    repo.setSetting("gmail_client_secret", String(req.body.gmail_client_secret ?? "").trim());
    repo.audit(null, req.staff!.username, "gmail_credentials_saved", "stored OAuth credentials in settings");
    res.redirect(settingsBack("Gmail credentials saved — now press “Connect with Google”."));
  });

  app.get("/settings/gmail/connect", requireLogin, requireRole("admin", "manager", "it"), (req, res) => {
    const clientId = repo.getSetting("gmail_client_id", "");
    if (!clientId) return res.redirect(settingsBack("Save the OAuth client ID and secret first."));
    const state = crypto.randomBytes(16).toString("hex");
    repo.setSetting("gmail_oauth_state", state);
    const redirectUri = `${req.protocol}://${req.get("host")}/settings/gmail/callback`;
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "https://www.googleapis.com/auth/gmail.modify");
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("state", state);
    res.redirect(url.toString());
  });

  app.get("/settings/gmail/callback", requireLogin, requireRole("admin", "manager", "it"), async (req, res) => {
    const state = String(req.query.state ?? "");
    if (!state || state !== repo.getSetting("gmail_oauth_state", "")) {
      return res.redirect(settingsBack("OAuth state mismatch — try connecting again."));
    }
    repo.setSetting("gmail_oauth_state", "");
    if (req.query.error) {
      return res.redirect(settingsBack(`Google returned an error: ${String(req.query.error)}`));
    }
    const code = String(req.query.code ?? "");
    const clientId = repo.getSetting("gmail_client_id", "");
    const clientSecret = repo.getSetting("gmail_client_secret", "");
    const redirectUri = `${req.protocol}://${req.get("host")}/settings/gmail/callback`;
    try {
      const resp = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code, client_id: clientId, client_secret: clientSecret,
          redirect_uri: redirectUri, grant_type: "authorization_code",
        }).toString(),
      });
      const json = (await resp.json()) as { refresh_token?: string; error_description?: string };
      if (!json.refresh_token) {
        return res.redirect(settingsBack(
          `Google did not return a refresh token${json.error_description ? ` (${json.error_description})` : ""}. Press “Connect with Google” again and approve access.`
        ));
      }
      repo.setSetting("gmail_refresh_token", json.refresh_token);
      repo.audit(null, req.staff!.username, "gmail_connected", repo.getSetting("gmail_address", ""));
      res.redirect(settingsBack("Gmail connected — live sorting starts within a minute."));
    } catch (e) {
      repo.audit(null, req.staff!.username, "gmail_connect_failed", (e as Error).message);
      res.redirect(settingsBack(`Token exchange failed: ${(e as Error).message}`));
    }
  });

  app.post("/settings/gmail/disconnect", requireLogin, requireRole("admin", "manager", "it"), csrfCheck, (req, res) => {
    repo.setSetting("gmail_refresh_token", "");
    repo.audit(null, req.staff!.username, "gmail_disconnected", "");
    res.redirect(settingsBack("Gmail disconnected — live fetching stopped."));
  });

  app.post("/settings/general", requireLogin, requireRole("admin", "manager", "it"), csrfCheck, (req, res) => {
    for (const key of [
      "institution_name", "ref_prefix", "sla_target_hours", "escalation_hours", "from_name",
      "unanswered_target_hours", "followup_ladder_days", "retention_days",
    ]) {
      if (typeof req.body[key] === "string") repo.setSetting(key, String(req.body[key]).trim());
    }
    repo.audit(null, req.staff!.username, "settings_changed", "general settings updated");
    res.redirect("/settings");
  });

  app.post("/settings/automation/global", requireLogin, requireRole("admin", "manager", "it"), csrfCheck, (req, res) => {
    const mode = String(req.body.mode ?? "auto") === "draft" ? "draft" : "auto";
    repo.setSetting("automation_mode", mode);
    repo.audit(null, req.staff!.username, "automation_changed", `global automation mode → ${mode}`);
    res.redirect("/settings");
  });

  app.post("/settings/automation/category", requireLogin, requireRole("admin", "manager", "it"), csrfCheck, (req, res) => {
    const cat = String(req.body.category ?? "");
    const mode = String(req.body.mode ?? "auto") === "draft" ? "draft" : "auto";
    if (cat) {
      repo.setAutomationMode(cat, mode);
      repo.audit(null, req.staff!.username, "automation_changed", `category '${cat}' → ${mode}`);
    }
    res.redirect("/settings");
  });

  app.post("/settings/intake-deadline", requireLogin, requireRole("admin", "manager", "it"), csrfCheck, (req, res) => {
    const name = String(req.body.name ?? "").trim();
    const deadline = String(req.body.deadline ?? "").trim();
    if (name) {
      // Garbage date strings produced Invalid Dates whose toISOString()
      // throws → 500. Validate first.
      const parsed = deadline ? new Date(`${deadline}T23:59:59Z`) : null;
      if (deadline && (parsed === null || isNaN(parsed.getTime()))) {
        return res.redirect("/settings?msg=invalid-deadline");
      }
      repo.setIntakeDeadline(name, parsed ? parsed.toISOString() : null);
      repo.audit(null, req.staff!.username, "intake_deadline_changed", `${name} → ${deadline || "none"}`);
    }
    res.redirect("/settings");
  });

  app.post("/settings/rules/add", requireLogin, requireRole("admin", "manager", "it"), csrfCheck, (req, res) => {
    const docType = String(req.body.document_type);
    // Anything outside the known document types would store a rule that can
    // never match — silently. Reject it instead of pretending.
    if (!DOC_TYPES.includes(docType as DocType) || docType === "unknown") {
      return res.redirect("/settings");
    }
    const minPoints = req.body.min_grade_points !== undefined && req.body.min_grade_points !== ""
      ? Number(req.body.min_grade_points)
      : null;
    if (minPoints !== null && (!Number.isFinite(minPoints) || minPoints < 0 || minPoints > 500)) {
      return res.redirect("/settings");
    }
    repo.upsertRule({
      programme: req.body.programme ? String(req.body.programme) : null,
      intake: req.body.intake ? String(req.body.intake) : null,
      document_type: docType as DocType,
      required: String(req.body.required) === "1",
      minGradePoints: minPoints,
    });
    repo.audit(null, req.staff!.username, "requirements_changed", `rule added/updated for ${docType}`);
    res.redirect("/settings");
  });

  app.post("/settings/rules/delete", requireLogin, requireRole("admin", "manager", "it"), csrfCheck, (req, res) => {
    repo.deleteRule(Number(req.body.id));
    repo.audit(null, req.staff!.username, "requirements_changed", `rule #${req.body.id} removed`);
    res.redirect("/settings");
  });

  app.post("/settings/lists/add", requireLogin, requireRole("admin", "manager", "it"), csrfCheck, (req, res) => {
    if (req.body.prog_code && req.body.prog_name) repo.addProgramme(String(req.body.prog_code), String(req.body.prog_name));
    if (req.body.intake) repo.addIntake(String(req.body.intake));
    repo.audit(null, req.staff!.username, "lists_changed", "programmes/intakes updated");
    res.redirect("/settings");
  });

  app.post("/settings/template", requireLogin, requireRole("admin", "manager", "it"), csrfCheck, (req, res) => {
    const key = String(req.body.key ?? "");
    const existing = repo.getTemplate(key);
    if (existing) {
      repo.upsertTemplate(key, String(req.body.name ?? existing.name), String(req.body.subject ?? existing.subject), String(req.body.body ?? existing.body));
      repo.audit(null, req.staff!.username, "template_changed", key);
    }
    res.redirect(`/settings?template=${encodeURIComponent(key)}`);
  });

  // ── Staff management (admin) ─────────────────────────────────────────────

  app.get("/staff", requireLogin, requireRole("admin"), (req, res) => res.send(staffPage(c(req))));

  app.post("/staff/add", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const username = String(req.body.username ?? "").trim();
    const role = ["admin", "manager", "officer", "it"].includes(String(req.body.role)) ? String(req.body.role) : "officer";
    if (username && req.body.password && !repo.getStaffByUsername(username)) {
      repo.createStaff(username, String(req.body.display_name ?? username), hashPassword(String(req.body.password)), role);
      repo.audit(null, req.staff!.username, "staff_created", `${username} (${role})`);
    }
    res.redirect("/staff");
  });

  app.post("/staff/toggle", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const s = repo.getStaff(Number(req.body.id));
    if (s && s.id !== req.staff!.id) {
      repo.setStaffActive(s.id, s.active !== 1);
      repo.audit(null, req.staff!.username, "staff_toggled", `${s.username} → ${s.active !== 1 ? "active" : "disabled"}`);
    }
    res.redirect("/staff");
  });

  app.post("/staff/password", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const id = Number(req.body.id);
    if (repo.getStaff(id) && req.body.password) {
      repo.setStaffPassword(id, hashPassword(String(req.body.password)));
      repo.audit(null, req.staff!.username, "staff_password_reset", `user #${id}`);
    }
    res.redirect("/staff");
  });

  // ── Exports (feature 38) ─────────────────────────────────────────────────

  const csv = (res: Response, filename: string, header: string[], rows: Array<Array<string | number | null>>) => {
    // Quote doubling for CSV, plus a leading apostrophe for cells that begin
    // with formula characters — otherwise a name like "=HYPERLINK(...)"
    // executes when staff open the export in Excel (CSV formula injection).
    const q = (v: string | number | null) => {
      let s = String(v ?? "");
      if (/^[=+\-@\t]/.test(s)) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const body = [header, ...rows].map((r) => r.map(q).join(",")).join("\r\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(body);
  };

  app.get("/export/applicants.csv", requireLogin, requireRole("admin", "manager", "it"), (_req, res) => {
    const rows = repo.allApplicants();
    csv(
      res,
      "applicants.csv",
      ["ref_number", "name", "email", "phone", "programme", "intake", "lifecycle", "triage", "priority", "assigned_to", "active_docs", "flags", "created_at"],
      rows.map((a) => [
        a.ref_number, a.full_name, a.email_address, a.phone, a.programme, a.intake, a.lifecycle, a.triage,
        a.priority, a.assigned_to ? repo.getStaff(a.assigned_to)?.username ?? "" : "",
        repo.listDocuments(a.id).length,
        [...new Set(repo.activeFlags(a.id).map((f) => f.type))].join("; "),
        a.created_at,
      ])
    );
  });

  app.get("/export/queue.csv", requireLogin, requireRole("admin", "manager", "it"), (_req, res) => {
    const rows = repo.queueView();
    csv(
      res,
      "review-queue.csv",
      ["ref_number", "name", "email", "verdict", "priority", "flags", "sla_due", "escalated"],
      rows.map((r) => [r.ref_number, r.full_name, r.email_address, r.computed_status, r.priority, r.flag_summary, r.sla_due_at, r.escalated])
    );
  });

  app.get("/export/audit.csv", requireLogin, requireRole("admin", "manager", "it"), (_req, res) => {
    const rows = repo.recentAudit(10000);
    csv(res, "audit.csv", ["at", "actor", "event", "detail", "applicant_id"], rows.map((r) => [r.at, r.actor, r.event, r.detail, r.applicant_id]));
  });

  // ── Applicant portal (v3 features 12, 35, 40) ────────────────────────────
  // Auth model: ref + applicant email + one-time code. The ref identifies the
  // case — the OTP proves identity. Sessions are short-lived cookies.

  const portalRateOk = makeRateLimiter(6, 60_000);
  const portalCookie = (token: string) => `psid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 60}`;
  const portalApplicant = (req: Request) => {
    const token = parseCookies(req.headers.cookie)["psid"];
    return token ? { token, applicant: repo.getPortalSession(token) } : { token: "", applicant: undefined };
  };

  app.get("/portal", (req, res) => res.send(portalStartPage(undefined, req.theme, instName())));

  app.post("/portal/start", async (req, res) => {
    const ip = req.ip ?? "?";
    if (!portalRateOk(ip)) return res.status(429).send(portalStartPage("Too many attempts — please wait a minute.", req.theme, instName()));
    const a = repo.findByRef(String(req.body.ref ?? "").trim());
    const email = String(req.body.email ?? "").trim().toLowerCase();
    // Do not reveal whether the reference exists; but when it matches, send the OTP.
    if (!a || a.email_address !== email) {
      return res.send(portalStartPage("If that reference and email match an application, a code has been sent.", req.theme, instName()));
    }
    const code = repo.createOtp(a.id);
    const delivery = repo.getSetting("portal_otp_delivery", "screen");
    if (delivery === "email") {
      try {
        await ctx.adapters.sender.send(
          a.email_address,
          `[${a.ref_number}] Your admissions portal access code`,
          `Hello ${a.full_name ?? ""},\n\nYour one-time access code is: ${code}\n\nIt expires in 10 minutes. If you did not request it, you can ignore this message.\n\n${repo.getSetting("institution_name", "Admissions")}`,
          a.thread_id
        );
        return res.send(portalOtpPage(a.ref_number, null, undefined, req.theme, instName()));
      } catch (e) {
        repo.audit(a.id, "system", "send_failed", `portal OTP email: ${(e as Error).message}`);
        // Fall back to on-screen delivery so the applicant is never locked out.
        return res.send(portalOtpPage(a.ref_number, code, "Email delivery failed — showing the code here instead.", req.theme, instName()));
      }
    }
    // Demo/mock mode: show the code on screen.
    res.send(portalOtpPage(a.ref_number, code, undefined, req.theme, instName()));
  });

  app.post("/portal/verify", (req, res) => {
    const ip = req.ip ?? "?";
    if (!portalRateOk(ip)) return res.status(429).send(portalStartPage("Too many attempts — please wait a minute.", req.theme, instName()));
    const a = repo.findByRef(String(req.body.ref ?? "").trim());
    if (!a || !repo.consumeOtp(a.id, String(req.body.code ?? ""))) {
      return res.send(portalOtpPage(String(req.body.ref ?? ""), null, "That code is not valid (codes expire after 10 minutes).", req.theme, instName()));
    }
    const token = repo.createPortalSession(a.id);
    repo.audit(a.id, "portal", "portal_login", "applicant signed in via one-time code");
    res.setHeader("Set-Cookie", portalCookie(token));
    res.redirect("/portal/home");
  });

  app.get("/portal/home", (req, res) => {
    const { applicant } = portalApplicant(req);
    if (!applicant) return res.redirect("/portal");
    res.send(portalHomePage(repo, applicant, req.query.msg ? String(req.query.msg) : undefined, req.theme, instName()));
  });

  app.post("/portal/logout", (req, res) => {
    const { token } = portalApplicant(req);
    if (token) repo.deletePortalSession(token);
    res.setHeader("Set-Cookie", "psid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
    res.redirect("/portal");
  });

  /**
   * Portal upload → synthetic incoming message on channel 'portal' → the SAME
   * pipeline triages it. Nothing special-cased: the case file stays whole.
   */
  app.post("/portal/upload", async (req, res) => {
    const { applicant } = portalApplicant(req);
    if (!applicant) return res.status(401).json({ ok: false, error: "not signed in" });
    const { filename, mimeType, data } = req.body ?? {};
    if (!filename || typeof data !== "string" || !data.length) {
      return res.status(400).json({ ok: false, error: "missing file" });
    }
    const content = Buffer.from(data, "base64");
    if (content.length > 10 * 1024 * 1024) {
      return res.status(413).json({ ok: false, error: "file too large (10 MB max)" });
    }
    const allowed = ["application/pdf", "image/png", "image/jpeg"];
    if (!allowed.includes(String(mimeType ?? ""))) {
      return res.status(400).json({ ok: false, error: "please upload a PDF, PNG or JPG" });
    }
    const id = `portal-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    try {
      await processEmail(
        {
          id,
          threadId: applicant.thread_id,
          from: applicant.email_address,
          fromName: applicant.full_name ?? undefined,
          subject: `Portal upload: ${filename}`,
          body: `Applicant uploaded ${filename} through the portal.`,
          receivedAt: new Date().toISOString(),
          attachments: [{ filename: String(filename), mimeType: String(mimeType), content }],
          channel: "portal",
        },
        ctx
      );
      repo.audit(applicant.id, "portal", "portal_upload", filename);
      res.json({ ok: true });
    } catch (e) {
      log(`portal upload failed: ${(e as Error).message}`, "error");
      res.status(500).json({ ok: false, error: "upload processing failed" });
    }
  });

  // ── Public self-service status page (features 20, 21) ────────────────────

  const rateOk = makeRateLimiter(10, 60_000);

  app.get("/status", (req, res) => res.send(publicStatusForm(undefined, req.theme, instName())));

  app.post("/status", (req, res) => {
    const ip = req.ip ?? "?";
    if (!rateOk(ip)) return res.status(429).send(publicStatusForm("Too many attempts — please wait a minute.", req.theme));
    const ref = String(req.body.ref ?? "").trim();
    const email = String(req.body.email ?? "").trim().toLowerCase();
    const a = repo.findByRef(ref);
    if (!a || a.email_address !== email) {
      return res.send(publicStatusForm("No application matches that reference number and email.", req.theme));
    }
    res.send(publicStatusResult(repo, a, req.theme, instName()));
  });

  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  /** Command-palette search API (v4). */
  app.get("/api/search", requireLogin, (req, res) => {
    const q = String(req.query.q ?? "").trim();
    if (!q) return res.json({ applicants: [] });
    res.json({
      applicants: repo.searchApplicants({ q, limit: 8 }).map((a) => ({
        id: a.id,
        ref_number: a.ref_number,
        name: a.full_name ?? "",
        email: a.email_address,
        lifecycle: a.lifecycle,
        avatar: avatar(a.full_name ?? a.ref_number, 26),
      })),
    });
  });

  return app;
}

/** Escalation sweep (feature 29) — runs on an interval in serve mode. */
export function runEscalationSweep(repo: Repo, escalationHours: number): number {
  const overdue = repo.overdueCases();
  let n = 0;
  for (const a of overdue) {
    repo.escalate(a.id);
    repo.notify("escalation", `⚠️ Case ${a.ref_number} has exceeded its response target.`, a.id);
    repo.audit(a.id, "system", "escalated", `exceeded response target (escalation window ${escalationHours}h)`);
    n++;
    log(`escalation: ${a.ref_number} exceeded response target → urgent`, "warn");
  }
  return n;
}
