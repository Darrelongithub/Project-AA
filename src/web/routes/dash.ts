/**
 * dash routes. Extracted verbatim from server.ts createApp;
 * shared closure state arrives via RouteCtx — behavior unchanged.
 */
import type { Express } from "express";
import { dashboardPage, intakeTestPage } from "../pages";
import { processEmail } from "../../pipeline";
import { makeTextPdf } from "../../simulation/pdfFactory";
import { csrfCheck, requireLogin, requireRole } from "../auth";
import { organizationName } from "../../branding";
import type { RouteCtx } from "./ctx";

export function registerDash(app: Express, rt: RouteCtx): void {
  // ── Dashboard / queue / applicants ───────────────────────────────────────

  app.get("/", requireLogin, (req, res) => res.send(dashboardPage(rt.c(req))));

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
    const org = Number.isInteger(id) ? rt.repo.getOrganization(id) : undefined;
    if (!org) return res.redirect("/?msg=" + encodeURIComponent("Unknown organization."));
    rt.repo.setActiveOrganization(req.staff!.id, org.id);
    rt.repo.audit(null, req.staff!.username, "organization_switched", `${org.id}:${org.name}`);
    res.redirect("/applicants?msg=" + encodeURIComponent(`Switched to ${organizationName(rt.repo, org.id)}.`));
  });

  // DEMO: test intake — a simulated inbound message for one of the ACTIVE
  // organization's CaseTypes, processed by the real pipeline.
  app.get("/intake/test", requireLogin, requireRole("admin"), (req, res) => {
    res.send(intakeTestPage(rt.c(req), { caseTypeCode: req.query.case_type ? String(req.query.case_type) : undefined, msg: req.query.msg ? String(req.query.msg) : undefined }));
  });
  app.post("/intake/test", requireLogin, requireRole("admin"), csrfCheck, async (req, res) => {
    const orgId = rt.organizationId(req);
    const ct = rt.repo.getCaseType(String(req.body.case_type ?? ""), orgId);
    if (!ct) return res.redirect("/intake/test?msg=" + encodeURIComponent("Unknown CaseType for this organization."));
    const from = String(req.body.from ?? "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(from)) return res.redirect(`/intake/test?case_type=${encodeURIComponent(ct.code)}&msg=` + encodeURIComponent("A valid contact email is required."));
    const fromName = String(req.body.from_name ?? "").trim().slice(0, 80);
    const wanted = new Set(([] as string[]).concat(req.body.doc ?? []).map(String));
    const slots = rt.repo.listDocumentDefinitions(ct.id).filter((d) => wanted.has(d.key));
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
      }, rt.ctx);
      if (!result.applicantId) return res.redirect(`/intake/test?case_type=${encodeURIComponent(ct.code)}&msg=` + encodeURIComponent("The message was parked by the intake gate (no case opened). Mention the CaseType in the subject."));
      rt.repo.audit(result.applicantId, req.staff!.username, "test_intake_submitted", `${ct.code}: ${slots.length} document(s)`);
      return res.redirect(rt.backToCase(result.applicantId, `Test message processed for ${ct.name}.`));
    } catch (e) {
      return res.redirect(`/intake/test?case_type=${encodeURIComponent(ct.code)}&msg=` + encodeURIComponent(`Processing failed: ${(e as Error).message}`));
    }
  });
}
