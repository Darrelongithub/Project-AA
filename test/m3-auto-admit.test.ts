/**
 * M-3 — the auto-admission path is LIVE again, and it is strictly opt-in.
 *
 * History: the migrated Riara (education) profile auto-admitted a fully
 * qualified, clean, Green file and sent the admission letter; a registrar
 * could always reverse it through the ordinary not_admitted path. A later
 * refactor left `routing = "auto_admit"` unreachable — the admission path was
 * dead code while the vocabulary (and the reversal UI) still existed.
 *
 * This suite pins both halves of the contract at once:
 *   (a) a fully qualifying, watcher-clean, non-draft education case reaches
 *       admission_decision = "auto_admitted" AND the admission letter goes out;
 *   (b) a registrar can reverse it (not_admitted, route "human", audited);
 *   (c) organizations WITHOUT the opt-in (new profiles: draft reply action,
 *       auto_admit = 0) never auto-admit anything — no letter, undecided.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { createApp } from "../src/web/server";
import { hashPassword } from "../src/util/password";
import { webLogin } from "./helpers";
import { processEmail } from "../src/pipeline";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";
import { makeTextPdf, docLines } from "../src/simulation/pdfFactory";
import type { IncomingEmail } from "../src/types";

const NAME = "ALICE WANJIKU KAMAU";

let repo: Repo;
let sender: MockSender;
let ctx: PipelineContext;
let server: Server;
let base = "";
let auth: { cookie: string; csrf: string };

/** The six-document qualifying set (identical to the probe / e2e clean set). */
async function cleanSet(): Promise<IncomingEmail["attachments"]> {
  const mk = async (filename: string, docType: string) => ({
    filename,
    mimeType: "application/pdf",
    content: await makeTextPdf(docLines(docType, { name: NAME })),
  });
  return [
    await mk("a.pdf", "academic_cert"),
    await mk("l.pdf", "leaving_certificate"),
    await mk("p.pdf", "passport_photo"),
    await mk("b.pdf", "birth_cert"),
    await mk("i.pdf", "id"),
    await mk("f.pdf", "application_form"),
  ];
}

function mail(over: Partial<IncomingEmail> & { id: string; from: string }): IncomingEmail {
  return {
    threadId: over.id,
    subject: "Application documents",
    body: "Please find attached.",
    receivedAt: "2026-09-14T09:00:00Z",
    ...over,
  } as IncomingEmail;
}

beforeAll(async () => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  // The migrated Riara profile requires KCPE at B- (same as ppr-workflow-rules).
  repo.upsertRule({ programme: null, intake: null, document_type: "kcpe_cert", required: true, meanGrade: "B-" } as never);
  repo.createStaff("admin", "Administrator", hashPassword("admin123"), "admin");

  sender = new MockSender();
  ctx = { repo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender } };

  const app = createApp({ repo, ctx });
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const login = await webLogin(base, "admin", "admin123");
  auth = { cookie: login.cookie, csrf: login.csrf };
  expect(login.status).toBe(302);
});

afterAll(() => {
  server?.close();
});

describe("M-3: auto-admission on the migrated education profile", () => {
  let autoAdmittedId = 0;

  it("a qualifying clean-Green case auto-admits and the admission LETTER is sent", async () => {
    const res = await processEmail(
      mail({ id: "m3-auto-1", from: "alice@example.org", attachments: await cleanSet() }),
      ctx
    );
    expect(res.skipped).not.toBe(true);
    autoAdmittedId = res.applicantId!;

    // The pipeline completed by ADMITTING, not by parking the case.
    expect(res.finalStatus).toBe("Green");
    expect(res.lifecycle).toBe("completed");
    expect(res.missing).toEqual([]);

    // The evaluation records the automated admission and why.
    const ev = repo.latestEvaluation(autoAdmittedId)!;
    expect(ev.result).toBe("passed");
    expect(ev.routing).toBe("auto_admit");

    // The case carries the automated decision plus the route that took it.
    const a = repo.getApplicant(autoAdmittedId)!;
    expect(a.routing).toBe("auto_admit");
    expect(a.routing_reason).toBe("qualified_auto_admit");
    expect(a.req_result).toBe("passed");
    expect(a.admission_decision).toBe("auto_admitted");
    expect(a.admission_route).toBe("auto");
    expect(a.decision_by).toBeNull(); // nobody human decided
    expect(a.decision_at).toBeTruthy();

    // The admission letter — not just an acknowledgement — left the building.
    const letter = sender.sent.find((s) => /Welcome to/i.test(s.subject));
    expect(letter).toBeTruthy();
    expect(letter!.subject).toMatch(/Welcome to .* — Your Admission to /);

    // Audit trail: qualified → triggered, both automated, both discoverable.
    const events = repo.auditForApplicant(autoAdmittedId).map((e) => e.event);
    expect(events).toContain("admission_auto_qualified");
    expect(events).toContain("auto_admission_triggered");
  });

  it("a registrar can REVERSE the auto-admission through the not_admitted path", async () => {
    const res = await fetch(`${base}/case/${autoAdmittedId}/admission-decision`, {
      method: "POST",
      headers: { cookie: auth.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${auth.csrf}&decision=decline&reason=${encodeURIComponent(
        "Certificate verification failed on the original documents — provisional admission withdrawn."
      )}`,
      redirect: "manual",
    });
    expect(res.status).toBe(302);

    const a = repo.getApplicant(autoAdmittedId)!;
    expect(a.admission_decision).toBe("not_admitted");
    expect(a.admission_route).toBe("human"); // the reversal is a HUMAN act
    expect(a.decision_by).toBe("admin");

    const audit = repo.auditForApplicant(autoAdmittedId);
    expect(audit.some((x) => x.event === "human_admission_decision" && x.detail.includes("Not Admitted"))).toBe(true);
    // The automated decision is history: reversal does not erase it.
    expect(audit.some((x) => x.event === "auto_admission_triggered")).toBe(true);
  });

  it("the case page offers the reversal form for an auto-decided case", async () => {
    // Back to a fresh auto-admitted case so the form (which only renders while
    // the decision stands) is exercised.
    const res = await processEmail(
      mail({ id: "m3-auto-2", from: "bella@example.org", attachments: await cleanSet() }),
      ctx
    );
    const id = res.applicantId!;
    expect(repo.getApplicant(id)!.admission_decision).toBe("auto_admitted");

    const page = await (await fetch(`${base}/case/${id}`, { headers: { cookie: auth.cookie } })).text();
    expect(page).toContain(`action="/case/${id}/admission-decision"`);
    expect(page).toContain('value="decline"');
    expect(page).toMatch(/Registrar review|reverse/i);
  });
});

describe("M-3 safety: organizations without the opt-in never auto-admit", () => {
  it("a brand-new organization's default profile (draft, auto_admit off) leaves the decision undecided", async () => {
    const org = repo.createOrganization({ name: "Northwind Support", refPrefix: "NS" });
    const ct = repo.createCaseType(org.id, { code: "SUPPORT", name: "Support enquiry", category: "general" });
    expect(ct.auto_admit).toBe(0); // new profiles: auto-admit OFF
    expect(ct.default_reply_action).toBe("draft");

    const before = sender.sent.length;
    const res = await processEmail(
      mail({
        id: "m3-org2-1",
        from: "customer@example.test",
        subject: "Support enquiry — account access",
        body: "Please help with my account access.",
        organizationId: org.id,
        caseTypeCode: "SUPPORT",
        attachments: await cleanSet(),
      }),
      ctx
    );
    expect(res.skipped).not.toBe(true);

    const a = repo.getApplicant(res.applicantId!)!;
    expect(a.organization_id).toBe(org.id);
    expect(a.admission_decision ?? "undecided").toBe("undecided");
    expect(repo.auditForApplicant(a.id).some((e) => e.event === "auto_admission_triggered")).toBe(false);
    expect(res.lifecycle).not.toBe("completed");
    // Nothing resembling a decision letter went out on this profile.
    expect(sender.sent.slice(before).some((s) => /Welcome to/i.test(s.subject))).toBe(false);
  });

  it("the same education profile on another organization, with auto_admit OFF, stays human_review", async () => {
    const org = repo.createOrganization({ name: "Rift Valley College", refPrefix: "RV" });
    const ct = repo.createCaseType(org.id, {
      code: "BCS-RV",
      name: "BSc Computer Science",
      category: "degree",
      educationModule: true,
      qualificationGate: true,
      defaultReplyAction: "send",
      autoAdmit: false, // the recipient of the old dead-code refactor: opt-in absent
    });
    expect(ct.auto_admit).toBe(0);

    const before = sender.sent.length;
    const res = await processEmail(
      mail({
        id: "m3-org2-2",
        from: "carol@example.test",
        organizationId: org.id,
        caseTypeCode: "BCS-RV",
        attachments: await cleanSet(),
      }),
      ctx
    );
    expect(res.skipped).not.toBe(true);

    const a = repo.getApplicant(res.applicantId!)!;
    expect(a.admission_decision ?? "undecided").toBe("undecided");
    expect(a.routing === "auto_admit").toBe(false);
    expect(repo.auditForApplicant(a.id).some((e) => e.event === "auto_admission_triggered")).toBe(false);
    expect(sender.sent.slice(before).some((s) => /Welcome to/i.test(s.subject))).toBe(false);
  });
});
