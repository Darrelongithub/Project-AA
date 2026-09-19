/**
 * Qualification gate: automated mail goes out ONLY for fully qualified
 * applicants (Green verdict, no blocking flags). Every other case gets the
 * reply held as a staff suggestion — borderline files can still be admitted
 * on special acceptance, so the machine never speaks for the office on them.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { DEFAULT_REQUIREMENTS } from "../src/config";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";
import { processEmail } from "../src/pipeline";
import { runFollowUpSweep } from "../src/followups";
import { makeTextPdf, docLines } from "../src/simulation/pdfFactory";
import type { Attachment, IncomingEmail } from "../src/types";

let repo: Repo;
let sender: MockSender;
let ctx: PipelineContext;

beforeEach(() => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  repo.seedBaseRequirements(DEFAULT_REQUIREMENTS);
  sender = new MockSender();
  ctx = { repo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender } };
});

const mkEmail = (id: string, from: string, attachments: Attachment[], body = "Please find attached."): IncomingEmail => ({
  id, threadId: `thread-${from}`, from, subject: "Application documents", body,
  receivedAt: "2026-09-18T09:00:00Z", attachments,
});

async function mkAtt(filename: string, docType: string, name: string, extra = {}): Promise<Attachment> {
  return { filename, mimeType: "application/pdf", content: await makeTextPdf(docLines(docType, { name, ...extra })) };
}

// OR-5: complete file per the official application-form checklist.
const fullSet = async (name: string) => [
  await mkAtt("a.pdf", "academic_cert", name),
  await mkAtt("l.pdf", "leaving_certificate", name),
  await mkAtt("p.pdf", "passport_photo", name),
  await mkAtt("b.pdf", "birth_cert", name),
  await mkAtt("i.pdf", "id", name),
  await mkAtt("f.pdf", "application_form", name),
];

describe("qualification gate", () => {
  it("a fully qualified applicant (Green, no flags) still gets the automatic acknowledgement", async () => {
    const res = await processEmail(mkEmail("q-green", "qualified@example.org", await fullSet("QUALIFIED APPLICANT")), ctx);
    expect(res.finalStatus).toBe("Green");
    expect(res.autoSent).toBe(true);
    expect(res.autoKind).toBe("ack");
    expect(sender.sent.length).toBe(1);
  });

  it("a ref-only status query from a fully qualified case is answered automatically", async () => {
    const first = await processEmail(mkEmail("q-ref-1", "status-ok@example.org", await fullSet("STATUS OK APPLICANT")), ctx);
    expect(first.finalStatus).toBe("Green");
    const res = await processEmail(
      mkEmail("q-ref-2", "status-ok@example.org", [], first.refNumber!),
      ctx
    );
    expect(res.autoSent).toBe(true);
    expect(res.autoKind).toBe("status_answer");
    expect(sender.sent.length).toBe(2);
  });

  it("a ref-only status query from an INCOMPLETE case is held, not auto-sent", async () => {
    const first = await processEmail(
      mkEmail("q-part-1", "partial@example.org", [await mkAtt("a.pdf", "academic_cert", "PARTIAL APPLICANT")]),
      ctx
    );
    expect(first.finalStatus).toBe("Red");
    sender.sent.length = 0;
    const res = await processEmail(
      mkEmail("q-part-2", "partial@example.org", [], first.refNumber!),
      ctx
    );
    expect(res.autoKind).toBe("status_answer");
    expect(res.autoSent).toBe(false); // special acceptance may still apply
    expect(sender.sent.length).toBe(0);
    const held = repo.queuedOutbox(first.applicantId);
    expect(held).toBeTruthy();
    expect(repo.auditForApplicant(first.applicantId).some((e) => e.event === "automation_held_qualification")).toBe(true);
  });

  it("the held suggestion carries the applicant-facing text, ready to edit or send", async () => {
    const res = await processEmail(mkEmail("q-text", "suggest@example.org", [], "What documents do you need?"), ctx);
    expect(res.autoSent).toBe(false);
    const held = repo.queuedOutbox(res.applicantId);
    expect(held).toBeTruthy();
    expect(held!.subject).toContain(res.refNumber!);
    expect(held!.body).not.toContain("INTERNAL");
  });

  it("reminder-ladder rungs are suggestions too — never auto-sent", async () => {
    const first = await processEmail(
      mkEmail("q-lad-1", "ladderq@example.org", [await mkAtt("a.pdf", "academic_cert", "LADDER QUAL")]),
      ctx
    );
    // A rung falls due immediately.
    repo.setFollowup(first.applicantId, 0, new Date(Date.now() - 1000).toISOString());
    const processed = await runFollowUpSweep(repo, ctx);
    expect(processed).toBe(1);
    expect(sender.sent.length).toBe(0);
    expect(repo.queuedOutbox(first.applicantId)?.subject).toContain("REMINDER");
  });
});
