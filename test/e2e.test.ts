/**
 * End-to-end pipeline tests (v2): real generated PDFs through processEmail
 * with mock external adapters and an in-memory DB. OCR is bypassed here so
 * tests never need the network — the simulation exercises the OCR tier.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { DEFAULT_REQUIREMENTS } from "../src/config";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";
import { processEmail } from "../src/pipeline";
import { makeScannedPdf, makeTextPdf, docLines } from "../src/simulation/pdfFactory";
import type { Attachment, IncomingEmail } from "../src/types";

import { mustProcessed } from "./harness";
let repo: Repo;
let sender: MockSender;
let ctx: PipelineContext;

beforeEach(() => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  repo.seedBaseRequirements(DEFAULT_REQUIREMENTS);
  // The grade floor the pipeline tests judge against: KCPE mean grade B-.
  repo.upsertRule({ programme: null, intake: null, document_type: "kcpe_cert", required: true, meanGrade: "B-" });
  sender = new MockSender();
  ctx = { repo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender } };
});

function mkEmail(id: string, from: string, attachments: Attachment[], body = "Please find attached."): IncomingEmail {
  return {
    id,
    threadId: `thread-${from}`,
    from,
    subject: "Application documents",
    body,
    receivedAt: "2026-09-14T09:00:00Z",
    attachments,
  };
}

async function mkAtt(filename: string, docType: string, name: string, extra = {}): Promise<Attachment> {
  return { filename, mimeType: "application/pdf", content: await makeTextPdf(docLines(docType, { name, ...extra })) };
}

// OR-5: the complete file follows the official application-form checklist
// (result slip via the academic document, leaving certificate, passport
// photo, ID, birth certificate, completed application form).
const fullSet = async (name: string) => [
  await mkAtt("a.pdf", "academic_cert", name),
  await mkAtt("l.pdf", "leaving_certificate", name),
  await mkAtt("p.pdf", "passport_photo", name),
  await mkAtt("b.pdf", "birth_cert", name),
  await mkAtt("i.pdf", "id", name),
  await mkAtt("f.pdf", "application_form", name),
];

describe("pipeline v2 end-to-end", () => {
  it("clean complete set → Green factual acknowledgement, admission remains for human review", async () => {
    const email = mkEmail("e2e-alice", "alice@example.org", await fullSet("ALICE WANJIKU KAMAU"));
    const res = mustProcessed(await processEmail(email, ctx));

    expect(res.finalStatus).toBe("Green");
    expect(res.autoSent).toBe(true);
    expect(res.autoKind).toBe("ack");
    // A clean qualification still receives only a factual acknowledgement;
    // the final admission decision remains a human action.
    expect(res.lifecycle).toBe("documents_checked");
    expect(res.refNumber).toMatch(/^[A-Z]{2}-\d{4}-\d{6}$/);
    expect(sender.sent.length).toBe(1);
    expect(sender.sent[0].subject.startsWith(`[${res.refNumber}]`)).toBe(true);

    const a = repo.getApplicant(res.applicantId)!;
    expect(a.admission_decision).toBe("undecided");
    expect(a.admission_route).toBeNull();
    expect(a.decision_by).toBeNull();
    expect(a.req_result).toBe("passed");
    expect(a.routing).toBe("human_review");

    const history = repo.statusHistory(res.applicantId);
    expect(history.some((h) => h.to_status === "documents_checked" && h.actor === "system")).toBe(true);
    const audit = repo.auditForApplicant(res.applicantId);
    expect(audit.some((a2) => a2.event === "email_received")).toBe(true);
    expect(audit.some((a2) => a2.event === "requirements_checked")).toBe(true);
    expect(audit.some((a2) => a2.event === "auto_admission_triggered")).toBe(false);
    expect(audit.some((a2) => a2.event === "admission_auto_qualified")).toBe(false);
    // The evaluation itself is stored, never overwritten by the admission.
    expect(repo.latestEvaluation(res.applicantId)?.result).toBe("passed");
  });

  it("missing required doc → suggested missing-docs reply HELD for staff (qualification gate)", async () => {
    const name = "CAROL NJERI MAINA";
    const email = mkEmail("e2e-carol", "carol@example.org", [
      await mkAtt("a.pdf", "academic_cert", name),
      await mkAtt("l.pdf", "leaving_certificate", name),
      await mkAtt("p.pdf", "passport_photo", name),
      await mkAtt("b.pdf", "birth_cert", name),
      await mkAtt("f.pdf", "application_form", name),
    ]);
    const res = mustProcessed(await processEmail(email, ctx));

    expect(res.finalStatus).toBe("Red");
    expect(res.autoKind).toBe("missing_docs");
    expect(res.autoSent).toBe(false); // not fully qualified → nothing leaves automatically
    expect(sender.sent.length).toBe(0);
    const held = repo.queuedOutbox(res.applicantId);
    expect(held).toBeTruthy();
    expect(held!.body).toMatch(/National ID/);
    expect(repo.auditForApplicant(res.applicantId).some((e) => e.event === "automation_held_qualification")).toBe(true);
    expect(res.missing).toEqual(["id"]);
    expect(res.lifecycle).toBe("documents_received");
  });

  it("bare inquiry → document-request suggestion held for staff (qualification gate)", async () => {
    const email = mkEmail("e2e-henry", "henry@example.org", [], "What documents do you need?");
    const res = mustProcessed(await processEmail(email, ctx));
    expect(res.autoKind).toBe("docs_request");
    expect(res.autoSent).toBe(false);
    expect(sender.sent.length).toBe(0);
    expect(repo.queuedOutbox(res.applicantId)).toBeTruthy();
    expect(res.lifecycle).toBe("application_received");
  });

  it("ambiguous (grade below floor) → queued for a human, nothing auto-sent", async () => {
    const name = "BRIAN KIPROTICH RUTO";
    const email = mkEmail("e2e-brian", "brian@example.org", [
      await mkAtt("a.pdf", "academic_cert", name, { kcseMeanGrade: "C-" }),
      await mkAtt("l.pdf", "leaving_certificate", name),
      await mkAtt("p.pdf", "passport_photo", name),
      await mkAtt("b.pdf", "birth_cert", name),
      await mkAtt("i.pdf", "id", name),
      await mkAtt("f.pdf", "application_form", name),
    ]);
    const res = mustProcessed(await processEmail(email, ctx));
    expect(res.finalStatus).toBe("Orange");
    expect(res.autoSent).toBe(false);
    expect(res.lifecycle).toBe("awaiting_review");
    expect(sender.sent.length).toBe(0);
    const applicant = repo.getApplicant(res.applicantId)!;
    expect(applicant.sla_due_at).toBeTruthy(); // SLA clock started
  });

  it("watcher downgrade: specimen document → Red, queued, watcher_flag recorded", async () => {
    const name = "IVY CHEBET KOSGEI";
    const email = mkEmail("e2e-ivy", "ivy@example.org", [
      await mkAtt("a.pdf", "academic_cert", name, { extraLines: ["SPECIMEN - SAMPLE COPY NOT VALID"] }),
      await mkAtt("l.pdf", "leaving_certificate", name),
      await mkAtt("p.pdf", "passport_photo", name),
      await mkAtt("b.pdf", "birth_cert", name),
      await mkAtt("i.pdf", "id", name),
      await mkAtt("f.pdf", "application_form", name),
    ]);
    const res = mustProcessed(await processEmail(email, ctx));
    expect(res.finalStatus).toBe("Red");
    expect(res.autoSent).toBe(false);
    expect(res.flags.map((f) => f.type)).toContain("watcher_flag");
    expect(sender.sent.length).toBe(0);
  });

  it("byte-identical resubmission → duplicate detected, not double-counted", async () => {
    const name = "KEVIN MWANGI NJOROGE";
    const docs = await fullSet(name);
    const idDoc = docs.find((d) => d.filename === "i.pdf")!;
    const res1 = await processEmail(mkEmail("e2e-kev1", "kevin@example.org", docs), ctx);
    expect(res1.finalStatus).toBe("Green");

    const res2 = mustProcessed(await processEmail(      mkEmail("e2e-kev2", "kevin@example.org", [{ ...idDoc, filename: "id-again.pdf" }], "Resending my ID."),
      ctx
    ));
    expect(res2.finalStatus).toBe("Green");
    expect(repo.countDuplicates(res2.applicantId)).toBe(1);
    expect(repo.listDocuments(res2.applicantId).length).toBe(6); // still one active set
    expect(repo.auditForApplicant(res2.applicantId).some((a) => a.event === "duplicate_detected")).toBe(true);
  });

  it("fuzzy one-letter name variant → name_mismatch → Orange (feature 23)", async () => {
    const email = mkEmail("e2e-lucy", "lucy@example.org", [
      await mkAtt("a.pdf", "academic_cert", "LUCY OCHIMI"),
      await mkAtt("l.pdf", "leaving_certificate", "LUCY OCHIMI"),
      await mkAtt("p.pdf", "passport_photo", "LUCY OCHIMI"),
      await mkAtt("b.pdf", "birth_cert", "LUCY OCHIMI"),
      await mkAtt("i.pdf", "id", "LUCY OCHIEMI"),
      await mkAtt("f.pdf", "application_form", "LUCY OCHIMI"),
    ]);
    const res = mustProcessed(await processEmail(email, ctx));
    expect(res.finalStatus).toBe("Orange");
    expect(res.flags.map((f) => f.type)).toContain("name_mismatch");
    expect(res.flags[0].detail).toMatch(/typo/i);
  });

  it("complaint email → category complaint + high priority", async () => {
    const email = mkEmail("e2e-mary", "mary@example.org", [], "Nobody responds to me. This is unacceptable. I want to apply for BCS in the September 2026 intake. My phone is 0712 345 678.");
    const res = mustProcessed(await processEmail(email, ctx));
    expect(res.category).toBe("complaint");
    const applicant = repo.getApplicant(res.applicantId)!;
    expect(applicant.priority).toBe("high");
    expect(applicant.programme).toBe("BCS");
    expect(applicant.intake).toBe("September 2026");
    expect(applicant.phone).toBeTruthy();
  });

  it("scanned PDF falls through to the mock Gemini tier → medium confidence → Orange", async () => {
    const name = "GRACE AKINYI OTIENO";
    const kcpeLines = docLines("kcpe_cert", { name, kcpePoints: 289, year: "2019" });
    const email = mkEmail("e2e-grace", "grace@example.org", [
      await mkAtt("a.pdf", "academic_cert", name),
      {
        filename: "k-scan.pdf",
        mimeType: "application/pdf",
        content: await makeScannedPdf(kcpeLines),
        mockVision: { document_type: "kcpe_cert", text: kcpeLines.join("\n"), fields: { name, gradePoints: 289 }, confidence: "medium" },
      },
      await mkAtt("l.pdf", "leaving_certificate", name),
      await mkAtt("p.pdf", "passport_photo", name),
      await mkAtt("b.pdf", "birth_cert", name),
      await mkAtt("i.pdf", "id", name),
      await mkAtt("f.pdf", "application_form", name),
    ]);
    const res = mustProcessed(await processEmail(email, ctx));
    expect(res.finalStatus).toBe("Orange");
    const docs = repo.listDocuments(res.applicantId);
    const scanned = docs.find((d) => d.document_type === "kcpe_cert")!;
    expect(scanned.extraction_method).toBe("gemini_vision");
    expect(scanned.confidence).toBe("medium");
  });

  it("is idempotent: processing the same email twice is a no-op", async () => {
    const email = mkEmail("e2e-twice", "twice@example.org", await fullSet("ALICE WANJIKU KAMAU"));
    await processEmail(email, ctx);
    const second = await processEmail(email, ctx);
    expect(second.skipped).toBe(true);
    expect(sender.sent.length).toBe(1);
    expect(repo.decisionLogs().length).toBe(1);
  });

  it("email history records incoming and outgoing mail under the applicant", async () => {
    const email = mkEmail("e2e-hist", "hist@example.org", await fullSet("HISTORIA WANJIKA MUTUA"));
    const res = mustProcessed(await processEmail(email, ctx));
    const emails = repo.emailsForApplicant(res.applicantId);
    expect(emails.length).toBe(2);
    expect(emails[0].direction).toBe("in");
    expect(emails[0].category).toBe("document_submission");
    expect(emails[1].direction).toBe("out");
    expect(emails[1].auto).toBe(1);
  });
});
