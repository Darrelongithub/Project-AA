/**
 * Smart intake engine (round 11) — replaces the blunt flat-hotword gate.
 *
 * Production feedback: a sent application email "doesn't work" (parked)
 * because the flat list missed natural phrasing, while the user supplied
 * the design: weighted keywords + phrases, subject weighted higher,
 * 2+ strong signals or 1 strong phrase, course names as hotwords,
 * attachment-name boost, and negative/disambiguation terms (job
 * applications, vacancies, CVs, complaints, refunds).
 *
 * Decision order (documented in src/intake/engine.ts):
 *   1. known applicant (quoted ref / known sender)   → application
 *   2. strong negatives (job/vacancy/CV/refund/…)    → parked
 *   3. configured hotword (settings list)            → application
 *   4. net application score ≥ 4 (2+ signals / 1 strong phrase / a course name)
 *   5. enquiry score ≥ 2 AND some admissions signal  → enquiry (case)
 *   6. anything else                                 → parked (visible in Mail)
 */
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { hashPassword } from "../src/util/password";
import { createApp } from "../src/web/server";
import { MockSender, type PipelineContext } from "../src/pipeline/adapters";
import { processEmail } from "../src/pipeline";
import type { IncomingEmail } from "../src/types";
import { classifyIntakeEmail, DEFAULT_INTAKE_HOTWORDS, intakeHotwordList } from "../src/intake";
import { webLogin } from "./helpers";

const HW = intakeHotwordList(DEFAULT_INTAKE_HOTWORDS);
const COURSES = ["BACHELOR OF SCIENCE (COMPUTER SCIENCE)", "BACHELOR OF NURSING", "MASTER OF BUSINESS ADMINISTRATION"];

function eng(p: Partial<Parameters<typeof classifyIntakeEmail>[0]> = {}) {
  return classifyIntakeEmail({
    subject: "",
    body: "",
    attachmentFilenames: [],
    courseNames: COURSES,
    customHotwords: HW,
    knownApplicant: false,
    ...p,
  });
}

describe("scored signals", () => {
  it("a course name in the subject alone opens a case (user: 'add all course names as hotwords')", () => {
    expect(eng({ subject: "Re: BACHELOR OF NURSING — seats?", body: "is the seat still available?" })).toMatchObject({
      category: "application", via: "score",
    });
  });

  it("two plain signals + an application-named attachment open a case", () => {
    const v = eng({
      subject: "documents",
      body: "please find my transcripts and my certificate",
      attachmentFilenames: ["ApplicationForm.pdf"],
    });
    expect(v.category).toBe("application");
    expect(v.via).toBe("score");
  });

  it("one strong phrase counts as a strong signal (body, plus one more signal)", () => {
    expect(eng({ subject: "", body: "I have submitted my application with supporting documents" })).toMatchObject({
      category: "application",
    });
  });

  it("the subject line is weighted higher than the body", () => {
    // (transcript + certificate are keywords but NOT default hotwords, so
    // the score — not the hotword rule — decides.)
    // In the subject each counts ×2: 2 + 2 = 4 → case.
    expect(eng({ subject: "my transcripts and certificate", body: "" })).toMatchObject({ category: "application", via: "score" });
    // The same words in the body alone count ×1: 2 → NOT enough.
    expect(eng({ subject: "hello", body: "my transcript and certificate" })).toMatchObject({ category: "parked" });
  });

  it("admissions enquiries become cases (category enquiry), general questions do not", () => {
    expect(eng({ subject: "question", body: "What are the tuition fees for nursing and is there a scholarship available?" })).toMatchObject({
      category: "enquiry",
    });
    expect(eng({ subject: "when is the open day?", body: "please advise" })).toMatchObject({ category: "parked" });
  });
});

describe("configured hotwords stay decisive (round-9 semantics preserved)", () => {
  it("a default hotword in the subject alone still opens a case", () => {
    expect(eng({ subject: "Application", body: "" })).toMatchObject({ category: "application", via: "hotword" });
  });

  it("a user-added custom hotword works too", () => {
    const v = eng({ subject: "safari-2026 group", body: "we are coming on the safari-2026 tour", customHotwords: ["safari-2026"] });
    expect(v.category).toBe("application");
  });

  it("known-applicant mail bypasses scoring entirely (replies always attach)", () => {
    expect(eng({ subject: "re: your message", body: "sure, sending it now", knownApplicant: true })).toMatchObject({
      category: "application", via: "known_applicant",
    });
  });
});

describe("negative / disambiguation terms", () => {
  it("a job application is parked even though it says 'apply' and 'application'", () => {
    const v = eng({
      subject: "Job application — admissions officer",
      body: "I would like to apply for the position. My CV and cover letter are attached.",
      attachmentFilenames: ["CV.pdf"],
    });
    expect(v.category).toBe("parked");
    expect(v.negatives.length).toBeGreaterThan(0);
  });

  it("a recruitment notice is parked despite admissions vocabulary", () => {
    expect(
      eng({ subject: "Staff vacancy", body: "We are recruiting two admissions officers. Submit your CV by Friday." })
    ).toMatchObject({ category: "parked" });
  });

  it("a genuine applicant complaint (no negative vocabulary) stays a case", () => {
    expect(
      eng({
        subject: "Nobody is responding to me",
        body: "I have been trying to reach your office for weeks. I want to apply for BSc in the September intake. My phone is 0712 345 678.",
      })
    ).toMatchObject({ category: "application" });
  });

  it("a service promo with no admissions signals is parked at score 0", () => {
    const v = eng({ subject: "Limited time inside", body: "Claim your discount today. No strings attached." });
    expect(v).toMatchObject({ category: "parked", via: "none" });
    expect(v.score).toBeLessThanOrEqual(0);
  });
});

describe("the pipeline uses the engine (gate behaviour end-to-end)", () => {
  let repo: Repo;
  let ctx: PipelineContext;
  let n = 0;

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
      attachments: [],
      ...p,
    } as IncomingEmail;
  }

  it("course-name-only mail creates a real case (course names from the database)", async () => {
    repo = new Repo(openDb(":memory:"));
    seedDefaults(repo);
    const sender = new MockSender();
    ctx = { repo, adapters: { vision: null as never, watcher: null as never, sender } };
    const prog = repo.listProgrammes()[0];
    const res = await processEmail(mail({ subject: `Re: ${prog.name}`, body: "is the seat available?" }), ctx);
    expect(res.skipped).toBeFalsy();
    expect(res.applicantId).toBeTruthy();
    expect(repo.getApplicant(res.applicantId!)).toBeDefined();
  });

  it("a job application is parked and the audit records the score + signals", async () => {
    repo = new Repo(openDb(":memory:"));
    seedDefaults(repo);
    const sender = new MockSender();
    ctx = { repo, adapters: { vision: null as never, watcher: null as never, sender } };
    const res = await processEmail(
      mail({
        subject: "Job application — admissions officer",
        body: "I would like to apply for the position. My CV is attached.",
      }),
      ctx
    );
    expect(res.skipped).toBe(true);
    const audits = repo.recentAudit(5).filter((a) => a.event === "email_parked_non_intake");
    expect(audits.length).toBe(1);
    expect(audits[0].detail).toMatch(/score/i);
    expect(audits[0].detail).toMatch(/kept in mail/i);
  });

  it("the Settings hotword card shows recently parked mail with its score", async () => {
    repo = new Repo(openDb(":memory:"));
    seedDefaults(repo);
    repo.createStaff("admin", "P Admin", hashPassword("admin123"), "admin");
    // park one email through the engine (no signals at all)
    const sender = new MockSender();
    const pctx: PipelineContext = { repo, adapters: { vision: null as never, watcher: null as never, sender } };
    processEmail(mail({ subject: "Summer sale — 50% off", body: "Only this weekend." }), pctx);

    const server = createApp({ repo, ctx: pctx }).listen(0);
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const { cookie } = await webLogin(base, "admin", "admin123");
      const html = await (await fetch(`${base}/settings`, { headers: { cookie } })).text();
      expect(html).toMatch(/Recently parked/i);
      expect(html).toContain("Summer sale — 50% off");
      expect(html).toMatch(/score/i);
    } finally {
      server.close();
    }
  });
});
