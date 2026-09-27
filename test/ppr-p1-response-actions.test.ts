/**
 * PPR P1-3 acceptance: every response path carries an EXPLICIT action
 * (send / draft / approve / do-nothing) defined per rule, wired end-to-end:
 *  - "approve" queues a draft that only the "Approve automation" permission
 *    may release (403 without it) — while ordinary drafts stay releasable by
 *    staff (user send paths remain allowed);
 *  - the follow-up ladder's rung response is rule data (send/draft/approve/
 *    none) replacing the old hardcoded "always hold": "none" cancels the
 *    ladder, "draft"/"approve" queue the rung accordingly, and "send" is
 *    subject to the profile's qualification gate — gate-on profiles keep
 *    holding, un-gated profiles actually send.
 * All rule definitions go through the real admin routes; cases are produced
 * by the real pipeline; rungs fire through the real sweep.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { createApp } from "../src/web/server";
import { hashPassword } from "../src/util/password";
import { webLogin } from "./helpers";
import { processEmail } from "../src/pipeline";
import { runFollowUpSweep } from "../src/followups";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";
import type { IncomingEmail } from "../src/types";

function fresh(): Repo {
  const repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  return repo;
}

const mail = (over: Partial<IncomingEmail>): IncomingEmail => ({
  id: over.id ?? "ra-1",
  threadId: over.threadId ?? "ra-thread",
  from: over.from ?? "someone@example.test",
  subject: over.subject ?? "hello",
  body: over.body ?? "hello there",
  receivedAt: new Date().toISOString(),
  attachments: [],
  ...over,
});

const pastIso = () => new Date(Date.now() - 40 * 24 * 3600_000).toISOString();

describe("PPR P1-3: explicit response actions — approve gate + follow-up rung actions", () => {
  let repo: Repo;
  let ctx: PipelineContext;
  let sender: MockSender;
  let server: Server | undefined;
  let base = "";
  let auth: { cookie: string; csrf: string };
  let clerkAuth: { cookie: string; csrf: string };
  let approverAuth: { cookie: string; csrf: string };
  let resId = 0;

  const postAs = (a: { cookie: string; csrf: string }, path: string, body: Record<string, string>) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { cookie: a.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: a.csrf, ...body }),
      redirect: "manual",
    });
  const post = (path: string, body: Record<string, string>) => postAs(auth, path, body);

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

    // Staff: clerk holds explicit rows WITHOUT approve_automation; approver holds it.
    repo.createStaff("clerk", "Chris Clerk", hashPassword("clerk1"), "user");
    repo.setPermissions(repo.getStaffByUsername("clerk")!.id, ["send_automated"]);
    repo.createStaff("approver", "Ada Approver", hashPassword("approver1"), "user");
    repo.setPermissions(repo.getStaffByUsername("approver")!.id, ["approve_automation"]);
    const clerkLogin = await webLogin(base, "clerk", "clerk1");
    clerkAuth = { cookie: clerkLogin.cookie, csrf: clerkLogin.csrf };
    const approverLogin = await webLogin(base, "approver", "approver1");
    approverAuth = { cookie: approverLogin.cookie, csrf: approverLogin.csrf };

    // Non-academic profile via the real admin route (invariant f: draft default).
    expect((await post("/config/case-types/create", {
      organization_id: "1", code: "RES", name: "Resident services", category: "general",
    })).status).toBe(302);
    resId = repo.getCaseType("RES", 1)!.id;
    expect(repo.getCaseType("RES", 1)!.default_reply_action).toBe("draft");
    expect(repo.getCaseType("RES", 1)!.qualification_gate).toBe(0);
    // The profile owns its document slots (P1-4 territory): give it real
    // required documents so follow-up ladders have something to chase.
    for (const [i, doc] of [["proof_of_address", "Proof of address"], ["id_photo", "Identity photo"]].entries()) {
      expect((await post("/config/case-types/document", {
        organization_id: "1", case_type_id: String(resId), key: doc[0], label: doc[1],
        required: "1", blocking: "1", position: String(i),
      })).status).toBe(302);
    }
    expect(repo.listDocumentDefinitions(resId).length).toBe(2);
  });

  afterAll(() => server?.close());

  it("queues \"approve\" replies behind the Approve automation permission (403 without it)", async () => {
    expect((await post("/config/workflow-rules/save", {
      name: "Status requests need approval",
      kind: "intake",
      case_type_id: String(resId),
      position: "0",
      cond_field_0: "text",
      cond_value_0: "applyapprove",
      decision: "create",
      reply_action: "approve",
      template_key: "status_answer",
      audit_code: "rule_appr",
      fallback: "human_draft",
    })).status).toBe(302);

    sender.sent.length = 0;
    const result = await processEmail(mail({
      id: "ra-appr-1", from: "appr@example.test", subject: "applyapprove please", body: "applyapprove — any update?",
      organizationId: 1, caseTypeCode: "RES",
    }), ctx);
    expect(result.skipped).not.toBe(true);
    const id = result.applicantId!;
    const draft = repo.queuedOutbox(id)!;
    expect(draft).toBeTruthy();
    expect(draft.needs_approval).toBe(1); // held for APPROVAL, not ordinary review
    expect(sender.sent.length).toBe(0);

    // Without the permission: refused at the real route.
    const denied = await postAs(clerkAuth, `/case/${id}/draft`, { decision: "send" });
    expect(denied.status).toBe(403);
    expect(await denied.text()).toMatch(/Approve automation/);
    expect(sender.sent.length).toBe(0);

    // With the permission: the draft goes out.
    const allowed = await postAs(approverAuth, `/case/${id}/draft`, { decision: "send" });
    expect(allowed.status).toBe(302);
    expect(sender.sent.length).toBe(1);
    expect(repo.queuedOutbox(id)).toBeFalsy();
  });

  it("ordinary drafts stay releasable without the approval permission (user send paths)", async () => {
    expect((await post("/config/workflow-rules/save", {
      name: "Ordinary staff drafts",
      kind: "intake",
      case_type_id: String(resId),
      position: "1",
      cond_field_0: "text",
      cond_value_0: "applydraft",
      decision: "create",
      reply_action: "draft",
      template_key: "docs_request",
      audit_code: "rule_draft",
      fallback: "human_draft",
    })).status).toBe(302);

    sender.sent.length = 0;
    const result = await processEmail(mail({
      id: "ra-draft-1", from: "drafty@example.test", subject: "applydraft please", body: "applydraft — sending my details.",
      organizationId: 1, caseTypeCode: "RES",
    }), ctx);
    const id = result.applicantId!;
    const draft = repo.queuedOutbox(id)!;
    expect(draft.needs_approval).toBe(0); // officer work — NOT approval-gated

    const released = await postAs(clerkAuth, `/case/${id}/draft`, { decision: "send" });
    expect(released.status).toBe(302); // no 403: staff send path stays allowed
    expect(sender.sent.length).toBe(1);
  });

  it("follow-up rung actions are rule data: none cancels, draft/approve queue per mode", async () => {
    const rule = (word: string, followupAction: string, position: string, name: string) =>
      post("/config/workflow-rules/save", {
        name,
        kind: "intake",
        case_type_id: String(resId),
        position,
        cond_field_0: "text",
        cond_value_0: word,
        decision: "create",
        reply_action: "draft",
        template_key: "docs_request",
        followup: "ladder",
        followup_action: followupAction,
        fallback: "human_draft",
      });
    expect((await rule("neednone", "none", "2", "Ladder cancelled")).status).toBe(302);
    expect((await rule("needdraft", "draft", "3", "Ladder drafts")).status).toBe(302);
    expect((await rule("needappr", "approve", "4", "Ladder needs approval")).status).toBe(302);

    // "none": the ladder is never armed.
    sender.sent.length = 0;
    const noneCase = await processEmail(mail({
      id: "ra-none-1", from: "none@example.test", subject: "neednone", body: "neednone", organizationId: 1, caseTypeCode: "RES",
    }), ctx);
    expect(repo.getApplicant(noneCase.applicantId!)!.followup_next_at).toBeNull();
    await runFollowUpSweep(repo, ctx);
    expect(sender.sent.length).toBe(0);

    // "draft": rung 1 queues an ordinary draft (officer work).
    const draftCase = await processEmail(mail({
      id: "ra-d-1", from: "needdraft@example.test", subject: "needdraft", body: "needdraft", organizationId: 1, caseTypeCode: "RES",
    }), ctx);
    const did = draftCase.applicantId!;
    expect(repo.getApplicant(did)!.followup_next_at).toBeTruthy();
    expect((repo.getApplicant(did) as { followup_action?: string }).followup_action).toBe("draft");
    repo.setFollowup(did, 0, pastIso(), pastIso()); // make rung 1 due now
    sender.sent.length = 0;
    await runFollowUpSweep(repo, ctx);
    const rungDraft = repo.queuedOutbox(did)!;
    expect(rungDraft).toBeTruthy();
    expect(rungDraft.needs_approval).toBe(0);
    expect(repo.auditForApplicant(did).some((a) => a.event === "followup_drafted")).toBe(true);
    expect(sender.sent.length).toBe(0);

    // "approve": rung 1 queues behind the approval permission.
    const apprCase = await processEmail(mail({
      id: "ra-a-1", from: "needappr@example.test", subject: "needappr", body: "needappr", organizationId: 1, caseTypeCode: "RES",
    }), ctx);
    const aid = apprCase.applicantId!;
    expect((repo.getApplicant(aid) as { followup_action?: string }).followup_action).toBe("approve");
    repo.setFollowup(aid, 0, pastIso(), pastIso());
    await runFollowUpSweep(repo, ctx);
    const apprRung = repo.queuedOutbox(aid)!;
    expect(apprRung).toBeTruthy();
    expect(apprRung.needs_approval).toBe(1);
    expect(repo.auditForApplicant(aid).some((a) => a.event === "followup_awaiting_approval")).toBe(true);
  });

  it("\"send\" rungs obey the qualification gate: education keeps holding, un-gated sends", async () => {
    // Gate-ON (education scope, legacy rules): explicit "send" still holds.
    // A response rule at position -1 wins the reply decision over the seeded
    // catch-all; the seeded intake signals open the case ("apply").
    expect((await post("/config/workflow-rules/save", {
      name: "Gate-on ladder sends",
      kind: "response",
      case_type_id: "",
      position: "-1",
      cond_field_0: "text",
      cond_value_0: "needsendgate",
      reply_action: "draft",
      template_key: "docs_request",
      followup: "ladder",
      followup_action: "send",
      fallback: "human_draft",
    })).status).toBe(302);
    sender.sent.length = 0;
    const edu = await processEmail(mail({
      id: "ra-gate-1", from: "gate@example.test", subject: "apply needsendgate", body: "apply — needsendgate", organizationId: 1, caseTypeCode: "education",
    }), ctx);
    const gid = edu.applicantId!;
    expect((repo.getApplicant(gid) as { followup_action?: string }).followup_action).toBe("send");
    repo.setFollowup(gid, 0, pastIso(), pastIso());
    await runFollowUpSweep(repo, ctx);
    expect(sender.sent.length).toBe(0); // gate-on profile keeps holding
    expect(repo.queuedOutbox(gid)).toBeTruthy();
    expect(repo.auditForApplicant(gid).some((a) => a.event === "followup_held_qualification")).toBe(true);

    // Gate-OFF (Resident services): explicit "send" actually sends.
    expect((await post("/config/workflow-rules/save", {
      name: "Gate-off ladder sends",
      kind: "intake",
      case_type_id: String(resId),
      position: "5",
      cond_field_0: "text",
      cond_value_0: "needsendfree",
      decision: "create",
      reply_action: "draft",
      template_key: "docs_request",
      followup: "ladder",
      followup_action: "send",
      fallback: "human_draft",
    })).status).toBe(302);
    const free = await processEmail(mail({
      id: "ra-free-1", from: "free@example.test", subject: "needsendfree", body: "needsendfree", organizationId: 1, caseTypeCode: "RES",
    }), ctx);
    const fid = free.applicantId!;
    repo.setFollowup(fid, 0, pastIso(), pastIso());
    sender.sent.length = 0;
    await runFollowUpSweep(repo, ctx);
    expect(sender.sent.length).toBe(1); // explicit action, un-gated profile
    expect(repo.auditForApplicant(fid).some((a) => a.event === "followup_sent")).toBe(true);
    expect(repo.auditForApplicant(fid).some((a) => a.event === "followup_held_qualification")).toBe(false);
  });
});
