/**
 * The web console (features 11–21, 27–35, 38–39):
 * staff dashboard, review queue, one-click case files, search/filters,
 * settings & templates, staff management, notifications, exports,
 * and the public applicant self-service status page.
 *
 * Server-rendered, self-contained, DB-backed sessions + CSRF.
 */
import * as crypto from "crypto";
import { FAVICON_BASE64, LOGO_BASE64, LOGO_WHITE_BASE64 } from "./logo";
import { FONT_INSTRUMENT_SERIF_ITALIC_WOFF2, FONT_INSTRUMENT_SERIF_WOFF2, FONT_MANROPE_WOFF2 } from "./fonts";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { Repo } from "../db/repo";
import { DEFAULT_GEMINI_MODEL } from "../extraction/gemini";
import type { PipelineContext } from "../pipeline/adapters";
import type { Adapters } from "../pipeline/adapters";
import type { ApplicantRow, LifecycleStage, Permission } from "../types";
import { EMAIL_CATEGORY_LABELS, LIFECYCLE_LABELS, LIFECYCLE_ORDER, PERMISSIONS, PERMISSION_LABELS, type EmailCategory } from "../types";
import { checklistText, renderTemplate } from "../drafting";
import { docLabel } from "../rules";
import { fillSlots } from "../documents/matrix";
import { evaluateAdmission, evaluateCaseTypeRules } from "../admissions/evaluate";
import { ADMISSION_SYSTEMS, DOC_TYPES, type AdmissionSystem, type DocType, type RuleField } from "../types";
import type { RuleAction, RuleCondition, WorkflowRule } from "../rules/workflow";
import { describeRule, firstMatchingRule, rulesForCaseScope, ruleMatches } from "../rules/workflow";
import { categorizeEmail } from "../categorize";

type LegacyAcademicLevel = "degree" | "diploma" | "certificate" | "masters" | "phd";
import {
  accountPage, admissionsPage, applicantsPage, casePage, composePage, composeWindowPage, configPage, dashboardPage, loginPage, mailPage, mailThreadPage, resetPasswordPage, setupPage,
  replayPage, settingsPage, staffPage, templatesPage,
} from "./pages";
import { TEMPLATE_DEFAULTS } from "../db/seed";
import { avatar, layout } from "./views";
import { authMiddleware, clearSessionCookie, csrfCheck, loginAttempt, parseCookies, requireLogin, requireRole, sessionCookie } from "./auth";
import { GmailClient } from "../ingestion/gmailClient";
import { BudgetedVisionAdapter, GeminiVisionAdapter, MockVisionAdapter } from "../extraction/gemini";
import { GeminiWatcher, makeHeuristicWatcher } from "../watcher";
import { log } from "../util/log";
import { hashPassword, verifyPassword } from "../util/password";
import { gmailRedirectUri } from "./oauth";
import { LoginThrottle } from "./throttle";
import { emailBanner, organizationName, organizationSender, organizationTheme } from "../branding";
import { PACK_DIR, PACK_SLOTS, type PackFile } from "../pack";
import { EXAM_SYSTEMS } from "../config";
import * as fs from "fs";
import * as path from "path";

export interface WebDeps {
  repo: Repo;
  ctx: PipelineContext; // reuse the pipeline's sender/vision adapters
  /** Manual "Sync now" hook — one live ingest pass; returns the failure, if any. */
  gmailSync?: () => Promise<Error | null>;
  /** One-off backfill hook — one pass over a deeper window (30/90/365 days). */
  gmailBackfill?: (days: number) => Promise<Error | null>;
  /** True when the running process has live environment Gmail credentials. */
  gmailConfigured?: boolean;
  gmailAddress?: string;
  /** Test the active Gmail client, including env-only deployments. */
  gmailTest?: () => Promise<Error | null>;
}

export function createApp(deps: WebDeps): Express {
  const { repo, ctx, gmailSync, gmailBackfill, gmailConfigured } = deps;
  const app = express();
  const organizationId = (req?: Request): number => req?.staff?.organization_id ?? 1;
  const instName = (req?: Request): string => organizationName(repo, organizationId(req));
  // PPR P1-5: every outgoing send carries the organization's sender identity
  // (From display name / Reply-To) — one wrapper so no send path can forget it.
  const sendOrgMail = (
    a: { email_address: string; thread_id: string; organization_id?: number | null },
    subject: string,
    body: string,
    extras: { banner?: { mime: string; base64: string } | null; attachments?: Array<{ filename: string; mimeType: string; content: Buffer }> }
  ): Promise<void> =>
    ctx.adapters.sender.send(a.email_address, subject, body, a.thread_id, {
      ...organizationSender(repo, a.organization_id ?? 1),
      ...extras,
    });
  const authName = (): string => repo.getOrganization(1)?.name?.trim() || organizationName(repo, 1);

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
    unread: repo.unreadCount(req.staff!.id, req.staff!.demo, repo.visibleSchoolsFor(req.staff!)),
    csrf: req.csrfToken ?? "",
    theme: req.theme,
    institution: instName(req),
    brand: repo.getOrganization(organizationId(req)) ? {
      ...organizationTheme(repo, organizationId(req)),
      logo: repo.getOrganization(organizationId(req))!.logo,
      tagline: organizationId(req) === 1 ? repo.getSetting("splash_tagline", "") : "",
    } : undefined,
    gmailConfigured: Boolean(gmailConfigured) && repo.getSetting("gmail_disabled", "") !== "1",
    gmailAddress: deps.gmailAddress,
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

  // Organization-neutral SVG identity assets, served once and cached.
  // Page shells render the token-aware monogram inline; these URLs remain for
  // integrations and legacy asset slots without a baked PNG dependency.
  app.get("/assets/logo", (_req, res) => {
    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(Buffer.from(LOGO_BASE64, "base64"));
  });
  app.get("/assets/logo-white", (_req, res) => {
    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(Buffer.from(LOGO_WHITE_BASE64, "base64"));
  });

  // Browser-tab mark: the a² SVG; organization logos remain stored on their organization row.
  app.get("/assets/favicon", (_req, res) => {
    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=604800");
    res.send(Buffer.from(FAVICON_BASE64, "base64"));
  });

  // Self-hosted typefaces (no CDN): Manrope variable font for the full interface.
  const fontRoutes: Array<[string, string]> = [
    ["/assets/fonts/manrope.woff2", FONT_MANROPE_WOFF2],
    ["/assets/fonts/instrument-serif.woff2", FONT_INSTRUMENT_SERIF_WOFF2],
    ["/assets/fonts/instrument-serif-italic.woff2", FONT_INSTRUMENT_SERIF_ITALIC_WOFF2],
  ];
  for (const [path, b64] of fontRoutes) {
    app.get(path, (_req, res) => {
      res.setHeader("Content-Type", "font/woff2");
      res.setHeader("Cache-Control", "public, max-age=604800");
      res.send(Buffer.from(b64, "base64"));
    });
  }

  /** Current email banner (used by the Configuration preview). */
  app.get("/assets/email-banner", requireLogin, (req, res) => {
    const b = emailBanner(repo, organizationId(req));
    if (!b) return res.status(404).send("No banner configured.");
    res.setHeader("Content-Type", b.mime);
    res.setHeader("Cache-Control", "no-store");
    res.send(Buffer.from(b.base64, "base64"));
  });

  /** Replace the email banner — raw image bytes in the request body. */
  app.post(
    "/config/branding/banner",
    requireLogin,
    requireRole("admin"),
    csrfCheck,
    express.raw({ type: ["image/jpeg", "image/png"], limit: "8mb" }), // phone photos run 3–8 MB
    (req, res) => {
      const back = (m: string) => `/config?tab=replies&msg=${encodeURIComponent(m)}#branding`;
      const buf = req.body as Buffer;
      if (!Buffer.isBuffer(buf) || buf.length < 1024) return res.redirect(back("Banner image missing or too small."));
      if (buf.length > 900 * 1024) return res.redirect(back("Banner too large — keep it under 900 KB."));
      // Trust the BYTES, not the Content-Type header: JPEG/PNG magic only.
      const isJpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
      const isPng = buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.subarray(4, 8).toString("hex") === "0d0a1a0a";
      if (!isJpeg && !isPng) return res.redirect(back("That file is not a JPEG or PNG image — banner unchanged."));
      const mime = isPng ? "image/png" : "image/jpeg";
      repo.setSetting("email_banner", buf.toString("base64"));
      repo.setSetting("email_banner_mime", mime);
      repo.audit(null, req.staff!.username, "email_banner_changed", `${(buf.length / 1024).toFixed(0)} KB ${mime}`);
      res.redirect(back("Email banner updated — every outgoing email now carries it."));
    }
  );

  /** Organization-owned logo upload; the bytes are stored in the tenant row,
   * never read from a bundled institution asset. */
  app.post(
    "/config/organization/logo",
    requireLogin,
    requireRole("admin"),
    csrfCheck,
    express.raw({ type: ["image/jpeg", "image/png", "image/svg+xml"], limit: "2mb" }),
    (req, res) => {
      const buf = req.body as Buffer;
      if (!Buffer.isBuffer(buf) || buf.length < 16) return res.status(400).send("Logo missing");
      const png = buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.subarray(4, 8).toString("hex") === "0d0a1a0a";
      const jpg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
      const svg = String(buf.subarray(0, 256)).trimStart().startsWith("<svg");
      if (!png && !jpg && !svg) return res.status(415).send("Logo must be PNG, JPEG or SVG");
      repo.updateOrganization(organizationId(req), { logo: `data:${png ? "image/png" : jpg ? "image/jpeg" : "image/svg+xml"};base64,${buf.toString("base64")}` });
      repo.audit(null, req.staff!.username, "organization_logo_changed", `${buf.length} bytes`);
      res.status(204).end();
    }
  );

  // OR-1: on a fresh install the whole console reduces to one screen — the
  // first-run setup where the owner creates their own admin account.
  const setupTokens = new Map<string, number>(); // one-time token -> expiry (epoch ms)
  const newSetupToken = (): string => {
    const t = crypto.randomBytes(16).toString("hex");
    setupTokens.set(t, Date.now() + 10 * 60_000);
    for (const [k, exp] of setupTokens) if (exp < Date.now()) setupTokens.delete(k);
    return t;
  };

  app.use((req, res, next) => {
    if (repo.staffCount() === 0 && req.path !== "/setup" && req.path !== "/healthz" && req.path !== "/theme") {
      res.redirect("/setup");
      return;
    }
    next();
  });

  app.get("/setup", (req, res) => {
    if (repo.staffCount() > 0) {
      res.status(404).send("Not found");
      return;
    }
    res.send(setupPage(newSetupToken(), undefined, req.theme, authName()));
  });

  app.post("/setup", (req, res) => {
    if (repo.staffCount() > 0) {
      res.status(404).send("Not found");
      return;
    }
    const fail = (msg: string) => res.status(200).send(setupPage(newSetupToken(), msg, req.theme, authName()));
    const token = String(req.body._setup ?? "");
    const exp = setupTokens.get(token);
    setupTokens.delete(token);
    if (!exp || exp < Date.now()) return fail("That setup link expired — reload the page and try again.");
    const username = String(req.body.username ?? "").trim().toLowerCase();
    const displayName = String(req.body.display_name ?? "").trim();
    const password = String(req.body.password ?? "");
    const confirm = String(req.body.confirm ?? "");
    if (!displayName) return fail("Please enter your name.");
    if (!/^[a-z0-9_.-]{2,32}$/.test(username)) return fail("Username: 2-32 characters — letters, digits, dots, dashes.");
    if (password.length < 8) return fail("Password must be at least 8 characters.");
    if (password !== confirm) return fail("The passwords do not match.");
    if (repo.getStaffByUsername(username)) return fail("That username is already taken.");
    repo.createStaff(username, displayName, hashPassword(password), "admin");
    const created = repo.getStaffByUsername(username);
    if (!created) return fail("Could not create the account — please try again.");
    const session = repo.createSession(created.id);
    repo.audit(null, username, "first_run_setup", "Administrator account created on first run");
    res.setHeader("Set-Cookie", sessionCookie(session.token, 8 * 3600, secureCookies));
    res.redirect("/");
  });

  // Login-CSRF defence (double-submit): the sign-in form echoes a token the
  // server also sets as a cookie. A cross-site forged login POST cannot read
  // that cookie, so it cannot supply the matching field. Set `COOKIE_SECURE=1`
  // behind TLS so the session cookie is never sent over plain HTTP.
  const secureCookies = process.env.COOKIE_SECURE === "1";
  const newLoginCsrf = (res: Response): string => {
    const t = crypto.randomBytes(16).toString("hex");
    res.setHeader("Set-Cookie", `lcsrf=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`);
    return t;
  };

  app.get("/login", (req, res) => {
    if (repo.staffCount() === 0) {
      res.redirect("/setup");
      return;
    }
    // ?msg= carries the one success notice (password just reset via code).
    res.send(loginPage(undefined, req.theme, authName(), newLoginCsrf(res), req.query.msg ? String(req.query.msg) : undefined));
  });

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

  // Failed-logins-only limiter: 10 failures per IP per minute blocks further
  // attempts. Only FAILURES count, so legitimate users are never locked out
  // by normal use. Time-based expiry + oldest-first eviction above the entry
  // cap — never a bulk clear (see src/web/throttle.ts).
  const loginFails = new LoginThrottle();
  const loginBlocked = (ip: string): boolean => !loginFails.allowed(ip);
  const loginRecordFail = (ip: string): void => {
    loginFails.recordFail(ip);
  };

  app.post("/login", (req, res) => {
    const ip = req.ip ?? "?";
    if (loginBlocked(ip)) {
      res.status(429).send(loginPage("Too many failed sign-ins from this address — please wait a minute.", req.theme, authName(), newLoginCsrf(res)));
      return;
    }
    // Login-CSRF: the token the page rendered must come back in the body AND
    // match the cookie. A mismatch means the form was forged or stale.
    const provided = String(req.body._lcsrf ?? "");
    const cookieToken = parseCookies(req.headers.cookie)["lcsrf"] ?? "";
    if (!provided || provided !== cookieToken) {
      res.status(403).send(loginPage("That sign-in page expired — please try again.", req.theme, authName(), newLoginCsrf(res)));
      return;
    }
    const staff = loginAttempt(repo, String(req.body.username ?? ""), String(req.body.password ?? ""));
    if (!staff) {
      loginRecordFail(ip);
      res.status(401).send(loginPage("Invalid username or password.", req.theme, authName(), newLoginCsrf(res)));
      return;
    }
    const session = repo.createSession(staff.id);
    repo.audit(null, staff.username, "staff_login", "");
    res.setHeader("Set-Cookie", sessionCookie(session.token, 8 * 3600, secureCookies));
    res.redirect("/");
  });

  // Logout mutates auth state, so it needs CSRF like every other mutation —
  // otherwise a cross-site 1-pixel form could sign staff out mid-crisis.
  app.post("/logout", csrfCheck, (req, res) => {
    if (req.sessionId) repo.deleteSession(req.sessionId);
    res.setHeader("Set-Cookie", clearSessionCookie());
    res.redirect("/login");
  });

  // ── Forgot password — one-time code issued by an admin ─────────────────
  // Per the owner's direction there is no email in the loop: the admin
  // issues a code on the staff page (shown once, in the response body —
  // never a URL, so it can't leak into history or a Referer) and hands it
  // to the member out-of-band; the member redeems it here. Codes are
  // single-use, expire in 30 minutes, are revoked by a newer issue, and
  // every failure returns the SAME generic refusal (no account
  // enumeration). The public endpoint is rate-limited per IP.
  const resetThrottle = new LoginThrottle({ windowMs: 10 * 60_000, maxFails: 5 });

  app.get("/reset-password", (req, res) => {
    res.send(resetPasswordPage(undefined, req.theme, authName(), newLoginCsrf(res)));
  });

  app.post("/reset-password", (req, res) => {
    const ip = req.ip ?? "?";
    if (!resetThrottle.allowed(ip)) {
      return res.status(429).send(resetPasswordPage("Too many reset attempts from this address — please wait a few minutes.", req.theme, authName(), newLoginCsrf(res)));
    }
    // Same anonymous double-submit CSRF as /login.
    const provided = String(req.body._lcsrf ?? "");
    const cookieToken = parseCookies(req.headers.cookie)["lcsrf"] ?? "";
    if (!provided || provided !== cookieToken) {
      return res.status(403).send(resetPasswordPage("That page expired — please try again.", req.theme, authName(), newLoginCsrf(res)));
    }
    const refuse = (m: string) => res.send(resetPasswordPage(m, req.theme, authName(), newLoginCsrf(res)));
    const GENERIC = "We couldn't verify that username and code. Check both, or ask your admin for a fresh code.";
    const username = String(req.body.username ?? "").trim();
    const code = String(req.body.code ?? "").trim();
    const password = String(req.body.password ?? "");
    const confirm = String(req.body.confirm ?? "");
    const member = username ? repo.getStaffByUsername(username) : undefined;
    if (!member || member.active !== 1) {
      resetThrottle.recordFail(ip); // credential guess — count it
      return refuse(GENERIC);
    }
    // Validate the password BEFORE consuming the code — a typo must not
    // burn the one-time code.
    if (password.length < 8) return refuse("The new password must be at least 8 characters.");
    if (password !== confirm) return refuse("The two new passwords do not match — nothing was changed.");
    // Atomic claim: racing redemptions can't both win.
    const ownerId = repo.consumeResetCode(code);
    if (ownerId === null || ownerId !== member.id) {
      resetThrottle.recordFail(ip); // credential guess — count it
      return refuse(GENERIC);
    }
    repo.setStaffPassword(member.id, hashPassword(password));
    const purged = repo.purgeStaffSessions(member.id);
    repo.audit(null, member.username, "password_reset_code_used", `admin-issued code consumed; ${purged} session(s) ended`);
    res.redirect(`/login?msg=${encodeURIComponent("Password updated — sign in with your new password.")}`);
  });

  // ── Dashboard / queue / applicants ───────────────────────────────────────

  app.get("/", requireLogin, (req, res) => res.send(dashboardPage(c(req))));

  // Round 18: five operational queues replace the old top-level categories.
  // The legacy /queue link lands on the Human Review queue.
  app.get("/queue", requireLogin, (req, res) => {
    res.redirect(`/applicants?queue=human_review${req.query.filter === "urgent" ? "&priority=urgent" : ""}`);
  });

  app.get("/applicants", requireLogin, (req, res) => {
    res.send(
      applicantsPage(c(req), {
        search: req.query.q ? String(req.query.q) : undefined,
        queue: req.query.queue ? String(req.query.queue) : undefined,
        sub: req.query.sub ? String(req.query.sub) : undefined,
        programme: req.query.programme ? String(req.query.programme) : undefined,
        intake: req.query.intake ? String(req.query.intake) : undefined,
      })
    );
  });

  // ── Case file ────────────────────────────────────────────────────────────

  // ── Admissions: the whole pipeline, split into its levels ─────────────────
  // Every gauge on the dashboard opens this page at its own stage; the stage
  // tabs show live counts. Staff act on cases right here.
  // PPR P0-2: the whole section exists only when an education-module profile
  // is enabled for this organization. Old bookmarks redirect, never break.
  app.get("/admissions", requireLogin, (req, res) => {
    if (!repo.hasEducationModule(organizationId(req))) {
      return res.redirect("/applicants?msg=" + encodeURIComponent("Admissions is off — this organization has no education-module profile."));
    }
    res.send(admissionsPage(c(req), String(req.query.stage ?? "all")));
  });

  // Realm guard: a case is only visible to accounts in the SAME realm —
  // live admins never open mock cases, demo accounts never open live ones.
  const sameRealm = (req: Request, a: { demo?: number } | null): boolean =>
    Boolean(a) && (a!.demo ?? 0) === (req.staff!.demo ?? 0);

  // PPR P1-8: the four automation actions are distinct permissions, replacing
  // the admin/user role split for them. Admins hold all four; other staff hold
  // what they were granted (see repo.hasPermission for the default grants).
  const requirePermission = (permission: Permission) =>
    (req: Request, res: Response, next: NextFunction): void => {
      if (req.staff && repo.hasPermission(req.staff.id, permission)) {
        next();
        return;
      }
      res.status(403).send(`403 — you do not hold the “${PERMISSION_LABELS[permission]}” permission.`);
    };

  // OR-8: visibility scoping covers EVERY case surface — the case page,
  // compose, replay and every POST action. Unknown ids and out-of-scope ids
  // get the SAME refusal, so scoped staff can't probe which cases exist.
  app.use("/case/:id", requireLogin, (req, res, next) => {
    const a = repo.getApplicant(Number(req.params.id));
    // Realm guard at the ONE choke point every /case/:id route passes through
    // (pages, compose, replay, notes, tasks, decisions, reminders…): a
    // cross-realm case is indistinguishable from a non-existent one.
    if (a && !sameRealm(req, a)) {
      res.status(404).send("Case not found.");
      return;
    }
    if (!a || !repo.applicantVisibleTo(req.staff!, a)) {
      res.status(403).send(layout({
        title: "Outside your schools",
        institution: instName(req),
        user: req.staff,
        unread: repo.unreadCount(req.staff!.id, req.staff!.demo, repo.visibleSchoolsFor(req.staff!)),
        csrf: req.csrfToken,
        content: `<div class="card" style="max-width:560px;margin:60px auto;text-align:center">
          <h1>This case is outside your assigned schools</h1>
          <p class="sub">You can only open cases that belong to a school you handle. If this should be yours, ask an administrator to update your visibility scope.</p>
          <p><a class="btn" href="/applicants">← Back to your queues</a></p>
        </div>`,
      }));
      return;
    }
    next();
  });

  app.get("/case/:id", requireLogin, (req, res) => {
    const a = repo.getApplicant(Number(req.params.id));
    if (!a || !sameRealm(req, a)) return res.status(404).send("Case not found.");
    res.send(casePage(c(req), a, req.query.msg ? String(req.query.msg) : undefined));
  });

  /** Decision replay — the step-by-step chain behind any flag/verdict. */
  app.get("/case/:id/replay", requireLogin, (req, res) => {
    const a = repo.getApplicant(Number(req.params.id));
    if (!a || !sameRealm(req, a)) return res.status(404).send("Case not found.");
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
    // PPR P1-3/P1-8: an ordinary draft is officer work (staff send paths stay
    // allowed); a draft awaiting APPROVAL may only be released by a holder of
    // the "Approve automation" permission.
    if (draft.needs_approval && !repo.hasPermission(req.staff!.id, "approve_automation")) {
      return res.status(403).send(`403 — you do not hold the “${PERMISSION_LABELS.approve_automation}” permission.`);
    }
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
    // The held draft remembers which template rendered it — approving the
    // draft honours that template's pack attachment exactly like a direct
    // send would. Without this, held replies (the common path under the
    // qualification gate) went out without the promised pack PDFs.
    // Claim BEFORE the awaited send: a second concurrent approval reads the
    // same queued draft only until this update fires — from here on it loses.
    if (!repo.claimOutboxDraft(draft.id, new Date().toISOString())) {
      return res.redirect(backToCase(id, "That draft is already being sent — refresh before trying again."));
    }
    const draftTpl = draft.template_key ? repo.getTemplate(draft.template_key, organizationId(req)) : undefined;
    const pack = packForTemplate(draftTpl?.attach_pack, id, req.staff!.username);
    try {
      await sendOrgMail(a, subject, body, {
        banner: draftTpl && draftTpl.include_banner === 0 ? null : emailBanner(repo, organizationId(req)),
        attachments: pack ? pack.files : [],
      });
      repo.insertEmail({
        applicant_id: id, message_id: `handoff-${draft.id}-${Date.now()}`, thread_id: a.thread_id,
        direction: "out", from_addr: "", to_addr: a.email_address, subject, body,
        category: null, auto: 0, at: new Date().toISOString(),
        attachments: pack ? pack.files.map((f) => f.filename) : [],
      });
      repo.deleteOutbox(draft.id);
      staffAction(req, id, "human_override", `approved held draft: "${subject}"${pack ? ` (+${pack.label} pack, ${pack.files.length} file(s))` : ""}`);
      res.redirect(backToCase(id, `Reply sent${pack ? ` with the ${pack.label} pack attached` : ""}.`));
    } catch (e) {
      repo.releaseOutboxDraft(draft.id); // let the officer retry the send
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
        // P1-4: a profile may declare required information per stage. Moving
        // INTO a stage whose list is not yet satisfied is refused with the
        // missing items named — staff decide what to collect; the console
        // refuses to pretend the stage is ready. Empty list (the default) =
        // no enforcement; the education profile keeps its generated matrix
        // as the richer requirements source.
        const stageCfg = repo.caseTypeForCase(id)?.stages?.find((s) => s.id === to);
        const requires = stageCfg?.requires ?? [];
        if (requires.length) {
          const docs = repo.listDocuments(id, { activeOnly: true });
          const satisfied = (item: string): boolean => {
            const k = item.trim().toLowerCase();
            return docs.some((d) =>
              String(d.document_type).toLowerCase() === k
              || Object.keys(d.extracted_fields ?? {}).some((f) => f.toLowerCase() === k)
              || String(d.extracted_text ?? "").toLowerCase().includes(k));
          };
          const missing = requires.filter((r) => !satisfied(r));
          if (missing.length) {
            return res.redirect(backToCase(id, `Cannot move to “${stageCfg?.label ?? to}” yet — still needed: ${missing.join(", ")}.`));
          }
        }
        repo.setLifecycle(id, to, req.staff!.username, `advanced by ${req.staff!.display_name}`);
        if (to === "verification" || to === "completed") staffAction(req, id, "case_action", `moved to ${to}`);
        else staffAction(req, id, "case_action", `advanced to ${to}`);
        return res.redirect(backToCase(id, `Status → ${LIFECYCLE_LABELS[to]}.`));
      }
    }

    if (action === "request_info") {
      // Actions open a READY, pre-filled reply — nothing leaves until the
      // officer has seen it and pressed Send on the compose page.
      const activeDocs = repo.listDocuments(id, { activeOnly: true });
      const tplKey = activeDocs.length === 0 ? "docs_request" : "missing_documents";
      return res.redirect(`/case/${id}/compose?template=${tplKey}`);
    }
    if (action === "ack_receipt") {
      return res.redirect(`/case/${id}/compose?template=ack_received`);
    }
    if (action === "status_answer") {
      return res.redirect(`/case/${id}/compose?template=status_answer`);
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

  /** PPR P0-5: which organization-owned attachment set (if any) rides along
   *  with a template. Missing/empty sets are audited — a send that silently
   *  drops a promised PDF is the worst kind of failure. Only sets owned by
   *  the SENDING organization resolve (E3: no privileged pack channel). */
  const packForTemplate = (ref: string | undefined, applicantId: number, actor: string): { files: PackFile[]; label: string } | null => {
    if (!ref || ref === "none") return null;
    const applicant = repo.getApplicant(applicantId);
    const resolved = repo.attachmentSetFiles(applicant?.organization_id ?? 1, ref);
    if (resolved.issues.length) repo.audit(applicantId, actor, "pack_incomplete", resolved.issues.join("; "));
    return { files: resolved.files, label: resolved.label };
  };

  app.post("/case/:id/send", requireLogin, csrfCheck, async (req, res) => {
    const id = Number(req.params.id);
    const a = repo.getApplicant(id);
    if (!a) return res.status(404).send("Case not found.");
    const tpl = repo.getTemplate(String(req.body.template ?? ""), organizationId(req));
    if (!tpl) return res.redirect(backToCase(id, "Unknown template."));
    if (req.body.preview === undefined && !sendGuardOk(`${req.staff!.id}:${id}:${tpl.key}`)) {
      return res.redirect(backToCase(id, "Duplicate send ignored — that reply was just sent."));
    }
    const activeDocs = repo.listDocuments(id, { activeOnly: true });
    const requirements = repo.effectiveRequirements(a).filter((r) => r.required);
    const present = activeDocs.map((d) => d.document_type);
    const { missing } = fillSlots(requirements, present);
    const rendered = renderTemplate(tpl.subject, tpl.body, {
      ref: a.ref_number,
      institution: instName(req),
      name: a.full_name ?? undefined,
      missingLabels: missing.map((m) => docLabel(m.document_type)),
      checklist: checklistText({ requirements, presentTypes: present }),
      statusLabel: LIFECYCLE_LABELS[a.lifecycle],
    });
    // "Preview" in the Responses card: show the rendered reply in-page, send nothing.
    if (req.body.preview !== undefined) {
      return res.send(casePage(c(req), a, "Preview only — nothing has been sent.", rendered));
    }
    const pack = packForTemplate(tpl.attach_pack, id, req.staff!.username);
    try {
      await sendOrgMail(a, rendered.subject, rendered.body, {
        banner: tpl.include_banner === 0 ? null : emailBanner(repo, organizationId(req)),
        attachments: pack ? pack.files : [],
      });
    } catch (e) {
      repo.audit(id, req.staff!.username, "send_failed", (e as Error).message);
      return res.redirect(backToCase(id, `Send failed: ${(e as Error).message}`));
    }
    repo.insertEmail({
      applicant_id: id, message_id: `manual-${Date.now()}`, thread_id: a.thread_id, direction: "out",
      from_addr: "", to_addr: a.email_address, subject: rendered.subject, body: rendered.body, category: null, auto: 0,
      at: new Date().toISOString(),
      attachments: pack ? pack.files.map((f) => f.filename) : [],
    });
    staffAction(req, id, "email_sent_manual", `template ${tpl.key}: "${rendered.subject}"${pack ? ` (+${pack.label} pack, ${pack.files.length} file(s))` : ""}`);
    res.redirect(backToCase(id, `Sent "${tpl.name}"${pack ? ` with the ${pack.label} pack attached` : ""}.`));
  });

  /** PPR P0-5: send an attachment set with its wrapper template. The set is
   *  named explicitly — legacy names map to the migrated profile's seeded
   *  sets; anything else must be one of the organization's own sets. */
  app.post("/case/:id/send-pack", requireLogin, requireRole("admin"), csrfCheck, async (req, res) => {
    const id = Number(req.params.id);
    const a = repo.getApplicant(id);
    if (!a) return res.status(404).send("Case not found.");
    const kind = String(req.body.kind ?? "");
    const resolved = repo.attachmentSetFiles(a.organization_id ?? organizationId(req), kind);
    if (!kind || kind === "none" || resolved.issues.some((i) => i.includes("does not exist"))) {
      return res.redirect(backToCase(id, "Unknown attachment set — nothing sent."));
    }
    const isAdmission = kind === "admission";
    const tpl = repo.getTemplate(isAdmission ? "admission_letter" : "docs_request", organizationId(req));
    if (!tpl) return res.redirect(backToCase(id, "Template missing — nothing sent."));
    const rendered = renderTemplate(tpl.subject, tpl.body, {
      ref: a.ref_number,
      institution: instName(req),
      name: a.full_name ?? undefined,
      missingLabels: [],
      checklist: "",
      statusLabel: LIFECYCLE_LABELS[a.lifecycle],
      programme: a.programme ? (repo.listProgrammes().find((p) => p.code === a.programme)?.name ?? a.programme) : undefined,
      regDate: repo.getSetting("reg_date", ""),
      orientationDates: repo.getSetting("orientation_dates", ""),
    });
    const pack = resolved;
    // Missing pack files must never be a silent gap in a real send.
    if (pack.issues.length) {
      repo.audit(id, req.staff!.username, "pack_incomplete", pack.issues.join("; "));
    }
    try {
      await sendOrgMail(a, rendered.subject, rendered.body, {
        banner: tpl.include_banner === 0 ? null : emailBanner(repo, organizationId(req)),
        attachments: pack.files,
      });
    } catch (e) {
      repo.audit(id, req.staff!.username, "send_failed", (e as Error).message);
      return res.redirect(backToCase(id, `Send failed: ${(e as Error).message}`));
    }
    repo.insertEmail({
      applicant_id: id, message_id: `pack-${Date.now()}`, thread_id: a.thread_id, direction: "out",
      from_addr: "", to_addr: a.email_address, subject: rendered.subject, body: rendered.body, category: null, auto: 0,
      at: new Date().toISOString(),
      attachments: pack.files.map((f) => f.filename),
    });
    staffAction(req, id, isAdmission ? "admission_pack_sent" : "application_pack_sent",
      `${pack.files.length} document(s): "${rendered.subject}"`);
    const packWarn = pack.issues.length
      ? ` ⚠ ${pack.issues.length} pack file(s) missing — see audit.`
      : "";
    res.redirect(backToCase(id, `${isAdmission ? "Admission" : "Attachment"} set “${pack.label}” sent — ${pack.files.length} document(s) attached.${packWarn}`));
  });

  // Compose: an action (e.g. "Request missing documents") or any template
  // opens a full-page reply with everything pre-filled — the officer edits if
  // they want, presses Send, done. One obvious path: draft → send.
  const renderFor = (a: ApplicantRow, subject: string, body: string) =>
    renderTemplate(subject, body, {
      ref: a.ref_number,
      institution: organizationName(repo, a.organization_id ?? 1),
      name: a.full_name ?? undefined,
      missingLabels: repo.effectiveRequirements(a)
        .filter((r) => r.required)
        .filter((r) => !repo.listDocuments(a.id, { activeOnly: true }).some((d) => d.document_type === r.document_type))
        .map((r) => docLabel(r.document_type)),
      checklist: checklistText({
        requirements: repo.effectiveRequirements(a),
        presentTypes: repo.listDocuments(a.id, { activeOnly: true }).map((d) => d.document_type),
      }),
      statusLabel: LIFECYCLE_LABELS[a.lifecycle],
      programme: a.programme ? (repo.programmeByCode(a.programme)?.name ?? a.programme) : undefined,
      regDate: repo.getSetting("reg_date", ""),
      orientationDates: repo.getSetting("orientation_dates", ""),
    });

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
    const baseOpts = { schools: repo.visibleSchoolsFor(req.staff!), demo: req.staff!.demo };
    const threads = repo.mailThreads({ ...baseOpts, q: q || undefined, unreadOnly, folder, page });
    const counts = repo.mailFolderCounts(baseOpts);
    const backUrl = `/mail?f=${unreadOnly ? "unread" : folder}${q ? `&q=${encodeURIComponent(q)}` : ""}`;
    res.send(mailPage(c(req), { threads, q, folder, unreadOnly, counts, backUrl, page, hasMore: threads.length === Repo.MAIL_PAGE_SIZE }));
  });

  app.get("/mail/thread/:tkey", requireLogin, (req, res) => {
    const tkey = String(req.params.tkey);
    const emails = repo.emailsForThread(tkey);
    if (!emails.length) {
      return res.status(404).send(layout({
        title: "Conversation not found",
        institution: instName(req),
        user: req.staff,
        unread: repo.unreadCount(req.staff!.id, req.staff!.demo, repo.visibleSchoolsFor(req.staff!)),
        csrf: req.csrfToken,
        content: `<div class="card" style="max-width:560px;margin:60px auto;text-align:center">
          <h1>Conversation not found</h1>
          <p class="sub">That conversation does not exist (or has no messages yet).</p>
          <p><a class="btn" href="/mail">← Back to mail</a></p>
        </div>`,
      }));
    }
    const a = emails[0].applicant_id != null ? (repo.getApplicant(emails[0].applicant_id) ?? null) : null;
    if (a) {
      if (!repo.applicantVisibleTo(req.staff!, a)) return refuseScope(req, res, "/mail", "← Back to mail");
    } else if ((req.staff!.demo ?? 0) !== 0) {
      // Parked mail (no applicant) belongs to the live realm — demo accounts never see it.
      return refuseScope(req, res, "/mail", "← Back to mail");
    }
    repo.markThreadRead(tkey);
    const labels = repo.threadLabelState(tkey);
    const backUrl = mailBack(req.query.back, labels.bin ? "/mail?f=bin" : labels.spam ? "/mail?f=spam" : "/mail");
    res.send(mailThreadPage(c(req), { applicant: a, emails, tkey, labels, backUrl }));
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
    const emails = repo.emailsForThread(tkey);
    if (!emails.length) return res.status(404).send("Conversation not found.");
    const a = emails[0].applicant_id != null ? (repo.getApplicant(emails[0].applicant_id) ?? null) : null;
    if (a) {
      if (!repo.applicantVisibleTo(req.staff!, a)) return refuseScope(req, res, "/mail", "← Back to mail");
    } else if ((req.staff!.demo ?? 0) !== 0) {
      // Parked mail (no applicant) belongs to the live realm — demo accounts never see it.
      return refuseScope(req, res, "/mail", "← Back to mail");
    }
    const action = THREAD_ACTIONS[String(req.body.action ?? "")];
    if (!action) return res.redirect(`/mail/thread/${encodeURIComponent(tkey)}`);
    const refBit = a ? ` (${a.ref_number})` : " (no case)";
    if ("unread" in action) {
      repo.markThreadUnread(tkey);
      repo.audit(a?.id ?? null, req.staff!.username, "mail_marked_unread", a?.ref_number ?? "no case");
      return res.redirect(mailBack(req.body.back, "/mail"));
    }
    repo.setThreadLabel(tkey, action.label, action.on);
    repo.audit(a?.id ?? null, req.staff!.username, "mail_label", `${action.label} ${action.on ? "added" : "removed"}${refBit}`);
    res.redirect(mailBack(req.body.back, `/mail/thread/${encodeURIComponent(tkey)}`));
  });

  // ── New-window composer ────────────────────────────────────────────────────
  // A standalone compose window: pick the recipient (scoped search), load a
  // template if wanted, edit, send. Same rules as every other send path —
  // scoping enforced on BOTH the open and the send, pack/banner come from the
  // chosen template, attachments recorded on the case history.
  const refuseScope = (req: Request, res: Response, backHref = "/compose", backLabel = "← Back to the composer"): void => {
    res.status(403).send(layout({
      title: "Outside your schools",
      institution: instName(req),
      user: req.staff,
      unread: repo.unreadCount(req.staff!.id, req.staff!.demo, repo.visibleSchoolsFor(req.staff!)),
      csrf: req.csrfToken,
      content: `<div class="card" style="max-width:560px;margin:60px auto;text-align:center">
        <h1>This case is outside your assigned schools</h1>
        <p class="sub">You can only reach cases that belong to a school you handle. If this should be yours, ask an administrator to update your visibility scope.</p>
        <p><a class="btn" href="${backHref}">${backLabel}</a></p>
      </div>`,
    }));
  };
  /** Case id from the composer (query or body) — visibility-checked. */
  const composeCase = (req: Request, raw: unknown): ApplicantRow | null | "refused" => {
    const id = Number(raw);
    if (!Number.isFinite(id)) return null;
    const a = repo.getApplicant(id);
    if (!a || !repo.applicantVisibleTo(req.staff!, a)) return "refused";
    return a;
  };

  app.get("/compose", requireLogin, (req, res) => {
    const caseId = req.query.case ? String(req.query.case) : "";
    const templateKey = req.query.template ? String(req.query.template) : undefined;
    if (caseId) {
      const a = composeCase(req, caseId);
      if (a === "refused") return refuseScope(req, res);
      if (a) {
        const tpl = templateKey ? repo.getTemplate(templateKey, organizationId(req)) : undefined;
        const rendered = tpl ? renderFor(a, tpl.subject, tpl.body) : undefined;
        return res.send(composeWindowPage(c(req), {
          applicant: a, templateKey: tpl?.key,
          subject: rendered?.subject, body: rendered?.body,
        }));
      }
    }
    const scope = repo.visibleSchoolsFor(req.staff!);
    const q = req.query.q !== undefined ? String(req.query.q).trim() : undefined;
    const matches = repo.searchApplicants({
      q: q || undefined, demo: req.staff!.demo, schools: scope, limit: 8,
    });
    res.send(composeWindowPage(c(req), { matches, q, templateKey }));
  });

  app.post("/compose", requireLogin, csrfCheck, async (req, res) => {
    const a = composeCase(req, req.body.case);
    if (a === "refused") return refuseScope(req, res);
    if (!a) return res.redirect("/compose");
    // Template choice happens via GET (chips re-render the draft); the POST
    // has exactly one job: send. The template only decides pack + banner.
    const tplKey = String(req.body.template ?? "");
    const tpl = tplKey ? repo.getTemplate(tplKey, organizationId(req)) : undefined;

    const subject = String(req.body.subject ?? "").trim();
    const body = String(req.body.body ?? "").trim();
    if (!subject || !body) {
      return res.send(composeWindowPage(c(req), {
        applicant: a, templateKey: tpl?.key, subject, body,
        error: "Both a subject and a message are needed before this can be sent.",
      }));
    }
    const pack = packForTemplate(tpl?.attach_pack, a.id, req.staff!.username);
    try {
      await sendOrgMail(a, subject, body, {
        banner: tpl && tpl.include_banner === 0 ? null : emailBanner(repo, organizationId(req)),
        attachments: pack ? pack.files : [],
      });
    } catch (e) {
      repo.audit(a.id, req.staff!.username, "send_failed", (e as Error).message);
      return res.send(composeWindowPage(c(req), {
        applicant: a, templateKey: tpl?.key, subject, body,
        error: `Send failed: ${(e as Error).message}`,
      }));
    }
    repo.insertEmail({
      applicant_id: a.id, message_id: `composewin-${Date.now()}`, thread_id: a.thread_id, direction: "out",
      from_addr: "", to_addr: a.email_address, subject, body, category: null, auto: 0,
      at: new Date().toISOString(),
      attachments: pack ? pack.files.map((f) => f.filename) : [],
    });
    staffAction(req, a.id, "email_sent_manual", `new-window compose${tpl ? ` (${tpl.key})` : ""}: "${subject}"${pack ? ` (+${pack.label} pack, ${pack.files.length} file(s))` : ""}`);
    res.redirect(backToCase(a.id, `Reply sent to ${a.email_address}${pack ? ` with the ${pack.label} pack attached` : ""}.`));
  });

  app.get("/case/:id/compose", requireLogin, (req, res) => {
    const a = repo.getApplicant(Number(req.params.id));
    if (!a) return res.status(404).send("Case not found.");
    const tpl = repo.getTemplate(String(req.query.template ?? ""), organizationId(req));
    if (!tpl) return res.redirect(backToCase(a.id, "Unknown template."));
    const rendered = renderFor(a, tpl.subject, tpl.body);
    res.send(composePage(c(req), a, tpl, rendered));
  });

  app.post("/case/:id/compose", requireLogin, csrfCheck, async (req, res) => {
    const a = repo.getApplicant(Number(req.params.id));
    if (!a) return res.status(404).send("Case not found.");
    const tplKey = String(req.body.template ?? "");
    const tpl = repo.getTemplate(tplKey, organizationId(req));
    if (!tpl) return res.redirect(backToCase(a.id, "Unknown template."));
    const subject = String(req.body.subject ?? "").trim();
    const body = String(req.body.body ?? "").trim();
    if (!subject || !body) {
      const rendered = renderFor(a, subject || tpl.subject, body || tpl.body);
      return res.send(composePage(c(req), a, tpl, rendered, "Both a subject and a body are needed before this can be sent."));
    }
    const pack = packForTemplate(tpl.attach_pack, a.id, req.staff!.username);
    try {
      await sendOrgMail(a, subject, body, {
        banner: tpl.include_banner === 0 ? null : emailBanner(repo, organizationId(req)),
        attachments: pack ? pack.files : [],
      });
    } catch (e) {
      repo.audit(a.id, req.staff!.username, "send_failed", (e as Error).message);
      return res.redirect(backToCase(a.id, `Send failed: ${(e as Error).message}`));
    }
    repo.insertEmail({
      applicant_id: a.id, message_id: `compose-${Date.now()}`, thread_id: a.thread_id, direction: "out",
      from_addr: "", to_addr: a.email_address, subject, body, category: null, auto: 0, at: new Date().toISOString(),
      attachments: pack ? pack.files.map((f) => f.filename) : [],
    });
    staffAction(req, a.id, "email_sent_manual", `composed reply (${tpl.key}): "${subject}"${pack ? ` (+${pack.label} pack)` : ""}`);
    res.redirect(backToCase(a.id, `Reply sent to ${a.email_address}${pack ? ` with the ${pack.label} pack attached` : ""}.`));
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
      return res.redirect(backToCase(id, `Priority set to ${p}.`));
    }
    res.redirect(backToCase(id, "Unknown priority — nothing changed."));
  });

  /**
   * Re-categorise the latest incoming email after review (managers/admins).
   * Audit-logged; the next sync routes its documents with the new category.
   */
  app.post("/case/:id/category", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
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

  /**
   * Human review resolution (round 18): a person decides a case the automated
   * path could not — special consideration, an approved exception, an
   * alternative qualification, or a decline. Recorded as a HUMAN decision,
   * always separately from anything automated.
   */
  app.post("/case/:id/admission-decision", requireLogin, requirePermission("record_outcome"), csrfCheck, (req, res) => {
    const id = Number(req.params.id);
    const a = repo.getApplicant(id);
    if (!a || !sameRealm(req, a)) return res.status(404).send("Case not found.");
    // PPR P0-2: outcome vocabulary and the decision form exist only for
    // education-module cases. Non-academic cases have no admission decision.
    if (!repo.educationCaseFor(a)) {
      return res.redirect(backToCase(id, "This case type has no admission decision — outcomes are recorded through its own workflow."));
    }
    const decision = String(req.body.decision ?? "");
    const reason = String(req.body.reason ?? "").trim();
    if (decision !== "admit" && decision !== "decline") {
      return res.redirect(backToCase(id, "Choose admit or decline — nothing was recorded."));
    }
    if (!reason) {
      return res.redirect(backToCase(id, "A reason is required for every human admission decision — it goes on the audit trail."));
    }
    const ROUTES: Record<string, string> = {
      alternative_qualification: "Alternative qualification",
      approved_exception: "Approved exception",
      special_consideration: "Special consideration",
      documented_pathway: "Documented pathway",
      standard_review: "Standard review",
    };
    const route = decision === "admit" ? (ROUTES[String(req.body.route ?? "")] ?? "Standard review") : "Standard review";
    const outcome = decision === "admit" ? "admitted_after_review" : "not_admitted";
    repo.updateApplicant(id, {
      admission_decision: outcome,
      admission_route: "human",
      decision_by: req.staff!.username,
      decision_reason: `${route}: ${reason}`,
      decision_at: new Date().toISOString(),
    });
    // The file is closed either way; the decision field says HOW it closed.
    repo.setLifecycle(id, "completed", req.staff!.username,
      decision === "admit" ? `admitted after human review (${route})` : "not admitted after human review");
    repo.audit(id, req.staff!.username, "human_admission_decision",
      `${decision === "admit" ? "Admitted after Human Review" : "Not Admitted after Human Review"} · reviewer: ${req.staff!.display_name} · ${route} · reason: ${reason}`);
    repo.notify("review_needed", `${a.ref_number}: ${decision === "admit" ? "admitted" : "not admitted"} after human review by ${req.staff!.display_name}`, id);
    res.redirect(backToCase(id, decision === "admit"
      ? `Recorded: Admitted after Human Review (${route}).`
      : "Recorded: Not Admitted after Human Review."));
  });

  /** Re-run the admissions evaluation on demand (new documents arrived etc.).
   *  PPR P0-3: every re-evaluation states WHICH configuration version it
   *  re-applied (the case's frozen version). Upgrading an open case to the
   *  profile's CURRENT version is only possible by explicit request
   *  (`reapply=current`) and is audited as a human decision. */
  app.post("/case/:id/reevaluate", requireLogin, csrfCheck, (req, res) => {
    const id = Number(req.params.id);
    const a = repo.getApplicant(id);
    if (!a || !sameRealm(req, a)) return res.status(404).send("Case not found.");
    let versionNote = "";
    if (String(req.body.reapply ?? "") === "current") {
      const upgraded = repo.reFreezeCaseConfig(a);
      repo.audit(id, req.staff!.username, "config_version_upgraded", `case explicitly re-applied on CURRENT profile configuration version ${upgraded.config_version} by staff request`);
      versionNote = ` — explicitly re-applied on CURRENT configuration version ${upgraded.config_version}`;
    }
    const frozen = repo.caseConfigFrozen(repo.getApplicant(id)!);
    const version = frozen?.config_version ?? repo.getApplicant(id)!.config_version_frozen ?? 1;
    if (!repo.educationCaseFor(a)) {
      // Generic profile: re-run the configured rule tree from the FROZEN
      // rules — outcome stays undecided, human review always.
      const caseType = repo.caseTypeForCase(id);
      const facts: Record<string, unknown> = {};
      for (const doc of repo.listDocuments(id, { activeOnly: true })) Object.assign(facts, doc.extracted_fields ?? {});
      const rules = frozen?.rules ?? (caseType ? repo.caseTypeRules(caseType) : []);
      const result = caseType ? evaluateCaseTypeRules(repo, caseType, rules, facts) : { result: "undetermined" as const, routing: "human_review" as const };
      repo.audit(id, req.staff!.username, "evaluation_rerun", `re-applied frozen configuration version ${version} → rules ${result.result}; outcome remains undecided`);
      return res.redirect(backToCase(id, `Evaluation re-run under configuration version ${version} (the version this case was opened under): rules ${String(result.result).replace(/_/g, " ")} — outcome remains undecided${versionNote}`));
    }
    const flags = repo.activeFlags(id).filter((f) => f.type !== "duplicate_submission");
    const result = evaluateAdmission(repo, id, flags);
    repo.syncFlags(id, [...flags, ...result.derivedFlags]);
    repo.audit(id, req.staff!.username, "evaluation_rerun", `re-applied frozen configuration version ${version} → ${result.report.result}/${result.report.routing}`);
    res.redirect(backToCase(id, `Evaluation re-run under configuration version ${version} (the version this case was opened under): ${result.report.result.replace(/_/g, " ")} → ${result.report.routing.replace(/_/g, " ")}.${versionNote}`));
  });

  /**
   * Round 19: after a rule change, re-run the evaluation across every OPEN
   * case in one click instead of opening them one by one. Cases keep the
   * requirement set they were frozen under — this simply re-applies it.
   */
  app.post("/config/reevaluate-open", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const back = (m: string) => `/config?msg=${encodeURIComponent(m)}#rules`;
    let done = 0;
    let failed = 0;
    for (const id of repo.openApplicantIds()) {
      const a = repo.getApplicant(id);
      if (!a || !sameRealm(req, a)) continue;
      try {
        const flags = repo.activeFlags(id).filter((f) => f.type !== "duplicate_submission");
        const result = evaluateAdmission(repo, id, flags);
        repo.syncFlags(id, [...flags, ...result.derivedFlags]);
        repo.audit(id, req.staff!.username, "evaluation_rerun", `bulk re-evaluation → ${result.report.result}/${result.report.routing}`);
        done++;
      } catch (e) {
        // One pathological case must not abort the whole batch.
        failed++;
        repo.audit(id, req.staff!.username, "evaluation_rerun_failed", (e as Error).message.slice(0, 200));
      }
    }
    repo.audit(null, req.staff!.username, "bulk_reevaluation", `${done} open case(s) re-evaluated${failed ? `, ${failed} failed` : ""}`);
    res.redirect(back(
      `Re-evaluated ${done} open case(s) against their frozen rule sets.${failed ? ` ${failed} case(s) failed — see their audit trails.` : ""}`
    ));
  });

  // Dead-letter queue: retry puts a parked message back in front of the next
  // sync; drop removes it for good (the sender will have to email again).
  app.post("/config/dead-letter/retry", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const back = (m: string) => `/config?tab=requirements&msg=${encodeURIComponent(m)}#deadletters`;
    const d = repo.getDeadLetter(Number(req.body.id ?? 0));
    if (!d) return res.redirect(back("That parked message no longer exists."));
    repo.resetDeadLetter(d.id);
    repo.unmarkProcessed(d.message_id);
    repo.audit(null, req.staff!.username, "dead_letter_retry", `message ${d.message_id} ("${d.subject}") re-queued for ingestion`);
    res.redirect(back(`"${d.subject || d.message_id}" will be retried on the next sync.`));
  });

  app.post("/config/dead-letter/delete", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const back = (m: string) => `/config?tab=requirements&msg=${encodeURIComponent(m)}#deadletters`;
    const d = repo.getDeadLetter(Number(req.body.id ?? 0));
    if (!d) return res.redirect(back("That parked message no longer exists."));
    repo.removeDeadLetter(d.id);
    repo.audit(null, req.staff!.username, "dead_letter_dropped", `message ${d.message_id} ("${d.subject}") dropped by staff`);
    res.redirect(back(`"${d.subject || d.message_id}" was dropped.`));
  });

  // ── Team performance (staff listener) ────────────────────────────────────

  app.get("/team", requireLogin, (_req, res) => res.redirect("/staff"));

  // ── Notifications ────────────────────────────────────────────────────────

  app.get("/notifications", requireLogin, (req, res) => {
    // Alerts now live on the Overview page; opening the old link still clears them.
    repo.markNotificationsRead(req.staff!.id);
    res.redirect("/#alerts");
  });

  app.post("/notifications/read-all", requireLogin, csrfCheck, (req, res) => {
    repo.markNotificationsRead(req.staff!.id);
    res.redirect("/#alerts");
  });

  // ── Account (self-service, every signed-in user) ─────────────────────────

  app.get("/account", requireLogin, (req, res) =>
    res.send(accountPage(c(req), req.query.msg ? String(req.query.msg) : undefined))
  );

  const accountMsg = (m: string) => `/account?msg=${encodeURIComponent(m)}`;

  app.post("/account/username", requireLogin, csrfCheck, (req, res) => {
    const next = String(req.body.username ?? "").trim();
    if (next.length < 3) return res.redirect(accountMsg("Usernames need at least 3 characters."));
    const clash = repo.getStaffByUsername(next);
    if (clash && clash.id !== req.staff!.id) return res.redirect(accountMsg(`“${next}” is already taken by another account.`));
    repo.setStaffUsername(req.staff!.id, next);
    repo.audit(null, next, "account_username_changed", `was “${req.staff!.username}”`);
    res.redirect(accountMsg("Username updated."));
  });

  app.post("/account/password", requireLogin, csrfCheck, (req, res) => {
    const me = repo.getStaffByUsername(req.staff!.username);
    if (!me) return res.redirect(accountMsg("Account not found."));
    const current = String(req.body.current ?? "");
    const next = String(req.body.next ?? "");
    const confirm = String(req.body.confirm ?? "");
    if (!verifyPassword(current, me.password_hash)) return res.redirect(accountMsg("Your current password was incorrect."));
    if (next.length < 8) return res.redirect(accountMsg("New password must be at least 8 characters."));
    if (next !== confirm) return res.redirect(accountMsg("New passwords did not match."));
    repo.setStaffPassword(me.id, hashPassword(next));
    repo.audit(null, me.username, "account_password_changed", "self-service password change");
    res.redirect(accountMsg("Password changed."));
  });

  app.post("/account/theme", requireLogin, csrfCheck, (req, res) => {
    const t = req.body.theme === "dark" ? "dark" : "light";
    res.setHeader("Set-Cookie", `theme=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${365 * 86400}`);
    res.redirect(accountMsg(`Theme set to ${t} mode.`));
  });

  // ── Settings (manager+) ──────────────────────────────────────────────────

  // 'it' role: cases + configuration, but not staff management.
  app.get("/settings", requireLogin, requireRole("admin"), (req, res) =>
    res.send(settingsPage(c(req), req.query.msg ? String(req.query.msg) : undefined, gmailRedirectUri(repo, req.protocol, req.get("host") ?? "localhost")))
  );

  // Configuration: requirements, replies, Gmail, intakes, templates, exports.
  // Case configuration moved to the STAFF area (round 3) — one home for
  // it; the old tab redirects so bookmarks keep working.
  app.get("/config", requireLogin, requireRole("admin"), (req, res) => {
    if (req.query.tab === "courses") return res.redirect("/staff");
    if (req.query.tab === "requirements" && (req.staff!.organization_id ?? 1) !== 1) return res.redirect("/config?tab=case-types");
    return res.send(
      configPage(
        c(req),
        req.query.template ? String(req.query.template) : undefined,
        req.query.msg ? String(req.query.msg) : undefined,
        req.query.reqs ? String(req.query.reqs) : undefined,
        req.query.tab ? String(req.query.tab) : undefined,
        req.query.system ? String(req.query.system) : undefined,
        req.query.organization ? Number(req.query.organization) : undefined,
        req.query.edit ? Number(req.query.edit) : undefined
      ));
  });

  // Generic CaseType administration. These routes are organization-scoped;
  // no academic catalogue or global settings are touched.
  app.post("/config/organizations/create", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const name = String(req.body.name ?? "").trim();
    const refPrefix = String(req.body.ref_prefix ?? "").trim().toUpperCase();
    if (!name || !/^[A-Z]{1,8}$/.test(refPrefix)) return res.redirect(`/config?tab=case-types&msg=${encodeURIComponent("Organization name and a 1–8 letter reference prefix are required.")}`);
    try {
      const organization = repo.createOrganization({ name, refPrefix });
      repo.audit(null, req.staff!.username, "organization_created", `${organization.name} (${organization.ref_prefix})`);
      return res.redirect(`/config?tab=case-types&organization=${organization.id}&msg=${encodeURIComponent(`Organization ${organization.name} created with an empty CaseType catalogue.`)}`);
    } catch (e) {
      return res.redirect(`/config?tab=case-types&msg=${encodeURIComponent(`Organization was not created: ${(e as Error).message}`)}`);
    }
  });

  // PPR P0-4: workflow rules — first-email and response behaviour as data.
  const parseRuleConditions = (body: Record<string, unknown>): RuleCondition[] => {
    const raw = String(body.conditions_json ?? "").trim();
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error("conditions JSON must be an array");
      return parsed as RuleCondition[];
    }
    const out: RuleCondition[] = [];
    for (let i = 0; i < 3; i++) {
      const field = String((body as Record<string, string>)[`cond_field_${i}`] ?? "").trim();
      const value = String((body as Record<string, string>)[`cond_value_${i}`] ?? "").trim();
      if (!field) continue;
      if (field === "always") out.push({ field: "always", value: true });
      else if (field === "sender_state") out.push({ field: "sender_state", value: value.toLowerCase() === "known" ? "known" : "unknown" });
      else if (field === "has_attachments") out.push({ field: "has_attachments", value: ["yes", "true", "1"].includes(value.toLowerCase()) });
      else if (field === "body_is_ref") out.push({ field: "body_is_ref", value: true });
      else if (field === "signals") out.push({ field: "signals", value: "education_intake" });
      else if (field === "category") out.push({ field: "category", op: "in", values: value.split(",").map((s) => s.trim()).filter(Boolean) });
      else if (field === "docs_state") {
        const values = value.split(",").map((s) => s.trim()).filter(Boolean);
        out.push({ field: "docs_state", values: (values.length ? values : ["any"]) as never });
      } else if (field === "text" || field === "subject" || field === "body") {
        out.push({ field, op: "contains_any", values: value.split(",").map((s) => s.trim()).filter(Boolean) });
      } else throw new Error(`unknown condition field '${field}'`);
    }
    return out;
  };
  const parseRuleAction = (body: Record<string, unknown>): RuleAction => {
    const b = body as Record<string, string>;
    const map = {
      green: b.map_green?.trim() || undefined,
      empty: b.map_empty?.trim() || undefined,
      missing: b.map_missing?.trim() || undefined,
    };
    const hasMap = Boolean(map.green || map.empty || map.missing);
    return {
      decision: (b.decision as RuleAction["decision"]) || undefined,
      stage: b.stage?.trim() || undefined,
      queue: b.queue?.trim() || undefined,
      priority: b.priority === "high" ? "high" : undefined,
      assign: b.assign ? Number(b.assign) : undefined,
      reply_action: (b.reply_action as RuleAction["reply_action"]) || undefined,
      template_key: b.template_key?.trim() || null,
      template_map: hasMap ? map : null,
      attachment_set: b.attachment_set?.trim() || null,
      request_info: Boolean(b.request_info),
      sla_hours: b.sla_hours ? Number(b.sla_hours) : null,
      followup: b.followup === "ladder" ? "ladder" : "none",
      followup_action: (b.followup_action as RuleAction["followup_action"]) || undefined,
      audit_code: b.audit_code?.trim() || undefined,
      fallback: b.fallback === "none" ? "none" : "human_draft",
    };
  };

  app.post("/config/workflow-rules/save", requireLogin, requirePermission("publish_rules"), csrfCheck, (req, res) => {
    try {
      const name = String(req.body.name ?? "").trim();
      const kind = String(req.body.kind) === "response" ? "response" : "intake";
      const caseTypeId = req.body.case_type_id ? Number(req.body.case_type_id) : null;
      // A rule lives in its profile's organization; legacy-scope rules live in
      // the staff member's organization.
      const orgId = (caseTypeId ? repo.caseTypeById(caseTypeId)?.organization_id : undefined) ?? req.staff!.organization_id ?? 1;
      const conditions = parseRuleConditions(req.body);
      const action = parseRuleAction(req.body);
      const saved = repo.saveWorkflowRule({
        id: req.body.id ? Number(req.body.id) : undefined,
        organizationId: orgId,
        caseTypeId,
        kind,
        name,
        position: req.body.position !== "" && req.body.position !== undefined ? Number(req.body.position) : undefined,
        enabled: true,
        conditions,
        action,
      });
      repo.audit(null, req.staff!.username, "workflow_rule_saved", `${saved.name} (#${saved.id}, ${kind})`);
      return res.redirect(`/config?tab=rules&msg=${encodeURIComponent(`Rule “${saved.name}” saved and enabled.`)}`);
    } catch (e) {
      return res.redirect(`/config?tab=rules&msg=${encodeURIComponent(`Rule was not saved: ${(e as Error).message}`)}`);
    }
  });

  // PPR P1-7: preview a sample email against the rule AS DRAFTED (form fields,
  // published or not) before anyone presses save. Nothing is written — the
  // response describes what would fire and who would win the order.
  app.post("/config/workflow-rules/preview", requireLogin, requirePermission("publish_rules"), csrfCheck, (req, res) => {
    try {
      const body = req.body as Record<string, string>;
      const name = String(body.name ?? "").trim() || "(unsaved rule)";
      const kind = String(body.kind) === "response" ? "response" : "intake";
      const caseTypeId = body.case_type_id ? Number(body.case_type_id) : null;
      const orgId = (caseTypeId ? repo.caseTypeById(caseTypeId)?.organization_id : undefined) ?? req.staff!.organization_id ?? 1;
      const proposed: WorkflowRule = {
        id: 0,
        organization_id: orgId,
        case_type_id: caseTypeId,
        kind,
        name,
        position: body.position !== "" && body.position !== undefined ? Number(body.position) : 9999,
        enabled: 1,
        conditions: parseRuleConditions(body),
        action: parseRuleAction(body),
      };
      // The sample message, as an applicant would send it.
      const sampleSubject = String(body.sample_subject ?? "").slice(0, 500);
      const sampleBody = String(body.sample_body ?? "").slice(0, 4000);
      const sampleFrom = String(body.sample_from ?? "").slice(0, 200);
      const docsState = (["complete", "empty", "missing", "dirty"] as const).includes(body.sample_docs_state as never)
        ? body.sample_docs_state as "complete" | "empty" | "missing" | "dirty"
        : "missing";
      const input = {
        senderState: body.sample_sender_state === "known" ? "known" as const : "unknown" as const,
        subject: sampleSubject,
        body: sampleBody,
        hasAttachments: body.sample_attachments === "1",
        category: categorizeEmail(sampleSubject, sampleBody, body.sample_attachments === "1"),
        bodyIsRef: /^[A-Z]{1,6}-\d{4}-\d{1,8}$/i.test(sampleBody.trim()),
        educationSignals: "open" as const,
        docsState,
        docsOnFile: docsState === "empty" ? 0 : 3,
      };
      // Who else is in the running: the scope's published rules plus this one.
      const scopeRules = rulesForCaseScope(
        repo.listWorkflowRules(orgId, { kind }), caseTypeId, caseTypeId === null,
      );
      const ordered = [...scopeRules, proposed].sort((a, b) => a.position - b.position || a.id - b.id);
      const winner = firstMatchingRule(ordered, input);
      const proposedMatches = ruleMatches(proposed, input);
      const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]!));
      let verdict: string;
      if (winner && winner.id === 0 && proposedMatches) {
        verdict = `<b>MATCH</b> — this rule would fire for that message: ${esc(describeRule(proposed))}`;
      } else if (winner && proposedMatches) {
        verdict = `<b>MATCH, but an earlier rule wins</b> — “${esc(winner.name)}” fires first (${esc(describeRule(winner))}). Raise this rule's position to take over.`;
      } else if (winner) {
        verdict = `<b>NO MATCH</b> — this rule would not fire; “${esc(winner.name)}” would handle the message instead (${esc(describeRule(winner))}).`;
      } else {
        verdict = `<b>NO MATCH</b> — no rule in this scope would fire; the message routes to human review (nothing is ever dropped).`;
      }
      const details = `<div class="small muted" style="margin-top:6px">Sample from ${esc(sampleFrom || "(no sender)")}: category <span class="mono">${esc(input.category)}</span> · docs ${docsState} · sender ${input.senderState} · ${scopeRules.length} published rule(s) in scope.</div>`;
      res.type("html").send(`<div class="small">${verdict}</div>${details}`);
    } catch (e) {
      res.status(400).type("html").send(`<div class="small">Preview failed: ${String((e as Error).message).replace(/[&<>"]/g, "")}</div>`);
    }
  });

  app.post("/config/workflow-rules/delete", requireLogin, requirePermission("publish_rules"), csrfCheck, (req, res) => {
    repo.deleteWorkflowRule(Number(req.body.id), req.staff!.organization_id ?? 1);
    repo.audit(null, req.staff!.username, "workflow_rule_deleted", `rule #${Number(req.body.id)}`);
    res.redirect("/config?tab=rules");
  });

  app.post("/config/workflow-rules/toggle", requireLogin, requirePermission("publish_rules"), csrfCheck, (req, res) => {
    const id = Number(req.body.id);
    const rule = repo.getWorkflowRule(id);
    if (rule) {
      repo.saveWorkflowRule({
        id,
        organizationId: rule.organization_id,
        caseTypeId: rule.case_type_id,
        kind: rule.kind,
        name: rule.name,
        position: rule.position,
        enabled: rule.enabled !== 1,
        conditions: rule.conditions,
        action: rule.action,
      });
      repo.audit(null, req.staff!.username, "workflow_rule_toggled", `${rule.name} (#${id}) → ${rule.enabled !== 1 ? "on" : "off"}`);
    }
    res.redirect("/config?tab=rules");
  });

  app.post("/config/case-types/vocabulary", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const id = Number(req.body.id);
    const ct = repo.listCaseTypes(req.staff!.organization_id ?? 1).find((x) => x.id === id)
      ?? repo.caseTypeById(id);
    if (!ct) return res.redirect(`/config?tab=rules&msg=${encodeURIComponent("Unknown profile.")}`);
    const parseIdLabels = (text: string): Array<{ id: string; label: string; requires?: string[] }> =>
      String(text ?? "").split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
        const [rawId, rawLabel, rawRequires] = line.split("|");
        const id = rawId.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
        const label = (rawLabel ?? rawId).trim();
        // P1-4: a stage line may declare required information — "stage|label|
        // item1, item2" (document keys or free-text info the file must hold).
        const requires = rawRequires ? rawRequires.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
        return requires && requires.length ? { id, label, requires } : { id, label };
      }).filter((x) => x.id);
    const b = req.body as Record<string, string>;
    repo.updateCaseTypeVocabulary(id, {
      terminology: {
        case: b.term_case?.trim() || "Applicant",
        contact: b.term_contact?.trim() || "Contact",
        category: b.term_category?.trim() || "Category",
        stage: b.term_stage?.trim() || "Current level",
        outcome: b.term_outcome?.trim() || "Admission decision",
      },
      stages: parseIdLabels(b.stages_text ?? ""),
      queues: parseIdLabels(b.queues_text ?? ""),
    });
    repo.audit(null, req.staff!.username, "workflow_vocabulary_saved", `${ct.code}: terminology + stages + queues`);
    res.redirect(`/config?tab=rules&msg=${encodeURIComponent(`Vocabulary, stages and queues saved for “${ct.name}”.`)}`);
  });

  app.post("/config/case-types/profile", requireLogin, requirePermission("send_automated"), csrfCheck, (req, res) => {
    const id = Number(req.body.id);
    const ct = repo.listCaseTypes(req.staff!.organization_id ?? 1).find((x) => x.id === id);
    if (!ct) return res.redirect("/config?tab=rules&msg=Unknown+profile");
    repo.updateCaseTypeProfile(id, {
      default_reply_action: String(req.body.default_reply_action) === "auto" ? "auto" : "draft",
      qualification_gate: String(req.body.qualification_gate) === "0" ? 0 : 1,
    });
    repo.audit(null, req.staff!.username, "workflow_profile_saved", `${ct.code}: default_reply_action=${String(req.body.default_reply_action)}, qualification_gate=${String(req.body.qualification_gate)}`);
    res.redirect(`/config?tab=rules&msg=${encodeURIComponent(`Profile “${ct.name}” updated.`)}`);
  });

  app.post("/config/case-types/create", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const organizationId = Number(req.body.organization_id);
    const code = String(req.body.code ?? "").trim();
    const name = String(req.body.name ?? "").trim();
    const category = String(req.body.category ?? "general").trim() || "general";
    if (!repo.getOrganization(organizationId) || !code || !name) return res.redirect(`/config?tab=case-types&msg=${encodeURIComponent("A valid organization, CaseType code and name are required.")}`);
    const ct = repo.createCaseType(organizationId, { code, name, category, config: { rules: [] } });
    repo.audit(null, req.staff!.username, "case_type_created", `${organizationId}:${ct.code}`);
    res.redirect(`/config?tab=case-types&organization=${organizationId}#case-type-${ct.id}`);
  });

  app.post("/config/case-types/document", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const organizationId = Number(req.body.organization_id);
    const caseTypeId = Number(req.body.case_type_id);
    const ct = repo.listCaseTypes(organizationId).find((x) => x.id === caseTypeId);
    const key = String(req.body.key ?? "").trim();
    const label = String(req.body.label ?? "").trim();
    if (!ct || !key || !label) return res.redirect(`/config?tab=case-types&organization=${organizationId}&msg=${encodeURIComponent("Unknown CaseType or incomplete document slot.")}`);
    repo.upsertDocumentDefinition(caseTypeId, { key, label, required: String(req.body.required) !== "0", blocking: String(req.body.blocking) !== "0", position: Number(req.body.position ?? 0) || 0 });
    repo.audit(null, req.staff!.username, "case_type_document_saved", `${ct.code}:${key}`);
    res.redirect(`/config?tab=case-types&organization=${organizationId}#case-type-${caseTypeId}`);
  });

  app.post("/config/case-types/document-delete", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const organizationId = Number(req.body.organization_id);
    const caseTypeId = Number(req.body.case_type_id);
    const ct = repo.listCaseTypes(organizationId).find((x) => x.id === caseTypeId);
    if (ct) repo.deleteDocumentDefinition(caseTypeId, String(req.body.key ?? ""));
    res.redirect(`/config?tab=case-types&organization=${organizationId}#case-type-${caseTypeId}`);
  });

  app.post("/config/case-types/rules", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const organizationId = Number(req.body.organization_id);
    const caseTypeId = Number(req.body.case_type_id);
    const ct = repo.listCaseTypes(organizationId).find((x) => x.id === caseTypeId);
    if (!ct) return res.redirect(`/config?tab=case-types&organization=${organizationId}&msg=${encodeURIComponent("Unknown CaseType — no rules saved.")}`);
    try {
      const parsed: unknown = JSON.parse(String(req.body.rules_json ?? "[]"));
      if (!Array.isArray(parsed) || parsed.length > 100) throw new Error("rule tree must be an array of at most 100 nodes");
      const valid = (n: any): boolean => n && (n.kind === "condition" || n.kind === "group") && (!n.children || (Array.isArray(n.children) && n.children.every(valid))) && (n.kind !== "group" || ["AND", "OR", "NOT"].includes(n.logic ?? "AND"));
      if (!parsed.every(valid)) throw new Error("invalid rule node or group logic");
      repo.updateCaseTypeRules(caseTypeId, parsed as any[]);
      repo.audit(null, req.staff!.username, "case_type_rules_saved", `${ct.code}: ${parsed.length} top-level nodes`);
      return res.redirect(`/config?tab=case-types&organization=${organizationId}#case-type-${caseTypeId}`);
    } catch (e) {
      return res.redirect(`/config?tab=case-types&organization=${organizationId}&msg=${encodeURIComponent(`Rule tree was not saved: ${(e as Error).message}`)}#case-type-${caseTypeId}`);
    }
  });

  app.post("/config/case-types/axes", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const organizationId = Number(req.body.organization_id);
    if (!repo.getOrganization(organizationId)) return res.redirect("/config?tab=case-types&msg=Unknown+organization");
    try {
      const parsed: unknown = JSON.parse(String(req.body.axes_json ?? "[]"));
      if (!Array.isArray(parsed) || parsed.length > 50 || parsed.some((x: any) => !x || typeof x.key !== "string" || typeof x.label !== "string" || !Array.isArray(x.values))) throw new Error("axes must be [{key,label,values:[]}]");
      repo.replaceOrganizationDocumentAxes(organizationId, parsed as Array<{ key: string; label: string; values: string[] }>);
      repo.audit(null, req.staff!.username, "organization_axes_saved", `${organizationId}: ${parsed.length} axes`);
      return res.redirect(`/config?tab=case-types&organization=${organizationId}`);
    } catch (e) {
      return res.redirect(`/config?tab=case-types&organization=${organizationId}&msg=${encodeURIComponent(`Axes were not saved: ${(e as Error).message}`)}`);
    }
  });

  // Assign who handles a course (configured in the staff area).
  app.post("/config/course-owner", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    if ((req.staff!.organization_id ?? 1) !== 1) return res.redirect("/config?tab=case-types&msg=Academic+compatibility+routes+are+Organization+1+only");
    const programme = String(req.body.programme ?? "").trim();
    const ownerRaw = String(req.body.owner ?? "").trim();
    const back = (m: string) => `/staff?msg=${encodeURIComponent(m)}#courses`;
    if (!programme) return res.redirect(back("No course selected."));
    const ownerId = ownerRaw ? Number(ownerRaw) : null;
    if (ownerId !== null && (!Number.isInteger(ownerId) || !repo.getStaff(ownerId))) {
      return res.redirect(back("Unknown staff member."));
    }
    repo.assignProgrammeOwner(programme, ownerId);
    const who = ownerId !== null ? repo.getStaff(ownerId)?.display_name ?? `#${ownerId}` : "nobody (unassigned)";
    repo.audit(null, req.staff!.username, "course_owner_changed", `${programme} → ${who}`);

    // Round 19: an owner change should not leave open, unowned cases behind.
    // Cases a human already picked up are never re-routed automatically.
    let routed = 0;
    if (ownerId !== null) {
      const realm: 0 | 1 = req.staff!.demo ? 1 : 0;
      for (const c of repo.openUnassignedCasesForProgramme(programme, realm)) {
        repo.updateApplicant(c.id, { assigned_to: ownerId });
        repo.audit(c.id, req.staff!.username, "case_routed", `assigned to ${who} — new owner of ${programme}`);
        repo.notify("assignment", `${programme} ownership changed: case ${c.ref_number} routed to you`, c.id, ownerId);
        routed++;
      }
    }
    res.redirect(back(`Case ${programme} now handled by ${who}.${routed ? ` ${routed} open case(s) routed over.` : ""}`));
  });

  // Editable course fields: entry requirements (and name/school) change over
  // time — they are data, not code. New applicants are judged by the rules in
  // force when THEY applied (requirement snapshots); edits affect new cases.
  app.post("/config/programme/edit", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    if ((req.staff!.organization_id ?? 1) !== 1) return res.redirect("/config?tab=case-types&msg=Academic+compatibility+routes+are+Organization+1+only");
    const programme = String(req.body.programme ?? "").trim();
    const back = (m: string) => `/config?msg=${encodeURIComponent(m)}#courses`;
    if (!programme || !repo.programmeByCode(programme)) return res.redirect(back("Unknown course."));
    repo.updateProgramme(programme, {
      name: String(req.body.name ?? ""),
      school: String(req.body.school ?? ""),
      entry_requirements: String(req.body.entry_requirements ?? ""),
    });
    repo.audit(null, req.staff!.username, "programme_updated", `${programme}: catalogue fields edited`);
    res.redirect(back(`Case ${programme} saved.`));
  });

  // Structured entry requirements — one qualification-system block per save.
  // OR-6: the legacy per-system block editor wrote to course_requirements,
  // a table the engine does NOT enforce — editing it would change what staff
  // see without changing what applicants are judged by (display ≠ enforce).
  // It is gone; the structured Requirements tab is the single source. A stale
  // POST gets an explicit refusal, never a silent write.
  app.post("/config/entry-requirements", requireLogin, requireRole("admin"), csrfCheck, (_req, res) => {
    res.redirect("/config?tab=requirements&msg=" + encodeURIComponent("Entry requirements are edited in the Requirements tab — that old form no longer saves anything."));
  });

  // ══ Requirements Configuration (round 18) ════════════════════════════════
  // Machine-evaluable rule trees per (programme × qualification system),
  // edited visually — no code, no raw expressions. Draft → preview → activate.

  // OR-6: grade values are picked from ladders, never typed freehand. This
  // server-side check mirrors exactly what the pickers offer, so the value
  // that gets stored is always one the UI could have displayed.
  const GRADE_FIELDS = new Set(["mean_grade", "subject"]);
  const NUMERIC_FIELDS: Record<string, { int: boolean; min: number; max: number; what: string }> = {
    credits: { int: true, min: 0, max: 99, what: "credit count" },
    principals: { int: true, min: 0, max: 9, what: "principal-pass count" },
    subsidiaries: { int: true, min: 0, max: 9, what: "subsidiary-pass count" },
    points: { int: true, min: 0, max: 45, what: "point total" },
    gpa: { int: false, min: 0, max: 4, what: "GPA" },
  };
  const CLASS_LADDERS: Record<string, string[]> = {
    degree: ["Pass", "Second Class Honours (Lower Division)", "Second Class Honours (Upper Division)", "First Class Honours"],
    diploma: ["Pass", "Credit", "Distinction"],
  };
  const validConditionValue = (
    system: AdmissionSystem,
    level: LegacyAcademicLevel,
    field: string | undefined,
    v: string
  ): { ok: true } | { ok: false; msg: string } => {
    if (!field) return { ok: true };
    if (field === "class") {
      const ladder = CLASS_LADDERS[level === "diploma" || level === "certificate" ? "diploma" : "degree"];
      return ladder.includes(v) ? { ok: true } : { ok: false, msg: `"${v}" is not a degree class on the ${level} ladder — pick one from the list.` };
    }
    if (GRADE_FIELDS.has(field)) {
      const ladder = EXAM_SYSTEMS.find((m) => m.system === system)?.gradeOptions ?? null;
      if (!ladder) return { ok: true }; // system has no grade ladder (e.g. DEGREE) — class/numbers apply
      return ladder.includes(v) ? { ok: true } : { ok: false, msg: `"${v}" is not a ${system} grade — pick one from the ladder.` };
    }
    const num = NUMERIC_FIELDS[field];
    if (num) {
      const n = Number(v);
      if (!Number.isFinite(n) || (num.int && !Number.isInteger(n)) || n < num.min || n > num.max) {
        return { ok: false, msg: `The ${num.what} must be ${num.int ? "a whole number" : "a number"} between ${num.min} and ${num.max}.` };
      }
      return { ok: true };
    }
    return { ok: true };
  };

  /** Parse a `reqs` target ("BASE:degree" | programme code) + system. */
  const reqsTarget = (req: Request): { programme: string | null; level: LegacyAcademicLevel; system: AdmissionSystem; back: (m: string) => string } | null => {
    const target = String(req.body.target ?? req.query.target ?? "").trim();
    const system = String(req.body.system ?? req.query.system ?? "").trim() as AdmissionSystem;
    const isBase = target.startsWith("BASE:");
    const level = (isBase ? target.slice(5) : repo.programmeByCode(target)?.level ?? "degree") as LegacyAcademicLevel;
    const programme = isBase ? null : target.toUpperCase();
    const back = (m: string) =>
      `/config?tab=requirements&msg=${encodeURIComponent(m)}&reqs=${encodeURIComponent(target)}&system=${encodeURIComponent(system)}#reqbuilder`;
    if (!ADMISSION_SYSTEMS.includes(system)) return null;
    // OR-6: Master's and PhD are separate levels. A stale "postgrad" form
    // repost is normalised to masters instead of being dropped silently.
    const normalized: LegacyAcademicLevel = (level === ("postgrad" as LegacyAcademicLevel) ? "masters" : level) as LegacyAcademicLevel;
    if (!["degree", "diploma", "certificate", "masters", "phd"].includes(normalized)) return null;
    if (!isBase && !repo.programmeByCode(programme!)) return null;
    return { programme, level: normalized, system, back };
  };

  app.post("/config/requirements/node-add", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const t = reqsTarget(req);
    if (!t) return res.redirect("/config?tab=requirements");
    const set = repo.ensureDraftSet(t.programme, t.level, t.system, req.staff!.username);
    const kind = String(req.body.kind) === "group" ? "group" : "condition";
    const parentId = req.body.parent ? Number(req.body.parent) : null;
    repo.addRuleNode(set.id, parentId && parentId > 0 ? parentId : null, kind, "AND");
    repo.audit(null, req.staff!.username, "requirements_draft_changed", `${t.programme ?? "base"} ${t.system}: ${kind} added (draft v${set.version})`);
    res.redirect(t.back(kind === "group" ? "Group added — set its AND/OR/NOT and conditions." : "Condition added — pick the field and minimum."));
  });

  app.post("/config/requirements/node-save", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const t = reqsTarget(req);
    if (!t) return res.redirect("/config?tab=requirements");
    const nodeId = Number(req.body.node);
    const logicRaw = String(req.body.logic ?? "");
    const patch: Parameters<Repo["updateRuleNode"]>[1] = {};
    if (["AND", "OR", "NOT"].includes(logicRaw)) patch.logic = logicRaw as "AND" | "OR" | "NOT";
    if (typeof req.body.field === "string" && req.body.field) patch.field = req.body.field as RuleField;
    if (typeof req.body.subject === "string") patch.subject = req.body.subject.trim() || null;
    if (typeof req.body.value === "string") {
      const v = req.body.value.trim();
      // OR-6: values must come from the picker ladders the UI offers — a
      // hand-typed grade outside the ladder would display one thing and
      // enforce another. Reject loudly instead of storing junk.
      const field = (typeof req.body.field === "string" && req.body.field ? req.body.field : undefined) ?? undefined;
      if (v) {
        const verdict = validConditionValue(t.system, t.level, field, v);
        if (!verdict.ok) return res.redirect(t.back(verdict.msg));
      }
      patch.value = v || null;
    }
    if (Object.keys(patch).length === 0) return res.redirect(t.back("Nothing to save."));
    // The node id comes from the form body — verify it belongs to THIS
    // target's DRAFT set before writing. Without this, a tampered or stale
    // `node=` reached ACTIVE and other courses' published rule sets, bypass-
    // ing the draft → activate versioning flow.
    if (!repo.updateRuleNodeIfDraft(nodeId, t.programme, t.level, t.system, patch)) {
      return res.redirect(t.back("That rule does not belong to this course's draft — nothing was changed."));
    }
    res.redirect(t.back("Rule updated in the draft — preview it, then activate."));
  });

  app.post("/config/requirements/node-delete", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const t = reqsTarget(req);
    if (!t) return res.redirect("/config?tab=requirements");
    const nodeId = Number(req.body.node);
    // Same ownership check as node-save: the body's node id may be stale or
    // hostile — only the target's own DRAFT set is deletable.
    if (!repo.deleteRuleNodeIfDraft(nodeId, t.programme, t.level, t.system)) {
      return res.redirect(t.back("That rule does not belong to this course's draft — nothing was changed."));
    }
    res.redirect(t.back("Rule removed from the draft."));
  });

  app.post("/config/requirements/activate", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const t = reqsTarget(req);
    if (!t) return res.redirect("/config?tab=requirements");
    const draft = repo.getDraftSet(t.programme, t.level, t.system);
    if (!draft) return res.redirect(t.back("No draft to activate."));
    if ((repo.getRuleSetNodes(draft.id)).length === 0) {
      return res.redirect(t.back("The draft has no rules — add at least one condition before activating."));
    }
    const activated = repo.activateDraftSet(draft.id)!;
    repo.audit(null, req.staff!.username, "requirements_activated",
      `${t.programme ?? `${t.level} (university-wide)`} · ${t.system} · requirement set v${activated.version} activated`);
    res.redirect(t.back(`Requirement set v${activated.version} is now ACTIVE for ${t.programme ?? `all ${t.level} programmes`} (${t.system}). New evaluations use it; historical cases keep their frozen version.`));
  });

  app.post("/config/requirements/discard", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const t = reqsTarget(req);
    if (!t) return res.redirect("/config?tab=requirements");
    const draft = repo.getDraftSet(t.programme, t.level, t.system);
    if (draft) repo.discardDraftSet(draft.id);
    res.redirect(t.back("Draft discarded — the active requirement set is unchanged."));
  });

  app.post("/config/requirements/catalogue-add", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const system = String(req.body.system ?? "").trim();
    const name = String(req.body.name ?? "").trim();
    const back = (m: string) => `/config?tab=requirements&msg=${encodeURIComponent(m)}#catalogue`;
    if (!ADMISSION_SYSTEMS.includes(system as AdmissionSystem)) return res.redirect(back("Unknown qualification system."));
    if (!name) return res.redirect(back("Subject name was empty."));
    // OR-6: duplicates are refused explicitly — never swallowed by INSERT OR IGNORE.
    if (!repo.addCatalogueSubject(system, name)) {
      return res.redirect(back(`"${name}" is already in the ${system} catalogue — nothing added.`));
    }
    repo.audit(null, req.staff!.username, "catalogue_changed", `${system}: subject "${name}" added`);
    res.redirect(back(`Subject "${name}" added to the ${system} catalogue.`));
  });

  app.post("/config/requirements/catalogue-rename", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const id = Number(req.body.id);
    const name = String(req.body.name ?? "").trim();
    const back = (m: string) => `/config?tab=requirements&msg=${encodeURIComponent(m)}#catalogue`;
    const row = repo.listSubjectCatalogue().find((r) => r.id === id);
    if (!row) return res.redirect(back("Unknown subject — nothing renamed."));
    if (!name) return res.redirect(back("Subject name was empty."));
    if (!repo.renameCatalogueSubject(id, name)) {
      return res.redirect(back(`"${name}" already exists in the ${row.system} catalogue — nothing renamed.`));
    }
    repo.audit(null, req.staff!.username, "catalogue_changed", `${row.system}: "${row.name}" renamed to "${name}"`);
    res.redirect(back(`Subject renamed to "${name}".`));
  });

  // OR-6: schools & courses live on ONE page — schools are first-class so a
  // faculty exists before its first course and renames cascade to courses.
  app.post("/config/schools/add", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const name = String(req.body.name ?? "").trim();
    const back = (m: string) => `/staff?msg=${encodeURIComponent(m)}#schools`;
    if (!name) return res.redirect(back("School name was empty — nothing added."));
    if (!repo.addSchool(name)) return res.redirect(back(`"${name}" already exists — nothing added.`));
    repo.audit(null, req.staff!.username, "school_changed", `school "${name}" added`);
    res.redirect(back(`School "${name}" added — assign courses to it below.`));
  });

  app.post("/config/schools/rename", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const from = String(req.body.from ?? "").trim();
    const to = String(req.body.to ?? "").trim();
    const back = (m: string) => `/staff?msg=${encodeURIComponent(m)}#schools`;
    if (!from || !to) return res.redirect(back("Rename needs a current name and a new name."));
    if (from === to) return res.redirect(back("The new name is the same as the old one — nothing changed."));
    const moved = repo.renameSchool(from, to);
    if (moved < 0) return res.redirect(back(`"${to}" already exists — nothing renamed.`));
    repo.audit(null, req.staff!.username, "school_changed", `school "${from}" renamed to "${to}" (${moved} course(s) moved)`);
    res.redirect(back(`"${from}" renamed to "${to}" — ${moved} course(s) moved with it.`));
  });

  app.post("/config/requirements/catalogue-toggle", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const id = Number(req.body.id);
    const row = repo.listSubjectCatalogue().find((r) => r.id === id);
    if (row) {
      repo.setCatalogueActive(id, row.active !== 1);
      repo.audit(null, req.staff!.username, "catalogue_changed", `${row.system}: "${row.name}" ${row.active !== 1 ? "restored" : "retired"}`);
    }
    res.redirect(`/config?tab=requirements#catalogue`);
  });

  // PPR P0-5: attachment sets — organization-owned groups of sendable files.
  app.post("/config/attachment-sets/create", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const name = String(req.body.name ?? "").trim();
    const orgId = req.body.organization_id ? Number(req.body.organization_id) : organizationId(req);
    if (!name || !repo.getOrganization(orgId)) return res.redirect(`/config?tab=pack&msg=${encodeURIComponent("A set needs a name and a valid organization.")}`);
    try {
      const set = repo.createAttachmentSet(orgId, name, String(req.body.description ?? ""));
      repo.audit(null, req.staff!.username, "attachment_set_created", `${set.name} (#${set.id}, org ${orgId})`);
      res.redirect(`/config?tab=pack&msg=${encodeURIComponent(`Set “${set.name}” created — upload its PDFs below.`)}#aset-${set.id}`);
    } catch (e) {
      res.redirect(`/config?tab=pack&msg=${encodeURIComponent(`Set was not created: ${(e as Error).message}`)}`);
    }
  });

  app.post("/config/attachment-sets/upload",
    requireLogin, requireRole("admin"), csrfCheck,
    express.raw({ type: "application/pdf", limit: "12mb" }),
    (req, res) => {
      const set = repo.getAttachmentSet(Number(req.query.set));
      if (!set) return res.status(400).send("Unknown attachment set.");
      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || body.length < 512 || body.subarray(0, 5).toString() !== "%PDF-") {
        return res.status(400).send("Not a PDF.");
      }
      // The filename arrives as a query parameter (raw-body upload).
      const rawName = String(req.query.filename ?? "").trim();
      const filename = rawName.replace(/[/\\]/g, "_").slice(0, 120) || `document-${Date.now()}.pdf`;
      repo.addAttachmentSetFile(set.id, { filename, mime: "application/pdf", content: body, provenance: "uploaded" });
      repo.audit(null, req.staff!.username, "attachment_set_file_added", `${set.name}: ${filename} (${body.length} bytes)`);
      res.send("Uploaded.");
    });

  app.post("/config/attachment-sets/file-delete", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const fileId = Number(req.body.file_id);
    const rows = repo.listAttachmentSets(organizationId(req));
    for (const s of rows) {
      if (repo.listAttachmentSetFiles(s.id).some((f) => f.id === fileId)) {
        repo.deleteAttachmentSetFile(fileId);
        repo.audit(null, req.staff!.username, "attachment_set_file_removed", `${s.name}: file #${fileId}`);
        return res.redirect(`/config?tab=pack#aset-${s.id}`);
      }
    }
    res.redirect(`/config?tab=pack&msg=${encodeURIComponent("Unknown file.")}`);
  });

  app.post("/config/attachment-sets/delete", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const set = repo.getAttachmentSet(Number(req.body.set_id));
    if (set && set.organization_id === organizationId(req)) {
      repo.deleteAttachmentSet(set.id, organizationId(req));
      repo.audit(null, req.staff!.username, "attachment_set_deleted", `${set.name} (#${set.id})`);
    }
    res.redirect(`/config?tab=pack&msg=${encodeURIComponent(`Set “${set?.name ?? "?"}” deleted. Templates referencing it will attach nothing (and say so in the audit).`)}`);
  });

  // Official pack files: download (staff) + replace (raw PDF upload).
  app.get("/pack/:key", requireLogin, (req, res) => {
    const slot = PACK_SLOTS.find((x) => x.key === req.params.key);
    if (!slot) return res.status(404).send("Unknown pack file.");
    const owned = repo.listOrganizationPackSlots(organizationId(req)).find((x) => x.key === slot.key);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${owned?.filename || slot.pretty}"`);
    if (owned?.content) return res.send(owned.content);
    // Only the migrated Organization #1 dataset may read bundled PDFs.
    if (organizationId(req) !== 1) return res.status(404).send("Pack file missing.");
    const file = path.join(PACK_DIR, slot.file);
    if (!fs.existsSync(file)) return res.status(404).send("Pack file missing.");
    res.sendFile(file);
  });
  app.post(
    "/config/pack/replace",
    requireLogin,
    requireRole("admin"),
    csrfCheck,
    express.raw({ type: "application/pdf", limit: "12mb" }),
    (req, res) => {
      const slot = PACK_SLOTS.find((x) => x.key === String(req.query.slot ?? ""));
      if (!slot) return res.status(400).send("Unknown pack slot.");
      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || body.length < 512 || body.subarray(0, 5).toString() !== "%PDF-") {
        return res.status(400).send("Not a PDF.");
      }
      repo.setOrganizationPackSlot(organizationId(req), slot.key, {
        filename: slot.pretty,
        mime: "application/pdf",
        content: body,
      });
      repo.audit(null, req.staff!.username, "pack_file_replaced", `${slot.key} replaced (${body.length} bytes)`);
      res.status(200).send("saved");
    }
  );

  // ── Gmail connect (OAuth code flow; tokens stored in Settings) ───────────

  // OR-4: connection controls have ONE home — Settings → Connections.
  const settingsBack = (msg: string) => `/settings?msg=${encodeURIComponent(msg)}#connections`;

  app.post("/settings/gmail/credentials", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    // Saving credentials is an explicit reconnect/enable action.
    repo.setSetting("gmail_disabled", "");
    repo.setSetting("gmail_address", String(req.body.gmail_address ?? "").trim());
    repo.setSetting("gmail_client_id", String(req.body.gmail_client_id ?? "").trim());
    // The watcher reads incoming All Mail (the same region for everyone).
    // Pin the OAuth origin only for reverse-proxy / HTTPS deployments — advanced field.
    repo.setSetting("gmail_public_base_url", String(req.body.gmail_public_base_url ?? "").trim());
    // Secret is write-only in the UI: kept if the field is left blank.
    // PPR P0-1: credentials live in the secrets store, never in settings.
    const secret = String(req.body.gmail_client_secret ?? "").trim();
    if (secret) repo.setSecret("gmail_client_secret", secret);
    // Manual / OAuth-Playground refresh token path (advanced field).
    const manualToken = String(req.body.gmail_refresh_token_manual ?? "").trim();
    if (manualToken) repo.setSecret("gmail_refresh_token", manualToken);
    repo.audit(null, req.staff!.username, "gmail_credentials_saved", "stored OAuth credentials in the secret store");
    res.redirect(settingsBack("Gmail credentials saved — now press “Connect with Google”."));
  });

  app.get("/settings/gmail/connect", requireLogin, requireRole("admin"), (req, res) => {
    const clientId = repo.getSetting("gmail_client_id", "");
    if (!clientId) return res.redirect(settingsBack("Save the OAuth client ID and secret first."));
    const state = crypto.randomBytes(16).toString("hex");
    repo.setSetting("gmail_oauth_state", state);
    const redirectUri = gmailRedirectUri(repo, req.protocol, req.get("host") ?? "localhost");
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

  app.get("/settings/gmail/callback", requireLogin, requireRole("admin"), async (req, res) => {
    const state = String(req.query.state ?? "");
    if (!state || state !== repo.getSetting("gmail_oauth_state", "")) {
      return res.redirect(settingsBack("OAuth state mismatch — try connecting again."));
    }
    repo.setSetting("gmail_oauth_state", "");
    if (req.query.error) {
      // AUX-1: a bare code ("access_denied") is not actionable — surface
      // Google's description and point at the usual causes.
      const err = String(req.query.error);
      const desc = req.query.error_description ? ` — ${String(req.query.error_description)}` : "";
      const hint =
        err === "redirect_uri_mismatch"
          ? " The redirect URI must match step 4 above byte-for-byte (scheme, host, port — http vs https counts)."
          : err === "access_denied"
            ? " While the consent screen is “In testing”, only the listed test users can approve — and the client type must be “Web application”, not Desktop."
            : "";
      return res.redirect(settingsBack(`Google returned an error: ${err}${desc}${hint}`));
    }
    const code = String(req.query.code ?? "");
    const clientId = repo.getSetting("gmail_client_id", "");
    const clientSecret = repo.getSecret("gmail_client_secret");
    const redirectUri = gmailRedirectUri(repo, req.protocol, req.get("host") ?? "localhost");
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
      repo.setSecret("gmail_refresh_token", json.refresh_token);
      repo.setSetting("gmail_disabled", "");
      repo.audit(null, req.staff!.username, "gmail_connected", repo.getSetting("gmail_address", ""));
      res.redirect(settingsBack("Gmail connected — live sorting starts within a minute."));
    } catch (e) {
      repo.audit(null, req.staff!.username, "gmail_connect_failed", (e as Error).message);
      res.redirect(settingsBack(`Token exchange failed: ${(e as Error).message}`));
    }
  });

  // OR-4: one real, lightweight call against the mailbox — success or a
  // helpful plain-words error, never silence.
  app.post("/settings/gmail/test", requireLogin, requireRole("admin"), csrfCheck, async (req, res) => {
    const cfg = {
      address: repo.getSetting("gmail_address", ""),
      clientId: repo.getSetting("gmail_client_id", ""),
      clientSecret: repo.getSecret("gmail_client_secret"),
      refreshToken: repo.getSecret("gmail_refresh_token"),
    };
    if (!cfg.address || !cfg.clientId || !cfg.clientSecret || !cfg.refreshToken) {
      if (deps.gmailTest && gmailConfigured && repo.getSetting("gmail_disabled", "") !== "1") {
        const envError = await deps.gmailTest();
        if (!envError) {
          repo.setSetting("gmail_last_error", "");
          repo.audit(null, req.staff!.username, "gmail_tested", "environment-configured Gmail connection succeeded");
          return res.redirect(settingsBack("Gmail test connection succeeded — the environment-configured mailbox is reachable."));
        }
        repo.setSetting("gmail_last_error", envError.message.slice(0, 300));
        repo.audit(null, req.staff!.username, "gmail_test_failed", envError.message.slice(0, 200));
        return res.redirect(settingsBack(`Gmail test connection failed: ${envError.message}`));
      }
      return res.redirect(settingsBack("Gmail is not fully configured yet — save credentials (and connect, or paste a refresh token) first."));
    }
    try {
      const client = new GmailClient(cfg);
      const ids = await client.listRecentMessageIds(1, { perPage: 1, maxPages: 1 });
      repo.setSetting("gmail_last_error", "");
      repo.audit(null, req.staff!.username, "gmail_tested", "test connection succeeded");
      return res.redirect(settingsBack(
        ids.length
          ? "Gmail test connection succeeded — mailbox reachable, recent mail found."
          : "Gmail test connection succeeded — mailbox reachable (no mail in the last day, which is fine)."
      ));
    } catch (e) {
      const msg = (e as Error).message;
      repo.setSetting("gmail_last_error", msg.slice(0, 300));
      repo.audit(null, req.staff!.username, "gmail_test_failed", msg.slice(0, 200));
      return res.redirect(settingsBack(`Gmail test connection failed: ${msg}`));
    }
  });

  app.post("/settings/gmail/disconnect", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    // Pause an environment-managed client without deleting its env secret.
    repo.setSetting("gmail_disabled", "1");
    repo.deleteSecret("gmail_refresh_token");
    repo.audit(null, req.staff!.username, "gmail_disconnected", "");
    res.redirect(settingsBack("Gmail disconnected — live fetching stopped."));
  });

  // Manual "Sync now": pull incoming All Mail immediately instead of waiting for the
  // next 60s poll. Errors are surfaced verbatim on the config page — a broken
  // connection is never silently ignored.
  app.post("/settings/gmail/sync", requireLogin, requireRole("admin"), csrfCheck, async (req, res) => {
    if (!gmailSync) {
      return res.redirect(settingsBack("No live mailbox — connect Gmail first."));
    }
    const err = await gmailSync();
    if (err) {
      repo.setSetting("gmail_last_error", err.message.slice(0, 300));
      repo.audit(null, req.staff!.username, "gmail_sync_failed", err.message.slice(0, 200));
      return res.redirect(settingsBack(`Sync failed: ${err.message}`));
    }
    repo.setSetting("gmail_last_sync_at", new Date().toISOString());
    repo.setSetting("gmail_last_error", "");
    repo.audit(null, req.staff!.username, "gmail_synced", "manual sync from Settings");
    res.redirect(settingsBack("Inbox synced — new mail has been triaged."));
  });
  // Round 11: one-off backfill — pull mail older than the normal window.
  app.post("/settings/gmail/backfill", requireLogin, requireRole("admin"), csrfCheck, async (req, res) => {
    const { BACKFILL_WINDOWS } = await import("../ingestion/sync");
    const days = Number(req.body.days);
    if (!BACKFILL_WINDOWS.includes(days)) {
      return res.redirect(`/settings?msg=${encodeURIComponent("Backfill windows are 30, 90 or 365 days.")}#connections`);
    }
    if (!gmailBackfill) {
      return res.redirect(`/settings?msg=${encodeURIComponent("Backfill is unavailable — the server was started without live Gmail sync.")}#connections`);
    }
    const err = await gmailBackfill(days);
    if (err) {
      return res.redirect(`/settings?msg=${encodeURIComponent(`Backfill failed: ${err.message}`)}#connections`);
    }
    repo.audit(null, req.staff!.username, "gmail_backfill", `Pulled mail from the last ${days} days into the console`);
    res.redirect(`/settings?msg=${encodeURIComponent(`History pulled — mail from the last ${days} days is now in All Mail.`)}#connections`);
  });


  // ── Gemini (document-reading AI) — a first-class settings field ───────────
  // The key is stored in the secret store (PPR P0-1), used by the extraction
  // pipeline AT ONCE (no restart, no env file). "Test key" performs a real
  // round-trip and reports exactly what happened.
  const rebuildAdapters = () => {
    const key = repo.getSecret("gemini_api_key").trim();
    if (!key) {
      // N1: no key means MOCK reading — say so by actually rebuilding. The
      // old early-return left stale live Gemini adapters in place after a
      // key removal: the dead-key watcher fails closed on every Green file
      // (auto-replies silently stop) while the UI/audit claim "back to
      // mock reading". Boot with no key behaves identically (mock either
      // way, so this is a no-op there).
      ctx.adapters = {
        ...ctx.adapters,
        vision: new MockVisionAdapter(),
        watcher: makeHeuristicWatcher(),
      };
      return;
    }
    const model = repo.getSetting("gemini_model", DEFAULT_GEMINI_MODEL).trim() || DEFAULT_GEMINI_MODEL;
    try {
      const next: Adapters = {
        ...ctx.adapters,
        vision: new BudgetedVisionAdapter(new GeminiVisionAdapter(key, model), repo.visionCacheStore()),
        watcher: ((w) => (input) => w.watch(input))(new GeminiWatcher(key, model)),
      };
      ctx.adapters = next;
      repo.setSetting("gemini_last_error", "");
      return;
    } catch (e) {
      repo.setSetting("gemini_last_error", (e as Error).message.slice(0, 300));
    }
  };
  // Boot with a key that was saved earlier (server restarts keep it working).
  rebuildAdapters();

  app.post("/settings/gemini", requireLogin, requireRole("admin"), csrfCheck, async (req, res) => {
    const back = (m: string) => `/settings?msg=${encodeURIComponent(m)}#connections`;
    const key = String(req.body.gemini_api_key ?? "").trim();
    const model = String(req.body.gemini_model ?? DEFAULT_GEMINI_MODEL).trim() || DEFAULT_GEMINI_MODEL;
    if (req.body.clear !== undefined) {
      repo.deleteSecret("gemini_api_key");
      repo.setSetting("gemini_last_error", "");
      // N1: the message below is only true if the adapters actually go
      // back to mock — rebuild before claiming it.
      rebuildAdapters();
      repo.audit(null, req.staff!.username, "gemini_disabled", "API key removed — back to mock reading");
      return res.redirect(back("Gemini key removed. Document reading falls back to text/OCR only."));
    }
    if (!key && !repo.hasSecret("gemini_api_key")) {
      return res.redirect(back("Paste a Gemini API key first (get one free at aistudio.google.com/apikey)."));
    }
    if (key) repo.setSecret("gemini_api_key", key);
    repo.setSetting("gemini_model", model);
    // Prove the key with ONE real API call before claiming it works.
    try {
      const probe = new GeminiVisionAdapter(repo.getSecret("gemini_api_key"), model);
      await probe.probeKey();
      rebuildAdapters();
      repo.audit(null, req.staff!.username, "gemini_enabled", `live document reading on (${model})`);
      return res.redirect(back(`Gemini is live (${model}) — unreadable scans are now read by AI, no restart needed.`));
    } catch (e) {
      const msg = (e as Error).message;
      repo.setSetting("gemini_last_error", msg.slice(0, 300));
      repo.audit(null, req.staff!.username, "gemini_test_failed", msg.slice(0, 200));
      return res.redirect(back(`Gemini test call failed: ${msg}`));
    }
  });

  app.post("/settings/organization", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const name = String(req.body.organization_name ?? "").trim();
    const primary = String(req.body.primary_color ?? "").trim();
    const accent = String(req.body.accent_color ?? "").trim();
    const refPrefix = String(req.body.ref_prefix ?? "").trim().toUpperCase();
    const validColor = (value: string) => /^#[0-9a-f]{6}$/i.test(value);
    if (!name) return res.redirect(`/settings?msg=${encodeURIComponent("Organization name is required.")}#letters`);
    if (!validColor(primary) || !validColor(accent)) {
      return res.redirect(`/settings?msg=${encodeURIComponent("Colours must be six-digit hexadecimal values.")}#letters`);
    }
    if (!/^[A-Z]{1,8}$/.test(refPrefix)) {
      return res.redirect(`/settings?msg=${encodeURIComponent("Reference prefix must be 1–8 letters.")}#letters`);
    }
    // PPR P1-5: sender identity + locale are organization-owned and now
    // actually applied to outgoing mail (From display name / Reply-To).
    repo.updateOrganization(organizationId(req), {
      name, refPrefix, theme: { primary, accent },
      fromName: String(req.body.from_name ?? ""),
      replyTo: String(req.body.reply_to ?? ""),
      locale: String(req.body.locale ?? ""),
      timezone: String(req.body.timezone ?? ""),
    });
    repo.audit(null, req.staff!.username, "organization_identity_changed", `${name} (${primary}, ${accent})`);
    res.redirect(`/settings?msg=${encodeURIComponent("Organization identity saved.")}#letters`);
  });

  app.post("/settings/general", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    // Blank identity fields keep their current value (an empty ref prefix
    // would break ref generation); numbers are validated.
    const ignored: string[] = [];
    const numOk = (v: string) => /^\d+(\.\d+)?$/.test(v) && Number(v) > 0;
    const ladderOk = (v: string) => v.split(",").every((p) => /^\d+$/.test(p.trim()) && Number(p.trim()) > 0);
    for (const key of [
      "institution_name", "sla_target_hours", "escalation_hours",
      "unanswered_target_hours", "followup_ladder_days", "retention_days",
      "reg_date", "orientation_dates", "intake_hotwords",
    ]) {
      if (typeof req.body[key] !== "string") continue;
      const v = String(req.body[key]).trim();
      if (["sla_target_hours", "escalation_hours", "unanswered_target_hours", "retention_days"].includes(key) && !numOk(v)) {
        ignored.push(key.replace(/_/g, " "));
        continue;
      }
      if (key === "followup_ladder_days" && !ladderOk(v)) {
        ignored.push(key.replace(/_/g, " "));
        continue;
      }
      if (!(key === "institution_name" && organizationId(req) !== 1)) repo.setSetting(key, v);
      if (key === "institution_name" && organizationId(req) !== 1 && v) {
        repo.updateOrganization(organizationId(req), { name: v });
      }
    }
    repo.audit(null, req.staff!.username, "settings_changed", "general settings updated");
    res.redirect(
      `/settings?msg=${encodeURIComponent(
        ignored.length ? `Saved. Kept current value for: ${ignored.join(", ")} (blank or invalid input).` : "Settings saved."
      )}`
    );
  });

  app.post("/settings/automation/global", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const mode = String(req.body.mode ?? "auto") === "draft" ? "draft" : "auto";
    repo.setSetting("automation_mode", mode);
    repo.audit(null, req.staff!.username, "automation_changed", `global automation mode → ${mode}`);
    res.redirect("/settings");
  });

  app.post("/settings/automation/category", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const cat = String(req.body.category ?? "");
    const mode = String(req.body.mode ?? "auto") === "draft" ? "draft" : "auto";
    if (cat) {
      repo.setAutomationMode(cat, mode);
      repo.audit(null, req.staff!.username, "automation_changed", `category '${cat}' → ${mode}`);
    }
    res.redirect("/settings");
  });

  app.post("/settings/intake-deadline", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const name = String(req.body.name ?? "").trim();
    const deadline = String(req.body.deadline ?? "").trim();
    if (name) {
      // Garbage date strings produced Invalid Dates whose toISOString()
      // throws → 500. Validate first.
      const parsed = deadline ? new Date(`${deadline}T23:59:59Z`) : null;
      if (deadline && (parsed === null || isNaN(parsed.getTime()))) {
        return res.redirect("/config?msg=invalid-deadline#intakes");
      }
      repo.setIntakeDeadline(name, parsed ? parsed.toISOString() : null);
      repo.audit(null, req.staff!.username, "intake_deadline_changed", `${name} → ${deadline || "none"}`);
    }
    res.redirect("/config#intakes");
  });

  // Requirement rules now speak GRADES (mean grade + subject lines) — the way
  // the university actually publishes entry requirements. No numeric points.
  // OR-5: document requirements are generated deterministically from the
  // official application-form checklist — they are NOT staff-configurable.
  // The old add/delete endpoints are gone; a stale POST (bookmark, old
  // tab, replayed request) must get an explicit refusal, never a silent
  // success and never a hidden write.
  app.post("/settings/rules/add", requireLogin, requireRole("admin"), csrfCheck, (_req, res) => {
    res.redirect("/config?msg=" + encodeURIComponent("Document requirements are generated deterministically from the application-form checklist — they cannot be added by hand. See the Requirements tab.") + "#courses");
  });
  app.post("/settings/rules/delete", requireLogin, requireRole("admin"), csrfCheck, (_req, res) => {
    res.redirect("/config?msg=" + encodeURIComponent("Document requirements are generated deterministically from the application-form checklist — they cannot be removed by hand. See the Requirements tab.") + "#courses");
  });

  app.post("/settings/lists/add", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    if ((req.staff!.organization_id ?? 1) !== 1 && (req.body.prog_code || req.body.prog_name)) return res.redirect("/config?tab=case-types&msg=Use+CaseTypes+for+this+organization");
    const added: string[] = [];
    if (req.body.prog_code && req.body.prog_name) {
      const school = String(req.body.prog_school ?? "").trim();
      // OR-6: Master's and PhD are distinct levels; anything unknown
      // falls back to "degree" rather than storing junk.
      const lvlRaw = String(req.body.prog_level ?? "degree");
      const level: LegacyAcademicLevel = ["degree", "diploma", "certificate", "masters", "phd"].includes(lvlRaw)
        ? (lvlRaw as LegacyAcademicLevel)
        : "degree";
      repo.addProgramme(String(req.body.prog_code), String(req.body.prog_name), school, "", level);
      added.push("programme");
    }
    if (req.body.intake) { repo.addIntake(String(req.body.intake)); added.push("intake"); }
    repo.audit(null, req.staff!.username, "lists_changed", "programmes/intakes updated");
    res.redirect("/config?msg=" + encodeURIComponent(added.length ? `Added ${added.join(" and ")}.` : "Nothing to add — fill in a programme code and name, or an intake.") + "#courses");
  });

  // OR-7: templates moved to their own section (/templates). A stale POST to
  // the old endpoint is refused explicitly — never a silent write to a page
  // nobody is looking at.
  app.post("/settings/template", requireLogin, requireRole("admin"), csrfCheck, (_req, res) => {
    res.redirect("/templates?msg=" + encodeURIComponent("Templates are edited in the Templates section now — this old form no longer saves anything."));
  });

  // ── OR-7: Templates section — every outgoing type, one home ──────────────
  const tplBack = (key: string, m: string) =>
    `/templates?template=${encodeURIComponent(key)}&msg=${encodeURIComponent(m)}#tpl-${key}`;
  const KNOWN_PLACEHOLDERS = [
    "{ref}", "{name}", "{first_name}", "{missing_docs}", "{missing_docs_section}",
    "{checklist}", "{status}", "{institution}", "{programme}", "{reg_date}",
    "{orientation_dates}", "{read_back}", "{document_issues}",
  ];
  const unknownPlaceholders = (text: string): string[] => {
    const found = text.match(/\{[a-z_]+\}/g) ?? [];
    return [...new Set(found.filter((p) => !KNOWN_PLACEHOLDERS.includes(p)))];
  };

  app.get("/templates", requireLogin, requireRole("admin"), (req, res) => {
    const key = String(req.query.template ?? "");
    const msg = req.query.msg ? String(req.query.msg) : undefined;
    res.send(templatesPage(c(req), repo.listTemplates(organizationId(req)).some((t) => t.key === key) ? key : undefined, msg));
  });

  app.post("/templates/save", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const key = String(req.body.key ?? "");
    const existing = repo.getTemplate(key, organizationId(req), req.body.case_type_id ? Number(req.body.case_type_id) : undefined);
    if (!existing) return res.redirect(`/templates?msg=${encodeURIComponent("Unknown template — nothing saved.")}`);
    const name = String(req.body.name ?? "").trim();
    const subject = String(req.body.subject ?? "").trim();
    const body = String(req.body.body ?? "").trim();
    if (!name || !subject || !body) return res.redirect(tplBack(key, "Template needs a name, a subject and a body — nothing saved."));
    const packRaw = String(req.body.attach_pack ?? "none").trim() || "none";
    const caseTypeId = req.body.case_type_id !== undefined ? Number(req.body.case_type_id) || 0 : existing.case_type_id;
    try {
      // PPR P0-5 (E3 close): upsertTemplate validates the reference against
      // this organization's OWN attachment sets — unknown refs are refused.
      repo.upsertTemplate(key, name, subject, body, req.body.include_banner !== undefined, packRaw, organizationId(req), caseTypeId);
    } catch (e) {
      return res.redirect(tplBack(key, `Template not saved: ${(e as Error).message}`));
    }
    repo.audit(null, req.staff!.username, "template_changed", `${key}${packRaw !== "none" ? ` (+${packRaw} set)` : ""}${caseTypeId ? ` [profile #${caseTypeId}]` : ""}`);
    const unknown = unknownPlaceholders(subject + " " + body);
    const warn = unknown.length
      ? ` ⚠ Unknown placeholder${unknown.length === 1 ? "" : "s"} left in the text: ${unknown.join(", ")} — it will reach applicants as literal text.`
      : "";
    res.redirect(tplBack(key, `Template “${name}” saved.${warn}`));
  });

  // PPR P0-6: templates are not a closed enum — a profile can create the
  // keys it needs. The key is a stable machine name (like a variable name).
  app.post("/templates/create", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const key = String(req.body.key ?? "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
    const name = String(req.body.name ?? "").trim();
    const caseTypeId = Number(req.body.case_type_id ?? 0) || 0;
    if (!/^[a-z][a-z0-9_]{1,48}$/.test(key) || !name) {
      return res.redirect(`/templates?msg=${encodeURIComponent("A template needs a machine key (letters, digits, underscores) and a display name.")}`);
    }
    if (repo.getTemplate(key, organizationId(req), caseTypeId || undefined)) {
      return res.redirect(`/templates?template=${encodeURIComponent(key)}&msg=${encodeURIComponent("That key already exists for this organization — opening it instead.")}`);
    }
    repo.upsertTemplate(key, name, `Subject for ${name}`, `Hello {name},\n\n\n\nKind regards,\n{institution}`, true, "none", organizationId(req), caseTypeId);
    repo.audit(null, req.staff!.username, "template_created", `${key}${caseTypeId ? ` [profile #${caseTypeId}]` : ""}`);
    res.redirect(`/templates?template=${encodeURIComponent(key)}&msg=${encodeURIComponent(`Template “${name}” created — its first version is its saved default.`)}`);
  });

  app.post("/templates/reset", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const key = String(req.body.key ?? "");
    // PPR P0-6: "Reset to default" restores the profile's OWN default —
    // the snapshot captured when the template was created — not a shared
    // global wording. Legacy rows without a snapshot fall back to the
    // migrated education profile's official defaults.
    const snap = repo.templateDefaultSnapshot(key, organizationId(req));
    const def = snap ?? TEMPLATE_DEFAULTS[key];
    if (!def) return res.redirect(`/templates?msg=${encodeURIComponent("No default exists for that template — nothing to reset.")}`);
    const existingRow = repo.getTemplate(key, organizationId(req));
    repo.upsertTemplate(key, def.name, def.subject, def.body, Boolean(def.include_banner), def.attach_pack, organizationId(req), existingRow?.case_type_id ?? 0);
    repo.audit(null, req.staff!.username, "template_reset", `${key} → ${snap ? "profile default" : "shipped default"}`);
    res.redirect(tplBack(key, `“${def.name}” reset to ${snap ? "its own default" : "the official default"}.`));
  });

  // ── Staff management (admin) ─────────────────────────────────────────────

  // OR-8: save a staff member's ENTIRE school scope in one action.
  app.post("/staff/scopes", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const staffId = Number(req.body.staff_id);
    const member = repo.getStaff(staffId);
    if (!member) return res.redirect("/staff?msg=" + encodeURIComponent("Unknown staff member — nothing saved."));
    const raw = req.body.schools;
    const schools = (Array.isArray(raw) ? raw : raw ? [raw] : []).map((x) => String(x).trim()).filter(Boolean);
    // Only real schools can be scoped — a typo'd school name would silently
    // hide cases forever otherwise.
    const known = new Set(repo.listSchools());
    const unknown = schools.filter((x) => !known.has(x));
    if (unknown.length) {
      return res.redirect(`/staff?msg=${encodeURIComponent(`Unknown school(s): ${unknown.join(", ")} — nothing saved.`)}#scopes`);
    }
    const restoreFull = String(req.body.scope_mode ?? "") === "unscoped";
    if (restoreFull) repo.clearScopes(staffId);
    else repo.setScopes(staffId, schools);
    repo.audit(null, req.staff!.username, "scope_changed",
      `${member.username}: ${restoreFull ? "scope cleared (full visibility)" : schools.length ? schools.join(", ") : "no access"}`);
    res.redirect(`/staff?msg=${encodeURIComponent(restoreFull
      ? `${member.display_name}'s scope cleared — they see all schools again.`
      : schools.length
        ? `${member.display_name} now sees: ${schools.join(", ")}.`
        : `${member.display_name} now has no school access until an administrator assigns one.`)}#scopes`);
  });

  app.get("/staff", requireLogin, requireRole("admin"), (req, res) =>
    res.send(staffPage(c(req), req.query.msg ? String(req.query.msg) : undefined))
  );

  // PPR P1-8: grant/revoke the four automation permissions per staff member.
  app.post("/staff/permissions", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    for (const st of repo.listStaff()) {
      if (st.role === "admin") continue; // admins implicitly hold all four
      const grants: Permission[] = [];
      for (const p of PERMISSIONS) {
        if (String((req.body as Record<string, string>)[`perm_${st.id}_${p}`] ?? "") === "1") grants.push(p);
      }
      repo.setPermissions(st.id, grants);
    }
    repo.audit(null, req.staff!.username, "staff_permissions_saved", "automation permissions updated");
    res.redirect("/staff?msg=" + encodeURIComponent("Automation permissions saved."));
  });

  app.post("/staff/add", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const username = String(req.body.username ?? "").trim();
    const password = String(req.body.password ?? "");
    const role = String(req.body.role) === "admin" ? "admin" : "user";
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
    const staffMsg = (m: string) => `/staff?msg=${encodeURIComponent(m)}`;
    if (!s) return res.redirect("/staff");
    if (s.id === req.staff!.id) return res.redirect(staffMsg("You cannot disable your own account."));
    repo.setStaffActive(s.id, s.active !== 1);
    repo.audit(null, req.staff!.username, "staff_toggled", `${s.username} → ${s.active !== 1 ? "active" : "disabled"}`);
    res.redirect(staffMsg(`${s.display_name} is now ${s.active !== 1 ? "active" : "disabled"}.`));
  });

  app.post("/staff/password", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const id = Number(req.body.id);
    const staffMsg = (m: string) => `/staff?msg=${encodeURIComponent(m)}`;
    const password = String(req.body.password ?? "");
    const confirm = String(req.body.confirm ?? "");
    const target = repo.getStaff(id);
    if (!target) return res.redirect(staffMsg("Unknown staff member."));
    // Same rules as first-run setup — one rulebook for every password write.
    if (password.length < 8) return res.redirect(staffMsg(`Password for “${target.username}” must be at least 8 characters.`));
    if (password !== confirm) return res.redirect(staffMsg(`The passwords do not match — nothing changed.`));
    repo.setStaffPassword(id, hashPassword(password));
    repo.audit(null, req.staff!.username, "staff_password_reset", `user #${id}`);
    res.redirect(staffMsg(`Password reset for “${target.username}”.`));
  });

  // Forgot password: issue a one-time code for a member. Deliberately a
  // 200 re-render, NOT a redirect — the code is shown exactly once, in the
  // response body, and must never appear in a URL (history/Referer).
  app.post("/staff/reset-code", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const target = repo.getStaff(Number(req.body.id));
    if (!target) return res.send(staffPage(c(req), "Unknown staff member — no code issued."));
    const code = repo.issueResetCode(target.id, req.staff!.username);
    repo.audit(null, req.staff!.username, "password_reset_code_issued", `for ${target.username}`);
    res.send(staffPage(c(req), `Reset code issued for “${target.username}”.`, code));
  });

  // Round 3 — per-course document checklists (checkboxes on the staff page).
  // Saving replaces the course's configured set; a course with no rows runs
  // on the generated matrix checklist. New applicants are checked against the
  // live list; cases that already froze a requirement snapshot keep theirs.
  app.post("/staff/course-docs", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    if ((req.staff!.organization_id ?? 1) !== 1) return res.redirect("/config?tab=case-types&msg=Use+CaseTypes+for+this+organization");
    const back = (m: string) => `/staff?msg=${encodeURIComponent(m)}#courses`;
    const programme = String(req.body.programme ?? "").trim().toUpperCase();
    if (!repo.programmeByCode(programme)) return res.redirect(back("Unknown course — nothing changed."));
    const raw = req.body.docs;
    const all = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
    const valid = new Set<string>(DOC_TYPES);
    const types = all.map((x) => String(x)).filter((x) => valid.has(x) && x !== "unknown");
    repo.saveCourseDocConfig(programme, types as DocType[]);
    repo.audit(null, req.staff!.username, "course_docs_configured",
      `${programme}: ${types.join(", ") || "none"}`);
    res.redirect(back(`Required documents saved for ${programme}. New applicants are checked against this list; cases with a frozen requirement set keep theirs.`));
  });

  app.post("/staff/course-docs/reset", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    if ((req.staff!.organization_id ?? 1) !== 1) return res.redirect("/config?tab=case-types&msg=Use+CaseTypes+for+this+organization");
    const back = (m: string) => `/staff?msg=${encodeURIComponent(m)}#courses`;
    const programme = String(req.body.programme ?? "").trim().toUpperCase();
    if (!repo.programmeByCode(programme)) return res.redirect(back("Unknown course — nothing changed."));
    repo.deleteCourseDocConfig(programme);
    repo.audit(null, req.staff!.username, "course_docs_reset", `${programme}: back to the generated checklist`);
    res.redirect(back(`${programme} is back on the generated document checklist.`));
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

  app.get("/export/applicants.csv", requireLogin, requireRole("admin"), (req, res) => {
    // Realm + school scope, like every other admin list — an admin in one
    // realm must not be able to pull the whole other realm's PII to CSV.
    const demo = req.staff!.demo ?? 0;
    const schools = repo.visibleSchoolsFor(req.staff!);
    const rows = repo.allApplicants(demo, schools);
    // Two aggregate queries for the whole export — never 2N per-applicant
    // lookups on a synchronous connection.
    const docCounts = repo.documentCountsByApplicant();
    const flagTypes = repo.activeFlagTypesByApplicant();
    csv(
      res,
      "applicants.csv",
      ["ref_number", "name", "email", "phone", "programme", "intake", "lifecycle", "triage", "priority", "assigned_to", "active_docs", "flags", "created_at"],
      rows.map((a) => [
        a.ref_number, a.full_name, a.email_address, a.phone, a.programme, a.intake, a.lifecycle, a.triage,
        a.priority, a.assigned_to ? repo.getStaff(a.assigned_to)?.username ?? "" : "",
        docCounts.get(a.id) ?? 0,
        (flagTypes.get(a.id) ?? []).join("; "),
        a.created_at,
      ])
    );
  });

  app.get("/export/queue.csv", requireLogin, requireRole("admin"), (req, res) => {
    const demo = req.staff!.demo ?? 0;
    const schools = repo.visibleSchoolsFor(req.staff!);
    const rows = repo.queueView(demo, schools);
    csv(
      res,
      "review-queue.csv",
      ["ref_number", "name", "email", "verdict", "priority", "flags", "sla_due", "escalated"],
      rows.map((r) => [r.ref_number, r.full_name, r.email_address, r.computed_status, r.priority, r.flag_summary, r.sla_due_at, r.escalated])
    );
  });

  app.get("/export/audit.csv", requireLogin, requireRole("admin"), (req, res) => {
    // Scope the audit log to the caller's realm: system rows (no applicant)
    // are institution-level and always included; applicant rows must belong
    // to an applicant visible to this realm.
    const demo = req.staff!.demo ?? 0;
    const schools = repo.visibleSchoolsFor(req.staff!);
    const visible = new Set(repo.allApplicants(demo, schools).map((a) => a.id));
    const rows = repo
      .recentAudit(10000)
      .filter((r) => r.applicant_id === null || visible.has(r.applicant_id));
    csv(res, "audit.csv", ["at", "actor", "event", "detail", "applicant_id"], rows.map((r) => [r.at, r.actor, r.event, r.detail, r.applicant_id]));
  });


  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  /** Command-palette search API (v4). Realm-scoped like every other list. */
  app.get("/api/search", requireLogin, (req, res) => {
    const q = String(req.query.q ?? "").trim();
    if (!q) return res.json({ applicants: [] });
    res.json({
      applicants: repo.searchApplicants({ q, limit: 8, demo: req.staff!.demo, schools: repo.visibleSchoolsFor(req.staff!) }).map((a) => ({
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
    if (req.path.startsWith("/api/")) {
      return res.status(404).json({ ok: false, error: "not found" });
    }
    res.status(404).send(layout({
      title: "Page not found",
      institution: instName(req),
      publicPage: !req.staff,
      user: req.staff,
      unread: req.staff ? repo.unreadCount(req.staff.id, req.staff.demo, repo.visibleSchoolsFor(req.staff)) : undefined,
      csrf: req.staff ? req.csrfToken : undefined,
      content: `<div class="card" style="max-width:520px;margin:60px auto;text-align:center">
        <h1>Page not found</h1>
        <p class="sub">That address does not exist${req.staff ? " in the console" : ""}.</p>
        <p><a class="btn" href="${req.staff ? "/" : "/login"}">${req.staff ? "← Back to the Overview" : "← Back to sign in"}</a></p>
      </div>`,
    }));
  });

  // Last-resort error handler: log the detail, show a calm page — never a stack trace.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, req: Request, res: Response, _next: unknown) => {
    log(`unhandled error on ${req.method} ${req.path}: ${(err as Error)?.stack ?? err}`, "error");
    if (res.headersSent) return;
    if (req.path.startsWith("/api/")) {
      return res.status(500).json({ ok: false, error: "internal error" });
    }
    res.status(500).send(layout({
      title: "Something went wrong",
      institution: instName(req),
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
    repo.notify("escalation", `Case ${a.ref_number} has exceeded its response target.`, a.id);
    repo.audit(a.id, "system", "escalated", `exceeded response target (escalation window ${escalationHours}h)`);
    n++;
    log(`escalation: ${a.ref_number} exceeded response target → urgent`, "warn");
  }
  return n;
}
