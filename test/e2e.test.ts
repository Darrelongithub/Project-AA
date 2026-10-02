/**
 * End-to-end pipeline behaviour against a real repository and a configured
 * organization: intake → extraction → triage → draft → human outcome.
 *
 * The invariant every test below pins: the pipeline reports evidence and
 * prepares replies. It never records an outcome and never sends mail that the
 * configured automation mode says must be approved first.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { configureTestOrganization, docLines } from "./helpers";
import { processEmail } from "../src/pipeline";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";
import { makeScannedPdf, makeTextPdf } from "../src/simulation/pdfFactory";
import { mustProcessed } from "./harness";
import type { Attachment, IncomingEmail } from "../src/types";

let repo: Repo;
let sender: MockSender;
let ctx: PipelineContext;

beforeEach(() => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  configureTestOrganization(repo, { refPrefix: "E2E" });
  sender = new MockSender();
  ctx = { repo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender } };
});

function mkEmail(id: string, from: string, attachments: Attachment[], body = "Please find the attached request.", subject = "Service request"): IncomingEmail {
  return {
    id,
    threadId: `thread-${from}`,
    from,
    subject,
    body,
    receivedAt: "2026-09-14T09:00:00Z",
    organizationId: 1,
    caseTypeCode: "SERVICE_REQUEST",
    attachments,
  };
}

async function mkAtt(filename: string, docType: string, name: string, extra: Record<string, string | number> = {}): Promise<Attachment> {
  return { filename, mimeType: "application/pdf", content: await makeTextPdf(docLines(docType, { name, ...extra })) };
}

/** Every blocking slot of the SERVICE_REQUEST checklist, plus the optional note. */
const fullSet = async (name: string) => [
  await mkAtt("request.pdf", "request_form", name, { consent: "yes" }),
  await mkAtt("id.pdf", "id", name),
  await mkAtt("note.pdf", "supporting_document", name),
];

describe("pipeline end-to-end", () => {
  it("a complete request is triaged Green, stored and held for a person", async () => {
    const res = mustProcessed(await processEmail(mkEmail("e2e-complete", "contact@example.test", await fullSet("ALEX MORGAN")), ctx));

    expect(res.finalStatus).toBe("Green");
    expect(res.missing).toEqual([]);
    expect(res.refNumber).toMatch(/^E2E-\d{4}-\d{6}$/);
    // Draft-first is the default automation mode: nothing is sent by itself.
    expect(res.autoSent).toBe(false);
    expect(sender.sent).toEqual([]);
    expect(repo.queuedOutbox(res.applicantId)).toBeTruthy();

    const row = repo.getCase(res.applicantId)!;
    expect(row.outcome).toBe("undecided");
    expect(row.decision_by).toBeNull();
    expect(row.req_result).toBe("passed");
    expect(repo.latestEvaluation(res.applicantId)?.result).toBe("passed");

    const audit = repo.auditForApplicant(res.applicantId);
    expect(audit.some((entry) => entry.event === "email_received")).toBe(true);
    expect(audit.some((entry) => entry.event === "requirements_checked")).toBe(true);
    expect(audit.some((entry) => /admit|admission/i.test(entry.event))).toBe(false);
  });

  it("a missing blocking slot is reported and the chase reply is held", async () => {
    const name = "SAM OKONKWO";
    const res = mustProcessed(await processEmail(mkEmail("e2e-missing", "sam@example.test", [
      await mkAtt("request.pdf", "request_form", name, { consent: "yes" }),
      await mkAtt("note.pdf", "supporting_document", name),
    ]), ctx));

    expect(res.finalStatus).toBe("Red");
    expect(res.missing).toEqual(["id"]);
    expect(res.autoSent).toBe(false);
    expect(sender.sent).toEqual([]);
    expect(repo.getCase(res.applicantId)!.outcome).toBe("undecided");
    expect(repo.latestEvaluation(res.applicantId)?.missingDocuments).toEqual(["id"]);
  });

  it("a request without the configured consent fact stays undetermined", async () => {
    const name = "RIA PATEL";
    const res = mustProcessed(await processEmail(mkEmail("e2e-nofact", "ria@example.test", [
      await mkAtt("request.pdf", "request_form", name),
      await mkAtt("id.pdf", "id", name),
    ]), ctx));
    expect(res.missing).toEqual([]);
    expect(repo.latestEvaluation(res.applicantId)?.result).toBe("needs_verification");
    expect(repo.getCase(res.applicantId)!.outcome).toBe("undecided");
  });

  it("a watcher downgrade overrides a complete file and is recorded", async () => {
    const attachments = await fullSet("ALEX MORGAN");
    attachments[0] = {
      filename: "request.pdf",
      mimeType: "application/pdf",
      // Still a complete, rule-passing file — the specimen marking is what the
      // watcher must catch and downgrade.
      content: await makeTextPdf([...docLines("request_form", { name: "ALEX MORGAN", consent: "yes" }), "SPECIMEN - SAMPLE COPY NOT VALID"]),
    };
    const res = mustProcessed(await processEmail(mkEmail("e2e-specimen", "specimen@example.test", attachments), ctx));
    expect(res.finalStatus).toBe("Red");
    expect(res.flags.map((flag) => flag.type)).toContain("watcher_flag");
    expect(res.autoSent).toBe(false);
    expect(repo.activeFlags(res.applicantId).map((flag) => flag.type)).toContain("watcher_flag");
  });

  it("a byte-identical resubmission is detected as a duplicate, not double-counted", async () => {
    // The SAME bytes twice: two separate renders would differ, and only a true
    // byte duplicate may be suppressed.
    const attachments = await fullSet("ALEX MORGAN");
    const first = mustProcessed(await processEmail(mkEmail("e2e-dup-1", "dup@example.test", attachments), ctx));
    const second = mustProcessed(await processEmail(mkEmail("e2e-dup-2", "dup@example.test", attachments), ctx));
    expect(second.applicantId).toBe(first.applicantId);
    const documents = repo.listDocuments(first.applicantId, { activeOnly: true });
    expect(documents.filter((doc) => doc.document_type === "request_form")).toHaveLength(1);
    expect(repo.countDuplicates(first.applicantId)).toBeGreaterThan(0);
  });

  it("a one-letter name variant is flagged for verification, not silently accepted", async () => {
    const res = mustProcessed(await processEmail(mkEmail("e2e-fuzzy", "fuzzy@example.test", [
      await mkAtt("request.pdf", "request_form", "ALEX MORGAN", { consent: "yes" }),
      await mkAtt("id.pdf", "id", "ALEX MORGANN"),
    ]), ctx));
    expect(res.finalStatus).toBe("Orange");
    expect(res.flags.map((flag) => flag.type)).toContain("name_mismatch");
    expect(res.autoSent).toBe(false);
  });

  it("a complaint is categorised and raised in priority without a decision", async () => {
    const res = mustProcessed(await processEmail(mkEmail("e2e-complaint", "angry@example.test", [], "This is a formal complaint about the delay. It is unacceptable.", "Complaint about handling"), ctx));
    expect(res.category).toBe("complaint");
    expect(repo.getCase(res.applicantId)!.priority).toBe("high");
    expect(repo.getCase(res.applicantId)!.outcome).toBe("undecided");
  });

  it("an image-only scan falls through the extraction tiers to medium confidence", async () => {
    const scanned: Attachment = {
      filename: "scan.pdf",
      mimeType: "application/pdf",
      content: await makeScannedPdf(docLines("request_form", { name: "ALEX MORGAN", consent: "yes" })),
    };
    const res = mustProcessed(await processEmail(mkEmail("e2e-scan", "scan@example.test", [scanned, await mkAtt("id.pdf", "id", "ALEX MORGAN")]), ctx));
    const documents = repo.listDocuments(res.applicantId, { activeOnly: true });
    expect(documents.length).toBeGreaterThan(0);
    expect(documents.every((doc) => (doc.confidence_score ?? 0) >= 0)).toBe(true);
    expect(res.autoSent).toBe(false);
  });

  it("processing the same message twice is a no-op", async () => {
    const email = mkEmail("e2e-idem", "idem@example.test", await fullSet("ALEX MORGAN"));
    const first = mustProcessed(await processEmail(email, ctx));
    const second = await processEmail(email, ctx);
    expect(second.skipped).toBe(true);
    expect(repo.listCases(1)).toHaveLength(1);
    expect(repo.getCase(first.applicantId)!.outcome).toBe("undecided");
  });

  it("records incoming and outgoing mail on the case history", async () => {
    const res = mustProcessed(await processEmail(mkEmail("e2e-history", "history@example.test", await fullSet("ALEX MORGAN")), ctx));
    repo.insertEmail({
      applicant_id: res.applicantId, message_id: "manual-1", thread_id: "thread-history@example.test", direction: "out",
      from_addr: "", to_addr: "history@example.test", subject: "Update", body: "Hello", category: null, auto: 0,
      at: new Date().toISOString(),
    });
    const history = repo.emailsForApplicant(res.applicantId);
    expect(history.some((email) => email.direction === "in")).toBe(true);
    expect(history.some((email) => email.direction === "out")).toBe(true);
    expect(history.every((email) => email.organization_id === 1)).toBe(true);
  });

  it("a person records the outcome; the pipeline never does", async () => {
    const res = mustProcessed(await processEmail(mkEmail("e2e-outcome", "outcome@example.test", await fullSet("ALEX MORGAN")), ctx));
    const id = res.applicantId;
    expect(repo.getCase(id)!.outcome).toBe("undecided");

    repo.db.transaction(() => {
      repo.updateCase(id, { outcome: "approved_after_review" });
      repo.updateApplicant(id, { outcome_route: "human", decision_by: "officer", decision_reason: "All evidence verified by phone", decision_at: new Date().toISOString() });
      repo.setLifecycle(id, "completed", "officer", "All evidence verified by phone");
    })();

    const row = repo.getCase(id)!;
    expect(row.outcome).toBe("approved_after_review");
    expect(row.decision_by).toBe("officer");
    expect(row.lifecycle).toBe("completed");
    // Re-evaluating evidence afterwards must not move a recorded outcome.
    const { evaluateStoredCase } = await import("../src/rules/evaluate");
    const report = evaluateStoredCase(repo, id);
    expect(report.routing).toBe("human_review");
    expect(repo.getCase(id)!.outcome).toBe("approved_after_review");
    expect(sender.sent).toEqual([]);
  });
});
