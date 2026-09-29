/**
 * export routes. Extracted verbatim from server.ts createApp;
 * shared closure state arrives via RouteCtx — behavior unchanged.
 */
import type { Express, Response } from "express";
import { requireLogin, requireRole } from "../auth";
import type { RouteCtx } from "./ctx";

export function registerExport(app: Express, rt: RouteCtx): void {
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
    const schools = rt.repo.caseScopeFor(req.staff!);
    const rows = rt.repo.allApplicants(demo, schools);
    // Two aggregate queries for the whole export — never 2N per-applicant
    // lookups on a synchronous connection.
    const docCounts = rt.repo.documentCountsByApplicant();
    const flagTypes = rt.repo.activeFlagTypesByApplicant();
    csv(
      res,
      "applicants.csv",
      ["ref_number", "name", "email", "phone", "programme", "intake", "lifecycle", "triage", "priority", "assigned_to", "active_docs", "flags", "created_at"],
      rows.map((a) => [
        a.ref_number, a.full_name, a.email_address, a.phone, a.programme, a.intake, a.lifecycle, a.triage,
        a.priority, a.assigned_to ? rt.repo.getStaff(a.assigned_to)?.username ?? "" : "",
        docCounts.get(a.id) ?? 0,
        (flagTypes.get(a.id) ?? []).join("; "),
        a.created_at,
      ])
    );
  });

  app.get("/export/queue.csv", requireLogin, requireRole("admin"), (req, res) => {
    const demo = req.staff!.demo ?? 0;
    const schools = rt.repo.caseScopeFor(req.staff!);
    const rows = rt.repo.queueView(demo, schools);
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
    const schools = rt.repo.caseScopeFor(req.staff!);
    const visible = new Set(rt.repo.allApplicants(demo, schools).map((a) => a.id));
    const rows = rt.repo
      .recentAudit(10000)
      .filter((r) => r.applicant_id === null || visible.has(r.applicant_id));
    csv(res, "audit.csv", ["at", "actor", "event", "detail", "applicant_id"], rows.map((r) => [r.at, r.actor, r.event, r.detail, r.applicant_id]));
  });
}
