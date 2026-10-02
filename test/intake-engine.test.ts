/**
 * Configured intake engine — which mail becomes a case.
 *
 * The gate is tenant data, never a bundled vocabulary:
 *   1. a known contact (a quoted reference or a sender who already has a case)
 *      → the case continues;
 *   2. a configured phrase — one of the tenant's own case-type names/codes, or
 *      an administrator's hotword → a case opens. A phrase in the subject
 *      scores 4, in the body or an attachment name 2;
 *   3. question wording makes that case an ENQUIRY rather than a submission;
 *   4. anything else is parked in Mail — kept, visible, labelable, never
 *      silently dropped, and never pre-judged by a bundled negative list.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { hashPassword } from "../src/util/password";
import { createApp } from "../src/web/server";
import { MockSender, type PipelineContext } from "../src/pipeline/adapters";
import { processEmail } from "../src/pipeline";
import type { IncomingEmail } from "../src/types";
import { classifyIntakeEmail, DEFAULT_INTAKE_HOTWORDS } from "../src/intake";
import { configureTestOrganization, webLogin } from "./helpers";

/** What a configured tenant hands the scorer: its own case types. */
const TYPES = ["service request", "SERVICE_REQUEST", "vendor intake", "VENDOR_INTAKE"];

function eng(p: Partial<Parameters<typeof classifyIntakeEmail>[0]> = {}) {
  return classifyIntakeEmail({
    subject: "",
    body: "",
    attachmentFilenames: [],
    caseTypeNames: TYPES,
    customHotwords: [],
    knownContact: false,
    ...p,
  });
}

describe("configured signals", () => {
  it("a configured case-type name in the subject alone opens a case", () => {
    const v = eng({ subject: "Re: vendor intake — our agreement", body: "please find it attached" });
    expect(v).toMatchObject({ category: "application", via: "hotword" });
    expect(v.positives).toContain("vendor intake");
    expect(v.score).toBe(4);
  });

  it("the subject line is weighted higher than the body", () => {
    expect(eng({ subject: "service request", body: "" }).score).toBe(4);
    expect(eng({ subject: "hello", body: "about my service request" }).score).toBe(2);
    // Both still open a case — the weight decides how much signal, not whether.
    expect(eng({ subject: "hello", body: "about my service request" })).toMatchObject({ category: "application" });
  });

  it("an attachment named after a configured phrase counts as a signal", () => {
    const v = eng({
      subject: "documents",
      body: "please find them attached",
      attachmentFilenames: ["vendor_intake_agreement.pdf"],
    });
    expect(v.positives).toContain("vendor intake");
    expect(v.category).toBe("application");
  });

  it("a question becomes an enquiry case, not a document submission", () => {
    expect(eng({ subject: "Question about vendor intake?", body: "please advise" })).toMatchObject({
      category: "enquiry",
      via: "hotword",
    });
    expect(eng({ subject: "Question about vendor intake?", body: "please advise" }).enquiryScore).toBeGreaterThan(0);
  });

  it("a known contact bypasses scoring entirely (replies always attach)", () => {
    expect(eng({ subject: "re: your message", body: "sure, sending it now", knownContact: true })).toMatchObject({
      category: "application",
      via: "known_contact",
    });
  });

  it("an administrator's hotword is decisive on its own", () => {
    const v = eng({
      subject: "safari-2026 group",
      body: "we are coming on the safari-2026 tour",
      customHotwords: ["safari-2026"],
    });
    expect(v.category).toBe("application");
    expect(v.positives).toContain("safari-2026");
  });
});

describe("no bundled vocabulary", () => {
  it("a job application is parked because this tenant never configured it", () => {
    const v = eng({
      subject: "Job application — operations officer",
      body: "I would like to apply for the position. My CV and cover letter are attached.",
      attachmentFilenames: ["CV.pdf"],
    });
    expect(v).toMatchObject({ category: "parked", via: "none", score: 0 });
    expect(v.positives).toEqual([]);
    // Nothing is pre-judged: only the tenant's own configuration decides.
    expect(v.negatives).toEqual([]);
  });

  it("a promotion with no configured phrase is parked at score 0", () => {
    const v = eng({ subject: "Limited time inside", body: "Claim your discount today. No strings attached." });
    expect(v).toMatchObject({ category: "parked", via: "none" });
    expect(v.score).toBe(0);
  });

  it("a tenant that configured nothing parks even the plainest request", () => {
    expect(eng({ caseTypeNames: [], subject: "service request", body: "vendor intake" })).toMatchObject({
      category: "parked",
      via: "none",
    });
  });

  it("a fresh install ships no hotwords at all", () => {
    expect(DEFAULT_INTAKE_HOTWORDS).toBe("");
  });
});

describe("the pipeline uses the engine (gate behaviour end-to-end)", () => {
  let repo: Repo;
  let ctx: PipelineContext;
  let sender: MockSender;
  let n = 0;

  beforeEach(() => {
    repo = new Repo(openDb(":memory:"));
    seedDefaults(repo);
    configureTestOrganization(repo);
    sender = new MockSender();
    ctx = { repo, adapters: { vision: null as never, watcher: null as never, sender } };
    n = 0;
  });

  function mail(p: Partial<IncomingEmail>): IncomingEmail {
    n += 1;
    return {
      id: `t11-${n}`,
      threadId: `t11-thread-${n}`,
      from: `person${n}@example.org`,
      fromName: `Person ${n}`,
      to: "",
      subject: "",
      body: "",
      receivedAt: new Date().toISOString(),
      organizationId: 1,
      attachments: [],
      ...p,
    } as IncomingEmail;
  }

  it("a case-type name alone creates a real case (names come from the database)", async () => {
    const res = await processEmail(mail({ subject: "Re: vendor intake", body: "is the slot still available?" }), ctx);
    expect(res.skipped).toBeFalsy();
    expect(res.applicantId).toBeTruthy();
    expect(repo.getApplicant(res.applicantId!)).toBeDefined();
  });

  it("an eligibility question with a screenshot stays in human enquiry triage", async () => {
    const res = await processEmail(mail({
      subject: "Question about service request requirements",
      body: "I am writing to ask what you need from me before I submit. Is a certified copy enough?",
      attachments: [{ filename: "screenshot.jpg", mimeType: "image/jpeg", content: Buffer.from("not-an-image") }],
    }), ctx);
    expect(res.skipped).toBeFalsy();
    expect(res.category).toBe("general_enquiry");
    // The attachment is evidence for the human reply, not a document submission.
    expect(res.autoKind).toBeNull();
    expect(res.autoSent).toBe(false);
    expect(res.lifecycle).toBe("application_received");
    expect(repo.getApplicant(res.applicantId!)!.lifecycle).toBe("application_received");
    expect(sender.sent.length).toBe(0);
  });

  it("unconfigured mail is parked and the audit records why", async () => {
    const res = await processEmail(
      mail({ subject: "Job application — operations officer", body: "I would like to apply for the position. My CV is attached." }),
      ctx
    );
    expect(res.skipped).toBe(true);
    const audits = repo.recentAudit(10).filter((a) => a.event === "email_parked_non_intake");
    expect(audits.length).toBe(1);
    expect(audits[0].detail).toMatch(/kept in Mail/i);
    expect(audits[0].detail).toMatch(/signals/i);
    expect(sender.sent.length).toBe(0);
  });

  it("the Settings card shows recently parked mail", async () => {
    repo.createStaff("admin", "Intake Admin", hashPassword("admin123"), "admin");
    await processEmail(mail({ subject: "Summer sale — 50% off", body: "Only this weekend." }), ctx);

    const server = createApp({ repo, ctx }).listen(0);
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const { cookie } = await webLogin(base, "admin", "admin123");
      const html = await (await fetch(`${base}/settings`, { headers: { cookie } })).text();
      expect(html).toMatch(/Recently parked/i);
      expect(html).toContain("Summer sale — 50% off");
    } finally {
      server.close();
    }
  });
});
