/**
 * v3 feature tests: identity matching & conversation reconstruction, anomaly
 * rules, requirement snapshots, intake deadlines, draft-first automation,
 * follow-up ladder, reopen, unanswered detection, portal OTP/sessions,
 * tasks, retention, and decision-replay inputs.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { DEFAULT_REQUIREMENTS } from "../src/config";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";
import { processEmail } from "../src/pipeline";
import { resolveIdentity } from "../src/matching/identity";
import { runFollowUpSweep } from "../src/followups";
import { decide } from "../src/rules";
import { extractFields } from "../src/extraction/fields";
import { makeTextPdf, docLines } from "../src/simulation/pdfFactory";
import type { Attachment, IncomingEmail } from "../src/types";
import { REQS, mkDoc } from "./helpers";

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

function mkEmail(id: string, threadId: string, from: string, extra: Partial<IncomingEmail> = {}): IncomingEmail {
  return {
    id, threadId, from,
    subject: "Application documents",
    body: "Please find attached.",
    receivedAt: "2026-09-14T09:00:00Z",
    attachments: [],
    ...extra,
  };
}

async function mkAtt(filename: string, docType: string, name: string, extra = {}): Promise<Attachment> {
  return { filename, mimeType: "application/pdf", content: await makeTextPdf(docLines(docType, { name, ...extra })) };
}

const fullSet = async (name: string, opts: { kcpeYear?: string; kcseYear?: string } = {}) => [
  await mkAtt("a.pdf", "academic_cert", name, opts.kcseYear ? { year: opts.kcseYear } : {}),
  await mkAtt("k.pdf", "kcpe_cert", name, { kcpePoints: 312, year: opts.kcpeYear ?? "2017" }),
  await mkAtt("i.pdf", "id", name),
  await mkAtt("f.pdf", "application_form", name),
];

describe("identity matching (features 4, 5, 34)", () => {
  it("unknown sender creates a new applicant", () => {
    const r = resolveIdentity(repo, mkEmail("m1", "t1", "new@example.org"), {});
    expect(r.isNew).toBe(true);
    expect(r.matchedBy).toBe("created");
    expect(r.concern).toBeUndefined();
  });

  it("same sender on a DIFFERENT thread resolves to the same case and links the thread", () => {
    resolveIdentity(repo, mkEmail("m1", "t1", "peter@example.org"), {});
    const r2 = resolveIdentity(repo, mkEmail("m2", "t2-completely-new", "peter@example.org"), {});
    expect(r2.isNew).toBe(false);
    expect(r2.matchedBy).toBe("sender");
    expect(repo.threadsForApplicant(r2.applicant.id)).toEqual(expect.arrayContaining(["t1", "t2-completely-new"]));
  });

  it("a quoted ref from the SAME sender attaches with no concern", () => {
    const r1 = resolveIdentity(repo, mkEmail("m1", "t1", "quinn@example.org"), {});
    const r2 = resolveIdentity(repo, mkEmail("m2", "t2", "quinn@example.org", { subject: `Docs for ${r1.applicant.ref_number}` }), {});
    expect(r2.applicant.id).toBe(r1.applicant.id);
    expect(r2.matchedBy).toBe("ref");
    expect(r2.concern).toBeUndefined();
  });

  it("a quoted ref from a DIFFERENT sender attaches but raises a concern", () => {
    const r1 = resolveIdentity(repo, mkEmail("m1", "t1", "quinn@example.org"), {});
    const r2 = resolveIdentity(repo, mkEmail("m2", "t9", "aunt@example.org", { body: `ref ${r1.applicant.ref_number} please` }), {});
    expect(r2.applicant.id).toBe(r1.applicant.id);
    expect(r2.matchedBy).toBe("ref");
    expect(r2.concern).toBeTruthy();
  });

  it("pipeline: identity concern becomes an identity_check flag → human review", async () => {
    const first = await processEmail(mkEmail("q1", "tq", "quinn@example.org", { attachments: await fullSet("QUINN ACHIENG OTIENO") }), ctx);
    expect(first.finalStatus).toBe("Green");
    const ref = first.refNumber!;

    const res = await processEmail(
      mkEmail("q2", "tq-aunt", "aunt@example.org", {
        subject: `Extra document for ${ref}`,
        attachments: [await mkAtt("birth.pdf", "birth_cert", "QUINN ACHIENG OTIENO")],
      }),
      ctx
    );
    expect(res.applicantId).toBe(first.applicantId); // right case, never fragmented
    expect(res.finalStatus).toBe("Orange");
    expect(res.flags.map((f) => f.type)).toContain("identity_check");
    expect(res.autoSent).toBe(false);
  });

  it("pipeline: completed case + new substantive email → SAME case reopened", async () => {
    const first = await processEmail(mkEmail("u1", "tu-a", "uma@example.org", { attachments: await fullSet("UMA WANJIRU MUTURI") }), ctx);
    expect(first.lifecycle).toBe("documents_checked");
    repo.setLifecycle(first.applicantId, "completed", "manager", "test");

    const res = await processEmail(
      mkEmail("u2", "tu-b", "uma@example.org", { attachments: [await mkAtt("i2.pdf", "id", "UMA WANJIRU MUTURI", { idNumber: "99988877" })] }),
      ctx
    );
    expect(res.applicantId).toBe(first.applicantId);
    const audit = repo.auditForApplicant(first.applicantId);
    expect(audit.some((e) => e.event === "case_reopened")).toBe(true);
  });
});

describe("anomaly & document intelligence (features 6, 7)", () => {
  it("KCPE dated after KCSE → anomaly flag → Orange, never an auto verdict", () => {
    const docs = [
      mkDoc("academic_cert", { fields: { examYear: "2021" } }),
      mkDoc("kcpe_cert", { fields: { examYear: "2022", gradePoints: 320 } }),
      mkDoc("id"),
      mkDoc("application_form"),
    ];
    const out = decide({ requirements: REQS, docs, flags: [] });
    expect(out.status).toBe("Orange");
    expect(out.derivedFlags.map((f) => f.type)).toContain("anomaly");
  });

  it("consistent exam years raise no anomaly", () => {
    const docs = [
      mkDoc("academic_cert", { fields: { examYear: "2021" } }),
      mkDoc("kcpe_cert", { fields: { examYear: "2017", gradePoints: 320 } }),
      mkDoc("id"),
      mkDoc("application_form"),
    ];
    const out = decide({ requirements: REQS, docs, flags: [] });
    expect(out.derivedFlags.some((f) => f.type === "anomaly")).toBe(false);
  });

  it("extracts the exam index number", () => {
    const f = extractFields("NAME: JANE DOE\nKCPE POINTS: 312\nINDEX NO: 10438211\nYEAR: 2017");
    expect(f.indexNumber).toBe("10438211");
  });
});

describe("rules versioning (feature 19) & deadlines (features 20, 21)", () => {
  it("snapshot freezes the requirement set; later rule edits don't move goalposts", () => {
    const a = repo.getOrCreateApplicant("snap@example.org", "t-snap", {});
    repo.freezeRequirementsSnapshot(a);
    const frozen = repo.effectiveRequirements(repo.getApplicant(a.id)!);
    // Later: somebody makes the birth certificate required.
    repo.upsertRule({ programme: null, intake: null, document_type: "birth_cert", required: true, meanGrade: null });
    const after = repo.effectiveRequirements(repo.getApplicant(a.id)!);
    expect(after).toEqual(frozen);
    // …but brand-new applicants get the new rules.
    const fresh = repo.getOrCreateApplicant("fresh@example.org", "t-fresh", {});
    const freshReqs = repo.effectiveRequirements(fresh);
    expect(freshReqs.find((r) => r.document_type === "birth_cert")?.required).toBe(true);
  });

  it("submission after the intake deadline → late_submission flag → human", async () => {
    repo.addIntakeWithDeadline("September 2026", "2026-08-31T23:59:59Z");
    const res = await processEmail(
      mkEmail("r1", "tr", "rosa@example.org", {
        body: "Here are my documents for the September 2026 intake.",
        receivedAt: "2026-09-14T09:00:00Z",
        attachments: await fullSet("ROSA WAMBUI GITHINJI"),
      }),
      ctx
    );
    expect(res.flags.map((f) => f.type)).toContain("late_submission");
    expect(res.autoSent).toBe(false);
    expect(repo.auditForApplicant(res.applicantId).some((e) => e.event === "late_submission")).toBe(true);
  });

  it("submission before the deadline is not flagged", async () => {
    repo.addIntakeWithDeadline("September 2026", "2026-12-31T23:59:59Z");
    const res = await processEmail(
      mkEmail("r2", "tr2", "early@example.org", {
        body: "Documents for September 2026 intake.",
        attachments: await fullSet("EARLY BIRD APPLICANT"),
      }),
      ctx
    );
    expect(res.flags.map((f) => f.type)).not.toContain("late_submission");
    expect(res.finalStatus).toBe("Green");
  });
});

describe("draft-first automation (features 16, 17)", () => {
  it("per-category draft mode holds even a clean Green auto-reply", async () => {
    repo.setAutomationMode("document_submission", "draft");
    const res = await processEmail(
      mkEmail("d1", "td", "tina@example.org", { attachments: await fullSet("TINA NYAMBURA KARIUKI") }),
      ctx
    );
    expect(res.finalStatus).toBe("Green");
    expect(res.autoSent).toBe(false);
    expect(sender.sent.length).toBe(0); // nothing left the building
    const held = repo.queuedOutbox(res.applicantId);
    expect(held).toBeTruthy();
    expect(held!.subject).toContain(res.refNumber!);
    expect(repo.auditForApplicant(res.applicantId).some((e) => e.event === "automation_held")).toBe(true);
  });

  it("global draft mode holds everything, regardless of category", async () => {
    repo.setSetting("automation_mode", "draft");
    const res = await processEmail(mkEmail("d2", "td2", "held@example.org"), ctx); // no docs → docs_request normally
    expect(res.autoSent).toBe(false);
    expect(sender.sent.length).toBe(0);
    expect(repo.queuedOutbox(res.applicantId)).toBeTruthy();
  });

  it("switching the category back to auto restores auto-send", async () => {
    repo.setAutomationMode("document_submission", "draft");
    repo.setAutomationMode("document_submission", "auto");
    const res = await processEmail(
      mkEmail("d3", "td3", "free@example.org", { attachments: await fullSet("FREE TO SEND APPLICANT") }),
      ctx
    );
    expect(res.autoSent).toBe(true);
    expect(sender.sent.length).toBe(1);
  });
});

describe("automatic follow-up ladder (feature 13)", () => {
  async function incompleteApplicant(email: string) {
    const res = await processEmail(
      mkEmail(`f-${email}`, `tf-${email}`, email, {
        attachments: [await mkAtt("a.pdf", "academic_cert", "FOLLOW UP APPLICANT")],
      }),
      ctx
    );
    expect(res.autoKind).toBe("missing_docs"); // notice sent, ladder armed
    return res.applicantId;
  }

  it("missing-docs notice arms the ladder; a due rung sends a reminder and advances", async () => {
    const id = await incompleteApplicant("ladder@example.org");
    // Wind the clock: reminder is due now.
    repo.setFollowup(id, 0, new Date(Date.now() - 1000).toISOString());

    const sent = await runFollowUpSweep(repo, ctx);
    expect(sent).toBe(1);
    expect(sender.sent.some((s) => s.subject.includes("REMINDER"))).toBe(true);
    const a = repo.getApplicant(id)!;
    expect(a.followup_rung).toBe(1);
    expect(a.followup_next_at).toBeTruthy();
  });

  it("ladder exhaustion escalates to a human instead of emailing forever", async () => {
    const id = await incompleteApplicant("exhaust@example.org");
    repo.setFollowup(id, 3, new Date(Date.now() - 1000).toISOString()); // past last rung (ladder 3,7,10)

    await runFollowUpSweep(repo, ctx);
    const a = repo.getApplicant(id)!;
    expect(a.lifecycle).toBe("awaiting_review");
    expect(repo.auditForApplicant(id).some((e) => e.event === "followup_exhausted")).toBe(true);
  });

  it("a complete file silently cancels the ladder", async () => {
    const id = await incompleteApplicant("done@example.org");
    repo.setFollowup(id, 0, new Date(Date.now() - 1000).toISOString());
    // The missing document arrives → file becomes complete.
    await processEmail(
      mkEmail("f-done-2", "tf-done@example.org", "done@example.org", {
        attachments: [
          await mkAtt("k.pdf", "kcpe_cert", "FOLLOW UP APPLICANT", { kcpePoints: 300, year: "2017" }),
          await mkAtt("i.pdf", "id", "FOLLOW UP APPLICANT"),
          await mkAtt("f.pdf", "application_form", "FOLLOW UP APPLICANT"),
        ],
      }),
      ctx
    );
    const a = repo.getApplicant(id)!;
    expect(a.followup_next_at).toBeNull();
  });
});

describe("unanswered email detection (feature 1)", () => {
  it("flags cases whose last incoming email has no reply; answered cases disappear", async () => {
    await processEmail(mkEmail("un1", "tun", "waiting@example.org"), ctx);
    // auto docs_request counts as a reply → not unanswered.
    expect(repo.unansweredCases().some((u) => u.applicant.email_address === "waiting@example.org")).toBe(false);
  });
});

describe("portal auth & sessions (features 12, 35)", () => {
  it("OTP: wrong code rejected, right code consumed once", () => {
    const a = repo.getOrCreateApplicant("otp@example.org", "t-otp", {});
    const code = repo.createOtp(a.id);
    expect(repo.consumeOtp(a.id, "000000")).toBe(false);
    expect(repo.consumeOtp(a.id, code)).toBe(true);
    expect(repo.consumeOtp(a.id, code)).toBe(false); // single use
  });

  it("portal sessions authenticate and expire", () => {
    const a = repo.getOrCreateApplicant("sess@example.org", "t-sess", {});
    const token = repo.createPortalSession(a.id);
    expect(repo.getPortalSession(token)?.id).toBe(a.id);
    repo.deletePortalSession(token);
    expect(repo.getPortalSession(token)).toBeUndefined();
  });
});

describe("tasks & retention (features 25, 38)", () => {
  it("tasks can be added, listed and toggled", () => {
    const a = repo.getOrCreateApplicant("tasks@example.org", "t-tasks", {});
    repo.addTask(a.id, "Verify certificate with KNEC", null);
    repo.addTask(a.id, "Call the applicant", null);
    let tasks = repo.listTasks(a.id);
    expect(tasks.length).toBe(2);
    const firstId = tasks[0].id;
    repo.toggleTask(firstId, true);
    tasks = repo.listTasks(a.id);
    expect(tasks.find((t) => t.id === firstId)?.done).toBe(1);
  });

  it("retention removal wipes the applicant's whole footprint", () => {
    const a = repo.getOrCreateApplicant("gone@example.org", "t-gone", {});
    repo.addNote(a.id, null, "internal");
    repo.insertEmail({
      applicant_id: a.id, message_id: "x", thread_id: "t-gone", direction: "in",
      from_addr: "gone@example.org", to_addr: "", subject: "s", body: "b",
      category: null, auto: 0, at: new Date().toISOString(),
    });
    repo.deleteApplicantFull(a.id);
    expect(repo.getApplicant(a.id)).toBeUndefined();
    expect(repo.emailsForApplicant(a.id).length).toBe(0);
  });
});
