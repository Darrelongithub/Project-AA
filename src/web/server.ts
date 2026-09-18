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
import express, { type Express, type Request, type Response } from "express";
import type { Repo } from "../db/repo";
import type { PipelineContext } from "../pipeline/adapters";
import type { ApplicantRow, LifecycleStage } from "../types";
import { DOC_TYPES, EMAIL_CATEGORY_LABELS, LIFECYCLE_LABELS, LIFECYCLE_ORDER, type DocType, type EmailCategory } from "../types";
import { checklistText, renderTemplate } from "../drafting";
import { docLabel } from "../rules";
import { evaluateAdmission } from "../admissions/evaluate";
import { ADMISSION_SYSTEMS, type AdmissionSystem, type CourseLevel, type RuleField } from "../types";
import {
  accountPage, admissionsPage, applicantsPage, casePage, composePage, configPage, dashboardPage, loginPage,
  replayPage, settingsPage, staffPage,
} from "./pages";
import { avatar, esc, layout } from "./views";
import { authMiddleware, clearSessionCookie, csrfCheck, loginAttempt, parseCookies, requireLogin, requireRole, sessionCookie } from "./auth";
import { processEmail } from "../pipeline";
import { BudgetedVisionAdapter, GeminiVisionAdapter } from "../extraction/gemini";
import { GeminiWatcher } from "../watcher";
import { buildAdapters, type Adapters } from "../pipeline/adapters";
import type { PipelineContext as PCtx } from "../pipeline/adapters";
import { log } from "../util/log";
import { hashPassword, verifyPassword } from "../util/password";
import { INSTITUTION, emailBanner } from "../branding";
import { admissionPack, applicationPack, PACK_DIR, PACK_SLOTS } from "../pack";
import { EXAM_SYSTEMS, SUBJECT_CATALOG } from "../config";
import type { SystemBlock } from "../types";
import * as fs from "fs";
import * as path from "path";

export interface WebDeps {
  repo: Repo;
  ctx: PipelineContext; // reuse the pipeline's sender/vision adapters
  /** Manual "Sync now" hook — one live ingest pass; returns the failure, if any. */
  gmailSync?: () => Promise<Error | null>;
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
  const { repo, ctx, gmailSync } = deps;
  const app = express();
  /** Institution name for all branding — fixed; no settings field exists. */
  const instName = (): string => INSTITUTION;

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
    unread: repo.unreadCount(req.staff!.id, req.staff!.demo),
    csrf: req.csrfToken ?? "",
    theme: req.theme,
    institution: instName(),
    /** True when the seeded demo dataset is present — the banner's only gate. */
    demo: repo.getSetting("demo_dataset", "") === "1",
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

  // Official logo, served once and cached; every page references these paths.
  // Colour on transparent for light surfaces, monochrome white for the dark
  // sidebar — both real PNGs so the mark blends with its background.
  app.get("/assets/logo", (_req, res) => {
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(Buffer.from(LOGO_BASE64, "base64"));
  });
  app.get("/assets/logo-white", (_req, res) => {
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(Buffer.from(LOGO_WHITE_BASE64, "base64"));
  });

  // Browser-tab mark: the purple "R" app tile — crisp at 16px, unmistakably
  // Riara. A real favicon (not the wide crest squashed into a square).
  app.get("/assets/favicon", (_req, res) => {
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=604800");
    res.send(Buffer.from(FAVICON_BASE64, "base64"));
  });

  // Self-hosted typefaces (no CDN): Manrope for UI, Instrument Serif display.
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
  app.get("/assets/email-banner", requireLogin, (_req, res) => {
    const b = emailBanner(repo);
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
    express.raw({ type: ["image/jpeg", "image/png"], limit: "1mb" }),
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

  // Failed-logins-only limiter: 10 failures per IP per minute blocks further
  // attempts. Only FAILURES count, so legitimate users are never locked out
  // by normal use.
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
  app.get("/admissions", requireLogin, (req, res) => {
    res.send(admissionsPage(c(req), String(req.query.stage ?? "all")));
  });

  // Realm guard: a case is only visible to accounts in the SAME realm —
  // live admins never open mock cases, demo accounts never open live ones.
  const sameRealm = (req: Request, a: { demo?: number } | null): boolean =>
    Boolean(a) && (a!.demo ?? 0) === (req.staff!.demo ?? 0);

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
      await ctx.adapters.sender.send(a.email_address, subject, body, a.thread_id, { banner: emailBanner(repo) });
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
      await ctx.adapters.sender.send(a.email_address, rendered.subject, rendered.body, a.thread_id, {
        banner: tpl.include_banner === 0 ? null : emailBanner(repo),
      });
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

  /** Official document packs: the application pack, or the full admission pack. */
  app.post("/case/:id/send-pack", requireLogin, requireRole("admin"), csrfCheck, async (req, res) => {
    const id = Number(req.params.id);
    const a = repo.getApplicant(id);
    if (!a) return res.status(404).send("Case not found.");
    const kind = String(req.body.kind ?? "");
    const isAdmission = kind === "admission";
    if (!isAdmission && kind !== "application") {
      return res.redirect(backToCase(id, "Unknown pack — nothing sent."));
    }
    const tpl = repo.getTemplate(isAdmission ? "admission_letter" : "docs_request");
    if (!tpl) return res.redirect(backToCase(id, "Template missing — nothing sent."));
    const rendered = renderTemplate(tpl.subject, tpl.body, {
      ref: a.ref_number,
      institution: instName(),
      name: a.full_name ?? undefined,
      missingLabels: [],
      checklist: "",
      statusLabel: LIFECYCLE_LABELS[a.lifecycle],
      programme: a.programme ? (repo.listProgrammes().find((p) => p.code === a.programme)?.name ?? a.programme) : undefined,
      regDate: repo.getSetting("reg_date", ""),
      orientationDates: repo.getSetting("orientation_dates", ""),
    });
    const pack = isAdmission ? admissionPack() : applicationPack();
    // Missing pack files must never be a silent gap in a real send.
    if (pack.issues.length) {
      repo.audit(id, req.staff!.username, "pack_incomplete", pack.issues.join("; "));
    }
    try {
      await ctx.adapters.sender.send(a.email_address, rendered.subject, rendered.body, a.thread_id, {
        banner: tpl.include_banner === 0 ? null : emailBanner(repo),
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
    });
    staffAction(req, id, isAdmission ? "admission_pack_sent" : "application_pack_sent",
      `${pack.files.length} document(s): "${rendered.subject}"`);
    const packWarn = pack.issues.length
      ? ` ⚠ ${pack.issues.length} pack file(s) missing — see audit.`
      : "";
    res.redirect(backToCase(id, (isAdmission
      ? `Admission pack sent — letter plus ${pack.files.length} documents.`
      : "Application pack sent — form and brochure attached.") + packWarn));
  });

  // Compose: an action (e.g. "Request missing documents") or any template
  // opens a full-page reply with everything pre-filled — the officer edits if
  // they want, presses Send, done. One obvious path: draft → send.
  const renderFor = (a: ApplicantRow, subject: string, body: string) =>
    renderTemplate(subject, body, {
      ref: a.ref_number,
      institution: instName(),
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

  app.get("/case/:id/compose", requireLogin, (req, res) => {
    const a = repo.getApplicant(Number(req.params.id));
    if (!a) return res.status(404).send("Case not found.");
    const tpl = repo.getTemplate(String(req.query.template ?? ""));
    if (!tpl) return res.redirect(backToCase(a.id, "Unknown template."));
    const rendered = renderFor(a, tpl.subject, tpl.body);
    res.send(composePage(c(req), a, tpl, rendered));
  });

  app.post("/case/:id/compose", requireLogin, csrfCheck, async (req, res) => {
    const a = repo.getApplicant(Number(req.params.id));
    if (!a) return res.status(404).send("Case not found.");
    const tplKey = String(req.body.template ?? "");
    const tpl = repo.getTemplate(tplKey);
    if (!tpl) return res.redirect(backToCase(a.id, "Unknown template."));
    const subject = String(req.body.subject ?? "").trim();
    const body = String(req.body.body ?? "").trim();
    if (!subject || !body) {
      const rendered = renderFor(a, subject || tpl.subject, body || tpl.body);
      return res.send(composePage(c(req), a, tpl, rendered, "Both a subject and a body are needed before this can be sent."));
    }
    try {
      await ctx.adapters.sender.send(a.email_address, subject, body, a.thread_id, {
        banner: tpl.include_banner === 0 ? null : emailBanner(repo),
      });
    } catch (e) {
      repo.audit(a.id, req.staff!.username, "send_failed", (e as Error).message);
      return res.redirect(backToCase(a.id, `Send failed: ${(e as Error).message}`));
    }
    repo.insertEmail({
      applicant_id: a.id, message_id: `compose-${Date.now()}`, thread_id: a.thread_id, direction: "out",
      from_addr: "", to_addr: a.email_address, subject, body, category: null, auto: 0, at: new Date().toISOString(),
    });
    staffAction(req, a.id, "email_sent_manual", `composed reply (${tpl.key}): "${subject}"`);
    res.redirect(backToCase(a.id, `Reply sent to ${a.email_address}.`));
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
  app.post("/case/:id/admission-decision", requireLogin, csrfCheck, (req, res) => {
    const id = Number(req.params.id);
    const a = repo.getApplicant(id);
    if (!a || !sameRealm(req, a)) return res.status(404).send("Case not found.");
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

  /** Re-run the admissions evaluation on demand (new documents arrived etc.). */
  app.post("/case/:id/reevaluate", requireLogin, csrfCheck, (req, res) => {
    const id = Number(req.params.id);
    const a = repo.getApplicant(id);
    if (!a || !sameRealm(req, a)) return res.status(404).send("Case not found.");
    const flags = repo.activeFlags(id).filter((f) => f.type !== "duplicate_submission");
    const result = evaluateAdmission(repo, id, flags);
    repo.syncFlags(id, [...flags, ...result.derivedFlags]);
    repo.audit(id, req.staff!.username, "evaluation_rerun", `re-evaluated on request → ${result.report.result}/${result.report.routing}`);
    res.redirect(backToCase(id, `Evaluation re-run: ${result.report.result.replace(/_/g, " ")} → ${result.report.routing.replace(/_/g, " ")}.`));
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
    res.send(settingsPage(c(req), req.query.msg ? String(req.query.msg) : undefined))
  );

  // Configuration: courses, requirements, Gmail, intakes, templates, exports.
  app.get("/config", requireLogin, requireRole("admin"), (req, res) =>
    res.send(
      configPage(
        c(req),
        req.query.template ? String(req.query.template) : undefined,
        req.query.msg ? String(req.query.msg) : undefined,
        req.query.reqs ? String(req.query.reqs) : undefined,
        req.query.tab ? String(req.query.tab) : undefined,
        req.query.system ? String(req.query.system) : undefined
      ))
  );

  // Assign who handles a course (shown on the administration overview).
  app.post("/config/course-owner", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const programme = String(req.body.programme ?? "").trim();
    const ownerRaw = String(req.body.owner ?? "").trim();
    const back = (m: string) => `/config?msg=${encodeURIComponent(m)}#courses`;
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
    res.redirect(back(`Course ${programme} now handled by ${who}.${routed ? ` ${routed} open case(s) routed over.` : ""}`));
  });

  // Editable course fields: entry requirements (and name/school) change over
  // time — they are data, not code. New applicants are judged by the rules in
  // force when THEY applied (requirement snapshots); edits affect new cases.
  app.post("/config/programme/edit", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const programme = String(req.body.programme ?? "").trim();
    const back = (m: string) => `/config?msg=${encodeURIComponent(m)}#courses`;
    if (!programme || !repo.programmeByCode(programme)) return res.redirect(back("Unknown course."));
    repo.updateProgramme(programme, {
      name: String(req.body.name ?? ""),
      school: String(req.body.school ?? ""),
      entry_requirements: String(req.body.entry_requirements ?? ""),
    });
    repo.audit(null, req.staff!.username, "programme_updated", `${programme}: catalogue fields edited`);
    res.redirect(back(`Course ${programme} saved.`));
  });

  // Structured entry requirements — one qualification-system block per save.
  app.post("/config/entry-requirements", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const target = String(req.body.target ?? "").trim();
    const back = (m: string) => `/config?msg=${encodeURIComponent(m)}&reqs=${encodeURIComponent(target)}#entryreqs`;
    const system = String(req.body.system ?? "").trim() as SystemBlock["system"];
    if (!EXAM_SYSTEMS.some((m) => m.system === system)) return res.redirect(back("Unknown qualification system."));
    const isBase = target.startsWith("BASE:");
    const level = (isBase ? target.slice(5) : repo.programmeByCode(target)?.level ?? "degree") as CourseLevel;
    if (!["degree", "diploma", "certificate", "postgrad"].includes(level)) return res.redirect(back("Unknown level."));
    const programme = isBase ? null : target.toUpperCase();
    if (!isBase && !repo.programmeByCode(programme!)) return res.redirect(back("Unknown course."));
    const meta = EXAM_SYSTEMS.find((m) => m.system === system)!;

    const enabled = req.body.enabled === "on";
    if (!enabled) {
      repo.deleteSystemBlock(programme, system, level);
      repo.audit(null, req.staff!.username, "requirements_changed",
        `${programme ?? `${level} (university-wide)`}: ${system} route removed`);
      return res.redirect(back(`${meta.label} route removed for ${programme ?? "the university-wide defaults"} — the fallback now applies.`));
    }

    const block: SystemBlock = { system, enabled: true, overall: null, subjects: [] };
    for (const f of meta.fields) {
      if (f === "overall") {
        const v = String(req.body.overall ?? "").trim().toUpperCase();
        if (v && !/^[A-E][+-]?$/.test(v)) return res.redirect(back(`"${v}" is not a KCSE grade — nothing saved.`));
        block.overall = v || null;
      } else if (f === "minCredits" || f === "minPrincipals" || f === "minSubsidiaries" || f === "minPoints") {
        const raw = String(req.body[f === "minCredits" ? "min_credits" : f === "minPrincipals" ? "min_principals" : f === "minSubsidiaries" ? "min_subsidiaries" : "min_points"] ?? "").trim();
        if (raw !== "") {
          const n = Number(raw);
          if (!Number.isInteger(n) || n < 0) return res.redirect(back("Counts must be whole numbers — nothing saved."));
          if (f === "minCredits") block.minCredits = n;
          if (f === "minPrincipals") block.minPrincipals = n;
          if (f === "minSubsidiaries") block.minSubsidiaries = n;
          if (f === "minPoints") block.minPoints = n;
        }
      } else if (f === "minGpa") {
        const raw = String(req.body.min_gpa ?? "").trim();
        if (raw !== "") {
          const n = Number(raw);
          if (!Number.isFinite(n) || n < 0 || n > 4) return res.redirect(back("GPA must be between 0 and 4 — nothing saved."));
          block.minGpa = n;
        }
      } else if (f === "minClass") {
        const v = String(req.body.min_class ?? "").trim();
        block.minClass = v || null;
      }
    }
    // Subject matrix: checkbox sub_i + grade_i + optional alternative alt_i.
    for (let i = 0; i < SUBJECT_CATALOG.length; i++) {
      if (req.body[`sub_${i}`] !== "on") continue;
      const grade = String(req.body[`grade_${i}`] ?? "").trim();
      if (!grade) return res.redirect(back(`${SUBJECT_CATALOG[i]} is ticked but has no minimum grade — nothing saved.`));
      const alt = String(req.body[`alt_${i}`] ?? "").trim();
      block.subjects!.push({ subject: SUBJECT_CATALOG[i], grade, ...(alt ? { alts: [alt] } : {}) });
    }
    repo.upsertSystemBlock(programme, level, block);
    repo.audit(null, req.staff!.username, "requirements_changed",
      `${programme ?? `${level} (university-wide)`}: ${system} entry requirements saved (${block.subjects!.length} subject rule(s))`);
    res.redirect(back(`Entry requirements saved for ${meta.label} — new applicants are checked against them immediately.`));
  });

  // ══ Requirements Configuration (round 18) ════════════════════════════════
  // Machine-evaluable rule trees per (programme × qualification system),
  // edited visually — no code, no raw expressions. Draft → preview → activate.

  /** Parse a `reqs` target ("BASE:degree" | programme code) + system. */
  const reqsTarget = (req: Request): { programme: string | null; level: CourseLevel; system: AdmissionSystem; back: (m: string) => string } | null => {
    const target = String(req.body.target ?? req.query.target ?? "").trim();
    const system = String(req.body.system ?? req.query.system ?? "").trim() as AdmissionSystem;
    const isBase = target.startsWith("BASE:");
    const level = (isBase ? target.slice(5) : repo.programmeByCode(target)?.level ?? "degree") as CourseLevel;
    const programme = isBase ? null : target.toUpperCase();
    const back = (m: string) =>
      `/config?tab=requirements&msg=${encodeURIComponent(m)}&reqs=${encodeURIComponent(target)}&system=${encodeURIComponent(system)}#reqbuilder`;
    if (!ADMISSION_SYSTEMS.includes(system)) return null;
    if (!["degree", "diploma", "certificate", "postgrad"].includes(level)) return null;
    if (!isBase && !repo.programmeByCode(programme!)) return null;
    return { programme, level, system, back };
  };

  app.post("/config/requirements/node-add", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const t = reqsTarget(req);
    if (!t) return res.redirect("/config?tab=requirements");
    const set = repo.ensureDraftSet(t.programme, t.level, t.system, req.staff!.username);
    const kind = String(req.body.kind) === "group" ? "group" : "condition";
    const parentId = req.body.parent ? Number(req.body.parent) : null;
    const nodeId = repo.addRuleNode(set.id, parentId && parentId > 0 ? parentId : null, kind, "AND");
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
      patch.value = v || null;
    }
    if (Object.keys(patch).length === 0) return res.redirect(t.back("Nothing to save."));
    // Subject conditions need a subject; grade/number conditions need a value.
    repo.updateRuleNode(nodeId, patch);
    res.redirect(t.back("Rule updated in the draft — preview it, then activate."));
  });

  app.post("/config/requirements/node-delete", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const t = reqsTarget(req);
    if (!t) return res.redirect("/config?tab=requirements");
    const nodeId = Number(req.body.node);
    repo.deleteRuleNode(nodeId);
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
    repo.addCatalogueSubject(system, name);
    repo.audit(null, req.staff!.username, "catalogue_changed", `${system}: subject "${name}" added`);
    res.redirect(back(`Subject "${name}" added to the ${system} catalogue.`));
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

  // Official pack files: download (staff) + replace (raw PDF upload).
  app.get("/pack/:key", requireLogin, (req, res) => {
    const slot = PACK_SLOTS.find((x) => x.key === req.params.key);
    if (!slot) return res.status(404).send("Unknown pack file.");
    const file = path.join(PACK_DIR, slot.file);
    if (!fs.existsSync(file)) return res.status(404).send("Pack file missing.");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${slot.pretty}"`);
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
      fs.writeFileSync(path.join(PACK_DIR, slot.file), body);
      repo.audit(null, req.staff!.username, "pack_file_replaced", `${slot.file} replaced (${body.length} bytes)`);
      res.status(200).send("saved");
    }
  );

  // ── Gmail connect (OAuth code flow; tokens stored in Settings) ───────────

  const settingsBack = (msg: string) => `/config?tab=replies&msg=${encodeURIComponent(msg)}#gmail`;

  app.post("/settings/gmail/credentials", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    repo.setSetting("gmail_address", String(req.body.gmail_address ?? "").trim());
    repo.setSetting("gmail_client_id", String(req.body.gmail_client_id ?? "").trim());
    // Which part of the mailbox to watch; blank = the inbox. Applies on the
    // very next sync — no restart needed.
    repo.setSetting("gmail_label", String(req.body.gmail_label ?? "").trim());
    // Secret is write-only in the UI: kept if the field is left blank.
    const secret = String(req.body.gmail_client_secret ?? "").trim();
    if (secret) repo.setSetting("gmail_client_secret", secret);
    repo.audit(null, req.staff!.username, "gmail_credentials_saved", "stored OAuth credentials in settings");
    res.redirect(settingsBack("Gmail credentials saved — now press “Connect with Google”."));
  });

  app.get("/settings/gmail/connect", requireLogin, requireRole("admin"), (req, res) => {
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

  app.get("/settings/gmail/callback", requireLogin, requireRole("admin"), async (req, res) => {
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

  app.post("/settings/gmail/disconnect", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    repo.setSetting("gmail_refresh_token", "");
    repo.audit(null, req.staff!.username, "gmail_disconnected", "");
    res.redirect(settingsBack("Gmail disconnected — live fetching stopped."));
  });

  // Manual "Sync now": pull the inbox immediately instead of waiting for the
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
    repo.audit(null, req.staff!.username, "gmail_synced", "manual sync from Configuration");
    res.redirect(settingsBack("Inbox synced — new mail has been triaged."));
  });

  // ── Gemini (document-reading AI) — a first-class settings field ───────────
  // The key is stored in Settings, used by the extraction pipeline AT ONCE
  // (no restart, no env file). "Test key" performs a real round-trip and
  // reports exactly what happened.
  const rebuildAdapters = () => {
    const key = repo.getSetting("gemini_api_key", "").trim();
    if (!key) return;
    const model = repo.getSetting("gemini_model", "gemini-1.5-flash").trim() || "gemini-1.5-flash";
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
    const back = (m: string) => `/config?tab=replies&msg=${encodeURIComponent(m)}#gemini`;
    const key = String(req.body.gemini_api_key ?? "").trim();
    const model = String(req.body.gemini_model ?? "gemini-1.5-flash").trim() || "gemini-1.5-flash";
    if (req.body.clear !== undefined) {
      repo.setSetting("gemini_api_key", "");
      repo.setSetting("gemini_last_error", "");
      repo.audit(null, req.staff!.username, "gemini_disabled", "API key removed — back to mock reading");
      return res.redirect(back("Gemini key removed. Document reading falls back to text/OCR only."));
    }
    if (!key && !repo.getSetting("gemini_api_key", "")) {
      return res.redirect(back("Paste a Gemini API key first (get one free at aistudio.google.com/apikey)."));
    }
    if (key) repo.setSetting("gemini_api_key", key);
    repo.setSetting("gemini_model", model);
    // Prove the key with ONE real API call before claiming it works.
    try {
      const probe = new GeminiVisionAdapter(repo.getSetting("gemini_api_key", ""), model);
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

  app.post("/settings/general", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    // Blank identity fields keep their current value (an empty ref prefix
    // would break ref generation); numbers are validated.
    const ignored: string[] = [];
    const numOk = (v: string) => /^\d+(\.\d+)?$/.test(v) && Number(v) > 0;
    const ladderOk = (v: string) => v.split(",").every((p) => /^\d+$/.test(p.trim()) && Number(p.trim()) > 0);
    for (const key of [
      "ref_prefix", "sla_target_hours", "escalation_hours", "from_name",
      "unanswered_target_hours", "followup_ladder_days", "retention_days",
      "reg_date", "orientation_dates",
    ]) {
      if (typeof req.body[key] !== "string") continue;
      const v = String(req.body[key]).trim();
      if (key === "ref_prefix" && !v) {
        ignored.push(key.replace(/_/g, " "));
        continue;
      }
      if (["sla_target_hours", "escalation_hours", "unanswered_target_hours", "retention_days"].includes(key) && !numOk(v)) {
        ignored.push(key.replace(/_/g, " "));
        continue;
      }
      if (key === "followup_ladder_days" && !ladderOk(v)) {
        ignored.push(key.replace(/_/g, " "));
        continue;
      }
      repo.setSetting(key, v);
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
  app.post("/settings/rules/add", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const docType = String(req.body.document_type);
    // Anything outside the known document types would store a rule that can
    // never match — silently. Reject it instead of pretending.
    if (!DOC_TYPES.includes(docType as DocType) || docType === "unknown") {
      return res.redirect("/config?msg=" + encodeURIComponent("Unknown document type — rule not saved.") + "#courses");
    }
    const meanGrade = String(req.body.mean_grade ?? "").trim().toUpperCase();
    if (meanGrade && !/^[A-E][+-]?$/.test(meanGrade)) {
      return res.redirect("/config?msg=" + encodeURIComponent(`"${meanGrade}" is not a KCSE grade (use A, A-, B+, … E) — rule not saved.`) + "#courses");
    }
    const subjectGrades = String(req.body.subject_grades ?? "").trim() || null;
    repo.upsertRule({
      programme: req.body.programme ? String(req.body.programme) : null,
      intake: req.body.intake ? String(req.body.intake) : null,
      document_type: docType as DocType,
      required: String(req.body.required) === "1",
      meanGrade: meanGrade || null,
      subjectGrades,
    });
    repo.audit(null, req.staff!.username, "requirements_changed", `rule saved for ${docType}${meanGrade ? ` (min ${meanGrade})` : ""}`);
    res.redirect("/config#courses");
  });

  app.post("/settings/rules/delete", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    repo.deleteRule(Number(req.body.id));
    repo.audit(null, req.staff!.username, "requirements_changed", `rule #${req.body.id} removed`);
    res.redirect("/config#courses");
  });

  app.post("/settings/lists/add", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const added: string[] = [];
    if (req.body.prog_code && req.body.prog_name) { repo.addProgramme(String(req.body.prog_code), String(req.body.prog_name)); added.push("programme"); }
    if (req.body.intake) { repo.addIntake(String(req.body.intake)); added.push("intake"); }
    repo.audit(null, req.staff!.username, "lists_changed", "programmes/intakes updated");
    res.redirect("/config?msg=" + encodeURIComponent(added.length ? `Added ${added.join(" and ")}.` : "Nothing to add — fill in a programme code and name, or an intake.") + "#courses");
  });

  app.post("/settings/template", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const key = String(req.body.key ?? "");
    const existing = repo.getTemplate(key);
    const back = (m: string) => `/config?tab=replies&template=${encodeURIComponent(key)}&msg=${encodeURIComponent(m)}#templates`;
    if (!existing) return res.redirect(back("Unknown template — nothing saved."));
    const name = String(req.body.name ?? "").trim();
    const subject = String(req.body.subject ?? "").trim();
    const body = String(req.body.body ?? "").trim();
    if (!name || !subject || !body) return res.redirect(back("Template needs a name, a subject and a body — nothing saved."));
    repo.upsertTemplate(key, name, subject, body);
    repo.setTemplateBanner(key, req.body.include_banner !== undefined);
    repo.audit(null, req.staff!.username, "template_changed", key);
    res.redirect(back(`Template “${name}” saved.`));
  });

  // ── Staff management (admin) ─────────────────────────────────────────────

  app.get("/staff", requireLogin, requireRole("admin"), (req, res) =>
    res.send(staffPage(c(req), req.query.msg ? String(req.query.msg) : undefined))
  );

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

  app.get("/export/applicants.csv", requireLogin, requireRole("admin"), (_req, res) => {
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

  app.get("/export/queue.csv", requireLogin, requireRole("admin"), (_req, res) => {
    const rows = repo.queueView();
    csv(
      res,
      "review-queue.csv",
      ["ref_number", "name", "email", "verdict", "priority", "flags", "sla_due", "escalated"],
      rows.map((r) => [r.ref_number, r.full_name, r.email_address, r.computed_status, r.priority, r.flag_summary, r.sla_due_at, r.escalated])
    );
  });

  app.get("/export/audit.csv", requireLogin, requireRole("admin"), (_req, res) => {
    const rows = repo.recentAudit(10000);
    csv(res, "audit.csv", ["at", "actor", "event", "detail", "applicant_id"], rows.map((r) => [r.at, r.actor, r.event, r.detail, r.applicant_id]));
  });


  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  /** Command-palette search API (v4). Realm-scoped like every other list. */
  app.get("/api/search", requireLogin, (req, res) => {
    const q = String(req.query.q ?? "").trim();
    if (!q) return res.json({ applicants: [] });
    res.json({
      applicants: repo.searchApplicants({ q, limit: 8, demo: req.staff!.demo }).map((a) => ({
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
      institution: instName(),
      publicPage: !req.staff,
      user: req.staff,
      unread: req.staff ? repo.unreadCount(req.staff.id) : undefined,
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
    repo.notify("escalation", `Case ${a.ref_number} has exceeded its response target.`, a.id);
    repo.audit(a.id, "system", "escalated", `exceeded response target (escalation window ${escalationHours}h)`);
    n++;
    log(`escalation: ${a.ref_number} exceeded response target → urgent`, "warn");
  }
  return n;
}
