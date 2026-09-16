/**
 * The web console (features 11–21, 27–35, 38–39):
 * staff dashboard, review queue, one-click case files, search/filters,
 * settings & templates, staff management, notifications, exports,
 * and the public applicant self-service status page.
 *
 * Server-rendered, self-contained, DB-backed sessions + CSRF.
 */
import * as crypto from "crypto";
import { LOGO_BASE64 } from "./logo";
import express, { type Express, type Request, type Response } from "express";
import type { Repo } from "../db/repo";
import type { PipelineContext } from "../pipeline/adapters";
import type { LifecycleStage } from "../types";
import { DOC_TYPES, EMAIL_CATEGORY_LABELS, LIFECYCLE_LABELS, LIFECYCLE_ORDER, type DocType, type EmailCategory } from "../types";
import { checklistText, renderTemplate } from "../drafting";
import { docLabel } from "../rules";
import {
  applicantsPage, casePage, dashboardPage, loginPage, notificationsPage,
  queuePage, replayPage, settingsPage, staffPage, teamPage,
} from "./pages";
import { avatar, esc, layout } from "./views";
import { authMiddleware, clearSessionCookie, csrfCheck, loginAttempt, parseCookies, requireLogin, requireRole, sessionCookie } from "./auth";
import { processEmail } from "../pipeline";
import { log } from "../util/log";
import { hashPassword } from "../util/password";

export interface WebDeps {
  repo: Repo;
  ctx: PipelineContext; // reuse the pipeline's sender/vision adapters
  /** Gmail was configured at boot (live mode) — mail is real, not simulated. */
  mailConnectedAtBoot?: boolean;
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

  /**
   * Is mail REAL right now? Either Gmail was configured at boot, or an OAuth
   * refresh token has since been saved from Settings → Gmail connection.
   * Used to show the demo-mode banner truthfully.
   */
  const mailLive = (): boolean =>
    Boolean(deps.mailConnectedAtBoot) || Boolean(repo.getSetting("gmail_refresh_token", ""));
  app.disable("x-powered-by");
  // Behind any reverse proxy (the preview environment included) req.ip is the
  // proxy's address unless this is set — which makes every per-IP rate
  // limiter a single global counter for ALL users. Opt in via TRUST_PROXY=1.
  if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);
  app.use(express.urlencoded({ extended: true, limit: "2mb" }));
  app.use(express.json({ limit: "1mb" }));
  app.use(authMiddleware(repo));

  const c = (req: Request) => ({
    repo,
    user: req.staff!,
    unread: repo.unreadCount(req.staff!.id),
    csrf: req.csrfToken ?? "",
    theme: req.theme,
    institution: instName(),
    mailMock: !mailLive(),
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

  // Official logo served once and cached; every page references this path.
  app.get("/assets/logo", (_req, res) => {
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(Buffer.from(LOGO_BASE64, "base64"));
  });

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

  // Failed-logins-only limiter: only FAILURES count, so legitimate users are
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
    if (!title) return res.redirect(backToCase(id, "Task title was empty — nothing added."));
    repo.addTask(id, title, req.staff!.id);
    staffAction(req, id, "task_added", title);
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

  // Rapid double-click protection for template sends: the same officer sending
  // the same template to the same case within 5s is treated as one action.
  const recentSends = new Map<string, number>();
  const sendGuardOk = (key: string): boolean => {
    const now = Date.now();
    if (recentSends.size > 2000) recentSends.clear();
    const last = recentSends.get(key) ?? 0;
    if (now - last < 5000) return false;
    recentSends.set(key, now);
    return true;
  };

  app.post("/case/:id/send", requireLogin, csrfCheck, async (req, res) => {
    const id = Number(req.params.id);
    const a = repo.getApplicant(id);
    if (!a) return res.status(404).send("Case not found.");
    const tpl = repo.getTemplate(String(req.body.template ?? ""));
    if (!tpl) return res.redirect(backToCase(id, "Unknown template."));
    if (req.body.preview === undefined && !sendGuardOk(`${req.staff!.id}:${id}:${tpl.key}`)) {
      return res.redirect(backToCase(id, "Duplicate send ignored — that reply was just sent."));
    }
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
    if (!body) return res.redirect(backToCase(id, "Note was empty — nothing saved."));
    repo.addNote(id, req.staff!.id, body);
    staffAction(req, id, "note_added", body.slice(0, 120));
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
    // Secret is write-only in the UI: kept if the field is left blank.
    const secret = String(req.body.gmail_client_secret ?? "").trim();
    if (secret) repo.setSetting("gmail_client_secret", secret);
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

  app.get("/staff", requireLogin, requireRole("admin"), (req, res) =>
    res.send(staffPage(c(req), req.query.msg ? String(req.query.msg) : undefined))
  );

  app.post("/staff/add", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const username = String(req.body.username ?? "").trim();
    const password = String(req.body.password ?? "");
    const role = ["admin", "manager", "officer", "it"].includes(String(req.body.role)) ? String(req.body.role) : "officer";
    const staffMsg = (m: string) => `/staff?msg=${encodeURIComponent(m)}`;
    if (!username) return res.redirect(staffMsg("Username is required."));
    if (!/^[a-z0-9_.-]{2,32}$/i.test(username)) return res.redirect(staffMsg("Username may contain letters, digits, dots, dashes and underscores (2–32 chars)."));
    if (!password || password.length < 8) return res.redirect(staffMsg(`Password for “${username}” must be at least 8 characters.`));
    if (repo.getStaffByUsername(username)) return res.redirect(staffMsg(`Username “${username}” is already taken.`));
    repo.createStaff(username, String(req.body.display_name ?? username), hashPassword(password), role);
    repo.audit(null, req.staff!.username, "staff_created", `${username} (${role})`);
    res.redirect(staffMsg(`Staff account “${username}” created (${role}).`));
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
    const staffMsg = (m: string) => `/staff?msg=${encodeURIComponent(m)}`;
    const password = String(req.body.password ?? "");
    const target = repo.getStaff(id);
    if (!target) return res.redirect(staffMsg("Unknown staff member."));
    if (password.length < 8) return res.redirect(staffMsg(`Password for “${target.username}” must be at least 8 characters.`));
    repo.setStaffPassword(id, hashPassword(password));
    repo.audit(null, req.staff!.username, "staff_password_reset", `user #${id}`);
    res.redirect(staffMsg(`Password reset for “${target.username}”.`));
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

  // Branded 404 instead of Express's raw "Cannot GET …" page.
  app.use((req, res) => {
    if (req.path.startsWith("/api/") || req.path.startsWith("/portal/upload")) {
      return res.status(404).json({ ok: false, error: "not found" });
    }
    res.status(404).send(layout({
      title: "Page not found",
      institution: instName(),
      publicPage: !req.staff,
      user: req.staff,
      unread: req.staff ? repo.unreadCount(req.staff.id) : undefined,
      csrf: req.staff ? req.csrfToken : undefined,
      content: `<div class="card" style="max-width:520px;margin:60px auto;text-align:center">
        <h1>Page not found</h1>
        <p class="sub">That address does not exist${req.staff ? " in the console" : ""}.</p>
        <p><a class="btn" href="${req.staff ? "/" : "/login"}">${req.staff ? "← Back to the Command Center" : "← Back to sign in"}</a></p>
      </div>`,
    }));
  });

  // Last-resort error handler: log the detail, show a calm page — never a stack trace.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, req: Request, res: Response, _next: unknown) => {
    log(`unhandled error on ${req.method} ${req.path}: ${(err as Error)?.stack ?? err}`, "error");
    if (res.headersSent) return;
    if (req.path.startsWith("/api/") || req.path.startsWith("/portal/upload")) {
      return res.status(500).json({ ok: false, error: "internal error" });
    }
    res.status(500).send(layout({
      title: "Something went wrong",
      institution: instName(),
      publicPage: !req.staff,
      user: req.staff,
      content: `<div class="card" style="max-width:520px;margin:60px auto;text-align:center">
        <h1>Something went wrong</h1>
        <p class="sub">The error has been logged. Try again — if it persists, tell your system administrator.</p>
        <p><a class="btn" href="/">← Back to the start</a></p>
      </div>`,
    }));
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
