/**
 * PPR P1-9 acceptance: the CORE pipeline carries a complete case life
 * (intake → documents → checklist → held replies → follow-up ladder → stage
 * movement) inside a brand-new ORGANIZATION that configured itself through
 * the real admin routes. Every surface that touches the case — pages, audit
 * trail, drafts — is swept for domain vocabulary the tenant never chose.
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
import { runFollowUpSweep } from "../src/followups";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";
import type { Attachment, IncomingEmail } from "../src/types";

function fresh(): Repo {
  const repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  return repo;
}

// The academic vocabulary this suite proves is ABSENT. Every page, draft and
// audit line this case produces is swept with it.
const ACADEMIC = /\bKCSE\b|\bKCPE\b|\bIGCSE\b|\bGPA\b|\bgrade\b|\bgrades\b|\bprogramme\b|\bprogrammes\b|\badmission\b|\badmissions\b|\beligibility\b|\bmatric\b|\bmean grade\b|\bprincipals\b|\bsubsidiaries\b|\bdegree\b|\bdiploma\b/i;

const mail = (over: Partial<IncomingEmail>): IncomingEmail => ({
  id: over.id ?? "gen-1",
  threadId: over.threadId ?? "gen-thread",
  from: over.from ?? "someone@example.test",
  subject: over.subject ?? "hello",
  body: over.body ?? "hello there",
  receivedAt: new Date().toISOString(),
  attachments: [],
  ...over,
});

const pastIso = () => new Date(Date.now() - 40 * 24 * 3600_000).toISOString();

// Case CONTENT with workspace chrome removed: the global nav, stylesheet
// comments and links may mention the legacy areas (invariant (e): old URLs
// keep working) — none of that is this case's flow.
const caseContent = (html: string): string =>
  html
    .replace(/<nav[\s\S]*?<\/nav>/g, "")
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/href="[^"]*"/g, "");

describe("PPR P1-9: core pipeline with education fully off — zero academic vocabulary", () => {
  let repo: Repo;
  let ctx: PipelineContext;
  let sender: MockSender;
  let server: Server | undefined;
  let base = "";
  let auth: { cookie: string; csrf: string };
  let orgId = 0;
  let svcId = 0;

  const post = (path: string, body: Record<string, string>) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { cookie: auth.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: auth.csrf, ...body }),
      redirect: "manual",
    });
  const get = (path: string) => fetch(`${base}${path}`, { headers: { cookie: auth.cookie } }).then((r) => r.text());

  beforeAll(async () => {
    repo = fresh();
    repo.createStaff("admin", "Administrator", hashPassword("admin123"), "admin");
    sender = new MockSender();
    ctx = { repo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender } };
    const app = createApp({ repo, ctx });
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    base = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
    const login = await webLogin(base, "admin", "admin123");
    expect(login.status).toBe(302);
    auth = { cookie: login.cookie, csrf: login.csrf };

    // A brand-new tenant — education off from birth (invariant f), no
    // migration snapshot, no legacy template vocabulary.
    expect((await post("/config/organizations/create", {
      name: "Greenfield Services", ref_prefix: "GS",
    })).status).toBe(302);
    orgId = repo.getOrganization(2)?.id ?? 0;
    orgId = (repo.db.prepare("SELECT id FROM organizations WHERE name = ?").get("Greenfield Services") as { id: number }).id;
    expect(orgId).toBeGreaterThan(0);
    // The admin works inside the new tenant for this suite:
    repo.db.prepare("UPDATE staff_users SET organization_id = ? WHERE username = 'admin'").run(orgId);
    const relogin = await webLogin(base, "admin", "admin123");
    auth = { cookie: relogin.cookie, csrf: relogin.csrf };
  });

  afterAll(() => {
    repo.db.prepare("UPDATE staff_users SET organization_id = 1 WHERE username = 'admin'").run();
    server?.close();
  });

  it("runs a whole case life on a self-configured profile with no domain words anywhere", async () => {
    // ── 1. A profile configured through the real admin routes ──
    expect((await post("/config/case-types/create", {
      organization_id: String(orgId), code: "NHS", name: "Neighbourhood help", category: "general",
    })).status).toBe(302);
    const nhs = repo.getCaseType("NHS", orgId)!;
    expect(nhs.default_reply_action).toBe("draft"); // invariant (f)
    expect(nhs.evidence_gate).toBe(1); // evidence gate ON for a new profile
    svcId = nhs.id;

    for (const [i, doc] of [["proof_of_address", "Proof of address"], ["id_photo", "Identity photo"]].entries()) {
      expect((await post("/config/case-types/document", {
        organization_id: String(orgId), case_type_id: String(svcId), key: doc[0], label: doc[1],
        required: "1", blocking: "1", position: String(i),
      })).status).toBe(302);
    }

    // Its OWN vocabulary (P1-1) — internal keys untouched, zero academic words:
    expect((await post("/config/case-types/vocabulary", {
      id: String(svcId),
      term_case: "Request", term_contact: "Requester", term_category: "Topic",
      term_stage: "Phase", term_outcome: "Resolution",
      stages_text: "application_received|Opened\ndocuments_received|In review\ndocuments_checked|Checked\nawaiting_review|With a reviewer\nverification|Resolution pending\ncompleted|Closed",
      queues_text: "front_desk|Front desk",
    })).status).toBe(302);

    // The profile OWNS its reply wording (P0-6) — nothing academic to inherit:
    for (const tpl of [
      { key: "docs_request", name: "Documents needed", subject: "Documents needed for {ref}" },
      { key: "missing_documents", name: "Reminder", subject: "Reminder: documents needed for {ref}" },
    ]) {
      // The key is CREATED first (open vocabulary — not an 8-key enum), then
      // given this profile's own wording:
      expect((await post("/templates/create", {
        key: tpl.key, name: tpl.name, case_type_id: String(svcId),
      })).status).toBe(302);
      expect((await post("/templates/save", {
        key: tpl.key,
        name: tpl.name,
        subject: tpl.subject,
        body: `Hello {name},\n\nTo continue your request {ref}, please send us:\n{checklist}\n\nKind regards,\n{institution} Neighbourhood services`,
        attach_pack: "none",
        case_type_id: String(svcId),
      })).status).toBe(302);
    }

    // A document set of its own (P1-4 library) — named freely, no pack slots:
    expect((await post("/config/attachment-sets/create", {
      name: "welcome pack", description: "Files we send to new requesters",
    })).status).toBe(302);

    // Rule as DATA (P0-4): first message opens the request, reply is drafted,
    // the follow-up ladder runs with rung replies drafted for staff (P1-3).
    expect((await post("/config/workflow-rules/save", {
      name: "Membership requests open a request",
      kind: "intake",
      case_type_id: String(svcId),
      position: "0",
      cond_field_0: "text",
      cond_value_0: "membership",
      decision: "create",
      reply_action: "draft",
      template_key: "docs_request",
      followup: "ladder",
      followup_action: "draft",
      fallback: "human_draft",
    })).status).toBe(302);

    // ── 2. First message opens the case through the real pipeline ──────────
    const first = await processEmail(mail({
      id: "gen-1", from: "helper@example.test",
      subject: "membership request", body: "I want to sort out my membership papers.",
      organizationId: orgId, caseTypeCode: "NHS",
    }), ctx);
    expect(first.skipped).not.toBe(true);
    const id = first.applicantId!;
    const row = repo.getApplicant(id)!;
    expect(repo.caseTypeForCase(id)?.code).toBe("NHS");
    expect(String(row.outcome ?? "undecided")).not.toMatch(/admitted|declined/); // nothing ever decided
    expect(row.requirements_snapshot ?? "").not.toMatch(ACADEMIC);

    // The reply is DRAFTED, not sent (invariant f — new profiles draft):
    expect(sender.sent.length).toBe(0);
    const draft = repo.queuedOutbox(id)!;
    expect(draft).toBeTruthy();
    expect(`${draft.subject}\n${draft.body}`).not.toMatch(ACADEMIC);

    // ── 3. Documents arrive; the checklist is reality, not a matrix ────────
    const idPhoto: Attachment = {
      filename: "identity-photo.pdf",
      mimeType: "application/pdf",
      content: Buffer.from("%PDF-1.4\n identity photo scan "),
      mockVision: { document_type: "id_photo", text: "IDENTITY PHOTO of the requester", fields: {}, confidence: "high" },
    } as unknown as Attachment;
    const second = await processEmail(mail({
      id: "gen-2", from: "helper@example.test", threadId: "gen-thread",
      subject: "membership documents attached", body: "Attaching the paperwork for my membership.",
      attachments: [idPhoto],
      organizationId: orgId, caseTypeCode: "NHS",
    }), ctx);
    expect(second.applicantId).toBe(id); // same requester, same case
    const pageAfterDocs = await get(`/case/${id}`);
    expect(pageAfterDocs).toContain("Identity photo");
    expect(pageAfterDocs).toMatch(/\d+ received/);

    // ── 4. The follow-up ladder fires rungs — drafted for staff ────────────
    expect((repo.getApplicant(id) as { followup_action?: string }).followup_action).toBe("draft");
    repo.setFollowup(id, 0, pastIso(), pastIso());
    sender.sent.length = 0;
    await runFollowUpSweep(repo, ctx);
    expect(sender.sent.length).toBe(0); // draft mode — nothing leaves the building
    expect(repo.auditForApplicant(id).some((a) => a.event === "followup_drafted")).toBe(true);

    // ── 5. Stage movement works on the configured stage set ────────────────
    // (mail2 already moved the case to "In review" = documents_received)
    expect(repo.getApplicant(id)!.lifecycle).toBe("documents_received");
    const step = await post(`/case/${id}/action`, { action: "advance" });
    expect(step.status).toBe(302);
    expect(repo.getApplicant(id)!.lifecycle).toBe("documents_checked");

    // ── 6. Zero academic vocabulary on every surface this case touches ────
    const casePage = await get(`/case/${id}`);
    expect(caseContent(casePage)).not.toMatch(ACADEMIC);
    expect(casePage).toContain("Request overview");      // its own term_case
    expect(casePage).toContain("Requester");             // its own term_contact
    expect(casePage).not.toContain("Applicant overview"); // education wording absent
    expect(casePage).not.toContain("Admission eligibility");
    // The document-set panel speaks the tenant's own sets:
    expect(casePage).toContain("welcome pack");

    const listPage = await get("/applicants");
    expect(caseContent(listPage)).not.toMatch(ACADEMIC);

    const auditLines = repo.auditForApplicant(id).map((a) => `${a.event} ${a.detail}`).join("\n");
    expect(auditLines).not.toMatch(ACADEMIC);

    // Every queued draft body stays generic too:
    const outboxRow = repo.queuedOutbox(id)!;
    expect(`${outboxRow.subject}\n${outboxRow.body}`).not.toMatch(ACADEMIC);

    // And the profile never grew academic fields:
    const finalRow = repo.getApplicant(id)!;
    expect(String(finalRow.outcome ?? "undecided")).not.toMatch(/admitted|declined/);
    expect((finalRow as { decision_by?: string | null }).decision_by ?? null).toBeNull();
  });
});
