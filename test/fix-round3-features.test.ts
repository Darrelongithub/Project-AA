/**
 * Round-3 feature fixes — gaps found by the master-checklist audit:
 *
 *  F1  "Wrong document landed" flag: a file whose type is NOT on the case
 *      type's document list fills no slot and used to be noted in the
 *      reasoning only. Staff need a visible `wrong_document` flag, and the
 *      case must route to human review — never auto-Green.
 *  F2  "Most requested missing documents" dashboard stat: the overview shows
 *      counts but not WHICH documents are missing most often.
 *
 * Both are exercised against a tenant's own configured checklist: nothing is
 * inherited from a bundled catalogue.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { configureTestOrganization, docLines } from "./helpers";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";
import { processEmail } from "../src/pipeline";
import { makeTextPdf } from "../src/simulation/pdfFactory";
import type { Attachment, IncomingEmail } from "../src/types";
import { mustProcessed } from "./harness";

let repo: Repo;
let ctx: PipelineContext;

beforeEach(() => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  // SERVICE_REQUEST requires a request form and an identity document; a
  // supporting note is optional. Its rule tree reads the "consent" fact.
  configureTestOrganization(repo);
  ctx = { repo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender: new MockSender() } };
});

function mkEmail(id: string, from: string, attachments: Attachment[]): IncomingEmail {
  return {
    id, threadId: `thread-${from}`, from,
    subject: "Service request documents",
    body: "Please find my papers attached.\nConsent: yes",
    receivedAt: "2026-09-14T09:00:00Z",
    organizationId: 1, caseTypeCode: "SERVICE_REQUEST",
    attachments,
  } as IncomingEmail;
}

async function mkAtt(filename: string, docType: string, name: string): Promise<Attachment> {
  return { filename, mimeType: "application/pdf", content: await makeTextPdf(docLines(docType, { name })) };
}

/** Everything this case type asks for — and nothing it does not. */
const fullSet = async (name: string) => [
  await mkAtt("f.pdf", "request_form", name),
  await mkAtt("i.pdf", "id", name),
];

describe("F1 — wrong-document flag", () => {
  it("a complete set plus a file that is not on the list → wrong_document flag, human review (Orange), never auto-Green", async () => {
    const email = mkEmail("wf-1", "wrong1@example.org", [
      ...(await fullSet("WRONG ONE")),
      await mkAtt("s.pdf", "services_agreement", "WRONG ONE"), // another case type's requirement, not this one's
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
    const email = mkEmail("wf-2", "wrong2@example.org", [
      await mkAtt("f.pdf", "request_form", "WRONG TWO"),
      await mkAtt("s.pdf", "services_agreement", "WRONG TWO"), // the identity document is missing
    ]);
    const res = mustProcessed(await processEmail(email, ctx));
    expect(res.finalStatus).toBe("Red");
    expect(res.missing).toEqual(["id"]);
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

describe("F2 — most requested missing documents", () => {
  function mkCase(email: string, name: string, caseTypeCode = "SERVICE_REQUEST"): number {
    return repo.createCase({ emailAddress: email, threadId: `t-${email}`, organizationId: 1, fullName: name, caseTypeCode }).id;
  }

  it("aggregates missing required documents across open cases, scoped by case type", () => {
    mkCase("cm1@example.org", "CM One");
    const a2 = mkCase("cm2@example.org", "CM Two");
    // a2 has already sent the identity document; a1 has nothing.
    repo.insertDocument({
      applicant_id: a2, document_type: "id", source_email_id: "x", extraction_method: "ocr",
      extracted_text: "", extracted_fields: { name: "CM TWO" }, confidence: "high", received_at: new Date().toISOString(),
    });
    const cm = repo.commonMissingDocs(0, null, 10);
    expect(cm.length).toBeGreaterThan(0);
    const identity = cm.find((r) => r.type === "id")!;
    expect(identity.count).toBe(1); // only a1 is missing it
    const form = cm.find((r) => r.type === "request_form")!;
    expect(form.count).toBe(2);
    expect(form.count).toBeGreaterThanOrEqual(identity.count); // sorted desc
    // The aggregation follows the caller's case-type scope…
    expect(repo.commonMissingDocs(0, ["VENDOR_INTAKE"], 10)).toEqual([]);
    expect(repo.commonMissingDocs(0, ["SERVICE_REQUEST"], 10).map((r) => r.type)).toContain("request_form");
    // …and closed cases are not counted.
    repo.updateApplicant(a2, { lifecycle: "completed" });
    expect(repo.commonMissingDocs(0, null, 10).find((r) => r.type === "request_form")!.count).toBe(1);
  });

  it("appears on the overview as a named list, not just a count", async () => {
    mkCase("cm3@example.org", "CM Three");
    mkCase("cm4@example.org", "CM Four");
    const { webLogin } = await import("./helpers");
    const { createApp } = await import("../src/web/server");
    const { hashPassword } = await import("../src/util/password");
    repo.createStaff("admin", "Admin", hashPassword("admin123"), "admin");
    const server = createApp({ repo, ctx }).listen(0);
    try {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const { cookie } = await webLogin(base, "admin", "admin123");
      const page = await (await fetch(`${base}/`, { headers: { cookie } })).text();
      expect(page).toMatch(/most requested missing documents/i);
      // Named from the tenant's own checklist, with the case count beside it.
      expect(page).toContain("Request form");
      expect(page).toContain("Identity document");
      expect(page).toMatch(/2 cases/);
    } finally {
      server.close();
    }
  });
});
