/**
 * v3 feature tests: identity matching & conversation reconstruction, anomaly
 * rules, requirement snapshots, intake deadlines, draft-first automation,
 * follow-up ladder, reopen, unanswered detection,
 * tasks, retention, and decision-replay inputs.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";
import { processEmail } from "../src/pipeline";
import { resolveIdentity } from "../src/matching/identity";
import { runFollowUpSweep } from "../src/followups";
import { decide } from "../src/rules";
import { extractFields } from "../src/extraction/fields";
import {makeTextPdf } from "../src/simulation/pdfFactory";
import type { Attachment, IncomingEmail } from "../src/types";
import { REQS, mkDoc, configureTestOrganization, docLines, releaseAutomation } from "./helpers";
import { mustProcessed } from "./harness";

let repo: Repo;
let sender: MockSender;
let ctx: PipelineContext;

beforeEach(() => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  configureTestOrganization(repo);
  sender = new MockSender(true);
  ctx = { repo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender } };
});

function mkEmail(id: string, threadId: string, from: string, extra: Partial<IncomingEmail> = {}): IncomingEmail {
  return {
    id, threadId, from,
    subject: "Service request",
    body: "Please find the attached request.",
    receivedAt: "2026-09-14T09:00:00Z",
    organizationId: 1,
    caseTypeCode: "SERVICE_REQUEST",
    attachments: [],
    ...extra,
  };
}

async function mkAtt(filename: string, docType: string, name: string, extra = {}): Promise<Attachment> {
  return { filename, mimeType: "application/pdf", content: await makeTextPdf(docLines(docType, { name, ...extra })) };
}

/** Every blocking slot of the configured checklist, plus the optional note. */
const fullSet = async (name: string) => [
  await mkAtt("request.pdf", "request_form", name, { consent: "yes" }),
  await mkAtt("id.pdf", "id", name),
  await mkAtt("note.pdf", "supporting_document", name),
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
    const first = mustProcessed(await processEmail(mkEmail("q1", "tq", "quinn@example.org", { attachments: await fullSet("QUINN ACHIENG OTIENO") }), ctx));
    expect(first.finalStatus).toBe("Green");
    const ref = first.refNumber!;

    const res = mustProcessed(await processEmail(
      mkEmail("q2", "tq-aunt", "aunt@example.org", {
        subject: `Extra document for ${ref}`,
        attachments: [await mkAtt("birth.pdf", "birth_cert", "QUINN ACHIENG OTIENO")],
      }),
      ctx
    ));
    expect(res.applicantId).toBe(first.applicantId); // right case, never fragmented
    expect(res.finalStatus).toBe("Orange");
    expect(res.flags.map((f) => f.type)).toContain("identity_check");
    expect(res.autoSent).toBe(false);
  });

  it("pipeline: completed case + new substantive email reopens the SAME case", async () => {
    const first = mustProcessed(await processEmail(mkEmail("u1", "tu-a", "uma@example.test", { attachments: await fullSet("UMA MUTURI") }), ctx));
    // Outcomes are human acts: close the case the way an officer would, then
    // prove new evidence reopens THAT case rather than fragmenting a second.
    repo.recordHumanOutcome(first.applicantId, {
      outcome: "approved_after_review",
      actor: "officer",
      reason: "closed after review",
    });
    expect(repo.getCase(first.applicantId)!.lifecycle).toBe("completed");

    const res = mustProcessed(await processEmail(
      mkEmail("u2", "tu-b", "uma@example.test", { attachments: [await mkAtt("i2.pdf", "id", "UMA MUTURI", { idNumber: "99988877" })] }),
      ctx
    ));
    expect(res.applicantId).toBe(first.applicantId);
    expect(repo.getCase(first.applicantId)!.lifecycle).not.toBe("completed");
    expect(repo.auditForApplicant(first.applicantId).some((entry) => entry.event === "case_reopened")).toBe(true);
    // Reopening never erases the recorded outcome.
    expect(repo.getCase(first.applicantId)!.outcome).toBe("approved_after_review");
  });
});

describe("cross-document intelligence (features 6, 7)", () => {
  it("contradicting dates of birth raise an identity concern, never an auto verdict", () => {
    const docs = [
      mkDoc("request_form", { fields: { name: "ALEX MORGAN", dateOfBirth: "1995-02-14" } }),
      mkDoc("id", { fields: { name: "ALEX MORGAN", dateOfBirth: "1990-11-03" } }),
    ];
    const out = decide({ requirements: REQS, docs, flags: [{ type: "identity_check", detail: "date of birth differs between documents" }] });
    expect(out.status).toBe("Orange");
    expect(out.reasoning).toContain("date of birth differs between documents");
    expect(out.reasoning).toContain("[identity_check]");
  });

  it("consistent documents raise no identity flag", () => {
    const docs = [
      mkDoc("request_form", { fields: { name: "ALEX MORGAN", dateOfBirth: "1995-02-14" } }),
      mkDoc("id", { fields: { name: "ALEX MORGAN", dateOfBirth: "14/02/1995" } }),
    ];
    const out = decide({ requirements: REQS, docs, flags: [] });
    expect(out.derivedFlags.some((flag) => flag.type === "identity_check")).toBe(false);
    expect(out.status).toBe("Green");
  });

  it("extracts the configured scalar facts and the identity number", () => {
    const fields = extractFields("NAME: ALEX MORGAN\nCONSENT: YES\nID NUMBER: 10438211\nDATE OF BIRTH: 14/02/1995");
    expect(fields.name).toBe("ALEX MORGAN");
    expect(fields.consent).toBe("yes");
    expect(fields.idNumber).toBe("10438211");
    expect(fields.dateOfBirth).toContain("1995");
  });

  it("never reads a prototype-polluting key as a fact", () => {
    const fields = extractFields("__proto__: polluted\nconstructor: evil\nregion: north");
    expect(fields.region).toBe("north");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(fields)).not.toContain("__proto__");
  });
});

describe("rules versioning (feature 19) & deadlines (features 20, 21)", () => {
  it("snapshot freezes the requirement set; later configuration edits do not move goalposts", () => {
    const a = repo.createCase({ emailAddress: "snap@example.test", threadId: "t-snap", organizationId: 1, caseTypeCode: "SERVICE_REQUEST" });
    repo.freezeRequirementsSnapshot(a);
    const frozen = repo.effectiveRequirements(repo.getCase(a.id)!);
    // Later: somebody adds a blocking slot to the checklist.
    const type = repo.getCaseType("SERVICE_REQUEST", 1)!;
    repo.upsertDocumentDefinition(type.id, { key: "site_survey", label: "Site survey", required: true, blocking: true });
    expect(repo.effectiveRequirements(repo.getCase(a.id)!)).toEqual(frozen);
    // Brand-new cases get the current configuration.
    const fresh = repo.createCase({ emailAddress: "fresh@example.test", threadId: "t-fresh", organizationId: 1, caseTypeCode: "SERVICE_REQUEST" });
    expect(repo.effectiveRequirements(fresh).map((row) => row.document_type)).toContain("site_survey");
  });

  it("a submission after the window deadline → late_submission flag → human", async () => {
    repo.addIntakeWithDeadline("September 2026", "2026-08-31T23:59:59Z");
    const res = mustProcessed(await processEmail(
      mkEmail("r1", "tr", "rosa@example.org", {
        body: "Here are my documents for the September 2026 intake.",
        receivedAt: "2026-09-14T09:00:00Z",
        attachments: await fullSet("ROSA WAMBUI"),
      }),
      ctx
    ));
    expect(res.flags.map((f) => f.type)).toContain("late_submission");
    expect(res.autoSent).toBe(false);
    expect(repo.auditForApplicant(res.applicantId).some((e) => e.event === "late_submission")).toBe(true);
  });

  it("submission before the deadline is not flagged", async () => {
    repo.addIntakeWithDeadline("September 2026", "2026-12-31T23:59:59Z");
    const res = mustProcessed(await processEmail(
      mkEmail("r2", "tr2", "early@example.org", {
        body: "Documents for September 2026 intake.",
        attachments: await fullSet("EARLY BIRD CONTACT"),
      }),
      ctx
    ));
    expect(res.flags.map((f) => f.type)).not.toContain("late_submission");
    expect(res.finalStatus).toBe("Green");
  });
});

describe("draft-first automation (features 16, 17)", () => {
  it("per-category draft mode holds even a clean Green auto-reply", async () => {
    repo.setAutomationMode("document_submission", "draft");
    const res = mustProcessed(await processEmail(
      mkEmail("d1", "td", "tina@example.org", { attachments: await fullSet("TINA NYAMBURA") }),
      ctx
    ));
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
    const res = mustProcessed(await processEmail(mkEmail("d2", "td2", "held@example.org"), ctx)); // no docs → docs_request normally
    expect(res.autoSent).toBe(false);
    expect(sender.sent.length).toBe(0);
    expect(repo.queuedOutbox(res.applicantId)).toBeTruthy();
  });

  it("a configured rule outranks the per-category automation mode", async () => {
    // The stored rule says "draft": flipping the category to auto must not make
    // the machine speak — the tenant's own configuration wins.
    repo.setAutomationMode("document_submission", "auto");
    const held = mustProcessed(await processEmail(
      mkEmail("d3", "td3", "free@example.org", { attachments: await fullSet("FREE TO SEND CONTACT") }),
      ctx
    ));
    expect(held.autoSent).toBe(false);
    expect(repo.queuedOutbox(held.applicantId)).toBeTruthy();
  });

  it("send is only automatic once every gate is opened", async () => {
    // Three independent gates: the rule's reply_action, the global automation
    // mode and the case type's evidence gate. All three must allow a send.
    const type = repo.getCaseType("SERVICE_REQUEST", 1)!;
    const rule = repo.listWorkflowRules(1, { kind: "response" }).find((r) => r.name === "Prepare a factual status draft")!;
    repo.saveWorkflowRule({
      organizationId: 1, caseTypeId: type.id, kind: "response", name: rule.name, position: rule.position,
      conditions: rule.conditions, action: { ...rule.action, reply_action: "send" },
    });
    // Gate 1: the case type opts into automation. Gate 2: its evidence gate is
    // off, so the rules own the send decision. Gate 3: the rule says "send".
    // Gate 4: no global or per-category draft mode.
    repo.updateCaseTypeProfile(type.id, { default_reply_action: "auto", evidence_gate: 0 });
    releaseAutomation(repo);
    repo.setAutomationMode("document_submission", "auto");
    const sent = mustProcessed(await processEmail(
      mkEmail("d4", "td4", "free2@example.org", { attachments: await fullSet("FREE TO SEND CONTACT TWO") }),
      ctx
    ));
    expect(sent.autoSent).toBe(true);
    expect(sender.sent.length).toBe(1);
  });
});

describe("automatic follow-up ladder (feature 13)", () => {
  // This tenant chases incomplete files: a response rule matched on the
  // document posture prepares the chase. Without it the ladder has nothing to
  // arm, which is the correct behaviour for a silent tenant.
  beforeEach(() => {
    const type = repo.getCaseType("SERVICE_REQUEST", 1)!;
    repo.saveWorkflowRule({
      organizationId: 1, caseTypeId: type.id, kind: "response", name: "Chase the missing document", position: 0,
      conditions: [{ field: "docs_state", values: ["empty", "missing"] }],
      action: { reply_action: "draft", template_key: "missing_documents", followup: "ladder", followup_action: "draft", audit_code: "fixture_chase" },
    });
    // The catch-all status rule stays, but behind the chase.
    const status = repo.listWorkflowRules(1, { kind: "response" }).find((r) => r.name === "Prepare a factual status draft")!;
    repo.saveWorkflowRule({
      organizationId: 1, caseTypeId: type.id, kind: "response", name: status.name, position: 5,
      conditions: status.conditions, action: status.action,
    });
  });

  async function incompleteCase(email: string) {
    const res = mustProcessed(await processEmail(
      mkEmail(`f-${email}`, `tf-${email}`, email, {
        // The request form arrives, the identity document does not: the
        // checklist is incomplete, so a chase is prepared and the ladder arms.
        attachments: [await mkAtt("request.pdf", "request_form", "FOLLOW UP CONTACT", { consent: "yes" })],
      }),
      ctx
    ));
    expect(res.autoKind).toBe("missing_docs"); // suggestion held for staff, ladder armed
    return res.applicantId;
  }

  it("missing-docs notice arms the ladder; a due rung HOLDS a reminder suggestion and advances", async () => {
    const id = await incompleteCase("ladder@example.org");
    // Wind the clock: reminder is due now.
    repo.setFollowup(id, 0, new Date(Date.now() - 1000).toISOString());

    const processed = await runFollowUpSweep(repo, ctx);
    expect(processed).toBe(1);
    expect(sender.sent.length).toBe(0); // evidence gate: never auto-sent
    const held = repo.queuedOutbox(id);
    expect(held?.subject).toContain("REMINDER");
    const a = repo.getApplicant(id)!;
    expect(a.followup_rung).toBe(1);
    expect(a.followup_next_at).toBeTruthy();
    expect(repo.auditForApplicant(id).some((e) => e.event === "followup_drafted")).toBe(true);
  });

  it("ladder exhaustion escalates to a human instead of emailing forever", async () => {
    const id = await incompleteCase("exhaust@example.org");
    repo.setFollowup(id, 3, new Date(Date.now() - 1000).toISOString()); // past last rung (ladder 3,7,10)

    await runFollowUpSweep(repo, ctx);
    const a = repo.getApplicant(id)!;
    expect(a.lifecycle).toBe("awaiting_review");
    expect(repo.auditForApplicant(id).some((e) => e.event === "followup_exhausted")).toBe(true);
  });

  it("a complete file silently cancels the ladder", async () => {
    const id = await incompleteCase("done@example.org");
    repo.setFollowup(id, 0, new Date(Date.now() - 1000).toISOString());
    // The missing document arrives → file becomes complete.
    await processEmail(
      mkEmail("f-done-2", "tf-done@example.org", "done@example.org", {
        // Everything the configured checklist still asks for arrives.
        attachments: [
          await mkAtt("i.pdf", "id", "FOLLOW UP CONTACT"),
          await mkAtt("note.pdf", "supporting_document", "FOLLOW UP CONTACT"),
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
    // The docs-request suggestion is HELD (qualification gate) — until a human
    // sends something, the applicant genuinely has no reply yet.
    expect(repo.unansweredCases().some((u) => u.applicant.email_address === "waiting@example.org")).toBe(true);
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
