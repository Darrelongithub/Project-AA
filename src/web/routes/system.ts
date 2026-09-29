/**
 * system routes. Extracted verbatim from server.ts createApp;
 * shared closure state arrives via RouteCtx — behavior unchanged.
 */
import type { Express, Request, Response } from "express";
import { avatar, layout } from "../views";
import { html } from "../tpl";
import { requireLogin, requireRole } from "../auth";
import { log } from "../../util/log";
import { flushMetrics } from "../../metrics";
import { metricsPage } from "../pages";
import type { RouteCtx } from "./ctx";

export function registerSystem(app: Express, rt: RouteCtx): void {
  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  /** Command-palette search API (v4). Realm-scoped like every other list. */
  app.get("/api/search", requireLogin, (req, res) => {
    const q = String(req.query.q ?? "").trim();
    if (!q) return res.json({ applicants: [] });
    res.json({
      applicants: rt.repo.searchApplicants({ q, limit: 8, demo: req.staff!.demo, schools: rt.repo.caseScopeFor(req.staff!) }).map((a) => ({
        id: a.id,
        ref_number: a.ref_number,
        name: a.full_name ?? "",
        email: a.email_address,
        lifecycle: a.lifecycle,
        avatar: avatar(a.full_name ?? a.ref_number, 26),
      })),
    });
  });

  // Phase 6: operational metrics, admin only. Flushes pending in-memory
  // samples first so the view is current (drain is idempotent).
  app.get("/metrics", requireLogin, requireRole("admin"), (req, res) => {
    flushMetrics((day, name, n, sum) => rt.repo.upsertMetric(day, name, n, sum));
    res.send(metricsPage(rt.c(req)));
  });

  // Branded 404 instead of Express's raw "Cannot GET …" page.
  app.use((req, res) => {
    if (req.path.startsWith("/api/")) {
      return res.status(404).json({ ok: false, error: "not found" });
    }
    res.status(404).send(layout({
      title: "Page not found",
      institution: rt.instName(req),
      publicPage: !req.staff,
      user: req.staff,
      unread: req.staff ? rt.repo.unreadCount(req.staff.id, req.staff.demo, rt.repo.caseScopeFor(req.staff)) : undefined,
      csrf: req.staff ? req.csrfToken : undefined,
      content: html`<div class="card" style="max-width:520px;margin:60px auto;text-align:center">
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
      institution: rt.instName(req),
      publicPage: !req.staff,
      user: req.staff,
      content: html`<div class="card" style="max-width:520px;margin:60px auto;text-align:center">
        <h1>Something went wrong</h1>
        <p class="sub">The error has been logged. Try again — if it persists, tell your system administrator.</p>
        <p><a class="btn" href="/">← Back to the start</a></p>
      </div>`,
    }));
  });
}
