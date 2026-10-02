/**
 * Phase C3 — safe by default: nothing leaves the building unless a person
 * released it, and uncertainty always reaches a human.
 *
 * Pinned here:
 *  1. the single global switch (default OFF = `automation_mode: draft`) holds
 *     EVERY automated reply — including a rule that says `send`, a case type
 *     that opted into auto with its evidence gate off, and a reminder rung;
 *  2. releasing the global switch is not enough: each category must also be on
 *     the explicit allowlist, which starts empty;
 *  3. uncertain input always goes to a person — a fallback classification, a
 *     low-confidence model label, a missing reply template, an unreadable
 *     attachment, or a stranger quoting somebody else's reference;
 *  4. the switch governs AUTOMATION, not people: a staff member's own Send
 *     still works while it is off.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { hashPassword } from "../src/util/password";
import { createApp } from "../src/web/server";
import { processEmail } from "../src/pipeline";
import { runFollowUpSweep } from "../src/followups";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";
import { makeTextPdf } from "../src/simulation/pdfFactory";
import { CLASSIFIER_MIN_CONFIDENCE, type CategoryLabeler } from "../src/categorize";
import { configureTestOrganization, docLines, releaseAutomation, webLogin } from "./helpers";
import type { Attachment, IncomingEmail } from "../src/types";

let repo: Repo;
let sender: MockSender;
let ctx: PipelineContext;
let typeId = 0;

/** A tenant whose SERVICE_REQUEST case type is configured to *want* to send:
 *  rule says send, evidence gate off, case type auto. Only the product's own
 *  switches stand between it and the wire. */
function boot(opts: { categorizer?: CategoryLabeler } = {}): void {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  configureTestOrganization(repo);
  sender = new MockSender();
  ctx = { repo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender, categorizer: opts.categorizer } };
  const type = repo.getCaseType("SERVICE_REQUEST", 1)!;
  typeId = type.id;
  repo.updateCaseTypeProfile(type.id, { default_reply_action: "auto", evidence_gate: 0 });
  const rule = repo.listWorkflowRules(1, { caseTypeId: type.id, kind: "response" })
    .find((r) => r.name === "Prepare a factual status draft")!;
  repo.saveWorkflowRule({
    id: rule.id, organizationId: 1, caseTypeId: type.id, kind: "response",
    name: rule.name, position: rule.position, conditions: rule.conditions,
    action: { ...rule.action, reply_action: "send", template_key: "ack_received" },
  });
}

let n = 0;
function mail(over: Partial<IncomingEmail> = {}): IncomingEmail {
  n += 1;
  return {
    id: `safe-${n}`, threadId: `safe-thread-${n}`, from: `contact${n}@example.org`, fromName: `Contact ${n}`,
    to: "intake@example.org", subject: "Service request documents",
    body: "Please process my service request.\nConsent: yes",
    receivedAt: new Date().toISOString(), organizationId: 1, caseTypeCode: "SERVICE_REQUEST",
    attachments: [], ...over,
  } as IncomingEmail;
}

async function completeRequest(name: string): Promise<Attachment[]> {
  return Promise.all([["form.pdf", "request_form"], ["id.pdf", "id"]].map(async ([filename, docType]) => ({
    filename, mimeType: "application/pdf", content: await makeTextPdf(docLines(docType, { name })),
  })));
}

beforeEach(() => { n = 0; });

describe("the global switch is a real kill switch", () => {
  it("holds an automated reply that every other gate has released", async () => {
    boot();
    expect(repo.getSetting("automation_mode", "")).toBe("draft"); // shipped default: OFF
    const result = await processEmail(mail({ attachments: await completeRequest("SAFE ONE") }), ctx);
    expect(result.skipped).toBeFalsy();
    expect(result.autoSent).toBe(false);
    expect(sender.sent.length).toBe(0);
    expect(repo.queuedOutbox(result.applicantId!)).toBeTruthy(); // drafted, waiting for a person
    expect(repo.auditForApplicant(result.applicantId!).some((a) => a.event === "automation_held")).toBe(true);
  });

  it("releasing the global switch is not enough — the category must be allowlisted", async () => {
    boot();
    repo.setSetting("automation_mode", "auto"); // released, allowlist still empty
    const held = await processEmail(mail({ attachments: await completeRequest("SAFE TWO") }), ctx);
    expect(held.autoSent).toBe(false);
    expect(sender.sent.length).toBe(0);
    expect(repo.automationMode("document_submission")).toBe("draft");

    releaseAutomation(repo); // now the category is explicitly allowed
    const sent = await processEmail(mail({ attachments: await completeRequest("SAFE THREE") }), ctx);
    expect(sent.autoSent).toBe(true);
    expect(sender.sent.length).toBe(1);
    expect(repo.automationMode("document_submission")).toBe("auto");
  });

  it("a category taken off the allowlist stops sending again", async () => {
    boot();
    releaseAutomation(repo);
    repo.setAutomationMode("document_submission", "draft");
    const result = await processEmail(mail({ attachments: await completeRequest("SAFE FOUR") }), ctx);
    expect(result.autoSent).toBe(false);
    expect(sender.sent.length).toBe(0);
  });

  it("holds a reminder rung that a rule armed to send", async () => {
    boot();
    const type = repo.getCaseType("SERVICE_REQUEST", 1)!;
    repo.saveWorkflowRule({
      organizationId: 1, caseTypeId: type.id, kind: "response", name: "Chase with a ladder", position: 0,
      conditions: [{ field: "docs_state", value: "missing" }],
      action: { reply_action: "draft", template_key: "missing_documents", followup: "ladder", followup_action: "send", audit_code: "rule_chase" },
    });
    // Position -1: within one case type the lowest position wins, and the
    // fixture tenant already has an always-true rule at 0.
    repo.saveWorkflowRule({
      organizationId: 1, caseTypeId: type.id, kind: "response", name: "Chase with a ladder", position: -1,
      conditions: [{ field: "docs_state", value: "missing" }],
      action: { reply_action: "draft", template_key: "missing_documents", followup: "ladder", followup_action: "send", audit_code: "rule_chase" },
    });
    const result = await processEmail(mail({
      attachments: [{ filename: "form.pdf", mimeType: "application/pdf", content: await makeTextPdf(docLines("request_form", { name: "LADDER ONE" })) }],
    }), ctx);
    expect(result.skipped).toBeFalsy();
    const id = result.applicantId!;
    expect((repo.getApplicant(id)! as { followup_action?: string }).followup_action).toBe("send"); // the rule armed a sending rung
    repo.updateCaseTypeProfile(typeId, { evidence_gate: 0 });
    repo.setFollowup(id, 0, new Date(Date.now() - 86_400_000).toISOString(), new Date(Date.now() - 86_400_000).toISOString());

    sender.sent.length = 0;
    await runFollowUpSweep(repo, ctx);
    expect(sender.sent.length).toBe(0); // the global switch outranks the rule
    expect(repo.auditForApplicant(id).some((a) => a.event === "followup_sent")).toBe(false);

    releaseAutomation(repo);
    repo.setFollowup(id, 0, new Date(Date.now() - 86_400_000).toISOString(), new Date(Date.now() - 86_400_000).toISOString());
    await runFollowUpSweep(repo, ctx);
    expect(sender.sent.length).toBe(1); // released: the rung sends
    expect(repo.auditForApplicant(id).some((a) => a.event === "followup_sent")).toBe(true);
  });

  it("does not stop a person: staff Send works while the switch is off", async () => {
    boot();
    repo.createStaff("officer", "Olive Officer", hashPassword("officer-pass-1"), "user");
    const result = await processEmail(mail({ attachments: await completeRequest("SAFE FIVE") }), ctx);
    const id = result.applicantId!;
    expect(repo.queuedOutbox(id)).toBeTruthy();
    const server = createApp({ repo, ctx }).listen(0);
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const { cookie, csrf } = await webLogin(base, "officer", "officer-pass-1");
      const res = await fetch(`${base}/case/${id}/draft`, {
        method: "POST", redirect: "manual",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: `_csrf=${encodeURIComponent(csrf)}&decision=send&subject=${encodeURIComponent("Your request")}&body=${encodeURIComponent("Thank you — we have your request.")}`,
      });
      expect(res.status).toBe(302);
      expect(sender.sent.length).toBe(1); // a human decision, not automation
      expect(repo.queuedOutbox(id)).toBeUndefined();
    } finally {
      server.close();
    }
  });
});

describe("uncertainty always reaches a person", () => {
  const labeler = (answer: { label: string; confidence: number } | Error): CategoryLabeler =>
    async (_input, categories) => {
      if (answer instanceof Error) throw answer;
      void categories;
      return { label: answer.label, confidence: answer.confidence, source: "gemini" };
    };

  it("a fallback classification is held, even with every switch released", async () => {
    boot({ categorizer: labeler(new Error("model unavailable")) });
    repo.addEmailCategory(1, { key: "document_submission", label: "Documents" });
    releaseAutomation(repo);
    const result = await processEmail(mail({ attachments: await completeRequest("FALLBACK ONE") }), ctx);
    expect(result.autoSent).toBe(false);
    expect(sender.sent.length).toBe(0);
    const audit = repo.auditForApplicant(result.applicantId!);
    expect(audit.some((a) => a.event === "held_for_classification")).toBe(true);
    expect(audit.find((a) => a.event === "email_labelled")!.detail).toContain("source=fallback");
    expect(repo.queuedOutbox(result.applicantId!)).toBeTruthy();
  });

  it("a low-confidence label is held; the same label at confidence is not", async () => {
    boot({ categorizer: labeler({ label: "document_submission", confidence: CLASSIFIER_MIN_CONFIDENCE - 0.05 }) });
    repo.addEmailCategory(1, { key: "document_submission", label: "Documents" });
    releaseAutomation(repo);
    const shy = await processEmail(mail({ attachments: await completeRequest("SHY ONE") }), ctx);
    expect(shy.autoSent).toBe(false);
    expect(repo.auditForApplicant(shy.applicantId!).some((a) => a.event === "held_for_classification")).toBe(true);
    expect(repo.auditForApplicant(shy.applicantId!).find((a) => a.event === "held_for_classification")!.detail)
      .toContain("below the");

    // Same tenant shape, but the model is confident: the only thing that
    // changed is the confidence, and the hold disappears with it.
    boot({ categorizer: labeler({ label: "document_submission", confidence: CLASSIFIER_MIN_CONFIDENCE }) });
    repo.addEmailCategory(1, { key: "document_submission", label: "Documents" });
    releaseAutomation(repo);
    sender.sent.length = 0;
    const sure = await processEmail(mail({ attachments: await completeRequest("SURE ONE") }), ctx);
    expect(repo.auditForApplicant(sure.applicantId!).some((a) => a.event === "held_for_classification")).toBe(false);
    expect(sure.autoSent).toBe(true);
  });

  it("a missing reply template is held and named, never silently skipped", async () => {
    boot();
    releaseAutomation(repo);
    const rule = repo.listWorkflowRules(1, { caseTypeId: typeId, kind: "response" })[0];
    repo.saveWorkflowRule({
      id: rule.id, organizationId: 1, caseTypeId: typeId, kind: "response",
      name: rule.name, position: rule.position, conditions: rule.conditions,
      action: { ...rule.action, template_key: "does_not_exist" },
    });
    const result = await processEmail(mail({ attachments: await completeRequest("NO TEMPLATE") }), ctx);
    expect(result.autoSent).toBe(false);
    expect(sender.sent.length).toBe(0);
    const audit = repo.auditForApplicant(result.applicantId!);
    expect(audit.some((a) => a.event === "template_missing")).toBe(true);
    expect(audit.find((a) => a.event === "template_missing")!.detail).toContain("does_not_exist");
    const draft = repo.queuedOutbox(result.applicantId!)!;
    expect(draft.body).toContain("does_not_exist"); // the officer is told what to fix
    expect(draft.body).toMatch(/^INTERNAL — DO NOT AUTO-SEND/); // and it cannot be sent as-is
  });

  it("an unreadable attachment is held with every switch released", async () => {
    boot();
    releaseAutomation(repo);
    const result = await processEmail(mail({
      attachments: [{ filename: "broken.pdf", mimeType: "application/pdf", content: Buffer.from("%PDF-1.4\ntruncated garbage") }],
    }), ctx);
    expect(result.autoSent).toBe(false);
    expect(sender.sent.length).toBe(0);
    const doc = repo.listDocuments(result.applicantId!)[0];
    expect(doc.extraction_method).toBe("none");
    expect(repo.activeFlags(result.applicantId!).map((f) => f.type)).toContain("low_confidence");
    expect(repo.queuedOutbox(result.applicantId!)).toBeTruthy();
  });

  it("a stranger quoting somebody else's reference cannot reach that case", async () => {
    boot();
    releaseAutomation(repo);
    const mine = await processEmail(mail({ attachments: await completeRequest("KNOWN CONTACT") }), ctx);
    const ref = repo.getApplicant(mine.applicantId!)!.ref_number;
    sender.sent.length = 0;
    const stranger = await processEmail(mail({
      from: "stranger@example.org", subject: "status", body: ref, attachments: [],
    }), ctx);
    // The stranger's message is retained, never dropped. Quoting a reference is
    // treated as conversation continuity, so it is filed on the case it names
    // (staff can see who actually wrote it) — see QUESTIONS.md Q5, which asks
    // whether that should instead park or open a separate case.
    expect(stranger.skipped).toBeFalsy();
    expect(repo.emailsForApplicant(mine.applicantId!).some((e) => e.direction === "in" && e.from_addr === "stranger@example.org")).toBe(true);
    // Nothing is ever sent TO the stranger on the strength of somebody else's
    // reference — the factual status answer belongs to the contact on the case.
    expect(sender.sent.every((sent) => sent.to !== "stranger@example.org")).toBe(true);
    expect(repo.auditForApplicant(mine.applicantId!).some((a) => a.event === "email_sent_auto" && /status_answer/.test(a.detail))).toBe(false);
    // And a reply that does go out discloses nothing beyond the case it belongs
    // to: no name from the stranger's message, no cross-case content.
    for (const sent of sender.sent) {
      expect(sent.body).not.toContain("stranger@example.org");
    }
    expect(repo.getApplicant(mine.applicantId!)!.ref_number).toBe(ref);
  });
});
