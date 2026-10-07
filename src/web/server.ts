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
import { FONT_MANROPE_WOFF2 } from "./fonts";
import express, { type Express, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { Repo } from "../db/repo";
import { DEFAULT_GEMINI_MODEL } from "../extraction/gemini";
import type { PipelineContext } from "../pipeline/adapters";
import type { Adapters } from "../pipeline/adapters";
import type { ApplicantRow, LifecycleStage, Permission } from "../types";
import { EMAIL_CATEGORIES, EMAIL_CATEGORY_LABELS, LIFECYCLE_LABELS, LIFECYCLE_ORDER, PERMISSIONS, PERMISSION_LABELS, type EmailCategory } from "../types";
import { checklistText, inspectTemplate, renderTemplate } from "../drafting";
import { docLabel } from "../rules";
import { fillSlots } from "../documents/matrix";
import { validateRuleTree } from "../rules/caseType";
import { evaluateStoredCase } from "../rules/evaluate";
import type { RuleAction, RuleCondition, WorkflowRule } from "../rules/workflow";
import { compareRuleOrder, describeRule, firstMatchingRule, rulesForCaseScope, ruleMatches } from "../rules/workflow";
import { categorizeEmail, geminiCategoryLabeler } from "../categorize";

import {
  accountPage, casesPage, applicantsPage, casePage, composePage, composeWindowPage, configPage, dashboardPage, loginPage, mailPage, mailThreadPage, resetPasswordPage, setupPage,
  replayPage, securityConsolePage, settingsPage, staffPage, templatesPage, intakeTestPage,
} from "./pages";
import { TEMPLATE_DEFAULTS, seedStarterTemplates, seedProcessTemplate, PROCESS_TEMPLATES, type ProcessTemplateId } from "../db/seed";
import { processEmail } from "../pipeline";
import { makeTextPdf } from "../simulation/pdfFactory";
import { avatar, layout } from "./views";
import { authMiddleware, clearSessionCookie, csrfCheck, loginAttempt, requireLogin, requireRole, sessionCookie } from "./auth";
import { GmailClient } from "../ingestion/gmailClient";
import { BudgetedVisionAdapter, GeminiVisionAdapter, MockVisionAdapter } from "../extraction/gemini";
import { GeminiWatcher, makeHeuristicWatcher } from "../watcher";
import { log } from "../util/log";
import type { OnceResult } from "../util/once";
import { hashPassword, verifyPassword } from "../util/password";
import { normalizeUsername, USERNAME_RE } from "../util/username";
import { gmailRedirectUri, publicOrigin } from "./oauth";
import { LoginThrottle, RateWindow, SendGuard } from "./throttle";
import { WEBHOOK_PATH_PREFIX, ingestWebhook, redactIngestKey } from "./webhook";
import { envInt } from "../util/envnum";
import { emailBanner, organizationName, organizationSender, organizationTheme, organizationSignature, formatSignatureHtml, formatSignatureText, bodyAlreadySigned, setOrgSetting } from "../branding";
import type { PackFile } from "../pack";

class MailDeliveryUnavailableError extends Error {
  constructor() {
    super("Mail is not connected.");
    this.name = "MailDeliveryUnavailableError";
  }
}

export interface WebDeps {
  repo: Repo;
  ctx: PipelineContext; // reuse the pipeline's sender/vision adapters
  /** Manual "Sync now" hook — one live ingest pass; `ran:false` = a pass was already in flight. */
  gmailSync?: () => Promise<OnceResult<Error | null>>;
  /** One-off backfill hook — one pass over a deeper window (30/90/365 days). */
  gmailBackfill?: (days: number) => Promise<OnceResult<Error | null>>;
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
  /** The acting staff member's own tenant — the only one configuration writes may touch. */
  const ownOrganizationId = (req: Request): number => organizationId(req);
  const instName = (req?: Request): string => organizationName(repo, organizationId(req));
  // PPR P1-5: every outgoing send carries the organization's sender identity
  // (From display name / Reply-To) — one wrapper so no send path can forget it.
  const sendOrgMail = (
    a: { email_address: string; thread_id: string; organization_id?: number | null },
    subject: string,
    body: string,
    extras: { banner?: { mime: string; base64: string } | null; attachments?: Array<{ filename: string; mimeType: string; content: Buffer }> }
  ): Promise<void> => {
    if (ctx.adapters.sender.delivers !== true) throw new MailDeliveryUnavailableError();
    const orgId = a.organization_id ?? 1;
    const sig = organizationSignature(repo, orgId);
    const inst = organizationName(repo, orgId);
    const signatureText = formatSignatureText(sig, inst);
    const signatureHtml = formatSignatureHtml(sig, inst);
    // Avoid double-appending if the template already ends with a signature-like block.
    // BUG-16: one shared rule for "already signed", so both MIME paths agree
    // and a body that merely mentions the signer no longer suppresses it.
    const alreadySigned = bodyAlreadySigned(body, signatureText);
    // When a banner is present the MIME path is HTML+plain; put the pretty signature
    // only in HTML (signatureHtml) and keep plain body clean for the text part via extras.
    const useHtmlBanner = extras.banner != null && extras.banner !== undefined;
    const bodyWithSig = signatureText && !alreadySigned && !useHtmlBanner ? body + signatureText : body;
    return ctx.adapters.sender.send(a.email_address, subject, bodyWithSig, a.thread_id, {
      ...organizationSender(repo, orgId),
      ...extras,
      ...(signatureHtml && !alreadySigned ? { signatureHtml } : {}),
      ...(signatureText && !alreadySigned ? { signatureText } : {}),
    });
  };
  const authName = (): string => repo.getOrganization(1)?.name?.trim() || organizationName(repo, 1);

  app.disable("x-powered-by");
  // Behind any reverse proxy (the preview environment included) req.ip is the
  // proxy's address unless this is set — which makes every per-IP rate
  // limiter a single global counter for ALL users. Opt in via TRUST_PROXY=1.
  if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);
  // A webhook POST is parsed by the ingest route itself, under a cap measured in
  // tens of kilobytes rather than megabytes: an unauthenticated caller must not
  // be able to hand the process a 2 MB document to parse before anyone has
  // decided whether its key is even valid. The console forms keep their limits.
  const ingestPayloadLimit = envInt(process.env.WEBHOOK_MAX_PAYLOAD_BYTES, 65_536);
  // Case-insensitive because Express matches routes case-insensitively: a caller
  // reaching /API/V1/ingest/... must not be handed back to the 2 MB global parser
  // (which is both a looser cap and a path where an oversized body escapes this
  // endpoint's own 413 answer).
  const ingestPrefix = WEBHOOK_PATH_PREFIX.toLowerCase();
  const ownsOwnBody = (req: Request): boolean => req.path.toLowerCase().startsWith(ingestPrefix);
  const skipIngestBody = (handler: RequestHandler): RequestHandler =>
    ((req, res, next) => (ownsOwnBody(req) ? (next as () => void)() : handler(req, res, next))) as RequestHandler;
  app.use(skipIngestBody(express.urlencoded({ extended: true, limit: "2mb" })));
  app.use(skipIngestBody(express.json({ limit: "1mb" })));
  app.use(authMiddleware(repo));

  const c = (req: Request) => ({
    repo,
    user: req.staff!,
    unread: repo.unreadCount(req.staff!.id, req.staff!.demo, repo.caseScopeFor(req.staff!)),
    csrf: req.csrfToken ?? "",
    theme: req.theme,
    institution: instName(req),
    brand: repo.getOrganization(organizationId(req)) ? {
      ...organizationTheme(repo, organizationId(req)),
      logo: repo.getOrganization(organizationId(req))!.logo,
      tagline: organizationId(req) === 1 ? repo.getSetting("splash_tagline", "") : "",
    } : undefined,
    // Reflect the same settings-backed connection that the sync loop uses.
    // Previously this only exposed env credentials, so a Gmail account saved
    // in Settings appeared disconnected everywhere in the console.
    gmailConfigured: repo.getSetting("gmail_disabled", "") !== "1" && (
      Boolean(gmailConfigured) ||
      Boolean(repo.getSetting("gmail_address", "").trim() && repo.getSetting("gmail_client_id", "").trim() && repo.hasSecret("gmail_client_secret") && repo.hasSecret("gmail_refresh_token"))
    ),
    gmailAddress: repo.getSetting("gmail_address", "").trim() || deps.gmailAddress,
    // Honesty about delivery: MockSender records, GmailSender sends. Anything
    // that cannot state it delivers raises the banner, exactly like the send
    // paths that refuse to record a delivery.
    mailDelivers: ctx.adapters?.sender?.delivers === true,
    // Is a stored Gemini credential reachable for this installation?
    geminiAvailable: geminiCredentials() !== null,
  });

  const settingsBack = (message: string) => `/settings?msg=${encodeURIComponent(message)}#connections`;
  const requireCase = (req: Request, res: Response, id: number): ApplicantRow | null => {
    const row = repo.getCase(id);
    if (!row || !repo.applicantVisibleTo(req.staff!, row)) { res.status(404).send("Case not found."); return null; }
    return row;
  };

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

  // Browser-tab mark: the aᵃ SVG; organization logos remain stored on their organization row.
  app.get("/assets/favicon", (_req, res) => {
    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=604800");
    res.send(Buffer.from(FAVICON_BASE64, "base64"));
  });

  // Self-hosted typefaces (no CDN): Manrope variable font for the full interface.
  // BUG-14: the Instrument Serif faces were removed with the redesign; their
  // @font-face rules are gone, so shipping the blobs and answering two routes
  // nobody can reach any more was dead weight.
  const fontRoutes: Array<[string, string]> = [
    ["/assets/fonts/manrope.woff2", FONT_MANROPE_WOFF2],
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
      // Scoped to the acting organization: an installation-global banner would
      // end up on every other tenant's mail (BUG-10).
      const bannerOrg = ownOrganizationId(req);
      setOrgSetting(repo, "email_banner", bannerOrg, buf.toString("base64"));
      setOrgSetting(repo, "email_banner_mime", bannerOrg, mime);
      repo.audit(null, req.staff!.username, "email_banner_changed", `${(buf.length / 1024).toFixed(0)} KB ${mime}`);
      res.redirect(back("Email banner updated — every outgoing email now carries it."));
    }
  );

  app.post("/config/branding/signature", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const fields = ["signature_name", "signature_title", "signature_phone", "signature_line"] as const;
    const signatureOrg = ownOrganizationId(req);
    for (const key of fields) {
      const val = String(req.body[key] ?? "").trim().slice(0, 200);
      setOrgSetting(repo, key, signatureOrg, val);
    }
    repo.audit(null, req.staff!.username, "email_signature_changed", "signature fields updated");
    res.redirect(`/config?msg=${encodeURIComponent("Email signature saved.")}#signature`);
  });

  app.post("/config/classifier-prompt", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const prompt = String(req.body.classifier_prompt ?? "").trim().slice(0, 4000);
    setOrgSetting(repo, "classifier_prompt", ownOrganizationId(req), prompt);
    repo.audit(null, req.staff!.username, "classifier_prompt_changed", prompt ? `${prompt.length} chars` : "cleared");
    res.redirect(`/config?msg=${encodeURIComponent(prompt ? "Classifier guidance saved." : "Classifier guidance cleared.")}#classifier`);
  });

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
  const setNoStore = (res: Response): void => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
  };

  app.use((req, res, next) => {
    if (repo.staffCount() === 0 && req.path !== "/setup" && req.path !== "/healthz" && req.path !== "/theme" && !ownsOwnBody(req)) {
      res.redirect("/setup");
      return;
    }
    next();
  });

  app.get("/setup", (req, res) => {
    if (repo.staffCount() > 0) {
      res.redirect(`/login?msg=${encodeURIComponent("Setup is already complete. Sign in with your account.")}`);
      return;
    }
    setNoStore(res);
    res.send(setupPage(newSetupToken(), undefined, req.theme, authName()));
  });

  app.post("/setup", (req, res) => {
    if (repo.staffCount() > 0) {
      // Setup may have succeeded even if the browser lost its session cookie or
      // a double-submit raced the first POST. Never create another admin here;
      // guide the owner to sign in instead of showing a confusing 404.
      res.redirect(`/login?msg=${encodeURIComponent("Setup is already complete. Sign in with your account.")}`);
      return;
    }
    const fail = (msg: string) => {
      setNoStore(res);
      return res.status(200).send(setupPage(newSetupToken(), msg, req.theme, authName()));
    };
    const token = String(req.body._setup ?? "");
    const exp = setupTokens.get(token);
    setupTokens.delete(token);
    if (!exp || exp < Date.now()) return fail("That setup link expired — reload the page and try again.");
    // M-2: one shared rule — normalizeUsername() + USERNAME_RE — used by
    // /setup, /staff/add and /account/username alike.
    const organizationName = String(req.body.organization_name ?? "").trim();
    if (organizationName.length < 2 || organizationName.length > 120) return fail("Organization name must be 2–120 characters.");
    const username = normalizeUsername(req.body.username);
    const displayName = String(req.body.display_name ?? "").trim();
    const password = String(req.body.password ?? "");
    const confirm = String(req.body.confirm ?? "");
    if (!displayName) return fail("Please enter your name.");
    if (!USERNAME_RE.test(username)) return fail("Username: 2-32 characters — letters, digits, dots, dashes.");
    if (password.length < 8) return fail("Password must be at least 8 characters.");
    if (password !== confirm) return fail("The passwords do not match.");
    if (repo.getStaffByUsername(username)) return fail("That username is already taken.");
    const session = repo.db.transaction(() => {
      if (repo.staffCount() !== 0) throw new Error("Setup was already completed");
      const organization = repo.createOrganization({ name: organizationName });
      // Neutral starter reply wording, owned by this organization and editable
      // or resettable afterwards. Without it no automated reply can render at
      // all — the pipeline would have nothing to say. Case types, checklists,
      // rules and files stay blank: those are the tenant's to describe.
      seedStarterTemplates(repo, organization.id);
      repo.createStaff(username, displayName, hashPassword(password), "admin", false, organization.id);
      const created = repo.getStaffByUsername(username)!;
      repo.audit(null, username, "first_run_setup", "Blank organization and administrator created together (starter reply templates included)");
      return repo.createSession(created.id);
    })();
    res.setHeader("Set-Cookie", sessionCookie(session.token, 8 * 3600, secureCookies, partitionedCookies));
    res.redirect("/");
  });

  // The preview may be embedded cross-site. Secure cookie deployments can
  // opt into CHIPS partitioning so the session survives browsers that block
  // unpartitioned third-party cookies. Local HTTP keeps the Lax defaults.
  const secureCookies = process.env.COOKIE_SECURE === "1";
  const partitionedCookies = secureCookies && process.env.COOKIE_PARTITIONED === "1";

  // Login-CSRF tokens are one-time, server-side values in the form, not a
  // double-submit cookie. This avoids browsers/proxies dropping the CSRF cookie
  // in an embedded preview, while cross-site forms still cannot read the token.
  const loginCsrfTokens = new Map<string, number>();
  const newLoginCsrf = (): string => {
    const token = crypto.randomBytes(24).toString("hex");
    loginCsrfTokens.set(token, Date.now() + 10 * 60_000);
    for (const [key, expires] of loginCsrfTokens) if (expires < Date.now()) loginCsrfTokens.delete(key);
    return token;
  };
  const consumeLoginCsrf = (token: string): boolean => {
    const expires = loginCsrfTokens.get(token);
    loginCsrfTokens.delete(token);
    return expires !== undefined && expires >= Date.now();
  };

  app.get("/login", (req, res) => {
    if (repo.staffCount() === 0) {
      res.redirect("/setup");
      return;
    }
    setNoStore(res);
    // ?msg= carries the one success notice (password just reset via code).
    res.send(loginPage(undefined, req.theme, authName(), newLoginCsrf(), req.query.msg ? String(req.query.msg) : undefined));
  });

  /** Theme toggle — public visitors may set their own preference, but an
   * authenticated POST must carry the same session CSRF token as other writes. */
  app.post("/theme", (req, res, next) => {
    if (req.staff) return csrfCheck(req, res, next);
    next();
  }, (req, res) => {
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
      setNoStore(res);
      res.status(429).send(loginPage("Too many failed sign-ins from this address — please wait a minute.", req.theme, authName(), newLoginCsrf()));
      return;
    }
    // The one-time form token is checked server-side. Multiple open login tabs
    // remain valid independently; missing/expired/forged tokens fail closed.
    const provided = String(req.body._lcsrf ?? "");
    if (!consumeLoginCsrf(provided)) {
      setNoStore(res);
      res.status(403).send(loginPage("That sign-in page expired — please try again.", req.theme, authName(), newLoginCsrf()));
      return;
    }
    const staff = loginAttempt(repo, String(req.body.username ?? ""), String(req.body.password ?? ""));
    if (!staff) {
      loginRecordFail(ip);
      setNoStore(res);
      res.status(401).send(loginPage("Invalid username or password.", req.theme, authName(), newLoginCsrf()));
      return;
    }
    const session = repo.createSession(staff.id);
    repo.audit(null, staff.username, "staff_login", "");
    res.setHeader("Set-Cookie", sessionCookie(session.token, 8 * 3600, secureCookies, partitionedCookies));
    res.redirect("/");
  });

  // Logout mutates auth state, so it needs CSRF like every other mutation —
  // otherwise a cross-site 1-pixel form could sign staff out mid-crisis.
  app.post("/logout", csrfCheck, (req, res) => {
    if (req.sessionId) repo.deleteSession(req.sessionId);
    res.setHeader("Set-Cookie", clearSessionCookie(secureCookies, partitionedCookies));
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
    setNoStore(res);
    res.send(resetPasswordPage(undefined, req.theme, authName(), newLoginCsrf()));
  });

  app.post("/reset-password", (req, res) => {
    const ip = req.ip ?? "?";
    if (!resetThrottle.allowed(ip)) {
      setNoStore(res);
      return res.status(429).send(resetPasswordPage("Too many reset attempts from this address — please wait a few minutes.", req.theme, authName(), newLoginCsrf()));
    }
    // The same one-time server-side form token used by /login works without
    // relying on an anonymous cookie in the hosted preview.
    const provided = String(req.body._lcsrf ?? "");
    if (!consumeLoginCsrf(provided)) {
      setNoStore(res);
      return res.status(403).send(resetPasswordPage("That page expired — please try again.", req.theme, authName(), newLoginCsrf()));
    }
    const refuse = (m: string) => {
      setNoStore(res);
      return res.send(resetPasswordPage(m, req.theme, authName(), newLoginCsrf()));
    };
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

  // DEMO: visible organization switcher (sidebar). Admin-only; the active
  // organization scopes queues, dashboards, mail, search, CaseTypes,
  // templates and branding for this admin.
  app.post("/org/switch", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    if (!req.staff!.can_switch_org) return res.status(403).send("403 — this account belongs to a single organization.");
    const id = Number(req.body.organization_id);
    const org = Number.isInteger(id) ? repo.getOrganization(id) : undefined;
    if (!org) return res.redirect("/?msg=" + encodeURIComponent("Unknown organization."));
    repo.setActiveOrganization(req.staff!.id, org.id);
    repo.audit(null, req.staff!.username, "organization_switched", `${org.id}:${org.name}`);
    res.redirect("/applicants?msg=" + encodeURIComponent(`Switched to ${organizationName(repo, org.id)}.`));
  });

  // DEMO: test intake — a simulated inbound message for one of the ACTIVE
  // organization's CaseTypes, processed by the real pipeline.
  app.get("/intake/test", requireLogin, requireRole("admin"), (req, res) => {
    res.send(intakeTestPage(c(req), { caseTypeCode: req.query.case_type ? String(req.query.case_type) : undefined, msg: req.query.msg ? String(req.query.msg) : undefined }));
  });
  app.post("/intake/test", requireLogin, requireRole("admin"), csrfCheck, async (req, res) => {
    const orgId = organizationId(req);
    const ct = repo.getCaseType(String(req.body.case_type ?? ""), orgId);
    if (!ct) return res.redirect("/intake/test?msg=" + encodeURIComponent("Unknown CaseType for this organization."));
    const from = String(req.body.from ?? "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(from)) return res.redirect(`/intake/test?case_type=${encodeURIComponent(ct.code)}&msg=` + encodeURIComponent("A valid contact email is required."));
    const fromName = String(req.body.from_name ?? "").trim().slice(0, 80);
    const wanted = new Set(([] as string[]).concat(req.body.doc ?? []).map(String));
    const slots = repo.listDocumentDefinitions(ct.id).filter((d) => wanted.has(d.key));
    const body = String(req.body.body ?? "").slice(0, 8000);
    const factLines = body.split(/\r?\n/).filter((l) => /^[A-Za-z][A-Za-z0-9 _/-]{1,40}:\s*\S/.test(l.trim()));
    const attachments = await Promise.all(slots.map(async (d) => ({
      filename: `${d.key}.pdf`,
      mimeType: "application/pdf",
      content: await makeTextPdf([d.label, `Name: ${fromName || from}`, ...factLines]),
    })));
    const stamp = Date.now().toString(36);
    try {
      const result = await processEmail({
        id: `test-intake-${stamp}`, threadId: `test-intake-${stamp}`, from, fromName: fromName || undefined,
        subject: String(req.body.subject ?? ct.name).slice(0, 200) || ct.name, body,
        receivedAt: new Date().toISOString(), attachments, organizationId: orgId, caseTypeCode: ct.code,
      }, ctx);
      if (!result.applicantId) return res.redirect(`/intake/test?case_type=${encodeURIComponent(ct.code)}&msg=` + encodeURIComponent("The message was parked by the intake gate (no case opened). Mention the CaseType in the subject."));
      repo.audit(result.applicantId, req.staff!.username, "test_intake_submitted", `${ct.code}: ${slots.length} document(s)`);
      return res.redirect(backToCase(result.applicantId, `Test message processed for ${ct.name}.`));
    } catch (e) {
      return res.redirect(`/intake/test?case_type=${encodeURIComponent(ct.code)}&msg=` + encodeURIComponent(`Processing failed: ${(e as Error).message}`));
    }
  });

  app.get("/applicants", requireLogin, (req, res) => {
    res.send(
      applicantsPage(c(req), {
        search: req.query.q ? String(req.query.q) : undefined,
        queue: req.query.queue ? String(req.query.queue) : undefined,
        sub: req.query.sub ? String(req.query.sub) : undefined,
        // The public filter parameter is case_type; it resolves against
        // applicants.case_type_code (renamed from `programme` by C2).
        caseType: req.query.case_type ? String(req.query.case_type) : undefined,
        intake: req.query.intake ? String(req.query.intake) : undefined,
      })
    );
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
        title: "Outside your case types",
        institution: instName(req),
        user: req.staff,
        unread: repo.unreadCount(req.staff!.id, req.staff!.demo, repo.caseScopeFor(req.staff!)),
        csrf: req.csrfToken,
        content: `<div class="card" style="max-width:560px;margin:60px auto;text-align:center">
          <h1>This case is outside your assigned case types</h1>
          <p class="sub">You can only open cases whose case type you handle. If this should be yours, ask an administrator to update your visibility scope.</p>
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
      if (e instanceof MailDeliveryUnavailableError) {
        repo.audit(id, req.staff!.username, "email_not_delivered", `held draft "${subject}" remains queued because mail is not connected`);
        return res.redirect(backToCase(id, "Mail is not connected — draft remains queued."));
      }
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
        // no enforcement; the generic profile keeps its generated matrix
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
  // Entries past the window are worthless, so the map is pruned by age on each
  // call. The previous shape capped the size with `recentSends.clear()`, which
  // discarded EVERY in-flight guard the moment a busy office crossed the cap —
  // the same bulk-wipe mistake src/web/throttle.ts documents for logins, and
  // here it silently re-opened the duplicate send the guard exists to prevent.
  // Rapid double-click protection for template sends: the same officer sending
  // the same template to the same case within 5 s is treated as one action
  // (see SendGuard for why the window is pruned instead of cleared).
  const sendGuard = new SendGuard();
  const sendGuardOk = (key: string): boolean => sendGuard.allow(key);

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
      if (e instanceof MailDeliveryUnavailableError) {
        repo.audit(id, req.staff!.username, "email_not_delivered", `manual template reply "${rendered.subject}" not sent because mail is not connected`);
        return res.redirect(backToCase(id, "Mail is not connected — no reply was sent."));
      }
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
    const tpl = repo.getTemplate("docs_request", organizationId(req));
    if (!tpl) return res.redirect(backToCase(id, "Template missing — nothing sent."));
    const rendered = renderTemplate(tpl.subject, tpl.body, {
      ref: a.ref_number,
      institution: instName(req),
      name: a.full_name ?? undefined,
      missingLabels: [],
      checklist: "",
      statusLabel: LIFECYCLE_LABELS[a.lifecycle],
      caseType: repo.caseTypeForCase(a.id)?.name,
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
      if (e instanceof MailDeliveryUnavailableError) {
        repo.audit(id, req.staff!.username, "email_not_delivered", `manual attachment-set reply "${rendered.subject}" not sent because mail is not connected`);
        return res.redirect(backToCase(id, "Mail is not connected — no reply was sent."));
      }
      repo.audit(id, req.staff!.username, "send_failed", (e as Error).message);
      return res.redirect(backToCase(id, `Send failed: ${(e as Error).message}`));
    }
    repo.insertEmail({
      applicant_id: id, message_id: `pack-${Date.now()}`, thread_id: a.thread_id, direction: "out",
      from_addr: "", to_addr: a.email_address, subject: rendered.subject, body: rendered.body, category: null, auto: 0,
      at: new Date().toISOString(),
      attachments: pack.files.map((f) => f.filename),
    });
    staffAction(req, id, "attachment_set_sent",
      `${pack.files.length} document(s): "${rendered.subject}"`);
    const packWarn = pack.issues.length
      ? ` ⚠ ${pack.issues.length} pack file(s) missing — see audit.`
      : "";
    res.redirect(backToCase(id, `Attachment set “${pack.label}” sent — ${pack.files.length} document(s) attached.${packWarn}`));
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
      caseType: repo.caseTypeForCase(a.id)?.name,
    });

  // ── Gmail-style mail window ─────────────────────────────────────────────────
  // Every conversation (received AND sent), grouped by thread, newest first.
  // Incoming mail arrives unread; opening a conversation reads it. Scoped by
  // case-type scope and demo realm exactly like every other case surface.
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
    const baseOpts = { caseTypes: repo.caseScopeFor(req.staff!), demo: req.staff!.demo };
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
        unread: repo.unreadCount(req.staff!.id, req.staff!.demo, repo.caseScopeFor(req.staff!)),
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
      title: "Outside your case types",
      institution: instName(req),
      user: req.staff,
      unread: repo.unreadCount(req.staff!.id, req.staff!.demo, repo.caseScopeFor(req.staff!)),
      csrf: req.csrfToken,
      content: `<div class="card" style="max-width:560px;margin:60px auto;text-align:center">
        <h1>This case is outside your assigned case types</h1>
        <p class="sub">You can only reach cases whose case type you handle. If this should be yours, ask an administrator to update your visibility scope.</p>
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
    const scope = repo.caseScopeFor(req.staff!);
    const q = req.query.q !== undefined ? String(req.query.q).trim() : undefined;
    const matches = repo.searchApplicants({
      q: q || undefined, demo: req.staff!.demo, caseTypes: scope, limit: 8,
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
      const unavailable = e instanceof MailDeliveryUnavailableError;
      repo.audit(a.id, req.staff!.username, unavailable ? "email_not_delivered" : "send_failed",
        unavailable ? `manual compose reply "${subject}" not sent because mail is not connected` : (e as Error).message);
      return res.send(composeWindowPage(c(req), {
        applicant: a, templateKey: tpl?.key, subject, body,
        error: unavailable ? "Mail is not connected — no reply was sent." : `Send failed: ${(e as Error).message}`,
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
    const existing = requireCase(req, res, id);
    if (!existing) return;
    const staffId = req.body.staff_id ? Number(req.body.staff_id) : null;
    // An unknown staff id violates the assigned_to FK and would 500 —
    // validate before writing.
    if (staffId !== null && !repo.getStaff(staffId)) {
      return res.redirect(backToCase(id, "Unknown staff member — not assigned."));
    }
    repo.updateApplicant(id, { assigned_to: staffId });
    const updated = requireCase(req, res, id);
    if (!updated) return;
    const who = staffId ? repo.getStaff(staffId)?.display_name : "nobody";
    staffAction(req, id, "case_assigned", `assigned to ${who}`);
    if (staffId) repo.notify("assignment", `${updated.ref_number} assigned to you`, id, staffId);
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

  app.get("/cases", requireLogin, (req, res) => res.send(casesPage(c(req), String(req.query.stage ?? "all"))));

  app.post("/case/:id/outcome", requireLogin, requirePermission("record_outcome"), csrfCheck, (req, res) => {
    const id = Number(req.params.id);
    const a = requireCase(req, res, id);
    if (!a) return;
    const outcome = String(req.body.outcome ?? "");
    const reason = String(req.body.reason ?? "").trim();
    if (!["approved_after_review", "not_approved", "undecided"].includes(outcome)) return res.redirect(backToCase(id, "Unknown outcome — nothing changed."));
    if (!reason || reason.length > 2000) return res.redirect(backToCase(id, "A reason of 1–2000 characters is required for every human outcome."));
    repo.recordHumanOutcome(id, {
      outcome: outcome as "approved_after_review" | "not_approved" | "undecided",
      actor: req.staff!.username,
      reason,
    });
    res.redirect(backToCase(id, "Human outcome recorded."));
  });

  /**
   * Phase D2 (Q7 step 1) — the routing safety valve: a person moves a case to
   * the right case type when the sender or the machine put it in the wrong one.
   *
   * It changes configuration context and nothing else. No mail is sent, no
   * workflow rule fires, and no verdict is recomputed: the case adopts the new
   * type's checklist and rules (re-frozen, so what staff see and what the next
   * evaluation uses agree), while the recorded verdict stays exactly as a human
   * or the pipeline left it until somebody presses Re-evaluate. The settled
   * owner choice is freeze-only: do not re-evaluate automatically (see
   * BUGS.md#resolved-product-decisions).
   */
  app.post("/case/:id/case-type", requireLogin, csrfCheck, (req, res) => {
    const id = Number(req.params.id);
    const a = requireCase(req, res, id);
    if (!a) return;
    // The target must be one of THIS case's organization's types: a forged id
    // must never move a case into another tenant's configuration.
    const caseOrg = a.organization_id ?? organizationId(req);
    const target = repo.listCaseTypes(caseOrg).find((t) => t.id === Number(req.body.case_type_id));
    if (!target) return res.redirect(backToCase(id, "Unknown case type for this organization — nothing changed."));
    const before = repo.caseTypeForCase(id);
    if (before?.id === target.id) return res.redirect(backToCase(id, `This case is already ${target.name} — nothing changed.`));
    repo.updateCase(id, { case_type_id: target.id });
    const updated = requireCase(req, res, id);
    if (!updated) return;
    repo.reFreezeCaseConfig(updated);
    repo.audit(id, req.staff!.username, "case_type_changed",
      `${before?.code ?? "unconfigured"} → ${target.code}; checklist re-frozen, verdict unchanged, nothing sent`);
    res.redirect(backToCase(id, `Moved to ${target.name}. Its checklist and rules apply from here; the recorded verdict predates the change — use Re-evaluate to recompute it. Nothing was sent.`));
  });

  app.post("/case/:id/reevaluate", requireLogin, csrfCheck, (req, res) => {
    const id = Number(req.params.id);
    const a = requireCase(req, res, id);
    if (!a) return;
    if (String(req.body.upgrade ?? "") === "1") {
      if (!repo.hasPermission(req.staff!.id, "publish_rules")) return res.status(403).send("Publishing permission is required to upgrade a case configuration.");
      repo.reFreezeCaseConfig(a);
      repo.audit(id, req.staff!.username, "case_config_upgraded", "Explicitly adopted current configuration; outcomes are unchanged");
    }
    try {
      const report = evaluateStoredCase(repo, id);
      res.redirect(backToCase(id, `Evidence re-evaluated: ${report.result}. Outcome unchanged.`));
    } catch (error) {
      res.redirect(backToCase(id, `Could not evaluate: ${(error as Error).message}`));
    }
  });

  /**
   * Record the axis values a case is assessed against, then re-freeze its
   * checklist against the current configuration.
   *
   * Axes are how one case type serves several situations ("a Kenyan applicant
   * needs a KRA PIN, an international applicant needs a visa"). Without a
   * selection recorded, every slot applies — so this is additive and a tenant
   * that never defines an axis is entirely unaffected.
   */
  app.post("/case/:id/axes", requireLogin, csrfCheck, (req, res) => {
    const id = Number(req.params.id);
    const a = requireCase(req, res, id);
    if (!a) return;
    const type = repo.caseTypeForCase(id);
    if (!type) return res.redirect(backToCase(id, "Give this case a case type before setting its axes — nothing changed."));
    const axes = repo.listOrganizationDocumentAxes(a.organization_id ?? organizationId(req));
    const selections: Record<string, string> = {};
    for (const axis of axes) {
      const raw = String((req.body as Record<string, unknown>)[`axis_${axis.key}`] ?? "").trim();
      if (raw && axis.values.includes(raw)) selections[axis.key] = raw;
    }
    const before = repo.axisSelections(a);
    const changed = JSON.stringify(before) !== JSON.stringify(selections);
    if (changed) {
      repo.setAxisSelections(id, selections);
      const updated = requireCase(req, res, id);
      if (!updated) return;
      // Re-freeze so the checklist this case is measured against matches the
      // selection, exactly as changing a case type does. The verdict is left
      // alone: evidence is re-derived by the Re-evaluate action, never here.
      repo.reFreezeCaseConfig(updated);
      repo.audit(id, req.staff!.username, "case_axes_changed",
        `${JSON.stringify(before)} → ${JSON.stringify(selections)}; checklist re-frozen, outcome unchanged`);
    }
    res.redirect(backToCase(id, changed
      ? "Axes updated — the checklist now shows only the slots that apply to this case. The recorded outcome is untouched; use Re-evaluate to re-check the evidence."
      : "Axes unchanged."));
  });

  app.post("/config/reevaluate-open", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    let checked = 0;
    let failed = 0;
    for (const row of repo.listCasesForStaff(req.staff!).filter((a) => a.lifecycle !== "completed")) {
      try { evaluateStoredCase(repo, row.id); checked++; }
      catch { failed++; }
    }
    repo.audit(null, req.staff!.username, "cases_reevaluated", `checked=${checked}; failed=${failed}; organization=${organizationId(req)}`);
    res.redirect(`/config?tab=requirements&msg=${encodeURIComponent(`Re-evaluated ${checked} open cases; ${failed} require configuration repair. No outcomes changed.`)}`);
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

  // M-2: the same normalization + pattern as /setup and /staff/add. (This
  // route previously accepted ANY string of 3+ characters — spaces, upper
  // case, symbols — so the account it produced could not be re-typed
  // consistently anywhere else.)
  app.post("/account/username", requireLogin, csrfCheck, (req, res) => {
    const next = normalizeUsername(req.body.username);
    if (!USERNAME_RE.test(next)) {
      return res.redirect(accountMsg("Usernames: 2-32 characters — letters, digits, dots, dashes."));
    }
    const clash = repo.getStaffByUsername(next);
    if (clash && clash.id !== req.staff!.id) return res.redirect(accountMsg(`“${next}” is already taken by another account.`));
    repo.setStaffUsername(req.staff!.id, next);
    repo.audit(null, next, "account_username_changed", `was “${req.staff!.username}”`);
    res.redirect(accountMsg("Username updated."));
  });

  /**
   * Let a person correct the name colleagues see.
   *
   * The display name was set once at account creation and could never be
   * changed again — not by its owner, not by an administrator — so a typo
   * followed someone through every queue, report and audit entry for good.
   */
  app.post("/account/display-name", requireLogin, csrfCheck, (req, res) => {
    const name = String(req.body.display_name ?? "").trim().replace(/\s+/g, " ");
    if (name.length < 2 || name.length > 80) return res.redirect(accountMsg("Your name must be 2–80 characters — nothing changed."));
    const before = req.staff!.display_name;
    if (name === before) return res.redirect(accountMsg("That is already your name."));
    repo.setStaffDisplayName(req.staff!.id, name);
    repo.audit(null, req.staff!.username, "account_display_name_changed", `“${before}” → “${name}”`);
    res.redirect(accountMsg(`Your name is now “${name}”.`));
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

  // ── Admin security console (strictly the active tenant; read-only) ────────
  app.get("/admin/security", requireLogin, requireRole("admin"), (req, res) => {
    const ownOrganizationId = organizationId(req);
    const requestedOrganizationId = req.query.organization_id;
    // There is deliberately no tenant selector on this page. Reject an
    // attempted cross-organization override instead of trusting a URL value.
    if (requestedOrganizationId !== undefined
      && (!/^\d+$/.test(String(requestedOrganizationId)) || Number(requestedOrganizationId) !== ownOrganizationId)) {
      return res.status(404).send("Security records not found.");
    }
    return res.send(securityConsolePage(c(req)));
  });

  // ── Settings (manager+) ──────────────────────────────────────────────────

  // 'it' role: cases + configuration, but not staff management.
  app.get("/settings", requireLogin, requireRole("admin"), (req, res) =>
    res.send(settingsPage(
      c(req),
      req.query.msg ? String(req.query.msg) : undefined,
      gmailRedirectUri(repo, req.protocol, req.get("host") ?? "localhost"),
      publicOrigin(repo, req.protocol, req.get("host") ?? "localhost"),
      // Issued on demand so a tenant that predates this feature gets a key the
      // first time its admin opens the page — no migration, no redeploy.
      repo.ensureWebhookIngestKey(organizationId(req))
    ))
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
      seedStarterTemplates(repo, organization.id);
      repo.audit(null, req.staff!.username, "organization_created", `${organization.name} (${organization.ref_prefix})`);
      return res.redirect(`/config?tab=case-types&organization=${organization.id}&msg=${encodeURIComponent(`Organization ${organization.name} created — an empty CaseType catalogue, with the neutral starter reply templates ready to edit.`)}`);
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
    for (let i = 0; i < 8; i++) {
      const field = String((body as Record<string, string>)[`cond_field_${i}`] ?? "").trim();
      const value = String((body as Record<string, string>)[`cond_value_${i}`] ?? "").trim();
      // "match / does not match" — the only operator a condition row exposes.
      // Anything else stays in the raw JSON box, which is still authoritative.
      const negated = String((body as Record<string, string>)[`cond_op_${i}`] ?? "").trim() === "not";
      if (!field) continue;
      if (field === "always") out.push({ field: "always", value: true });
      else if (field === "sender_state") out.push({ field: "sender_state", value: value.toLowerCase() === "known" ? "known" : "unknown" });
      else if (field === "has_attachments") out.push({ field: "has_attachments", value: ["yes", "true", "1"].includes(value.toLowerCase()) });
      else if (field === "body_is_ref") out.push({ field: "body_is_ref", value: true });
      else if (field === "signals") out.push({ field: "signals", value: "configured_intake" });
      else if (field === "category") out.push({ field: "category", op: negated ? "not_in" : "in", values: value.split(",").map((s) => s.trim()).filter(Boolean) });
      else if (field === "docs_state") {
        const values = value.split(",").map((s) => s.trim()).filter(Boolean);
        out.push({ field: "docs_state", values: (values.length ? values : ["any"]) as never });
      } else if (field === "text" || field === "subject" || field === "body") {
        out.push({ field, op: negated ? "not_contains" : "contains_any", values: value.split(",").map((s) => s.trim()).filter(Boolean) });
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
      // H-3 (rules): a hand-crafted POST cannot hang rules on another
      // tenant's profile — the acting admin only rules their own org.
      if (orgId !== (req.staff!.organization_id ?? 1)) {
        return res.redirect(`/config?tab=rules&msg=${encodeURIComponent("That CaseType belongs to another organization — rule not saved.")}`);
      }
      const conditions = parseRuleConditions(req.body);
      const action = parseRuleAction(req.body);
      // Refuse to arm a rule that names wording this organization does not
      // have: a rule pointing at a missing template silently produces no reply
      // at all, which reads to staff as "the system ignored the message".
      const wantedTemplate = typeof action.template_key === "string" ? action.template_key.trim() : "";
      if (wantedTemplate && !repo.getTemplate(wantedTemplate, orgId, caseTypeId ?? undefined)) {
        return res.redirect(`/config?tab=rules&msg=${encodeURIComponent(`Rule was not saved: this organization has no template '${wantedTemplate}' — create it under Templates first.`)}`);
      }
      const saved = repo.saveWorkflowRule({
        id: req.body.id ? Number(req.body.id) : undefined,
        organizationId: orgId,
        caseTypeId,
        kind,
        name,
        position: req.body.position !== "" && req.body.position !== undefined ? Number(req.body.position) : undefined,
        // BUG-06: the flowchart submits the rule's current on/off state, so
        // editing a parked rule leaves it parked. The advanced form carries no
        // `enabled` field at all and keeps its historical behaviour of
        // enabling whatever it saves.
        enabled: String(req.body.enabled ?? "1") !== "0",
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
        intakeSignals: "open" as const,
        docsState,
        docsOnFile: docsState === "empty" ? 0 : 3,
      };
      // Who else is in the running: the scope's published rules plus this one.
      const scopeRules = rulesForCaseScope(
        repo.listWorkflowRules(orgId, { kind }), caseTypeId, caseTypeId === null,
      );
      // Same comparator the pipeline uses, so "who would win" here is the same
      // answer the pipeline would give (BUG-07: it used to sort on position
      // alone and could disagree with firstMatchingRule).
      const ordered = [...scopeRules, proposed].sort(compareRuleOrder);
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
    // H-3 (rules): toggle only the acting organization's rules — the delete
    // route is already scoped; this route must agree with it.
    if (rule && rule.organization_id !== (req.staff!.organization_id ?? 1)) return res.redirect("/config?tab=rules");
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

  /**
   * Reorder one step inside its own chain.
   *
   * The flowchart says "first match wins", so the order has to be editable
   * from the flowchart itself — otherwise the only way to reprioritise a rule
   * is to retype a number in the advanced form and hope it is right. The
   * scope is the repository's, which is the same grouping the diagram draws.
   */
  app.post("/config/workflow-rules/move", requireLogin, requirePermission("publish_rules"), csrfCheck, (req, res) => {
    const id = Number(req.body.id);
    const dir = String(req.body.dir) === "up" ? "up" : "down";
    const rule = repo.getWorkflowRule(id);
    if (rule && rule.organization_id !== (req.staff!.organization_id ?? 1)) return res.redirect("/config?tab=rules");
    const order = rule ? repo.moveWorkflowRule(id, rule.organization_id, dir) : null;
    if (!order) {
      return res.redirect(`/config?tab=rules&msg=${encodeURIComponent(dir === "up" ? "That step is already first in its chain." : "That step is already last in its chain.")}`);
    }
    repo.audit(null, req.staff!.username, "workflow_rule_moved", `${rule!.name} (#${id}) ${dir} — chain now ${order.join(" > ")}`);
    res.redirect(`/config?tab=rules&msg=${encodeURIComponent(`“${rule!.name}” moved ${dir}. Rules above it are tried first.`)}`);
  });

  app.post("/config/case-types/vocabulary", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const id = Number(req.body.id);
    // Tenant guard: only this administrator's own profiles are addressable —
    // a foreign id is indistinguishable from an unknown one.
    const ct = repo.listCaseTypes(ownOrganizationId(req)).find((x) => x.id === id);
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
        case: b.term_case?.trim() || "Case",
        contact: b.term_contact?.trim() || "Contact",
        category: b.term_category?.trim() || "Category",
        stage: b.term_stage?.trim() || "Stage",
        outcome: b.term_outcome?.trim() || "Outcome",
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
      evidence_gate: String(req.body.evidence_gate) === "0" ? 0 : 1,
    });
    repo.audit(null, req.staff!.username, "workflow_profile_saved", `${ct.code}: default_reply_action=${String(req.body.default_reply_action)}, evidence_gate=${String(req.body.evidence_gate)}`);
    res.redirect(`/config?tab=rules&msg=${encodeURIComponent(`Profile “${ct.name}” updated.`)}`);
  });

  app.post("/config/case-types/create", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const organizationId = Number(req.body.organization_id);
    // Tenant guard: configuration writes only ever reach the acting
    // administrator's own organization, whatever the form claims.
    if (organizationId !== ownOrganizationId(req)) return res.redirect(`/config?tab=case-types&msg=${encodeURIComponent("That configuration belongs to another organization — nothing was saved.")}`);
    const code = String(req.body.code ?? "").trim();
    const name = String(req.body.name ?? "").trim();
    const category = String(req.body.category ?? "general").trim() || "general";
    if (!repo.getOrganization(organizationId) || !code || !name) return res.redirect(`/config?tab=case-types&msg=${encodeURIComponent("A valid organization, CaseType code and name are required.")}`);
    const ct = repo.createCaseType(organizationId, { code, name, category, config: { rules: [] } });
    repo.audit(null, req.staff!.username, "case_type_created", `${organizationId}:${ct.code}`);
    res.redirect(`/config?tab=case-types&organization=${organizationId}#case-type-${ct.id}`);
  });

  /**
   * Rename / re-code / re-categorise a case type and retire it again.
   *
   * A case type is created once and then referenced by cases, aliases,
   * templates and workflow rules, so there was previously no way at all to
   * correct a typo in its name or code. Retiring is a soft delete: the type
   * leaves every picker and stops routing mail, but the cases that froze its
   * configuration keep their history.
   */
  app.post("/config/case-types/update", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const organizationId = Number(req.body.organization_id);
    if (organizationId !== ownOrganizationId(req)) return res.redirect(`/config?tab=case-types&msg=${encodeURIComponent("That configuration belongs to another organization — nothing was saved.")}`);
    const caseTypeId = Number(req.body.case_type_id);
    const ct = repo.listCaseTypes(organizationId).find((x) => x.id === caseTypeId);
    if (!ct) return res.redirect(`/config?tab=case-types&organization=${organizationId}&msg=${encodeURIComponent("Unknown CaseType — nothing was saved.")}`);
    try {
      repo.updateCaseTypeIdentity(caseTypeId, {
        name: req.body.name === undefined ? undefined : String(req.body.name),
        code: req.body.code === undefined ? undefined : String(req.body.code),
        category: req.body.category === undefined ? undefined : String(req.body.category),
      });
      const saved = repo.caseTypeById(caseTypeId)!;
      repo.audit(null, req.staff!.username, "case_type_updated", `${organizationId}:${ct.code} → ${saved.code} (“${saved.name}”)`);
      return res.redirect(`/config?tab=case-types&organization=${organizationId}&msg=${encodeURIComponent(`Case type “${saved.name}” updated.`)}#case-type-${caseTypeId}`);
    } catch (e) {
      return res.redirect(`/config?tab=case-types&organization=${organizationId}&msg=${encodeURIComponent(`Case type was not updated: ${(e as Error).message}`)}#case-type-${caseTypeId}`);
    }
  });

  app.post("/config/case-types/retire", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const organizationId = Number(req.body.organization_id);
    if (organizationId !== ownOrganizationId(req)) return res.redirect(`/config?tab=case-types&msg=${encodeURIComponent("That configuration belongs to another organization — nothing was changed.")}`);
    const caseTypeId = Number(req.body.case_type_id);
    const ct = repo.listCaseTypes(organizationId).find((x) => x.id === caseTypeId);
    if (!ct) return res.redirect(`/config?tab=case-types&organization=${organizationId}&msg=${encodeURIComponent("Unknown CaseType — nothing was changed.")}`);
    try {
      repo.retireCaseType(caseTypeId);
      repo.audit(null, req.staff!.username, "case_type_retired", `${organizationId}:${ct.code} — stopped routing; history kept`);
      return res.redirect(`/config?tab=case-types&organization=${organizationId}&msg=${encodeURIComponent(`“${ct.name}” retired. Existing cases keep their history; its addresses and rules stopped.`)}`);
    } catch (e) {
      return res.redirect(`/config?tab=case-types&organization=${organizationId}&msg=${encodeURIComponent(`Case type was not retired: ${(e as Error).message}`)}`);
    }
  });

  app.post("/config/case-types/reactivate", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const organizationId = Number(req.body.organization_id);
    if (organizationId !== ownOrganizationId(req)) return res.redirect(`/config?tab=case-types&msg=${encodeURIComponent("That configuration belongs to another organization — nothing was changed.")}`);
    const caseTypeId = Number(req.body.case_type_id);
    try {
      const ct = repo.listRetiredCaseTypes(organizationId).find((x) => x.id === caseTypeId);
      if (!ct) return res.redirect(`/config?tab=case-types&organization=${organizationId}&msg=${encodeURIComponent("Unknown retired CaseType.")}`);
      repo.reactivateCaseType(caseTypeId);
      repo.audit(null, req.staff!.username, "case_type_reactivated", `${organizationId}:${ct.code}`);
      return res.redirect(`/config?tab=case-types&organization=${organizationId}&msg=${encodeURIComponent(`“${ct.name}” is active again. Re-enable its rules and addresses if you want them to run.`)}`);
    } catch (e) {
      return res.redirect(`/config?tab=case-types&organization=${organizationId}&msg=${encodeURIComponent(`Case type was not restored: ${(e as Error).message}`)}`);
    }
  });

  app.post("/config/case-types/document", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const organizationId = Number(req.body.organization_id);
    // Tenant guard: configuration writes only ever reach the acting
    // administrator's own organization, whatever the form claims.
    if (organizationId !== ownOrganizationId(req)) return res.redirect(`/config?tab=case-types&msg=${encodeURIComponent("That configuration belongs to another organization — nothing was saved.")}`);
    const caseTypeId = Number(req.body.case_type_id);
    const ct = repo.listCaseTypes(organizationId).find((x) => x.id === caseTypeId);
    const key = String(req.body.key ?? "").trim();
    const label = String(req.body.label ?? "").trim();
    if (!ct || !key || !label) return res.redirect(`/config?tab=case-types&organization=${organizationId}&msg=${encodeURIComponent("Unknown CaseType or incomplete document slot.")}`);
    // An axis makes the slot conditional: it applies only for the values of
    // that axis listed here. Blank axis (the default) means "always applies".
    const axis = String(req.body.axis ?? "").trim();
    const axisValues = String(req.body.axis_values ?? "")
      .split(",").map((v) => v.trim()).filter(Boolean);
    // Silently ignoring an unknown axis would leave a slot that looks
    // conditional and never is. Reject it instead, naming the axes that exist.
    if (axis && !repo.listOrganizationDocumentAxes(organizationId).some((ax) => ax.key === axis)) {
      return res.redirect(`/config?tab=case-types&organization=${organizationId}&msg=${encodeURIComponent(`Document slot was not saved: “${axis}” is not one of this organization's axes.`)}#case-type-${caseTypeId}`);
    }
    try {
      repo.upsertDocumentDefinition(caseTypeId, {
        key, label,
        required: String(req.body.required) !== "0",
        blocking: String(req.body.blocking) !== "0",
        position: Number(req.body.position ?? 0) || 0,
        axis: axis || null,
        values: axis ? axisValues : null,
      });
    } catch (e) {
      return res.redirect(`/config?tab=case-types&organization=${organizationId}&msg=${encodeURIComponent(`Document slot was not saved: ${(e as Error).message}`)}#case-type-${caseTypeId}`);
    }
    repo.audit(null, req.staff!.username, "case_type_document_saved", `${ct.code}:${key}${axis ? ` (axis ${axis} = ${axisValues.join("/") || "any"})` : ""}`);
    res.redirect(`/config?tab=case-types&organization=${organizationId}#case-type-${caseTypeId}`);
  });

  app.post("/config/case-types/document-delete", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const organizationId = Number(req.body.organization_id);
    // Tenant guard: configuration writes only ever reach the acting
    // administrator's own organization, whatever the form claims.
    if (organizationId !== ownOrganizationId(req)) return res.redirect(`/config?tab=case-types&msg=${encodeURIComponent("That configuration belongs to another organization — nothing was saved.")}`);
    const caseTypeId = Number(req.body.case_type_id);
    const ct = repo.listCaseTypes(organizationId).find((x) => x.id === caseTypeId);
    if (ct) repo.deleteDocumentDefinition(caseTypeId, String(req.body.key ?? ""));
    res.redirect(`/config?tab=case-types&organization=${organizationId}#case-type-${caseTypeId}`);
  });

  app.post("/config/case-types/rules", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const organizationId = Number(req.body.organization_id);
    // Tenant guard: configuration writes only ever reach the acting
    // administrator's own organization, whatever the form claims.
    if (organizationId !== ownOrganizationId(req)) return res.redirect(`/config?tab=case-types&msg=${encodeURIComponent("That configuration belongs to another organization — nothing was saved.")}`);
    const caseTypeId = Number(req.body.case_type_id);
    const ct = repo.listCaseTypes(organizationId).find((x) => x.id === caseTypeId);
    if (!ct) return res.redirect(`/config?tab=case-types&organization=${organizationId}&msg=${encodeURIComponent("Unknown CaseType — no rules saved.")}`);
    try {
      const parsed: unknown = JSON.parse(String(req.body.rules_json ?? "[]"));
      validateRuleTree(parsed);
      repo.updateCaseTypeRules(caseTypeId, parsed);
      repo.audit(null, req.staff!.username, "case_type_rules_saved", `${ct.code}: ${parsed.length} top-level nodes`);
      return res.redirect(`/config?tab=case-types&organization=${organizationId}#case-type-${caseTypeId}`);
    } catch (e) {
      return res.redirect(`/config?tab=case-types&organization=${organizationId}&msg=${encodeURIComponent(`Rule tree was not saved: ${(e as Error).message}`)}#case-type-${caseTypeId}`);
    }
  });

  app.post("/config/case-types/axes", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const organizationId = Number(req.body.organization_id);
    // Tenant guard: configuration writes only ever reach the acting
    // administrator's own organization, whatever the form claims.
    if (organizationId !== ownOrganizationId(req)) return res.redirect(`/config?tab=case-types&msg=${encodeURIComponent("That configuration belongs to another organization — nothing was saved.")}`);
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

  // PPR P0-5: attachment sets — organization-owned groups of sendable files.
  app.post("/config/attachment-sets/create", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const name = String(req.body.name ?? "").trim();
    // H-3 consistency: the Document-library tab is own-org only (no picker,
    // uploads are org-checked) — sets are always created in the ACTING
    // admin's organization, whatever a hand-crafted form claims.
    const orgId = organizationId(req);
    if (!name) return res.redirect(`/config?tab=pack&msg=${encodeURIComponent("A set needs a name.")}`);
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
      // H-3 (pack channel): the set must belong to the ACTING admin's
      // organization — a foreign set id is indistinguishable from an unknown
      // one, so nobody can drop files into another tenant's outgoing mail.
      if (!set || set.organization_id !== organizationId(req)) return res.status(400).send("Unknown attachment set.");
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
    const slot = repo.listOrganizationPackSlots(organizationId(req)).find((candidate) => candidate.key === req.params.key);
    if (!slot?.content || !slot.filename) return res.status(404).send("Organization file not found");
    res.setHeader("Content-Type", slot.mime ?? "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${slot.filename.replace(/[\r\n"\\]/g, "_")}"`);
    res.send(slot.content);
  });

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
    // The narrowest scope set that covers every call this product makes:
    //   gmail.readonly -> users.messages.list / .get / .attachments.get
    //   gmail.send     -> users.messages.send (including the stale-thread retry)
    // gmail.modify is deliberately NOT requested: it would also grant delete,
    // label and read/unread writes on the mailbox, and nothing here performs
    // them. If archiving or labelling processed mail is ever added, that is a
    // deliberate re-widening — not a default.
    url.searchParams.set(
      "scope",
      "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send"
    );
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
    const pass = await gmailSync();
    if (!pass.ran) {
      return res.redirect(settingsBack("A sync is already running — give it a few seconds, then try again."));
    }
    const err = pass.result;
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
    const pass = await gmailBackfill(days);
    if (!pass.ran) {
      return res.redirect(`/settings?msg=${encodeURIComponent("A sync or backfill is already running — wait for it to finish, then try again.")}#connections`);
    }
    if (pass.result) {
      return res.redirect(`/settings?msg=${encodeURIComponent(`Backfill failed: ${pass.result.message}`)}#connections`);
    }
    repo.audit(null, req.staff!.username, "gmail_backfill", `Pulled mail from the last ${days} days into the console`);
    res.redirect(`/settings?msg=${encodeURIComponent(`History pulled — mail from the last ${days} days is now in All Mail.`)}#connections`);
  });


  // ── Gemini (document-reading AI) — a first-class settings field ───────────
  // The key is stored in the secret store (PPR P0-1), used by the extraction
  // pipeline AT ONCE (no restart, no env file). "Test key" performs a real
  // round-trip and reports exactly what happened.
  /** Gemini's secret is managed only in the installation secret store;
   *  environment variables never supply or replace it. */
  const geminiCredentials = (): { apiKey: string; model: string } | null => {
    const apiKey = repo.getSecret("gemini_api_key").trim();
    if (!apiKey) return null;
    const model = repo.getSetting("gemini_model", "").trim() || (process.env.GEMINI_MODEL ?? "").trim() || DEFAULT_GEMINI_MODEL;
    return { apiKey, model };
  };
  const rebuildAdapters = () => {
    const credentials = geminiCredentials();
    if (!credentials) {
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
        // No key: classification stays deterministic (the tenant's labels are
        // still honoured by the keyword matcher).
        categorizer: undefined,
      };
      return;
    }
    const { apiKey, model } = credentials;
    try {
      const next: Adapters = {
        ...ctx.adapters,
        vision: new BudgetedVisionAdapter(new GeminiVisionAdapter(apiKey, model), repo.visionCacheStore()),
        watcher: ((w) => (input) => w.watch(input))(new GeminiWatcher(apiKey, model)),
        // The same credential also powers message classification for tenants
        // that define their own labels.
        categorizer: geminiCategoryLabeler({ apiKey, model }),
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
    // The model credential is installation-wide (one key powers document
    // reading, the watcher and classification for every tenant), and it is
    // stored on organization 1. A second tenant's administrator must not
    // silently rewrite — or believe they own — the whole installation's key.
    if (ownOrganizationId(req) !== 1) {
      return res.redirect(back("Gemini credentials are installation-wide and can only be changed from the head-office tenant."));
    }
    const key = String(req.body.gemini_api_key ?? "").trim();
    const model = String(req.body.gemini_model ?? DEFAULT_GEMINI_MODEL).trim() || DEFAULT_GEMINI_MODEL;
    if (req.body.clear !== undefined) {
      repo.deleteSecret("gemini_api_key");
      repo.setSetting("gemini_last_error", "");
      // N1: the message below is only true if the adapters actually go
      // back to mock — rebuild before claiming it.
      rebuildAdapters();
      repo.audit(null, req.staff!.username, "gemini_disabled", "API key removed — back to text/OCR reading");
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
    const inboundAddress = String(req.body.inbound_address ?? "").trim().toLowerCase();
    if (inboundAddress && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(inboundAddress)) {
      return res.redirect(`/settings?msg=${encodeURIComponent("The inbound address must be a valid email address.")}#letters`);
    }
    // Two organizations claiming one address would make routing a coin toss,
    // because the first match wins. Refuse it while it is still obvious which
    // organization is which — the whole identity save is withheld, not just
    // the address, so a half-applied identity can never exist.
    const claimant = inboundAddress ? repo.organizationForInboundAddress(inboundAddress) : null;
    if (claimant?.matched && claimant.organizationId !== organizationId(req)) {
      return res.redirect(`/settings?msg=${encodeURIComponent(`That inbound address already belongs to another organization — nothing was saved.`)}#letters`);
    }
    repo.updateOrganization(organizationId(req), {
      name, refPrefix, theme: { primary, accent },
      fromName: String(req.body.from_name ?? ""),
      replyTo: String(req.body.reply_to ?? ""),
      locale: String(req.body.locale ?? ""),
      timezone: String(req.body.timezone ?? ""),
      inboundAddress,
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
      "intake_hotwords",
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

  app.post("/settings/webhook", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    // Strict like every other settings surface: an action this route does not
    // know is reported as "nothing changed", never quietly treated as a no-op
    // success — the two things it can do are destructive or rate-affecting.
    const back = (message: string) => res.redirect(`/settings?msg=${encodeURIComponent(message)}#webhook`);
    const organizationIdForStaff = req.staff!.organization_id ?? 1;
    const action = String(req.body.action ?? "");
    if (action === "rotate") {
      // One row update. Lookup is by value, so the previous URL is dead the
      // instant this returns: no cache to expire, no grace window, no restart.
      repo.setWebhookIngestKey(organizationIdForStaff, req.staff!.username);
      return back("A new ingest key is live. The previous webhook URL stopped working at that moment — update every form, Zap or scenario that used it.");
    }
    if (action === "limit") {
      const raw = String(req.body.webhook_rate_limit_per_minute ?? "").trim();
      if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 10_000) {
        return back("Rate limit unchanged: enter a whole number of calls per minute between 1 and 10000.");
      }
      repo.setWebhookRateLimitPerMinute(organizationIdForStaff, Math.floor(Number(raw)));
      repo.audit(null, req.staff!.username, "settings_changed", `webhook ingest rate limit for organization ${organizationIdForStaff} → ${raw} per minute`);
      return back(`Rate limit saved for this organization: ${raw} requests per minute on the ingest address. Effective on the next request.`);
    }
    return back("Nothing changed: this form rotates the ingest key or sets the per-minute request budget.");
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

  // ── Message categories: the ONLY labels Gemini may return ───────────────
  // Classification is a sensor: the model is handed this tenant's allow-list
  // and its answer is rejected unless it is on it. With no labels configured,
  // categorization stays deterministic keyword matching.
  const WORKFLOW_CATEGORY_KEYS: readonly string[] = EMAIL_CATEGORIES;
  // ── Phase D3 (Q7 step 2): inbound address -> case type ───────────────────
  // Tenant-guarded like every other configuration write: the acting admin can
  // only ever claim an address for their OWN organization's case types, and an
  // address another tenant already holds is refused rather than shared.
  app.post("/config/case-type-aliases/create", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const orgId = ownOrganizationId(req);
    const back = (m: string) => `/config?tab=case-types&organization=${orgId}&msg=${encodeURIComponent(m)}#aliases`;
    const caseTypeId = Number(req.body.case_type_id);
    const result = repo.addCaseTypeAlias(orgId, caseTypeId, String(req.body.address ?? ""));
    if (!result.ok) return res.redirect(back(`Address was not added: ${result.reason}.`));
    repo.audit(null, req.staff!.username, "case_type_alias_added",
      `${result.address} → ${repo.caseTypeById(caseTypeId)?.code ?? `case type #${caseTypeId}`} (organization ${orgId})`);
    return res.redirect(back(`Mail to ${result.address} now opens ${repo.caseTypeById(caseTypeId)?.code ?? "that case type"}.`));
  });
  app.post("/config/case-type-aliases/retire", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const orgId = ownOrganizationId(req);
    const back = (m: string) => `/config?tab=case-types&organization=${orgId}&msg=${encodeURIComponent(m)}#aliases`;
    const address = String(req.body.address ?? "").trim().toLowerCase();
    if (!repo.retireCaseTypeAlias(orgId, address)) return res.redirect(back("Unknown address for this organization — nothing changed."));
    repo.audit(null, req.staff!.username, "case_type_alias_retired", `${address} (record kept; it stops routing)`);
    return res.redirect(back(`${address} no longer routes mail. The record is kept.`));
  });

  app.post("/settings/categories/create", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const orgId = ownOrganizationId(req);
    const back = (m: string) => `/settings?msg=${encodeURIComponent(m)}#categories`;
    if (!repo.getOrganization(orgId)) return res.redirect(back("Unknown organization — complete setup first."));
    const key = String(req.body.key ?? "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 40);
    const label = String(req.body.label ?? "").trim().slice(0, 60);
    if (!/^[a-z0-9_]{2,40}$/.test(key)) return res.redirect(back("A category key is 2-40 characters: lowercase letters, digits, underscores."));
    if (!label) return res.redirect(back("A category needs a label staff can read."));
    repo.addEmailCategory(orgId, { key, label });
    const routed = WORKFLOW_CATEGORY_KEYS.includes(key);
    repo.audit(null, req.staff!.username, "email_category_added",
      `${key} ("${label}")${routed ? "" : " — not a workflow category, so messages carrying it route as 'other'"}`);
    return res.redirect(back(`Category "${label}" (${key}) added.${routed ? "" : " Note: only the built-in workflow categories drive routing; a custom label is recorded and routes as 'other'."}`));
  });
  app.post("/settings/categories/edit", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const orgId = ownOrganizationId(req);
    const back = (m: string) => `/settings?msg=${encodeURIComponent(m)}#categories`;
    if (!repo.getOrganization(orgId)) return res.redirect(back("Unknown organization — complete setup first."));
    const key = String(req.body.key ?? "").trim();
    const label = String(req.body.label ?? "").trim();
    const current = repo.listEmailCategories(orgId).find((row) => row.key === key);
    if (!current) return res.redirect(back("Unknown category for this organization — nothing changed."));
    if (!label || label.length > 60) return res.redirect(back("A category label must be 1-60 characters."));
    if (label === current.label) return res.redirect(back(`Category "${key}" is unchanged.`));
    if (!repo.updateEmailCategoryLabel(orgId, key, label)) {
      return res.redirect(back("Category could not be updated — refresh the list and try again."));
    }
    repo.audit(null, req.staff!.username, "email_category_updated", `${key}: "${current.label}" → "${label}"`);
    return res.redirect(back(`Category label updated to "${label}". Its key and existing message history are unchanged.`));
  });

  app.post("/settings/categories/remove", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const orgId = ownOrganizationId(req);
    const back = (m: string) => `/settings?msg=${encodeURIComponent(m)}#categories`;
    const key = String(req.body.key ?? "").trim();
    if (!repo.listEmailCategories(orgId).some((row) => row.key === key)) return res.redirect(back("Unknown category — nothing changed."));
    // Retired, not deleted: messages already labelled keep their label.
    repo.setEmailCategoryActive(orgId, key, false);
    repo.audit(null, req.staff!.username, "email_category_removed", `${key} (messages already labelled keep it)`);
    return res.redirect(back(`Category "${key}" retired — it is no longer offered to the classifier.`));
  });

  app.post("/settings/intake-deadline", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const name = String(req.body.name ?? "").trim();
    const deadline = String(req.body.deadline ?? "").trim();
    if (name) {
      // Garbage date strings produced Invalid Dates whose toISOString()
      // throws → 500. Validate first.
      const parsed = deadline ? new Date(`${deadline}T23:59:59Z`) : null;
      if (deadline && (parsed === null || isNaN(parsed.getTime()))) {
        return res.redirect("/config?tab=requirements&msg=invalid-deadline#intakes");
      }
      // Upsert: a window named in mail (or typed here) may not have a row yet.
      // An UPDATE-only write silently discarded the administrator's deadline
      // on any installation that had no pre-seeded windows.
      repo.addIntakeWithDeadline(name, parsed ? parsed.toISOString() : null, ownOrganizationId(req));
      repo.audit(null, req.staff!.username, "intake_deadline_changed", `${name} → ${deadline || "none"}`);
    }
    res.redirect("/config?tab=requirements#intakes");
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
    const inspection = inspectTemplate(`${subject}\n${body}`);
    if (inspection.malformedIncludes.length || inspection.unknownPartials.length) {
      const problems = [
        ...inspection.unknownPartials.map((partial) => `unknown partial {{> ${partial}}}`),
        ...inspection.malformedIncludes,
      ];
      return res.redirect(tplBack(key, `Template not saved: ${problems.join("; ")}. Use one of the documented partial includes.`));
    }
    try {
      // PPR P0-5 (E3 close): upsertTemplate validates the reference against
      // this organization's OWN attachment sets — unknown refs are refused.
      repo.upsertTemplate(key, name, subject, body, req.body.include_banner !== undefined, packRaw, organizationId(req), caseTypeId);
    } catch (e) {
      return res.redirect(tplBack(key, `Template not saved: ${(e as Error).message}`));
    }
    repo.audit(null, req.staff!.username, "template_changed", `${key}${packRaw !== "none" ? ` (+${packRaw} set)` : ""}${caseTypeId ? ` [profile #${caseTypeId}]` : ""}`);
    const unknown = inspection.unknownTokens.map((token) => `{${token}}`);
    const warn = unknown.length
      ? ` ⚠ Unknown placeholder${unknown.length === 1 ? "" : "s"} left in the text: ${unknown.join(", ")} — it will reach contacts as literal text.`
      : "";
    res.redirect(tplBack(key, `Template “${name}” saved.${warn}`));
  });

  // PPR P0-6: templates are not a closed enum — a case type can create the
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

  // Recovery for an organization created before starter templates were seeded
  // with it (or one whose templates were deleted): idempotent, own tenant only.
  app.post("/templates/seed-starters", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const orgId = ownOrganizationId(req);
    if (!repo.getOrganization(orgId)) {
      return res.redirect(`/templates?msg=${encodeURIComponent("Unknown organization — complete setup first.")}`);
    }
    const before = repo.listTemplates(orgId).length;
    seedStarterTemplates(repo, orgId);
    const added = repo.listTemplates(orgId).length - before;
    repo.audit(null, req.staff!.username, "templates_seeded", `${added} starter template(s) added; ${before} already present`);
    return res.redirect(`/templates?msg=${encodeURIComponent(added
      ? `Added ${added} starter template(s) — edit the wording before anything goes out.`
      : "Every starter template is already present — nothing was overwritten.")}`);
  });

  // One-click process templates (applications / hiring / generic). Safe defaults, human review first.
  app.post("/setup/process-template", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const orgId = ownOrganizationId(req);
    if (!repo.getOrganization(orgId)) {
      return res.redirect(`/?msg=${encodeURIComponent("Unknown organization — complete setup first.")}`);
    }
    // Validated against the catalogue itself, so a fourth template cannot be
    // added to seed.ts and silently rejected here.
    const raw = String(req.body.template ?? "applications").trim().toLowerCase();
    const allowed = new Set<string>(PROCESS_TEMPLATES.map((t) => t.id));
    const templateId = (allowed.has(raw) ? raw : "applications") as ProcessTemplateId;
    try {
      const result = seedProcessTemplate(repo, orgId, templateId);
      repo.audit(null, req.staff!.username, "process_template_seeded",
        result.created
          ? `Created process template "${result.templateName}" (${result.caseTypeCode}) with documents and reply templates`
          : `Process template already present (${result.caseTypeCode}) — templates refreshed`);
      const msg = result.created
        ? `“${result.templateName}” is ready. Cases can now be received and reviewed.`
        : `“${result.templateName}” was already set up. Nothing was overwritten.`;
      return res.redirect(`/?msg=${encodeURIComponent(msg)}`);
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      return res.redirect(`/?msg=${encodeURIComponent("Could not set up process template: " + err)}`);
    }
  });

  app.post("/templates/reset", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const key = String(req.body.key ?? "");
    // PPR P0-6: "Reset to default" restores the case type's OWN default —
    // the snapshot captured when the template was created — not a shared
    // global wording. Rows without a snapshot fall back to the shipped
    // operational defaults.
    const snap = repo.templateDefaultSnapshot(key, organizationId(req));
    const def = snap ?? TEMPLATE_DEFAULTS[key];
    if (!def) return res.redirect(`/templates?msg=${encodeURIComponent("No default exists for that template — nothing to reset.")}`);
    const existingRow = repo.getTemplate(key, organizationId(req));
    repo.upsertTemplate(key, def.name, def.subject, def.body, Boolean(def.include_banner), def.attach_pack, organizationId(req), existingRow?.case_type_id ?? 0);
    repo.audit(null, req.staff!.username, "template_reset", `${key} → ${snap ? "profile default" : "shipped default"}`);
    res.redirect(tplBack(key, `“${def.name}” reset to ${snap ? "its own default" : "the official default"}.`));
  });

  // ── Staff management (admin) ─────────────────────────────────────────────

  // OR-8: save a staff member's ENTIRE case-type scope in one action.
  // H-3: every /staff/* route resolves its target only inside the acting
  // administrator's own organization — an org-1 admin can never act on an
  // org-2 account by guessing its id.
  app.post("/staff/scopes", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const staffId = Number(req.body.staff_id);
    const member = repo.staffInOrganization(staffId, organizationId(req));
    if (!member) return res.redirect("/staff?msg=" + encodeURIComponent("Unknown staff member — nothing saved."));
    // An administrator who cannot see every case type cannot reach the
    // configuration that would give it back — refuse rather than lock out.
    if (member.role === "admin") {
      return res.redirect(`/staff?msg=${encodeURIComponent("Administrators always see every case type — nothing saved.")}#scopes`);
    }
    const raw = req.body.case_types;
    const requested = (Array.isArray(raw) ? raw : raw ? [raw] : []).map((x) => String(x).trim().toUpperCase()).filter(Boolean);
    // Only real case types of THIS organization can be scoped — a typo'd code
    // would silently hide cases forever otherwise.
    const known = new Set(repo.listCaseTypes(organizationId(req)).map((t) => t.code.toUpperCase()));
    const unknown = requested.filter((x) => !known.has(x));
    if (unknown.length) {
      return res.redirect(`/staff?msg=${encodeURIComponent(`Unknown case type(s): ${unknown.join(", ")} — nothing saved.`)}#scopes`);
    }
    const mode = String(req.body.scope_mode ?? "");
    const restoreFull = mode === "unscoped";
    // "No access" is reachable, but only by pressing the button that says so.
    // An empty selection on a plain save must not silently empty someone's
    // desk — that reads as "the cases disappeared".
    if (!restoreFull && mode !== "none" && !requested.length) {
      return res.redirect(`/staff?msg=${encodeURIComponent(`Tick at least one case type, or choose “every case type” — ${member.display_name}'s scope was left alone.`)}#scopes`);
    }
    if (restoreFull) repo.clearCaseTypeScopes(staffId);
    else repo.setCaseTypeScopes(staffId, mode === "none" ? [] : requested);
    repo.audit(null, req.staff!.username, "scope_changed",
      `${member.username}: ${restoreFull ? "scope cleared (full visibility)" : requested.length ? requested.join(", ") : "no access"}`);
    res.redirect(`/staff?msg=${encodeURIComponent(restoreFull
      ? `${member.display_name} now sees every case type again.`
      : requested.length
        ? `${member.display_name} now sees ${requested.length} case type${requested.length === 1 ? "" : "s"}: ${requested.join(", ")}.`
        : `${member.display_name} now sees no case types — the queues stay empty until a scope is set.`)}#scopes`);
  });

  app.get("/staff", requireLogin, requireRole("admin"), (req, res) =>
    res.send(staffPage(c(req), req.query.msg ? String(req.query.msg) : undefined))
  );

  // PPR P1-8: grant/revoke the four automation permissions per staff member.
  // H-3: only the acting organization's staff are read or granted.
  app.post("/staff/permissions", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    for (const st of repo.listStaff(organizationId(req))) {
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

  // H-2: the new account belongs to the ACTING admin's organization — never
  // a hard-coded tenant. Usernames stay globally unique (the column is
  // UNIQUE), so the clash check still looks across every tenant.
  app.post("/staff/add", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const username = normalizeUsername(String(req.body.username ?? ""));
    const password = String(req.body.password ?? "");
    const role = String(req.body.role) === "admin" ? "admin" : "user";
    const staffMsg = (m: string) => `/staff?msg=${encodeURIComponent(m)}`;
    if (!username) return res.redirect(staffMsg("Username is required."));
    if (!USERNAME_RE.test(username)) return res.redirect(staffMsg("Username may contain letters, digits, dots, dashes and underscores (2–32 chars)."));
    if (!password || password.length < 8) return res.redirect(staffMsg(`Password for “${username}” must be at least 8 characters.`));
    if (repo.getStaffByUsername(username)) return res.redirect(staffMsg(`Username “${username}” is already taken.`));
    const orgId = organizationId(req);
    repo.createStaff(username, String(req.body.display_name ?? username), hashPassword(password), role, false, orgId);
    repo.audit(null, req.staff!.username, "staff_created", `${username} (${role}) in organization ${orgId}`);
    res.redirect(staffMsg(`Staff account “${username}” created (${role}).`));
  });

  app.post("/staff/toggle", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const s = repo.staffInOrganization(Number(req.body.id), organizationId(req));
    const staffMsg = (m: string) => `/staff?msg=${encodeURIComponent(m)}`;
    if (!s) return res.redirect("/staff");
    if (s.id === req.staff!.id) return res.redirect(staffMsg("You cannot disable your own account."));
    repo.setStaffActive(s.id, s.active !== 1);
    repo.audit(null, req.staff!.username, "staff_toggled", `${s.username} → ${s.active !== 1 ? "active" : "disabled"}`);
    res.redirect(staffMsg(`${s.display_name} is now ${s.active !== 1 ? "active" : "disabled"}.`));
  });

  app.post("/staff/display-name", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const staffMsg = (m: string) => `/staff?msg=${encodeURIComponent(m)}`;
    const member = repo.listStaff(organizationId(req)).find((st) => st.id === Number(req.body.id));
    if (!member) return res.redirect(staffMsg("Unknown staff member — nothing changed."));
    const name = String(req.body.display_name ?? "").trim().replace(/\s+/g, " ");
    if (name.length < 2 || name.length > 80) return res.redirect(staffMsg("A display name must be 2–80 characters — nothing changed."));
    if (name === member.display_name) return res.redirect(staffMsg(`${member.display_name}'s name is unchanged.`));
    const before = member.display_name;
    repo.setStaffDisplayName(member.id, name);
    repo.audit(null, req.staff!.username, "staff_display_name_changed", `${member.username}: “${before}” → “${name}”`);
    res.redirect(staffMsg(`${before} is now shown as “${name}”.`));
  });

  app.post("/staff/password", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const id = Number(req.body.id);
    const staffMsg = (m: string) => `/staff?msg=${encodeURIComponent(m)}`;
    const password = String(req.body.password ?? "");
    const confirm = String(req.body.confirm ?? "");
    const target = repo.staffInOrganization(id, organizationId(req));
    if (!target) return res.redirect(staffMsg("Unknown staff member."));
    // Same rules as first-run setup — one rulebook for every password write.
    if (password.length < 8) return res.redirect(staffMsg(`Password for “${target.username}” must be at least 8 characters.`));
    if (password !== confirm) return res.redirect(staffMsg(`The passwords do not match — nothing changed.`));
    repo.setStaffPassword(id, hashPassword(password));
    // Session hygiene: an admin reset (stolen laptop, offboarding, suspected
    // compromise) must end the member's live sessions — the self-service
    // reset-code path already purges; this path has to agree with it.
    const ended = repo.purgeStaffSessions(id);
    repo.audit(null, req.staff!.username, "staff_password_reset", `user #${id}; ${ended} session(s) ended`);
    res.redirect(staffMsg(`Password reset for “${target.username}” — their open sessions were ended.`));
  });

  // Forgot password: issue a one-time code for a member. Deliberately a
  // 200 re-render, NOT a redirect — the code is shown exactly once, in the
  // response body, and must never appear in a URL (history/Referer).
  app.post("/staff/reset-code", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const target = repo.staffInOrganization(Number(req.body.id), organizationId(req));
    if (!target) return res.send(staffPage(c(req), "Unknown staff member — no code issued."));
    const code = repo.issueResetCode(target.id, req.staff!.username);
    repo.audit(null, req.staff!.username, "password_reset_code_issued", `for ${target.username}`);
    res.send(staffPage(c(req), `Reset code issued for “${target.username}”.`, code));
  });

  // ── Exports (feature 38) ─────────────────────────────────────────────────

  const csv = (res: Response, filename: string, header: string[], rows: Array<Array<string | number | null>>, opts: { note?: string } = {}) => {
    // Quote doubling for CSV, plus a leading apostrophe for cells that begin
    // with formula characters — otherwise a name like "=HYPERLINK(...)"
    // executes when staff open the export in Excel (CSV formula injection).
    const q = (v: string | number | null) => {
      let s = String(v ?? "");
      if (/^[=+\-@\t]/.test(s)) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const lines = [header, ...rows].map((r) => r.map(q).join(","));
    // A leading "#" note keeps the warning INSIDE the file that leaves the
    // building (headers are invisible once someone forwards the CSV). The
    // evaluation harness skips comment lines before the header row.
    const body = [...(opts.note ? [`#${opts.note}`] : []), ...lines].join("\r\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(body);
  };

  app.get("/export/applicants.csv", requireLogin, requireRole("admin"), (req, res) => {
    // Realm + case-type scope, like every other admin list — an admin in one
    // realm must not be able to pull the whole other realm's PII to CSV.
    const demo = req.staff!.demo ?? 0;
    const scope = repo.caseScopeFor(req.staff!);
    const rows = repo.allApplicants(demo, scope);
    // Two aggregate queries for the whole export — never 2N per-applicant
    // lookups on a synchronous connection.
    const caseTypeCodes = new Map(repo.listCaseTypes(organizationId(req)).map((t) => [t.id, t.code] as [number, string]));
    const docCounts = repo.documentCountsByApplicant();
    const flagTypes = repo.activeFlagTypesByApplicant();
    csv(
      res,
      "applicants.csv",
      ["ref_number", "name", "email", "phone", "case_type", "window", "lifecycle", "triage", "priority", "assigned_to", "active_docs", "flags", "created_at"],
      rows.map((a) => [
        a.ref_number, a.full_name, a.email_address, a.phone, caseTypeCodes.get(a.case_type_id ?? 0) ?? "", a.intake, a.lifecycle, a.triage,
        a.priority, a.assigned_to ? repo.getStaff(a.assigned_to)?.username ?? "" : "",
        docCounts.get(a.id) ?? 0,
        (flagTypes.get(a.id) ?? []).join("; "),
        a.created_at,
      ])
    );
  });

  // Phase D1 (Q6): the labelled-measurement input for scripts/eval-classifier.ts.
  // Admin-only, this organization's mail only, capped, audited, and marked as
  // the personal data it is — an export of message bodies is the most sensitive
  // file this console can produce.
  const LABELS_DEFAULT_LIMIT = 200;
  const LABELS_MAX_LIMIT = 1000;
  app.get("/export/labels.csv", requireLogin, requireRole("admin"), (req, res) => {
    const orgId = ownOrganizationId(req);
    const requested = Number(req.query.limit ?? LABELS_DEFAULT_LIMIT);
    const limit = Number.isFinite(requested) && requested > 0
      ? Math.min(Math.floor(requested), LABELS_MAX_LIMIT)
      : LABELS_DEFAULT_LIMIT;
    const rows = repo.labelableMessages(orgId, limit);
    repo.audit(null, req.staff!.username, "labels_exported",
      `${rows.length} inbound message(s) of organization ${orgId} (limit ${limit}) — the file contains message text, i.e. personal data`);
    // Header values must stay ASCII (Node rejects anything else).
    res.setHeader("X-Personal-Data", "real message subjects and bodies - handle per README.md#classifier-evaluation-and-personal-data-handling");
    csv(
      res,
      "labels.csv",
      ["id", "subject", "body", "true_category"],
      rows.map((r) => [r.id, r.subject, r.body, ""]),
      {
        note: " PERSONAL DATA: real subjects and bodies. Remove names, phone numbers, addresses, ID/reference numbers and account numbers before this file leaves your machine; keep it out of version control (labels/ and *.labels.csv are git-ignored) and delete it after labelling. Fill true_category with one of the eight keys using the tie-breaks in README.md#classifier-evaluation-and-personal-data-handling, then score it with scripts/eval-classifier.ts. true_category is deliberately blank: labelling before reading the machine's answer is what makes the measurement honest.",
      }
    );
  });

  app.get("/export/queue.csv", requireLogin, requireRole("admin"), (req, res) => {
    const demo = req.staff!.demo ?? 0;
    const scope = repo.caseScopeFor(req.staff!);
    const rows = repo.queueView(demo, scope);
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
    const scope = repo.caseScopeFor(req.staff!);
    const visible = new Set(repo.allApplicants(demo, scope).map((a) => a.id));
    const rows = repo
      .recentAudit(10000)
      .filter((r) => r.applicant_id === null || visible.has(r.applicant_id));
    csv(res, "audit.csv", ["at", "actor", "event", "detail", "applicant_id"], rows.map((r) => [r.at, r.actor, r.event, r.detail, r.applicant_id]));
  });


  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  // ── Public webhook ingest (Phase 18) ─────────────────────────────────────
  // Unauthenticated by design — the permanent per-organization key in the path
  // IS the credential, which is why it never appears in a log line, an audit row
  // or this response body. Everything the payload carries is treated as hostile
  // until src/web/webhook.ts has validated it, and the submission then runs
  // through the same processEmail path as a real message: no gate is skipped and
  // nothing in this endpoint can decide a case.
  const declaredBytes = (req: Request): number => {
    const lengthHeader = Number(req.headers["content-length"]);
    if (Number.isFinite(lengthHeader) && lengthHeader > 0) return Math.floor(lengthHeader);
    try { return Buffer.byteLength(JSON.stringify(req.body ?? {}), "utf8"); } catch { return 0; }
  };
  const webhookLimiter = new RateWindow({ windowMs: 60_000 });
  const ingestJson = express.json({ limit: ingestPayloadLimit });
  const ingestForm = express.urlencoded({ extended: false, limit: ingestPayloadLimit });
  const parseIngestBody: RequestHandler = (req, res, next) => {
    const isJson = String(req.headers["content-type"] ?? "").toLowerCase().includes("json");
    const parser = isJson ? ingestJson : ingestForm;
    const refuse = (error?: unknown): void => {
      const message = String((error as Error)?.message ?? error);
      setNoStore(res);
      // 413/400 in the API's own shape: the parser's error text names byte
      // limits, internal types and stack traces, which is the caller's business
      // only as far as "your body was refused".
      if (/too large|limit/i.test(message)) {
        log(`webhook: body refused over the ${ingestPayloadLimit}-byte cap`, "warn");
        res.status(413).json({ ok: false, error: "the request body is larger than this endpoint accepts" });
        return;
      }
      res.status(400).json({ ok: false, error: isJson ? "the body is not valid JSON" : "the body is not readable form fields" });
    };
    try {
      parser(req, res, (error?: unknown) => { if (error) return refuse(error); next(); });
    } catch (error) {
      // A recursion bomb (20 000 nested arrays) makes JSON.parse throw
      // RangeError synchronously, before the callback — and an uncaught throw
      // here would reach the generic error handler, which answers 500 AND
      // writes a server_error audit row. A caller must not be able to buy
      // audit-log growth with one line of JSON, so this surface answers it
      // itself and stores nothing.
      refuse(error);
    }
  };
  app.post(`${WEBHOOK_PATH_PREFIX}:org_key`, parseIngestBody, async (req, res) => {
    const reply = await ingestWebhook(
      { repo, ctx, limiter: webhookLimiter },
      {
        orgKey: String(req.params.org_key ?? ""),
        body: req.body,
        // Declared bytes when the client stated them; otherwise a guarded
        // re-serialisation. The guard matters: a 20 000-level-nested array
        // parses fine and then overflows JSON.stringify's stack, and an
        // uncaught throw here would answer 500 and write an audit row per
        // request — a cheap way for a stranger to grow the audit log.
        payloadBytes: declaredBytes(req),
        ip: req.ip ?? "",
      }
    );
    // No session, no cache: the answer belongs to this one call, and a shared
    // proxy must not be able to serve a stale 429 or a replayed ref_number.
    setNoStore(res);
    if (reply.retryAfterSeconds) res.setHeader("Retry-After", String(reply.retryAfterSeconds));
    res.status(reply.status).json(reply.body);
  });
  app.get(`${WEBHOOK_PATH_PREFIX}:org_key`, (_req, res) => {
    // A key in a URL is a credential: never echo it back, and never confirm
    // whether it is valid — GET is simply not what this endpoint is.
    setNoStore(res);
    res.status(405).setHeader("Allow", "POST").json({ ok: false, error: "use POST" });
  });

  /** Command-palette search API (v4). Realm-scoped like every other list. */
  app.get("/api/search", requireLogin, (req, res) => {
    const q = String(req.query.q ?? "").trim();
    if (!q) return res.json({ applicants: [] });
    res.json({
      applicants: repo.searchApplicants({ q, limit: 8, demo: req.staff!.demo, caseTypes: repo.caseScopeFor(req.staff!) }).map((a) => ({
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
      unread: req.staff ? repo.unreadCount(req.staff.id, req.staff.demo, repo.caseScopeFor(req.staff)) : undefined,
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
    log(`unhandled error on ${req.method} ${redactIngestKey(req.path)}: ${(err as Error)?.stack ?? err}`, "error");
    // Persist only a minimal, tenant-attributable incident marker. The full
    // stack/message stays in the process log and is never copied into the
    // shared tenant audit surface where it could contain secrets or PII.
    try {
      const errorName = err instanceof Error ? err.name : "UnknownError";
      repo.audit(null, req.staff?.username ?? "system", "server_error", `${req.method} ${redactIngestKey(req.path)} — ${errorName}`);
    } catch { /* the console log above remains authoritative if the DB is down */ }
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

  guardAsyncRoutes(app);
  return app;
}

type AnyHandler = (req: never, res: never, next: never) => unknown;
interface RouteEntry { handle: AnyHandler }
interface RouterLayer { route?: { stack: RouteEntry[] }; handle?: AnyHandler }

/**
 * Express 4 never forwards a REJECTED PROMISE from an `async` handler to the
 * error middleware: the request simply hangs until the client gives up (a
 * three-minute spinner for a one-line SQL mistake, and no log line). Wrapping
 * every registered async handler turns any throw into a normal error response
 * — the last-resort handler above still decides what the user sees.
 */
export function guardAsyncRoutes(app: Express): void {
  const router = (app as unknown as { _router?: { stack?: RouterLayer[] } })._router;
  const wrap = (handle: AnyHandler): AnyHandler =>
    ((req, res, next) => { Promise.resolve(handle(req, res, next)).catch(next); }) as AnyHandler;
  for (const layer of router?.stack ?? []) {
    if (layer.route) {
      for (const entry of layer.route.stack) {
        if (entry.handle?.constructor?.name === "AsyncFunction") entry.handle = wrap(entry.handle);
      }
      continue;
    }
    // Plain middleware (app.use) — error handlers take four arguments and must
    // stay untouched, or Express stops recognising them as error handlers.
    if (layer.handle?.constructor?.name === "AsyncFunction" && layer.handle.length <= 3) layer.handle = wrap(layer.handle);
  }
}

/** Escalation sweep (feature 29) — runs on an interval in serve mode. */
export function runEscalationSweep(repo: Repo, escalationHours: number): number {
  // The Settings window is what selects the cases — it used to be read, printed
  // into the audit line and then ignored, so every value behaved like 0.
  // Callers pass it through envInt, so a corrupt value arrives as the documented
  // default, and 0 keeps the older “past its own SLA clock” rule.
  const overdue = repo.overdueCases(escalationHours);
  let n = 0;
  for (const a of overdue) {
    repo.escalate(a.id);
    repo.notify("escalation", `Case ${a.ref_number} has exceeded its response target.`, a.id);
    repo.audit(a.id, "system", "escalated", escalationHours > 0 ? `unhandled for over ${escalationHours} h (escalation window)` : "exceeded response target");
    n++;
    log(`escalation: ${a.ref_number} exceeded response target → urgent`, "warn");
  }
  return n;
}
