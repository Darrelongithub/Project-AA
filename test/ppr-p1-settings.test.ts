/**
 * PPR P1 acceptance (settings surfaces) — each item proven through real
 * admin routes and real rendered pages:
 *  P1-1: terminology labels (case/contact/category/stage/outcome) are
 *        case-type data; the defaults are the product's own generic wording;
 *        internal keys and DB columns never move.
 *  P1-2: stages and queues are configurable per case type (the shipped preset
 *        is the four-stage generic lifecycle), and a rule can route into a
 *        configured queue.
 *  P1-6: SLA target hours, escalation hours and the follow-up ladder are
 *        surfaced in the real Settings UI and save through the real route.
 *  P1-8: the four automation actions are distinct permissions replacing the
 *        admin/user role split — enforced on the routes.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import { openDb } from "../src/db/db";
import { Repo, GENERIC_STAGE_PRESET, GENERIC_QUEUE_PRESET } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { createApp } from "../src/web/server";
import { hashPassword } from "../src/util/password";
import { webLogin, configureTestOrganization } from "./helpers";
import { processEmail } from "../src/pipeline";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";
import type { IncomingEmail } from "../src/types";

function fresh(): Repo {
  const repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  return repo;
}

const mail = (over: Partial<IncomingEmail>): IncomingEmail => ({
  id: over.id ?? "p1-1",
  threadId: over.threadId ?? "p1-thread",
  from: over.from ?? "someone@example.test",
  subject: over.subject ?? "hello",
  body: over.body ?? "hello there",
  receivedAt: new Date().toISOString(),
  attachments: [],
  ...over,
});

describe("PPR P1-1/P1-2/P1-6/P1-8: vocabulary, stages & queues, SLA settings, permissions", () => {
  let repo: Repo;
  let ctx: PipelineContext;
  let sender: MockSender;
  let server: Server | undefined;
  let base = "";
  let adminAuth: { cookie: string; csrf: string };

  const post = (path: string, body: Record<string, string>, auth: { cookie: string; csrf: string }) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { cookie: auth.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: auth.csrf, ...body }),
      redirect: "manual",
    });

  beforeAll(async () => {
    repo = fresh();
    // One explicitly configured tenant, created BEFORE any account so every
    // staff member and every route resolves to it.
    configureTestOrganization(repo);
    repo.createStaff("admin", "Administrator", hashPassword("admin123"), "admin");
    sender = new MockSender();
    ctx = { repo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender } };
    const app = createApp({ repo, ctx });
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    base = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
    const login = await webLogin(base, "admin", "admin123");
    expect(login.status).toBe(302);
    adminAuth = { cookie: login.cookie, csrf: login.csrf };
  });

  afterAll(() => server?.close());

  it("P1-2: the shipped preset IS the generic lifecycle (ids stable)", () => {
    expect(GENERIC_STAGE_PRESET.map((s) => s.id)).toEqual([
      "application_received", "documents_received", "awaiting_review", "completed",
    ]);
    expect(GENERIC_QUEUE_PRESET.map((q) => q.id)).toEqual(["new", "in_progress", "waiting", "done"]);
    // Internal keys unchanged: the DB columns keep their names.
    const cols = (repo.db.prepare("PRAGMA table_info(applicants)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("lifecycle");
    expect(cols).toContain("queue");
    expect(cols).toContain("ref_number");
  });

  it("P1-1/P1-2: admin renames terminology, stages and queues through the real route — the case page renders them", async () => {
    expect((await post("/config/case-types/create", {
      organization_id: "1", code: "SVC", name: "Service request", category: "general",
    }, adminAuth)).status).toBe(302);
    const svc = repo.getCaseType("SVC", 1)!;
    expect((await post("/config/case-types/vocabulary", {
      id: String(svc.id),
      term_case: "Matter", term_contact: "Requester", term_category: "Topic",
      term_stage: "Phase", term_outcome: "Resolution",
      stages_text: "intake|Received\nreview|In review\ndone|Closed",
      queues_text: "desk|Front desk\nbackoffice|Back office",
    }, adminAuth)).status).toBe(302);
    const saved = repo.getCaseType("SVC", 1)!;
    expect(saved.terminology!.case).toBe("Matter");
    expect(saved.stages!.map((s) => s.id)).toEqual(["intake", "review", "done"]); // ids stable
    expect(saved.queues!.find((q) => q.id === "desk")?.label).toBe("Front desk");
    // Vocabulary edits are configuration publishes — the case-type version moved:
    expect(saved.config_version!).toBeGreaterThan(svc.config_version!);

    // A rule routes the case into the configured queue and stage, and the
    // rendered case page shows the renamed words (real e2e):
    expect((await post("/config/workflow-rules/save", {
      name: "Service requests open", kind: "intake", case_type_id: String(svc.id), position: "0",
      cond_field_0: "text", cond_value_0: "service request",
      decision: "create", audit_code: "rule_svc_intake", fallback: "human_draft",
    }, adminAuth)).status).toBe(302);
    expect((await post("/config/workflow-rules/save", {
      name: "Route to the front desk", kind: "response", case_type_id: String(svc.id), position: "0",
      cond_field_0: "always", cond_value_0: "true",
      reply_action: "hold", stage: "review", queue: "desk", fallback: "human_draft",
      audit_code: "rule_svc_route",
    }, adminAuth)).status).toBe(302);
    const result = await processEmail(mail({
      id: "p1-svc-1", from: "citizen@example.test",
      subject: "Service request about my account", body: "Please help with this service request.",
      organizationId: 1, caseTypeCode: "SVC",
    }), ctx);
    expect(result.skipped).not.toBe(true);
    const caseRow = repo.getApplicant(result.applicantId!)!;
    expect(caseRow.queue).toBe("desk"); // rule-assigned configured queue
    expect(result.lifecycle).toBe("review"); // rule-assigned configured stage
    const page = await (await fetch(`${base}/case/${caseRow.id}`, { headers: { cookie: adminAuth.cookie } })).text();
    expect(page).toMatch(/Matter overview/);        // term_case
    expect(page).toMatch(/>Requester</);            // term_contact
    expect(page).toMatch(/>Topic</);                // term_category
    expect(page).toMatch(/>Phase</);                // term_stage
    expect(page).toMatch(/In review/);              // stage label
    expect(page).toMatch(/Front desk/);             // queue label
  });

  it("P1-1: a case type nobody renamed keeps the shipped wording", async () => {
    // A brand-new case type carries no vocabulary of its own: the console uses
    // the product's generic words until an administrator renames something.
    expect((await post("/config/case-types/create", {
      organization_id: "1", code: "PLAIN", name: "Plain intake", category: "general",
    }, adminAuth)).status).toBe(302);
    const result = await processEmail(mail({
      id: "p1-plain-1", from: "plain@example.test", organizationId: 1, caseTypeCode: "PLAIN",
      subject: "Plain intake question", body: "Please help me with this plain intake.",
    }), ctx);
    expect(result.skipped).not.toBe(true);
    const page = await (await fetch(`${base}/case/${result.applicantId}`, { headers: { cookie: adminAuth.cookie } })).text();
    expect(page).toMatch(/Case overview/);
    expect(page).not.toMatch(/Matter overview/);
    expect(repo.getCaseType("PLAIN", 1)!.terminology ?? {}).toEqual({});
  });

  it("P1-6: SLA target, escalation hours and the follow-up ladder are in the real Settings UI", async () => {
    const settingsPageHtml = await (await fetch(`${base}/settings`, { headers: { cookie: adminAuth.cookie } })).text();
    expect(settingsPageHtml).toMatch(/sla_target_hours/);
    expect(settingsPageHtml).toMatch(/escalation_hours/);
    expect(settingsPageHtml).toMatch(/followup_ladder_days/);
    expect(settingsPageHtml).toMatch(/Response targets/);
    expect((await post("/settings/general", {
      sla_target_hours: "6", escalation_hours: "48", followup_ladder_days: "3,7,10",
    }, adminAuth)).status).toBe(302);
    expect(repo.getSetting("sla_target_hours", "")).toBe("6");
    expect(repo.getSetting("escalation_hours", "")).toBe("48");
    expect(repo.getSetting("followup_ladder_days", "")).toBe("3,7,10");
  });

  it("P1-8: the four automation actions are distinct permissions, enforced on the routes", async () => {
    // A regular staff account starts with the historical defaults:
    repo.createStaff("officer", "Olive Officer", hashPassword("officer1"), "user");
    const officer = repo.getStaffByUsername("officer")!;
    expect(repo.hasPermission(officer.id, "send_automated")).toBe(true);
    expect(repo.hasPermission(officer.id, "approve_automation")).toBe(true);
    expect(repo.hasPermission(officer.id, "publish_rules")).toBe(false);
    expect(repo.hasPermission(officer.id, "record_outcome")).toBe(false);

    const officerLogin = await webLogin(base, "officer", "officer1");
    const officerAuth = { cookie: officerLogin.cookie, csrf: officerLogin.csrf };
    const svc = repo.getCaseType("SVC", 1)!;

    // (1) publish workflow rules — refused without the permission…
    const denied = await post("/config/workflow-rules/save", {
      name: "Officer rule", kind: "intake", case_type_id: String(svc.id),
      cond_field_0: "always", cond_value_0: "true", decision: "create",
    }, officerAuth);
    expect(denied.status).toBe(403);
    // …granted through the real staff permissions UI route…
    expect((await post("/staff/permissions", {
      [`perm_${officer.id}_publish_rules`]: "1",
      [`perm_${officer.id}_send_automated`]: "1",
      [`perm_${officer.id}_approve_automation`]: "1",
    }, adminAuth)).status).toBe(302);
    expect(repo.hasPermission(officer.id, "publish_rules")).toBe(true);
    // …and then it works:
    const allowed = await post("/config/workflow-rules/save", {
      name: "Officer rule", kind: "intake", case_type_id: String(svc.id),
      cond_field_0: "always", cond_value_0: "true", decision: "create", audit_code: "rule_officer",
    }, officerAuth);
    expect(allowed.status).toBe(302);

    // (2) record outcome — still refused (not granted). Outcomes are a human
    // decision on any case, so use the unrenamed case from earlier:
    const plainCase = repo.db.prepare("SELECT id FROM applicants WHERE email_address = ?").get("plain@example.test") as { id: number };
    const deniedOutcome = await post(`/case/${plainCase.id}/outcome`, {
      outcome: "approved_after_review", reason: "test",
    }, officerAuth);
    expect(deniedOutcome.status).toBe(403);
    // Grant it and the same route works:
    expect((await post("/staff/permissions", {
      [`perm_${officer.id}_publish_rules`]: "1",
      [`perm_${officer.id}_record_outcome`]: "1",
    }, adminAuth)).status).toBe(302);
    const allowedOutcome = await post(`/case/${plainCase.id}/outcome`, {
      outcome: "approved_after_review", reason: "approved under the documented exception route",
    }, officerAuth);
    expect(allowedOutcome.status).toBe(302);
    // And the outcome really landed (decision_by is the officer):
    const recorded = repo.getApplicant(plainCase.id)!;
    expect(recorded.outcome).toBe("approved_after_review");
    expect(recorded.decision_by).toBe("officer");

    // (3) approve automation — P1-3 split: an ordinary draft is officer work
    // (staff send paths stay allowed without the permission); only a draft
    // awaiting APPROVAL is refused.
    repo.createStaff("clerk", "Chris Clerk", hashPassword("clerk1"), "user");
    const clerk = repo.getStaffByUsername("clerk")!;
    repo.setPermissions(clerk.id, ["send_automated"]); // explicitly no approval right
    const clerkLogin = await webLogin(base, "clerk", "clerk1");
    const ordinaryDraft = await post(`/case/${plainCase.id}/draft`, { decision: "edit" }, {
      cookie: clerkLogin.cookie, csrf: clerkLogin.csrf,
    });
    expect(ordinaryDraft.status).toBe(302); // not 403 — ordinary drafts are officer work
    repo.addOutbox({
      applicant_id: plainCase.id, to_address: "plain@example.test",
      subject: "Awaiting approval", body: "A real reply body.", mode: "queued",
      template_key: "status_answer", needs_approval: 1,
    });
    const deniedDraft = await post(`/case/${plainCase.id}/draft`, { decision: "discard" }, {
      cookie: clerkLogin.cookie, csrf: clerkLogin.csrf,
    });
    expect(deniedDraft.status).toBe(403);
    // The refusal is the PERMISSION (not visibility) — the message names it:
    expect(await deniedDraft.text()).toMatch(/Approve automation/);
    // Admins hold all four, always:
    for (const p of ["publish_rules", "send_automated", "approve_automation", "record_outcome"] as const) {
      expect(repo.hasPermission(repo.getStaffByUsername("admin")!.id, p)).toBe(true);
    }
  });
});
