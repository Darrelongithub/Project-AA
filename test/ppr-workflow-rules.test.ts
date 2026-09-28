/**
 * PPR P0-4 acceptance: first-email rules as DATA.
 *  - an admin defines intake + response rules through the real admin routes
 *    (the Workflow rules tab) for a NEW non-academic profile, and a matching
 *    email fires them end-to-end through the real pipeline;
 *  - the migrated education profile's seeded rules reproduce the behaviour
 *    staff already know (first contact → receipt; complaint → high-priority
 *    human review with the reply held; missing documents → held chase);
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
import { DEFAULT_REQUIREMENTS } from "../src/config";
import { createApp } from "../src/web/server";
import { hashPassword } from "../src/util/password";
import { webLogin } from "./helpers";
import { processEmail } from "../src/pipeline";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";
import { makeTextPdf, docLines } from "../src/simulation/pdfFactory";
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

  const post = (path: string, body: Record<string, string>) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { cookie: auth.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: auth.csrf, ...body }),
      redirect: "manual",
    });

  beforeAll(async () => {
    repo = fresh();
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
    auth = { cookie: login.cookie, csrf: login.csrf };
  });

  afterAll(() => server?.close());

  it("defines a first-email rule through the UI routes and fires it end-to-end for a new non-academic profile", async () => {
    // ── real admin routes: non-academic profile on the migrated org ───
    // (its templates live here; per-organization template ownership is the
    // P0-6 round — rules themselves are organization-scoped either way)
    expect((await post("/config/case-types/create", {
      organization_id: "1", code: "VOL", name: "Volunteer intake", category: "general",
    })).status).toBe(302);
    const vol = repo.getCaseType("VOL", 1)!;
    expect(vol.education_module).toBe(0);
    expect(vol.default_reply_action).toBe("draft"); // invariant (f): new profiles draft
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
    // First-email rules for a new profile default to DRAFT automation
    // (invariant f): the reply is prepared but HELD, never sent…
    expect(sender.sent.length).toBe(0);
    const held = repo.queuedOutbox(result.applicantId!);
    expect(held).toBeTruthy(); // prepared as a queued draft, not sent
    // …and the admin explicitly opts the profile into sending.
    expect((await post("/config/case-types/profile", {
      id: String(supportId), default_reply_action: "auto", qualification_gate: "0",
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
    // The Harbour profile's intake rules only match “volunteer/helper” —
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

  it("the seeded education rules reproduce the known chain: a clean complete file gets the receipt (sent)", async () => {
    sender.sent.length = 0;
    repo.seedBaseRequirements(DEFAULT_REQUIREMENTS);
    repo.upsertRule({ programme: null, intake: null, document_type: "kcpe_cert", required: true, meanGrade: "B-" });
    const name = "ALICE WANJIKU KAMAU";
    const att = async (filename: string, docType: string): Promise<Attachment> => ({
      filename,
      mimeType: "application/pdf",
      content: await makeTextPdf(docLines(docType, { name })),
    });
    const result = await processEmail(mail({
      id: "wr-edu-1",
      from: "alice@example.test",
      subject: "Application documents",
      body: "Please find attached.",
      attachments: [
        await att("a.pdf", "academic_cert"),
        await att("l.pdf", "leaving_certificate"),
        await att("p.pdf", "passport_photo"),
        await att("b.pdf", "birth_cert"),
        await att("i.pdf", "id"),
        await att("f.pdf", "application_form"),
      ],
    }), ctx);
    expect(result.skipped).not.toBe(true);
    expect(result.autoKind).toBe("ack");
    expect(result.autoSent).toBe(true);
    expect(sender.sent.length).toBe(1); // fully qualified → the admission letter goes out (M-3)
    expect(sender.sent[0].subject).toMatch(/Welcome to .* — Your Admission to /);
    const audit = repo.auditForApplicant(result.applicantId!);
    expect(audit.some((a) => a.event === "rule_first_contact")).toBe(true); // rule data fired
    expect(audit.some((a) => a.event === "rule_ack")).toBe(true);
    expect(audit.some((a) => a.event === "email_sent_auto")).toBe(true);
    // M-3: the migrated education profile auto-admits a fully qualified,
    // watcher-clean file — the decision is PROVISIONAL and a registrar can
    // reverse it at any time (test/m3-auto-admit.test.ts). The human path is
    // never removed; it is simply no longer the only path.
    const admitted = repo.getApplicant(result.applicantId!)!;
    expect(admitted.admission_decision).toBe("auto_admitted");
    expect(admitted.admission_route).toBe("auto");
    expect(audit.some((a) => a.event === "admission_auto_qualified")).toBe(true);
    expect(audit.some((a) => a.event === "auto_admission_triggered")).toBe(true);
  });

  it("the seeded education rules reproduce the known chain: complaint → high-priority human review, reply held", async () => {
    sender.sent.length = 0;
    // A complaint from a KNOWN contact (conversation continuity opens the
    // case; the response rules route it to a human at high priority).
    const first = await processEmail(mail({
      id: "wr-known-1",
      from: "known@example.test",
      subject: "Application for BCS admission",
      body: "I am applying for the BCS programme this September 2026 intake.",
    }), ctx);
    expect(first.skipped).not.toBe(true);
    sender.sent.length = 0;
    const result = await processEmail(mail({
      id: "wr-known-2",
      threadId: "wr-known-thread",
      from: "known@example.test",
      subject: "Complaint about the handling of my file",
      body: "I wish to file a complaint about my application handling.",
    }), ctx);
    expect(result.skipped).not.toBe(true);
    const caseRow = repo.getApplicant(result.applicantId!)!;
    expect(caseRow.priority).toBe("high");
    // Nothing went out — the complaint path holds everything for staff:
    expect(sender.sent.length).toBe(0);
    const audit = repo.auditForApplicant(caseRow.id);
    expect(audit.some((a) => a.event === "rule_complaint")).toBe(true);
    expect(audit.some((a) => a.event === "human_review_triggered")).toBe(true);
  });

  it("the seeded education rules reproduce the known chain: incomplete file gets a HELD document chase (qualification gate)", async () => {
    sender.sent.length = 0;
    // Same shape as the long-standing e2e scenario: five clean documents,
    // the National ID missing → Red, clean-missing → the chase is prepared…
    repo.seedBaseRequirements(DEFAULT_REQUIREMENTS);
    repo.upsertRule({ programme: null, intake: null, document_type: "kcpe_cert", required: true, meanGrade: "B-" });
    const name = "CAROL NJERI MAINA";
    const att = async (filename: string, docType: string): Promise<Attachment> => ({
      filename,
      mimeType: "application/pdf",
      content: await makeTextPdf(docLines(docType, { name })),
    });
    const result = await processEmail(mail({
      id: "wr-missing-1",
      from: "short@example.test",
      subject: "Application documents",
      body: "Please find attached.",
      attachments: [
        await att("a.pdf", "academic_cert"),
        await att("l.pdf", "leaving_certificate"),
        await att("p.pdf", "passport_photo"),
        await att("b.pdf", "birth_cert"),
        await att("f.pdf", "application_form"),
      ],
    }), ctx);
    expect(result.skipped).not.toBe(true);
    expect(result.autoKind).toBe("missing_docs");
    // …but held as a staff suggestion — the qualification gate never lets a
    // not-fully-qualified file get machine mail, exactly as it always did:
    expect(sender.sent.length).toBe(0);
    expect(result.autoSent).toBe(false);
    const outbox = repo.queuedOutbox(result.applicantId!);
    expect(outbox).toBeTruthy();
    expect(outbox).toBeTruthy();
    const audit = repo.auditForApplicant(result.applicantId!);
    expect(audit.some((a) => a.event === "automation_held_qualification")).toBe(true);
    expect(audit.some((a) => a.event === "rule_docs_chase")).toBe(true); // rule data fired
    // The follow-up ladder still arms on the held chase (3/7/10):
    expect(audit.some((a) => a.event === "followup_scheduled")).toBe(true);
  });
});
