/**
 * PPR P0-4 acceptance: first-email rules as DATA.
 *  - an admin defines intake + response rules through the real admin routes
 *    (the Workflow rules tab) for a NEW case type, and a matching
 *    email fires them end-to-end through the real pipeline;
 *  - a configured organization's rules reproduce the behaviour staff expect
 *    (complete request → acknowledgement; complaint → high-priority human
 *    review with the reply held; missing documents → held chase);
 *  - a rule set with a gap never silently drops mail: unmatched messages
 *    still reach a human;
 *  - new profiles default to draft automation (invariant f) — a send rule
 *    only starts sending once the profile explicitly opts in.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { createApp } from "../src/web/server";
import { hashPassword } from "../src/util/password";
import { webLogin, configureTestOrganization, docLines, releaseAutomation } from "./helpers";
import { processEmail } from "../src/pipeline";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";
import {makeTextPdf } from "../src/simulation/pdfFactory";
import type { Attachment, IncomingEmail } from "../src/types";

function fresh(): Repo {
  const repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  return repo;
}

const mail = (over: Partial<IncomingEmail>): IncomingEmail => ({
  id: over.id ?? "wr-1",
  threadId: over.threadId ?? "wr-thread",
  from: over.from ?? "someone@example.test",
  subject: over.subject ?? "hello",
  body: over.body ?? "hello there",
  receivedAt: new Date().toISOString(),
  attachments: [],
  ...over,
});

describe("PPR P0-4: workflow rules — first-email behaviour as data", () => {
  let repo: Repo;
  let ctx: PipelineContext;
  let sender: MockSender;
  let server: Server | undefined;
  let base = "";
  let auth: { cookie: string; csrf: string };
  let supportId = 0;
  let supportOrgId = 0;

  /** Push the fixture tenant's always-true status draft behind this suite's
   *  own rules — otherwise it wins the position/id order and masks them. */
  function deprioritizeStatusDraft(caseTypeId: number): void {
    const rule = repo.listWorkflowRules(1, { caseTypeId, kind: "response" })
      .find((r) => r.name === "Prepare a factual status draft");
    if (!rule) return;
    repo.saveWorkflowRule({
      id: rule.id, organizationId: 1, caseTypeId, kind: "response",
      name: rule.name, position: 9, conditions: rule.conditions, action: rule.action,
    });
  }

  const post = (path: string, body: Record<string, string>) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { cookie: auth.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: auth.csrf, ...body }),
      redirect: "manual",
    });

  beforeAll(async () => {
    repo = fresh();
    // One explicitly configured tenant, created BEFORE any account so every
    // staff member resolves to it.
    configureTestOrganization(repo);
    repo.createStaff("admin", "Administrator", hashPassword("admin123"), "admin");
    sender = new MockSender(true);
    ctx = { repo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender } };
    const app = createApp({ repo, ctx });
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    base = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
    const login = await webLogin(base, "admin", "admin123");
    expect(login.status).toBe(302);
    auth = { cookie: login.cookie, csrf: login.csrf };
  });

  afterAll(() => server?.close());

  it("defines a first-email rule through the UI routes and fires it end-to-end for a new case type", async () => {
    // ── real admin routes: a new case type on the configured organization ──
    // (its templates live here; per-organization template ownership is the
    // P0-6 round — rules themselves are organization-scoped either way)
    expect((await post("/config/case-types/create", {
      organization_id: "1", code: "VOL", name: "Volunteer intake", category: "general",
    })).status).toBe(302);
    const vol = repo.getCaseType("VOL", 1)!;
    expect(vol.default_reply_action).toBe("draft"); // invariant (f): new case types draft
    supportId = vol.id;
    supportOrgId = 1;

    // ── the admin defines the rules through the Workflow rules form ───
    const rulePage = await (await fetch(`${base}/config?tab=rules`, { headers: { cookie: auth.cookie } })).text();
    expect(rulePage).toMatch(/Workflow rules/);
    expect(rulePage).toMatch(/Intake rules/);
    expect(rulePage).toMatch(/Response rules/);
    expect((await post("/config/workflow-rules/save", {
      name: "Volunteer applications open a case",
      kind: "intake",
      case_type_id: String(vol.id),
      position: "0",
      cond_field_0: "text",
      cond_value_0: "volunteer, helper",
      decision: "create",
      reply_action: "send",
      template_key: "docs_request",
      followup: "ladder",
      audit_code: "rule_volunteer_intake",
      fallback: "human_draft",
    })).status).toBe(302);
    expect((await post("/config/workflow-rules/save", {
      name: "Volunteer follow-ups get a factual status",
      kind: "response",
      case_type_id: String(vol.id),
      position: "0",
      cond_field_0: "category",
      cond_value_0: "follow_up",
      reply_action: "send",
      template_key: "status_answer",
      audit_code: "rule_volunteer_status",
      fallback: "human_draft",
    })).status).toBe(302);
    const intakeRules = repo.listWorkflowRules(1, { caseTypeId: vol.id, kind: "intake" });
    expect(intakeRules.some((r) => r.name === "Volunteer applications open a case")).toBe(true);

    // ── a matching email fires the rule end-to-end ────────────────────
    const result = await processEmail(mail({
      id: "wr-vol-1",
      from: "helper@example.test",
      subject: "Volunteer application for the harbour clean-up",
      body: "I would like to volunteer as a helper this spring.",
      organizationId: 1,
      caseTypeCode: "VOL",
    }), ctx);
    expect(result.skipped).not.toBe(true);
    const caseRow = repo.getApplicant(result.applicantId!)!;
    expect(repo.caseTypeForCase(caseRow.id)?.code).toBe("VOL");
    // The rule's audit code fired — automation is explainable:
    const audit = repo.auditForApplicant(caseRow.id);
    expect(audit.some((a) => a.event === "rule_volunteer_intake")).toBe(true);
    // First-email rules for a new case type default to DRAFT automation
    // (invariant f): the reply is prepared but HELD, never sent…
    expect(sender.sent.length).toBe(0);
    const held = repo.queuedOutbox(result.applicantId!);
    expect(held).toBeTruthy(); // prepared as a queued draft, not sent
    // …and the administrator explicitly opts in: the global automation mode
    // holds every automated reply until it is released, and the case type
    // carries its own draft-first default.
    releaseAutomation(repo);
    expect((await post("/config/case-types/profile", {
      id: String(supportId), default_reply_action: "auto", evidence_gate: "0",
    })).status).toBe(302);
    const result2 = await processEmail(mail({
      id: "wr-vol-2",
      from: "helper@example.test",
      subject: "Re: Volunteer application for the harbour clean-up",
      body: "Following up on my volunteer application.",
      organizationId: 1,
      caseTypeCode: "VOL",
    }), ctx);
    expect(result2.skipped).not.toBe(true);
    expect(sender.sent.length).toBe(1); // the rule's template went out
    const audit2 = repo.auditForApplicant(result2.applicantId!);
    expect(audit2.some((a) => a.event === "rule_volunteer_status")).toBe(true);
    expect(sender.sent[0].subject.length).toBeGreaterThan(0);
  });

  it("never silently drops mail when a rule set has a gap", async () => {
    sender.sent.length = 0;
    // The VOL case type's intake rules only match “volunteer/helper” —
    // this message matches nothing. It must NOT park: it becomes a case for
    // a human (mail is never lost to a rule gap).
    const result = await processEmail(mail({
      id: "wr-gap-1",
      from: "stranger@example.test",
      subject: "Question about harbour parking",
      body: "Is the harbour car park open on Sundays?",
      organizationId: supportOrgId,
      caseTypeCode: "VOL",
    }), ctx);
    expect(result.skipped).not.toBe(true);
    const audit = repo.auditForApplicant(result.applicantId!);
    expect(audit.some((a) => a.event === "email_parked_non_intake")).toBe(false);
    // It sat with staff — nothing was auto-sent.
    expect(sender.sent.length).toBe(0);
  });

  it("a complete request is acknowledged — drafted by default, sent only on explicit opt-in", async () => {
    sender.sent.length = 0;
    const type = repo.getCaseType("SERVICE_REQUEST", 1)!;
    deprioritizeStatusDraft(type.id);
    const att = async (filename: string, docType: string): Promise<Attachment> => ({
      filename, mimeType: "application/pdf", content: await makeTextPdf(docLines(docType, { name: "ALEX MORGAN" })),
    });
    const complete = async (id: string, from: string) => processEmail(mail({
      id, threadId: `wr-${id}`, from, organizationId: 1, caseTypeCode: "SERVICE_REQUEST",
      // The case type's rule tree reads "consent" from a fact line: a trailing
      // full stop would make the value "yes." and fail the rule.
      subject: "Service request", body: "Please process my request.\nConsent: yes",
      attachments: [await att("request.pdf", "request_form"), await att("id.pdf", "id")],
    }), ctx);

    // Draft-first is the default: the acknowledgement is prepared, never sent.
    const drafted = await complete("wr-generic-1", "contact-a@example.test");
    expect(drafted.skipped).not.toBe(true);
    expect(drafted.autoSent).toBe(false);
    expect(sender.sent.length).toBe(0);
    expect(repo.queuedOutbox(drafted.applicantId!)).toBeTruthy();
    expect(repo.getCase(drafted.applicantId!)!.outcome).toBe("undecided");
    const draftAudit = repo.auditForApplicant(drafted.applicantId!);
    expect(draftAudit.some((entry) => entry.event === "case_type_gate")).toBe(true);
    expect(draftAudit.some((entry) => entry.event === "fixture_drafted")).toBe(true);

    // Explicit opt-in: the same case type may send, and still never decides.
    releaseAutomation(repo);
    repo.updateCaseTypeProfile(type.id, { default_reply_action: "auto", evidence_gate: 0 });
    repo.saveWorkflowRule({
      organizationId: 1, caseTypeId: type.id, kind: "response", name: "Acknowledge a complete request", position: 0,
      conditions: [{ field: "docs_state", value: "complete" }],
      action: { reply_action: "send", template_key: "ack_received", audit_code: "rule_ack" },
    });
    const sent = await complete("wr-generic-2", "contact-b@example.test");
    expect(sent.autoSent).toBe(true);
    expect(sender.sent.length).toBe(1);
    expect(sender.sent[0].subject).toContain("Information received");
    const sentRow = repo.getCase(sent.applicantId!)!;
    expect(sentRow.outcome).toBe("undecided");
    expect(sentRow.decision_by).toBeNull();
    const sentAudit = repo.auditForApplicant(sent.applicantId!);
    expect(sentAudit.some((entry) => entry.event === "email_sent_auto")).toBe(true);
    expect(sentAudit.some((entry) => entry.event === "rule_ack")).toBe(true);
  });

  it("a complaint is raised to high priority and its reply is held for a person", async () => {
    sender.sent.length = 0;
    // Conversation continuity opens the case for a known contact; the
    // response rules then route the complaint to a human at high priority.
    const first = await processEmail(mail({
      id: "wr-known-1", threadId: "wr-known-thread", from: "known@example.test",
      organizationId: 1, caseTypeCode: "SERVICE_REQUEST",
      subject: "Service request", body: "Please process my request. Consent: yes.",
    }), ctx);
    expect(first.skipped).not.toBe(true);
    sender.sent.length = 0;

    const result = await processEmail(mail({
      id: "wr-known-2", threadId: "wr-known-thread", from: "known@example.test",
      organizationId: 1, caseTypeCode: "SERVICE_REQUEST",
      subject: "Complaint about the handling of my request",
      body: "I wish to file a complaint about how my request was handled.",
    }), ctx);
    expect(result.skipped).not.toBe(true);
    expect(result.applicantId).toBe(first.applicantId);
    const caseRow = repo.getCase(result.applicantId!)!;
    expect(caseRow.priority).toBe("high");
    expect(caseRow.outcome).toBe("undecided");
    expect(sender.sent.length).toBe(0);
    const audit = repo.auditForApplicant(caseRow.id);
    expect(audit.some((entry) => entry.event === "priority_raised")).toBe(true);
    expect(audit.some((entry) => entry.event === "human_review_triggered")).toBe(true);
  });

  it("an incomplete file gets a held information chase and arms the follow-up ladder", async () => {
    sender.sent.length = 0;
    const type = repo.getCaseType("SERVICE_REQUEST", 1)!;
    // This tenant's own chase rule: an incomplete file gets the information
    // chase, ahead of the always-true status draft every fixture tenant has.
    deprioritizeStatusDraft(type.id);
    repo.saveWorkflowRule({
      organizationId: 1, caseTypeId: type.id, kind: "response", name: "Chase the missing information", position: 0,
      conditions: [{ field: "docs_state", value: "missing" }],
      action: { reply_action: "draft", template_key: "missing_documents", followup: "ladder", audit_code: "fixture_chase" },
    });
    const att = async (filename: string, docType: string): Promise<Attachment> => ({
      filename, mimeType: "application/pdf", content: await makeTextPdf(docLines(docType, { name: "SAM OKONKWO" })),
    });
    const result = await processEmail(mail({
      id: "wr-missing-1", threadId: "wr-missing-thread", from: "short@example.test",
      organizationId: 1, caseTypeCode: "SERVICE_REQUEST",
      subject: "Service request", body: "Please find my request form attached. Consent: yes.",
      attachments: [await att("request.pdf", "request_form")],
    }), ctx);
    expect(result.skipped).not.toBe(true);
    expect(result.finalStatus).toBe("Red");
    expect(result.missing).toEqual(["id"]);
    expect(result.autoKind).toBe("missing_docs");
    // The evidence gate holds the chase: an incomplete file never gets
    // machine mail on its own.
    expect(sender.sent.length).toBe(0);
    expect(result.autoSent).toBe(false);
    expect(repo.queuedOutbox(result.applicantId!)).toBeTruthy();
    expect(repo.getCase(result.applicantId!)!.outcome).toBe("undecided");
    const audit = repo.auditForApplicant(result.applicantId!);
    expect(audit.some((entry) => entry.event === "case_type_gate")).toBe(true);
    expect(audit.some((entry) => entry.event === "fixture_chase")).toBe(true);
    expect(audit.some((entry) => entry.event === "followup_scheduled")).toBe(true);
  });
});
