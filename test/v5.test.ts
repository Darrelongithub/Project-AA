/**
 * v5 features: stage levels, gauge counts, course routing, compose flow,
 * grade-based requirements, admissions page, Gemini settings slot.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { hashPassword } from "../src/util/password";
import { DEFAULT_REQUIREMENTS } from "../src/config";
import { deriveFlags, gradeBelow, parseGradeRule } from "../src/rules";
import { createApp } from "../src/web/server";
import type { ApplicantRow, DocumentRecord } from "../src/types";

let repo: Repo;

beforeEach(() => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  // OR-1: no seeded accounts — provision the admin like first-run setup does.
  repo.createStaff("admin", "System Administrator", hashPassword("admin123"), "admin");
  repo.seedBaseRequirements(DEFAULT_REQUIREMENTS);
});

function mkApplicant(opts: Partial<ApplicantRow> = {}): ApplicantRow {
  const a = repo.getOrCreateApplicant(opts.email_address ?? `v5-${Math.random().toString(36).slice(2)}@example.org`, `t-${Math.random()}`);
  repo.updateApplicant(a.id, opts);
  return repo.getApplicant(a.id)!;
}

const login = async (app: ReturnType<typeof createApp>, username = "admin", password = "admin123") => {
  const res = await fetch("http://test/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `username=${username}&password=${password}`,
    redirect: "manual",
  });
  const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  const page = await (await fetch("http://test/", { headers: { cookie } })).text();
  const csrf = /name="csrf" content="([^"]+)"/.exec(page)![1];
  return { cookie, csrf };
};

// createApp needs an express app to test against — build a minimal one.
import express from "express";
import type { PipelineContext } from "../src/pipeline/adapters";
import { MockSender } from "../src/pipeline/adapters";

function testApp(): { app: ReturnType<typeof createApp>; ctx: PipelineContext } {
  const sender = new MockSender();
  const ctx: PipelineContext = { repo, adapters: { vision: null as never, watcher: null as never, sender } };
  const app = createApp({ repo, ctx });
  return { app, ctx };
}

describe("grades, not points", () => {
  it("gradeBelow compares on the KCSE ladder strictly", () => {
    expect(gradeBelow("C+", "B-")).toBe(true);
    expect(gradeBelow("B", "B-")).toBe(false);
    expect(gradeBelow("A", "E")).toBe(false);
    expect(gradeBelow("D-", "D")).toBe(true);
    expect(gradeBelow(undefined, "A")).toBe(false); // unreadable never compares
  });

  it("parseGradeRule reads the published subject lines", () => {
    const parsed = parseGradeRule("B in English and Kiswahili; C+ in Mathematics");
    expect(parsed).toHaveLength(2);
    expect(parsed[0].grade).toBe("B");
    expect(parsed[0].subjects).toEqual(["English", "Kiswahili"]);
    expect(parsed[1].grade).toBe("C+");
    expect(parsed[1].subjects).toEqual(["Mathematics"]);
  });

  it("mean grade below the rule → grade_below_requirement; subject miss → low_confidence", () => {
    const doc = (fields: Record<string, unknown>): DocumentRecord[] => [
      {
        id: 1, applicant_id: 1, document_type: "academic_cert", source_email_id: "m1",
        extraction_method: "pdf_text", extracted_text: "x", extracted_fields: fields,
        confidence: "high", superseded_by: null, received_at: "2026-09-14T00:00:00Z",
      },
    ];
    const reqs = [{ document_type: "academic_cert" as const, required: true, meanGrade: "C+", subjectGrades: "C+ in English" }];
    const flags = deriveFlags(reqs, doc({ meanGrade: "C-", subjectGrades: { English: "B" } }));
    expect(flags.map((f) => f.type)).toContain("grade_below_requirement");
    const flags2 = deriveFlags(reqs, doc({ meanGrade: "A", subjectGrades: { Mathematics: "A" } }));
    expect(flags2.map((f) => f.type)).toContain("low_confidence"); // English unreadable
    const flags3 = deriveFlags(reqs, doc({ meanGrade: "A", subjectGrades: { English: "A" } }));
    expect(flags3).toEqual([]);
  });
});

describe("course routing", () => {
  it("a case for a course lands with that course's assigned officer", async () => {
    repo.createStaff("courseowner", "Course Owner", "x", "officer");
    const owner = repo.getStaffByUsername("courseowner")!.id;
    repo.assignProgrammeOwner("BCS", owner);
    const sender2 = new MockSender();
    const ctx: PipelineContext = {
      repo,
      adapters: { vision: null as never, watcher: null as never, sender: sender2 },
    };
    const { processEmail } = await import("../src/pipeline");
    const res = await processEmail(
      {
        id: "route-1", threadId: "t-route-1", from: "router@example.org",
        subject: "Application for BSc Computer Science",
        body: "I would like to apply for BCS in the September 2026 intake.",
        receivedAt: "2026-09-14T09:00:00Z", attachments: [],
      },
      ctx
    );
    const applicant = repo.getApplicant(res.applicantId)!;
    expect(applicant.programme).toBe("BCS");
    expect(applicant.assigned_to).toBe(owner);
    // the owner was notified
    const notes = repo.notificationsFor(owner);
    expect(notes.some((n) => n.kind === "assignment")).toBe(true);
  });
});

describe("stages & routing", () => {
  it("stageCounts buckets every applicant into exactly one level", () => {
    mkApplicant({ lifecycle: "application_received" });
    mkApplicant({ lifecycle: "documents_received" });
    mkApplicant({ lifecycle: "documents_checked" });
    mkApplicant({ lifecycle: "awaiting_review" });
    mkApplicant({ lifecycle: "verification" });
    mkApplicant({ lifecycle: "completed" });
    const c = repo.stageCounts();
    expect(c.total).toBe(6);
    expect(c.unfinished).toBe(3); // received + docs received + docs checked
    expect(c.pending).toBe(2); // awaiting review + verification
    expect(c.finished).toBe(1);
    expect(c.application_received).toBe(1);
    expect(c.completed).toBe(1);
  });

  it("approverFor names who completed a file", () => {
    const a = mkApplicant({});
    repo.setLifecycle(a.id, "completed", "jane", "approved by panel");
    const appr = repo.approverFor(a.id);
    expect(appr?.actor).toBe("jane");
    expect(appr?.at).toBeTruthy();
  });

  it("programme catalogue is editable and lookup-able", () => {
    expect(repo.programmeByCode("llb")?.name).toContain("Laws"); // case-insensitive
    expect(repo.programmeByCode("BNS")?.school).toBe("School of Nursing");
    repo.updateProgramme("BNS", { entry_requirements: "New NCK rules apply from 2027." });
    expect(repo.programmeByCode("BNS")?.entry_requirements).toContain("New NCK rules");
  });

  it("seeded structured entry requirements match the published set", () => {
    const blocks = (code: string) => repo.listSystemBlocks(code);
    // LLB: KCSE C+ with B in English or Kiswahili.
    const llb = blocks("LLB").find((b) => b.system === "KCSE");
    expect(llb?.overall).toBe("C+");
    expect(llb?.subjects?.some((r) => r.subject === "English" && r.grade === "B" && r.alts?.includes("Kiswahili"))).toBe(true);
    // BBA: C in English AND Mathematics.
    const bba = blocks("BBA").find((b) => b.system === "KCSE");
    expect(bba?.subjects?.some((r) => r.subject === "Mathematics" && r.grade === "C")).toBe(true);
    // Diploma floors override the university-wide C+ degree minimum.
    expect(blocks("DBM").find((b) => b.system === "KCSE")?.overall).toBe("C-");
    // DBM (2026 brochure): D plain in Mathematics — NOT the English-or-Maths
    // C- rule an earlier draft carried.
    const dbm = blocks("DBM").find((b) => b.system === "KCSE");
    expect(dbm?.subjects?.some((r) => r.subject === "Mathematics" && r.grade === "D")).toBe(true);
    expect(dbm?.subjects?.some((r) => r.subject === "English")).toBe(false);
    // DIR (2026 brochure): C in English only — no science subject.
    const dir = blocks("DIR").find((b) => b.system === "KCSE");
    expect(dir?.overall).toBe("C-");
    expect(dir?.subjects?.some((r) => r.subject === "English" && r.grade === "C")).toBe(true);
    expect(dir?.subjects?.some((r) => ["Biology", "Chemistry", "Physics"].includes(r.subject))).toBe(false);
    // Postgraduate routes check the degree class — no KCSE rule.
    expect(blocks("MBA").find((b) => b.system === "DEGREE")?.minClass).toContain("Upper Division");
    // Nursing specifics were not in the published details → no invented
    // subject clusters; the programme falls back to the university-wide floor.
    expect(blocks("BNS").length).toBe(0);
  });
});

describe("web: admissions, compose, gemini slot", () => {
  let app: ReturnType<typeof createApp>;
  let server: ReturnType<typeof app.listen> | undefined;
  let base = "";
  let auth: { cookie: string; csrf: string };

  const start = async () => {
    ({ app } = testApp());
    server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    base = `http://127.0.0.1:${port}`;
    auth = await loginWith(base);
  };

  beforeEach(async () => {
    await start();
  });

  afterEach(async () => {
    server?.close();
  });

  it("admissions page splits the pipeline by level with counts", async () => {
    const a = mkApplicant({ lifecycle: "awaiting_review" });
    const page = await (await fetch(`${base}/admissions`, { headers: { cookie: auth.cookie } })).text();
    expect(page).toContain("Admissions");
    expect(page).toContain("Application received");
    expect(page).toContain("Awaiting review");
    expect(page).toContain(a.ref_number);
    const filtered = await (await fetch(`${base}/admissions?stage=awaiting_review`, { headers: { cookie: auth.cookie } })).text();
    expect(filtered).toContain('class="tabs"');
    // admin nav includes admissions everywhere
    expect(page).toContain('href="/admissions"');
  });

  it("case page shows the status level next to the name and keeps the work areas", async () => {
    const a = mkApplicant({});
        const page = await (await fetch(`${base}/case/${a.id}`, { headers: { cookie: auth.cookie } })).text();
    expect(page).toContain("Applicant overview");
    expect(page).toContain("Applied programme");
    expect(page).toContain("Email history");
    expect(page).toContain("Audit log");
    expect(page).toContain("Status history");
    expect(page).toContain("Responses");
    expect(page).toContain('name="template"');
    expect(page).toContain('name="preview"');
    expect(page).toContain("/case/" + a.id + "/compose?template=missing_documents");
  });

  it("compose opens a ready-filled template and sending records it", async () => {
    const a = mkApplicant({});
    const page = await (await fetch(`${base}/case/${a.id}/compose?template=missing_documents`, { headers: { cookie: auth.cookie } })).text();
    expect(page).toContain("Compose reply");
    expect(page).toContain(`To <b>${a.email_address}</b>`);
    expect(page).toContain("Send now");

    const res = await fetch(`${base}/case/${a.id}/compose`, {
      method: "POST",
      headers: { cookie: auth.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${auth.csrf}&template=missing_documents&subject=Hello&body=World`,
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.headers.get("location") || "")).toContain("Reply sent");
    const emails = repo.emailsForApplicant(a.id).filter((e) => e.direction === "out");
    expect(emails.some((e) => e.subject === "Hello")).toBe(true);
  });

  it("gemini slot exists and validates a junk grade rule politely", async () => {
    const config = await (await fetch(`${base}/config?tab=replies`, { headers: { cookie: auth.cookie } })).text();
    expect(config).toContain('id="gemini"');
    expect(config).toContain("Gemini API key");
    expect(config).toContain('action="/settings/gemini"');

    // empty key + nothing saved → honest message, no crash
    const res = await fetch(`${base}/settings/gemini`, {
      method: "POST",
      headers: { cookie: auth.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${auth.csrf}&gemini_api_key=&gemini_model=gemini-1.5-flash`,
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.headers.get("location") || "")).toContain("Paste a Gemini API key");
  });

  it("grade rule add accepts grades and rejects junk", async () => {
    const ok = await fetch(`${base}/settings/rules/add`, {
      method: "POST",
      headers: { cookie: auth.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${auth.csrf}&programme=LLB&intake=&document_type=academic_cert&required=1&mean_grade=B-&subject_grades=${encodeURIComponent("B in English")}`,
      redirect: "manual",
    });
    expect(ok.status).toBe(302);
    const rule = repo.listRules().find((r) => r.programme === "LLB" && r.document_type === "academic_cert");
    expect(rule?.meanGrade).toBe("B-");
    expect(rule?.subjectGrades).toContain("English");

    const junk = await fetch(`${base}/settings/rules/add`, {
      method: "POST",
      headers: { cookie: auth.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${auth.csrf}&programme=&intake=&document_type=id&required=1&mean_grade=250`,
      redirect: "manual",
    });
    expect(decodeURIComponent(junk.headers.get("location") || "")).toContain("not a KCSE grade");
  });
});

async function loginWith(base: string): Promise<{ cookie: string; csrf: string }> {
  const res = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "username=admin&password=admin123",
    redirect: "manual",
  });
  const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  const page = await (await fetch(`${base}/`, { headers: { cookie } })).text();
  const csrf = /name="csrf" content="([^"]+)"/.exec(page)![1];
  return { cookie, csrf };
}
