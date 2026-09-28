/**
 * The web console (features 11–21, 27–35, 38–39):
 * staff dashboard, review queue, one-click case files, search/filters,
 * settings & templates, staff management, notifications, exports,
 * and the public applicant self-service status page.
 *
 * Server-rendered, self-contained, DB-backed sessions + CSRF.
 */
import express, { type Express } from "express";
import { authMiddleware } from "./auth";
import { buildRouteCtx, type WebDeps } from "./routes/ctx";
export type { WebDeps } from "./routes/ctx";
import { registerAssets } from "./routes/assets";
import { registerAuth } from "./routes/auth";
import { registerDash } from "./routes/dash";
import { registerApplicants } from "./routes/applicants";
import { registerCase } from "./routes/case";
import { registerMail } from "./routes/mail";
import { registerCompose } from "./routes/compose";
import { registerAccount } from "./routes/account";
import { registerSettings } from "./routes/settings";
import { registerConfig } from "./routes/config";
import { registerTemplates } from "./routes/templates";
import { registerStaff } from "./routes/staff";
import { registerExport } from "./routes/export";
import { registerSystem } from "./routes/system";
import type { Repo } from "../db/repo";
import { log } from "../util/log";
import { metrics } from "../metrics";

export function createApp(deps: WebDeps): Express {
  const app = express();

  app.disable("x-powered-by");
  // Behind any reverse proxy (the preview environment included) req.ip is the
  // proxy's address unless this is set — which makes every per-IP rate
  // limiter a single global counter for ALL users. Opt in via TRUST_PROXY=1.
  if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);
  // Phase 6: per-route request counts (route templates, so cardinality is
  // bounded) + a 5xx counter. Observes on finish; never changes responses.
  app.use((req, res, next) => {
    res.on("finish", () => {
      const route = req.route?.path ?? "unmatched";
      metrics.incr("http.requests");
      metrics.incr(`http.${req.method}.${Array.isArray(route) ? route.join(",") : route}`);
      if (res.statusCode >= 500) metrics.incr("http.5xx");
    });
    next();
  });
  app.use(express.urlencoded({ extended: true, limit: "2mb" }));
  app.use(express.json({ limit: "1mb" }));
  app.use(authMiddleware(deps.repo));
  const rt = buildRouteCtx(deps);
  registerAssets(app, rt);
  registerAuth(app, rt);
  registerDash(app, rt);
  registerApplicants(app, rt);
  registerCase(app, rt);
  registerMail(app, rt);
  registerCompose(app, rt);
  registerAccount(app, rt);
  registerSettings(app, rt);
  registerConfig(app, rt);
  registerTemplates(app, rt);
  registerStaff(app, rt);
  registerExport(app, rt);
  registerSystem(app, rt);
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
  metrics.incr("sweep.runs");
  metrics.incr("sweep.escalated", n);
  return n;
}
