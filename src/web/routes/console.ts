/**
 * Phase 12: per-org admin security console (read-only monitoring).
 *
 * Same gates as /staff and /metrics (requireLogin + requireRole("admin")),
 * plus an explicit cross-org guard: the org is derived ONLY from the
 * session — a ?org= that disagrees with it is refused 403 at the data
 * boundary, never honored. Every query underneath filters by that org
 * in SQL (src/db/repo/console.ts).
 */
import type { Express } from "express";
import { flushMetrics } from "../../metrics";
import { consolePage, type ConsoleRange } from "../pages/console";
import { requireLogin, requireRole } from "../auth";
import type { RouteCtx } from "./ctx";

const RANGES: ConsoleRange[] = ["24h", "7d", "30d", "all", "custom"];

export function registerConsole(app: Express, rt: RouteCtx): void {
  app.get("/console", requireLogin, requireRole("admin"), (req, res) => {
    const orgId = rt.organizationId(req);
    if (req.query.org !== undefined && Number(req.query.org) !== orgId) {
      res.status(403).send("403 — the security console shows your organization only.");
      return;
    }
    // Durations must include runs from the last minute, not just the last flush.
    flushMetrics((day, name, n, sum) => rt.repo.upsertMetric(day, name, n, sum));
    const rawRange = String(req.query.range ?? "24h");
    const range: ConsoleRange = (RANGES as string[]).includes(rawRange) ? (rawRange as ConsoleRange) : "24h";
    res.send(consolePage(rt.c(req), orgId, rt.instName(req), {
      range,
      from: String(req.query.from ?? ""),
      to: String(req.query.to ?? ""),
    }));
  });
}
