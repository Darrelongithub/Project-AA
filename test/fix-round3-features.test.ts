/**
 * Round-3 feature fixes — gaps found by the master-checklist audit:
 *
 *  F1  "Wrong document landed" flag: a file whose type is NOT on the course's
 *      document list currently fills no slot and is silently noted in
 *      reasoning only. Staff need a visible `wrong_document` flag (and the
 *      case must route to human review — never auto-Green).
 *  F2  "Most common missing documents" dashboard stat: the overview shows
 *      counts but not WHICH documents are missing most often.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { DEFAULT_REQUIREMENTS } from "../src/config";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";
import { processEmail } from "../src/pipeline";
import { makeTextPdf, docLines } from "../src/simulation/pdfFactory";
import type { Attachment, IncomingEmail } from "../src/types";
import { mustProcessed } from "./harness";

let repo: Repo;
let ctx: PipelineContext;

beforeEach(() => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  repo.seedBaseRequirements(DEFAULT_REQUIREMENTS);
  ctx = { repo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender: new MockSender() } };
});

function mkEmail(id: string, from: string, attachments: Attachment[]): IncomingEmail {
  return { id, threadId: `thread-${from}`, from, subject: "Application documents", body: "Please find attached.", receivedAt: "2026-09-14T09:00:00Z", attachments };
}
async function mkAtt(filename: string, docType: string, name: string): Promise<Attachment> {
  return { filename, mimeType: "application/pdf", content: await makeTextPdf(docLines(docType, { name })) };
}
/** Complete file for a KCSE degree course (see test/e2e.test.ts). */
const fullSet = async (name: string) => [
  await mkAtt("a.pdf", "academic_cert", name),
  await mkAtt("l.pdf", "leaving_certificate", name),
  await mkAtt("p.pdf", "passport_photo", name),
  await mkAtt("b.pdf", "birth_cert", name),
  await mkAtt("i.pdf", "id", name),
  await mkAtt("f.pdf", "application_form", name),
];

describe("F1 — wrong-document flag", () => {
  /** Pin the applicant's programme so the test does not depend on
   *  programme inference from the email body. */
  function pinApplicant(email: string, programme: string): void {
    const a = repo.getOrCreateApplicant(email, `thread-${email}`);
    repo.updateApplicant(a.id, { programme });
  }

  it("a complete set plus a file that is not on the list → wrong_document flag, human review (Orange), never auto-Green", async () => {
    pinApplicant("wrong1@example.org", "BNS"); // nursing: 6 core docs, no statements
    const email = mkEmail("wf-1", "wrong1@example.org", [
      ...(await fullSet("WRONG ONE")),
      await mkAtt("ps.pdf", "business_statement_of_objective", "WRONG ONE"), // business-course item, not on BNS's list
    ]);
    const res = mustProcessed(await processEmail(email, ctx));
    expect(res.finalStatus).toBe("Orange");
    expect(res.lifecycle).not.toBe("completed");
    const flags = repo.activeFlags(res.applicantId).map((f) => f.type);
    expect(flags).toContain("wrong_document");
    // the reasoning record names the offending document
    const decision = repo.decisionLogs(res.applicantId).find((d) => d.reasoning?.includes("wrong_document"));
    expect(decision).toBeTruthy();
  });

  it("missing documents + a wrong file still reads Red (missing wins, flag rides along)", async () => {
    pinApplicant("wrong2@example.org", "BNS");
    const email = mkEmail("wf-2", "wrong2@example.org", [
      await mkAtt("a.pdf", "academic_cert", "WRONG TWO"),
      await mkAtt("ps.pdf", "business_statement_of_objective", "WRONG TWO"), // passport photo et al. missing
    ]);
    const res = mustProcessed(await processEmail(email, ctx));
    expect(res.finalStatus).toBe("Red");
    const flags = repo.activeFlags(res.applicantId).map((f) => f.type);
    expect(flags).toContain("wrong_document");
  });

  it("a clean complete set still stays Green with no wrong_document flag", async () => {
    const email = mkEmail("wf-3", "clean@example.org", await fullSet("CLEAN THREE"));
    const res = mustProcessed(await processEmail(email, ctx));
    expect(res.finalStatus).toBe("Green");
    expect(repo.activeFlags(res.applicantId).map((f) => f.type)).not.toContain("wrong_document");
  });
});

describe("F2 — most common missing documents", () => {
  it("aggregates missing required docs across open cases, scoped by realm", () => {
    const a1 = repo.getOrCreateApplicant("cm1@example.org", "t-cm1");
    const a2 = repo.getOrCreateApplicant("cm2@example.org", "t-cm2");
    repo.updateApplicant(a1.id, { programme: "BNS", lifecycle: "application_received" });
    repo.updateApplicant(a2.id, { programme: "BNS", lifecycle: "application_received" });
    // a2 has already sent the passport photo; a1 has nothing
    repo.insertDocument({
      applicant_id: a2.id, document_type: "passport_photo", source_email_id: "x", extraction_method: "ocr",
      extracted_text: "", extracted_fields: { name: "CM TWO" }, confidence: "high", received_at: new Date().toISOString(),
    });
    const cm = repo.commonMissingDocs(0, null, 10);
    expect(cm.length).toBeGreaterThan(0);
    const passport = cm.find((r) => r.type === "passport_photo")!;
    expect(passport.count).toBe(1); // only a1 is missing it
    const form = cm.find((r) => r.type === "application_form")!;
    expect(form.count).toBe(2);
    expect(form.count).toBeGreaterThanOrEqual(passport.count); // sorted desc
    // completed cases are not counted
    repo.updateApplicant(a2.id, { lifecycle: "completed" });
    expect(repo.commonMissingDocs(0).find((r) => r.type === "passport_photo")!.count).toBe(1);
  });

  it("appears on the overview as a named list, not just a count", async () => {
    const a1 = repo.getOrCreateApplicant("cm3@example.org", "t-cm3");
    repo.updateApplicant(a1.id, { programme: "BNS", lifecycle: "application_received" });
    const { webLogin } = await import("./helpers");
    const { createApp } = await import("../src/web/server");
    const { hashPassword } = await import("../src/util/password");
    repo.createStaff("admin", "Admin", hashPassword("admin123"), "admin");
    const server = createApp({ repo, ctx }).listen(0);
    try {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const { cookie } = await webLogin(base, "admin", "admin123");
      const page = await (await fetch(`${base}/`, { headers: { cookie } })).text();
      expect(page).toMatch(/most (requested |common )?missing documents/i);
      expect(page).toContain("Passport-size Photograph");
    } finally {
      server.close();
    }
  });
});
