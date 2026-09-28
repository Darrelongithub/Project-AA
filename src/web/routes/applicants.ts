/**
 * applicants routes. Extracted verbatim from server.ts createApp;
 * shared closure state arrives via RouteCtx — behavior unchanged.
 */
import type { Express } from "express";
import { admissionsPage, applicantsPage } from "../pages";
import { requireLogin } from "../auth";
import type { RouteCtx } from "./ctx";

export function registerApplicants(app: Express, rt: RouteCtx): void {
  app.get("/applicants", requireLogin, (req, res) => {
    res.send(
      applicantsPage(rt.c(req), {
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
    if (!rt.repo.hasEducationModule(rt.organizationId(req))) {
      return res.redirect("/applicants?msg=" + encodeURIComponent("Admissions is off — this organization has no education-module profile."));
    }
    res.send(admissionsPage(rt.c(req), String(req.query.stage ?? "all")));
  });
}
