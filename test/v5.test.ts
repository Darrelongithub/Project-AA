/**
 * v5 features, expressed against the generic model: stage buckets, rule-driven
 * assignment, evidence flags, the case work areas, compose flow and the
 * Settings validation slots.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../src/util/password";
import { deriveFlags, normalizeName } from "../src/rules";
import { compareFacts } from "../src/rules/caseType";
import { createApp } from "../src/web/server";
import type { ApplicantRow, DocumentRecord } from "../src/types";
import { freshRepo, webLogin } from "./helpers";
import { mustProcessed } from "./harness";
import type { Repo } from "../src/db/repo";
import type { PipelineContext } from "../src/pipeline/adapters";
import { MockSender } from "../src/pipeline/adapters";

let repo: Repo;

beforeEach(() => {
  repo = freshRepo({ refPrefix: "V5" });
  // No seeded accounts exist on a fresh install: provision one like setup does.
  repo.createStaff("admin", "System Administrator", hashPassword("admin123"), "admin");
});

function mkCase(opts: Partial<ApplicantRow> = {}): ApplicantRow {
  const a = repo.createCase({
    emailAddress: opts.email_address ?? `v5-${Math.random().toString(36).slice(2)}@example.test`,
    threadId: `t-${Math.random().toString(36).slice(2)}`,
    organizationId: 1,
    caseTypeCode: "SERVICE_REQUEST",
  });
  if (Object.keys(opts).length) repo.updateApplicant(a.id, opts);
  return repo.getCase(a.id)!;
}

function testApp(): { app: ReturnType<typeof createApp>; ctx: PipelineContext } {
  const sender = new MockSender();
  const ctx: PipelineContext = { repo, adapters: { vision: null as never, watcher: null as never, sender } };
  return { app: createApp({ repo, ctx }), ctx };
}

describe("evidence flags never become decisions", () => {
  const doc = (fields: Record<string, unknown>, confidence: DocumentRecord["confidence"] = "high", score = 98): DocumentRecord[] => [
    {
      id: 1, applicant_id: 1, document_type: "request_form", source_email_id: "m1",
      extraction_method: "pdf_text", extracted_text: "x", extracted_fields: fields,
      confidence, confidence_score: score, superseded_by: null, received_at: "2026-09-14T00:00:00Z",
    },
  ];

  it("flags weak extraction instead of failing the file", () => {
    expect(deriveFlags([], doc({ name: "ALEX MORGAN" }, "low", 40)).map((flag) => flag.type)).toContain("low_confidence");
    expect(deriveFlags([], doc({ name: "ALEX MORGAN" }))).toEqual([]);
  });

  it("flags differing names for a human rather than picking one", () => {
    const flags = deriveFlags([], [
      { ...doc({ name: "ALEX MORGAN" })[0], id: 1 },
      { ...doc({ name: "ALEXA MORGAN" })[0], id: 2, document_type: "id" },
    ]);
    expect(flags.map((flag) => flag.type)).toContain("name_mismatch");
    expect(normalizeName("  alex  morgan. ")).toBe("ALEX MORGAN");
  });

  it("treats an unread fact as undetermined, never as false", () => {
    expect(compareFacts("yes", "=", "yes")).toBe(true);
    expect(compareFacts(undefined, "=", "yes")).toBeNull();
    expect(compareFacts("1,200,000", ">=", "1000000")).toBeNull(); // text is not a number
    expect(compareFacts(1200000, ">=", 1000000)).toBe(true);
  });
});

describe("rule-driven assignment", () => {
  it("assigns a case to the officer named by the matching response rule", async () => {
    repo.createStaff("officer", "Case Officer", "x", "user");
    const owner = repo.getStaffByUsername("officer")!.id;
    const type = repo.getCaseType("SERVICE_REQUEST", 1)!;
    // Updating the configured response rule by name — a repeated save edits
    // the published rule instead of duplicating it.
    const before = repo.listWorkflowRules(1, { caseTypeId: type.id, kind: "response" }).length;
    repo.saveWorkflowRule({
      organizationId: 1, caseTypeId: type.id, kind: "response", name: "Prepare a factual status draft", position: 0,
      conditions: [{ field: "always", value: true }],
      action: { reply_action: "draft", template_key: "status_answer", assign: owner, audit_code: "assigned_to_officer" },
    });
    expect(repo.listWorkflowRules(1, { caseTypeId: type.id, kind: "response" })).toHaveLength(before);
    const ctx: PipelineContext = { repo, adapters: { vision: null as never, watcher: null as never, sender: new MockSender() } };
    const { processEmail } = await import("../src/pipeline");
    const res = mustProcessed(await processEmail(
      {
        id: "route-1", threadId: "t-route-1", from: "router@example.test", organizationId: 1, caseTypeCode: "SERVICE_REQUEST",
        subject: "Service request for a new access card",
        body: "Please process my request. Consent: yes.",
        receivedAt: "2026-09-14T09:00:00Z", attachments: [],
      },
      ctx
    ));
    const caseRow = repo.getCase(res.applicantId)!;
    expect(caseRow.assigned_to).toBe(owner);
    expect(repo.notificationsFor(owner).some((note) => note.kind === "assignment")).toBe(true);
  });
});

describe("stages & routing", () => {
  it("stageCounts buckets every case into exactly one stage", () => {
    mkCase({ lifecycle: "application_received" });
    mkCase({ lifecycle: "documents_received" });
    mkCase({ lifecycle: "documents_checked" });
    mkCase({ lifecycle: "awaiting_review" });
    mkCase({ lifecycle: "verification" });
    mkCase({ lifecycle: "completed" });
    const c = repo.stageCounts();
    expect(c.total).toBe(6);
    expect(c.unfinished).toBe(3);
    expect(c.pending).toBe(2);
    expect(c.finished).toBe(1);
    expect(c.application_received).toBe(1);
    expect(c.completed).toBe(1);
  });

  it("approverFor names who completed a file", () => {
    const a = mkCase();
    repo.setLifecycle(a.id, "completed", "jane", "closed after review");
    const approver = repo.approverFor(a.id);
    expect(approver?.actor).toBe("jane");
    expect(approver?.at).toBeTruthy();
  });

  it("case configuration is organization-owned and editable", () => {
    const type = repo.getCaseType("SERVICE_REQUEST", 1)!;
    expect(repo.caseTypeForCase(mkCase().id)?.code).toBe("SERVICE_REQUEST");
    repo.updateCaseTypeVocabulary(type.id, { terminology: { case: "Ticket", contact: "Customer" } });
    expect(repo.getCaseType("SERVICE_REQUEST", 1)?.terminology).toMatchObject({ case: "Ticket" });
  });
});

describe("web: cases, compose, settings slots", () => {
  let app: ReturnType<typeof createApp>;
  let server: ReturnType<typeof app.listen> | undefined;
  let base = "";
  let auth: { cookie: string; csrf: string };

  beforeEach(async () => {
    ({ app } = testApp());
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    auth = await webLogin(base, "admin", "admin123");
  });

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it("the cases page splits the pipeline by stage with counts", async () => {
    const a = mkCase({ lifecycle: "awaiting_review" });
    const page = await (await fetch(`${base}/cases`, { headers: { cookie: auth.cookie } })).text();
    expect(page).toContain("Cases");
    expect(page).toContain(a.ref_number);
    expect(page).toContain('class="tabs"');
    const filtered = await (await fetch(`${base}/cases?stage=awaiting_review`, { headers: { cookie: auth.cookie } })).text();
    expect(filtered).toContain(a.ref_number);
    expect(page).toContain('href="/cases"');
  });

  it("the case page keeps every work area", async () => {
    const a = mkCase();
    const page = await (await fetch(`${base}/case/${a.id}`, { headers: { cookie: auth.cookie } })).text();
    expect(page).toContain("Email history");
    expect(page).toContain("Audit log");
    expect(page).toContain("Status history");
    expect(page).toContain("Responses");
    expect(page).toContain('name="template"');
    expect(page).toContain(`/case/${a.id}/compose?template=missing_documents`);
  });

  it("compose opens a ready-filled template and sending records it", async () => {
    const a = mkCase();
    const page = await (await fetch(`${base}/case/${a.id}/compose?template=missing_documents`, { headers: { cookie: auth.cookie } })).text();
    expect(page).toContain("Compose reply");
    expect(page).toContain(`To <b>${a.email_address}</b>`);

    const res = await fetch(`${base}/case/${a.id}/compose`, {
      method: "POST",
      headers: { cookie: auth.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${auth.csrf}&template=missing_documents&subject=Hello&body=World`,
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.headers.get("location") || "")).toContain("Reply sent");
    expect(repo.emailsForApplicant(a.id).some((email) => email.direction === "out" && email.subject === "Hello")).toBe(true);
  });

  it("the Gemini slot lives in Settings and rejects an empty key politely", async () => {
    const settings = await (await fetch(`${base}/settings`, { headers: { cookie: auth.cookie } })).text();
    expect(settings).toContain('id="gemini"');
    expect(settings).toContain('action="/settings/gemini"');

    const res = await fetch(`${base}/settings/gemini`, {
      method: "POST",
      headers: { cookie: auth.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${auth.csrf}&gemini_api_key=&gemini_model=gemini-1.5-flash`,
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.headers.get("location") || "")).toContain("Paste a Gemini API key");
  });

  it("removed requirement endpoints stay closed while case-type configuration is open", async () => {
    const legacy = await fetch(`${base}/settings/rules/add`, {
      method: "POST",
      headers: { cookie: auth.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${auth.csrf}&document_type=request_form&required=1`,
      redirect: "manual",
    });
    expect(legacy.status).toBe(404);

    const type = repo.getCaseType("SERVICE_REQUEST", 1)!;
    const save = await fetch(`${base}/config/case-types/document`, {
      method: "POST",
      headers: { cookie: auth.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: auth.csrf, organization_id: "1", case_type_id: String(type.id), key: "site_plan", label: "Site plan", required: "1", blocking: "1" }),
      redirect: "manual",
    });
    expect(save.status).toBe(302);
    expect(repo.listDocumentDefinitions(type.id).map((definition) => definition.key)).toContain("site_plan");
  });
});
