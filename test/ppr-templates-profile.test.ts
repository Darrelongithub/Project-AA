/**
 * PPR P0-6 acceptance: templates belong to case types — not a closed 8-key
 * enum — Reset restores the case type's OWN default, and the D4
 * generic_enquiry is a real fallback (or honest about being one).
 *  - an admin creates a brand-new template key through the real routes,
 *    binds it to a case type, and a rule-driven send carries exactly that
 *    wording end-to-end;
 *  - Reset restores the wording the template had at CREATION (its own saved
 *    default), not a shared global text;
 *  - a rule-driven case type with a reply gap gets the organization's
 *    generic_enquiry as a QUEUED staff suggestion — never sent automatically
 *    — and the UI no longer claims anything else;
 *  - a case-type-bound template never leaks into another case type's cases.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { createApp } from "../src/web/server";
import { hashPassword } from "../src/util/password";
import { webLogin, configureTestOrganization, releaseAutomation } from "./helpers";
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
  id: over.id ?? "tp-1",
  threadId: over.threadId ?? "tp-thread",
  from: over.from ?? "someone@example.test",
  subject: over.subject ?? "hello",
  body: over.body ?? "hello there",
  receivedAt: new Date().toISOString(),
  attachments: [],
  ...over,
});

describe("PPR P0-6: templates per case type, case-type-owned defaults, real fallback", () => {
  let repo: Repo;
  let ctx: PipelineContext;
  let sender: MockSender;
  let server: Server | undefined;
  let base = "";
  let auth: { cookie: string; csrf: string };

  const post = (path: string, body: Record<string, string>) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { cookie: auth.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: auth.csrf, ...body }),
      redirect: "manual",
    });

  beforeAll(async () => {
    repo = fresh();
    // One explicitly configured tenant, created BEFORE the administrator
    // account so the account resolves to it (and its templates exist).
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

  it("creates a NEW template key for a case type through the routes and fires it end-to-end", async () => {
    expect((await post("/config/case-types/create", {
      organization_id: "1", code: "VOL", name: "Volunteer intake", category: "general",
    })).status).toBe(302);
    const vol = repo.getCaseType("VOL", 1)!;
    // The vocabulary is OPEN: a key that never existed in the shipped set.
    expect((await post("/templates/create", {
      key: "volunteer_welcome", name: "Volunteer welcome", case_type_id: String(vol.id),
    })).status).toBe(302);
    expect(repo.getTemplate("volunteer_welcome", 1, vol.id)?.name).toBe("Volunteer welcome");
    // Edit it to distinctive wording (this edit is NOT its default):
    expect((await post("/templates/save", {
      key: "volunteer_welcome", name: "Volunteer welcome",
      subject: "Welcome aboard, volunteer",
      body: "Hello {name},\n\nThank you for volunteering at the harbour. We will be in touch.\n\nRegards,\n{institution}",
      case_type_id: String(vol.id),
    })).status).toBe(302);
    // First-email + response rules drive the profile to that template:
    expect((await post("/config/workflow-rules/save", {
      name: "Volunteer applications open a case", kind: "intake", case_type_id: String(vol.id), position: "0",
      cond_field_0: "text", cond_value_0: "volunteer", decision: "create", audit_code: "rule_vol_intake", fallback: "human_draft",
    })).status).toBe(302);
    expect((await post("/config/workflow-rules/save", {
      name: "Volunteers get the welcome", kind: "response", case_type_id: String(vol.id), position: "0",
      cond_field_0: "always", cond_value_0: "true",
      reply_action: "send", template_key: "volunteer_welcome", audit_code: "rule_vol_welcome", fallback: "human_draft",
    })).status).toBe(302);
    // Automation is opt-in twice over: the global mode holds every automated
    // reply, and each case type carries its own draft-first default.
    releaseAutomation(repo);
    expect((await post("/config/case-types/profile", {
      id: String(vol.id), default_reply_action: "auto", evidence_gate: "0",
    })).status).toBe(302);

    sender.sent.length = 0;
    const result = await processEmail(mail({
      id: "tp-vol-1", from: "helper@example.test",
      subject: "Volunteer application", body: "I would like to volunteer.",
      organizationId: 1, caseTypeCode: "VOL",
    }), ctx);
    expect(result.skipped).not.toBe(true);
    expect(sender.sent.length).toBe(1);
    expect(sender.sent[0].subject).toContain("Welcome aboard, volunteer");
    expect(sender.sent[0].body).toContain("volunteering at the harbour");
  });

  it("Reset restores the template's OWN default (captured at creation), not shared wording", async () => {
    const before = repo.getTemplate("volunteer_welcome", 1)!;
    // The default snapshot is the CREATION wording ("Subject for Volunteer welcome"):
    expect(repo.templateDefaultSnapshot("volunteer_welcome", 1)?.subject).toBe("Subject for Volunteer welcome");
    // …while the current wording is the distinctive edit:
    expect(before.subject).toBe("Welcome aboard, volunteer");
    expect((await post("/templates/reset", { key: "volunteer_welcome" })).status).toBe(302);
    const after = repo.getTemplate("volunteer_welcome", 1)!;
    expect(after.subject).toBe("Subject for Volunteer welcome"); // its own default
    expect(after.body).not.toContain("volunteering at the harbour"); // edit gone
    // …and a starter template's reset still restores its own shipped wording:
    expect((await post("/templates/reset", { key: "docs_request" })).status).toBe(302);
    const docs = repo.getTemplate("docs_request", 1)!;
    expect(docs.body.length).toBeGreaterThan(0);
    expect(repo.templateDefaultSnapshot("docs_request", 1)?.subject).toBe(docs.subject);
  });

  it("D4: generic_enquiry is a REAL fallback — queued for staff, never sent automatically", async () => {
    // The UI text must not claim automation it does not have:
    const tplPage = await (await fetch(`${base}/templates?template=generic_enquiry`, { headers: { cookie: auth.cookie } })).text();
    expect(tplPage).not.toMatch(/Automated fallback acknowledgement/);
    expect(tplPage).toMatch(/never sent automatically/);
    // A rule-driven case type with a reply GAP (rules that match nothing):
    expect((await post("/config/case-types/create", {
      organization_id: "1", code: "GAP", name: "Gap intake", category: "general",
    })).status).toBe(302);
    const gap = repo.getCaseType("GAP", 1)!;
    expect((await post("/config/workflow-rules/save", {
      name: "Questions open a case", kind: "intake", case_type_id: String(gap.id), position: "0",
      cond_field_0: "text", cond_value_0: "advise, question",
      decision: "create", audit_code: "rule_gap_intake", fallback: "human_draft",
    })).status).toBe(302);
    expect((await post("/config/workflow-rules/save", {
      name: "Only sunny days", kind: "response", case_type_id: String(gap.id), position: "0",
      cond_field_0: "subject", cond_value_0: "sunny",
      reply_action: "send", template_key: "status_answer", audit_code: "rule_sunny", fallback: "human_draft",
    })).status).toBe(302);
    sender.sent.length = 0;
    const result = await processEmail(mail({
      id: "tp-gap-1", from: "gap@example.test",
      subject: "Wet weather question", body: "It rains a lot here. Please advise.",
      organizationId: 1, caseTypeCode: "GAP",
    }), ctx);
    expect(result.skipped).not.toBe(true);
    // Gap → human review (never silent), with the org's generic_enquiry
    // rendered as the staff SUGGESTION:
    expect(sender.sent.length).toBe(0);
    const held = repo.queuedOutbox(result.applicantId!);
    expect(held).toBeTruthy();
    expect(held!.subject).toContain("Thank you for contacting us");
    expect(held!.body).toContain("We have received your message about case");
  });

  it("a case-type-bound template never leaks into another case type's cases", async () => {
    const vol = repo.getCaseType("VOL", 1)!;
    const gap = repo.getCaseType("GAP", 1)!;
    // volunteer_welcome is bound to VOL — GAP cases must not resolve it.
    expect(repo.getTemplate("volunteer_welcome", 1, vol.id)).toBeTruthy();
    expect(repo.getTemplate("volunteer_welcome", 1, gap.id)).toBeUndefined();
    // The admin context (no case) still sees it for editing:
    expect(repo.getTemplate("volunteer_welcome", 1)).toBeTruthy();
  });
});
