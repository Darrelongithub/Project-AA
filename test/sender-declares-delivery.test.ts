/**
 * An adapter that cannot vouch for delivery never counts as delivered.
 *
 * `EmailSender.delivers` used to be optional and every send path asked
 * `delivers === false` — "only treat a sender as offline when it says so
 * explicitly". A sender that simply omitted the flag therefore received the
 * full success treatment: an `email_sent_auto` audit entry, an outbound emails
 * row, an `auto` outbox record and `auto_sent = 1` on the decision log, for mail
 * that never went anywhere. That is the same false positive the offline-sender
 * handling exists to prevent, reached by a different door. The property is now
 * required on the interface and every check reads `!== true`, so undeclared
 * means undelivered.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { processEmail } from "../src/pipeline";
import { MockSender, MockVisionAdapter, type EmailSender, type PipelineContext } from "../src/pipeline/adapters";
import { runFollowUpSweep } from "../src/followups";
import { makeHeuristicWatcher } from "../src/watcher";
import { makeTextPdf } from "../src/simulation/pdfFactory";
import { configureTestOrganization, docLines, releaseAutomation } from "./helpers";
import type { Attachment, IncomingEmail } from "../src/types";

let repo: Repo;
let ctx: PipelineContext;
let n = 0;

/** A sender that says nothing about delivery — the shape the hole allowed. */
function silentSender(): EmailSender & { attempts: number } {
  const sender = {
    attempts: 0,
    async send(): Promise<void> {
      sender.attempts += 1;
    },
  };
  // Cast at the boundary on purpose: the point is how the pipeline behaves when
  // an implementation shows up without the flag, which the interface forbids.
  return sender as unknown as EmailSender & { attempts: number };
}

function mail(over: Partial<IncomingEmail> = {}): IncomingEmail {
  n += 1;
  return {
    id: `silent-${n}`, threadId: `silent-thread-${n}`, from: `contact${n}@example.org`, fromName: `Contact ${n}`,
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

/** Every switch needed for an automatic reply is released; only the sender's
 *  honesty stands between the reply and a recorded send. */
function boot(sender: EmailSender): void {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  configureTestOrganization(repo);
  ctx = { repo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender } };
  const type = repo.getCaseType("SERVICE_REQUEST", 1)!;
  repo.updateCaseTypeProfile(type.id, { default_reply_action: "auto", evidence_gate: 0 });
  const rule = repo.listWorkflowRules(1, { caseTypeId: type.id, kind: "response" })
    .find((r) => r.name === "Prepare a factual status draft")!;
  repo.saveWorkflowRule({
    id: rule.id, organizationId: 1, caseTypeId: type.id, kind: "response",
    name: rule.name, position: rule.position, conditions: rule.conditions,
    action: { ...rule.action, reply_action: "send", template_key: "ack_received" },
  });
  releaseAutomation(repo);
}

beforeEach(() => { n = 0; });

describe("a sender that does not declare delivery", () => {
  it("writes no sent record for an automated reply", async () => {
    const silent = silentSender();
    boot(silent);
    const result = await processEmail(mail({ attachments: await completeRequest("SILENT AUTOMATION") }), ctx);
    const id = result.applicantId!;

    expect(result.finalStatus).toBe("Green");
    expect(result.autoSent).toBe(false);
    expect(silent.attempts).toBe(0); // it is not even offered the mail
    expect(repo.emailsForApplicant(id).filter((email) => email.direction === "out")).toHaveLength(0);
    expect(repo.latestOutbox(id)?.mode).toBe("queued");
    expect(repo.decisionLogs(id).at(-1)?.auto_sent).toBe(false);
    const events = repo.auditForApplicant(id).map((entry) => entry.event);
    expect(events).toContain("email_not_delivered");
    expect(events).not.toContain("email_sent_auto");
  });

  it("writes no sent record for a reminder rung either", async () => {
    const silent = silentSender();
    boot(silent);
    const result = await processEmail(mail({
      attachments: [{
        filename: "form.pdf", mimeType: "application/pdf",
        content: await makeTextPdf(docLines("request_form", { name: "SILENT REMINDER" })),
      }],
    }), ctx);
    const id = result.applicantId!;
    repo.updateApplicant(id, { triage: "Green" }); // reach the protected send branch
    const due = new Date(Date.now() - 86_400_000).toISOString();
    repo.setFollowup(id, 0, due, due, "send");

    await runFollowUpSweep(repo, ctx);

    expect(silent.attempts).toBe(0);
    expect(repo.latestOutbox(id)?.mode).toBe("queued");
    expect(repo.emailsForApplicant(id).filter((email) => email.direction === "out")).toHaveLength(0);
    const events = repo.auditForApplicant(id).map((entry) => entry.event);
    expect(events).toContain("email_not_delivered");
    expect(events).not.toContain("followup_sent");
  });

  it("still sends when the sender states that it delivers", async () => {
    const sender = new MockSender(true);
    boot(sender);
    const result = await processEmail(mail({ attachments: await completeRequest("HONEST SENDER") }), ctx);

    expect(result.autoSent).toBe(true);
    expect(sender.sent).toHaveLength(1);
    expect(repo.auditForApplicant(result.applicantId!).map((e) => e.event)).toContain("email_sent_auto");
  });
});
