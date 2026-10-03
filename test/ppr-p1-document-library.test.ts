/**
 * PPR P1-4 acceptance: the ten fixed pack slots are replaced by a real
 * document library (organization files inside named attachment sets), and
 * required-information lists are configurable per stage and enforced when
 * staff move a case. Nothing is bundled: a new organization starts with an
 * empty library and its own configured requirements. Everything is exercised
 * through the real admin and case routes.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { createApp } from "../src/web/server";
import { hashPassword } from "../src/util/password";
import { webLogin, configureTestOrganization } from "./helpers";
import { processEmail } from "../src/pipeline";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";
import type { DocType, ExtractionMethod, IncomingEmail } from "../src/types";

function fresh(): Repo {
  const repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  return repo;
}

const fakePdf = (tag: string): Buffer =>
  Buffer.concat([Buffer.from(`%PDF-1.4\n% ${tag}\n`), Buffer.alloc(600, 0x20)]);

const mail = (over: Partial<IncomingEmail>): IncomingEmail => ({
  id: over.id ?? "dl-1",
  threadId: over.threadId ?? "dl-thread",
  from: over.from ?? "someone@example.test",
  subject: over.subject ?? "hello",
  body: over.body ?? "hello there",
  receivedAt: new Date().toISOString(),
  attachments: [],
  ...over,
});

describe("PPR P1-4: document library + per-stage required information", () => {
  let repo: Repo;
  let ctx: PipelineContext;
  let server: Server | undefined;
  let base = "";
  let auth: { cookie: string; csrf: string };

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
    // The tenant is configured BEFORE any account exists, so the
    // administrator resolves to it and its own requirements are on file.
    configureTestOrganization(repo);
    repo.createStaff("admin", "Administrator", hashPassword("admin123"), "admin");
    ctx = {
      repo,
      adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender: new MockSender() },
    };
    const app = createApp({ repo, ctx });
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    base = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
    const login = await webLogin(base, "admin", "admin123");
    expect(login.status).toBe(302);
    auth = { cookie: login.cookie, csrf: login.csrf };
  });

  afterAll(() => server?.close());

  it("the pack tab is a document library — the ten fixed slots are gone and nothing bundled remains", async () => {
    // A NEW set with an arbitrary name — no bundled pack vocabulary anywhere.
    expect((await post("/config/attachment-sets/create", {
      name: "onboarding pack", description: "Files we send to new joiners",
    })).status).toBe(302);
    const set = repo.attachmentSetByName(1, "onboarding pack")!;
    expect(set).toBeTruthy();
    const up = await fetch(`${base}/config/attachment-sets/upload?set=${set.id}&filename=onboarding-guide.pdf`, {
      method: "POST",
      headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf, "content-type": "application/pdf" },
      body: fakePdf("onboarding"),
    });
    expect(up.status).toBe(200);

    const page = await get("/config?tab=pack");
    // The library exists and shows the org's own file in its own set:
    expect(page).toContain("Document library");
    expect(page).toContain("onboarding-guide.pdf");
    expect(page).toContain("onboarding pack");
    // The ten fixed pack slots are GONE from the UI:
    expect(page).not.toContain("data-pack-slot");
    expect(page).not.toContain("Application pack</h3>");
    expect(page).not.toContain("Admission pack</h3>");
    // No bundled snapshot survives either — the library is empty until this
    // organization uploads something.
    expect(page).not.toMatch(/legacy/i);
    expect(page).toContain("No sample files or fixed packs are provided");
    // The requirements tab reads this tenant's OWN configured checklists:
    const reqs = await get("/config?tab=requirements");
    expect(reqs).toContain("Configured requirements");
    expect(reqs).toContain("Request form");
    expect(reqs).toContain("Identity document");
  });

  it("required-information lists configure per stage and gate stage movement", async () => {
    // A new case type + an intake rule → a real case via the pipeline.
    expect((await post("/config/case-types/create", {
      organization_id: "1", code: "LIB", name: "Library services", category: "general",
    })).status).toBe(302);
    const lib = repo.getCaseType("LIB", 1)!;
    expect((await post("/config/workflow-rules/save", {
      name: "Library enquiries open a case",
      kind: "intake",
      case_type_id: String(lib.id),
      position: "0",
      cond_field_0: "text",
      cond_value_0: "joinlibrary",
      decision: "create",
      reply_action: "draft",
      template_key: "docs_request",
      fallback: "human_draft",
    })).status).toBe(302);

    // The stage vocabulary gains a required-information list via the UI form:
    expect((await post("/config/case-types/vocabulary", {
      id: String(lib.id),
      term_case: "Member", term_contact: "Contact", term_category: "Category",
      term_stage: "Stage", term_outcome: "Decision",
      stages_text: "documents_checked|Documents checked|proof_of_address, id_photo",
      queues_text: "front_desk|Front desk",
    })).status).toBe(302);
    const stages = repo.caseTypeById(lib.id)!.stages ?? [];
    const gated = stages.find((s) => s.id === "documents_checked")!;
    expect(gated.requires).toEqual(["proof_of_address", "id_photo"]);

    // A real case for the case type:
    const result = await processEmail(mail({
      id: "dl-case-1", from: "joiner@example.test",
      subject: "joinlibrary request", body: "I would like to joinlibrary — details attached.",
      organizationId: 1, caseTypeCode: "LIB",
    }), ctx);
    expect(result.skipped).not.toBe(true);
    const id = result.applicantId!;
    expect(repo.caseTypeForCase(id)?.code).toBe("LIB");

    // Advance 1: application_received → documents_received (no gate) — fine.
    const step1 = await post(`/case/${id}/action`, { action: "advance" });
    expect(step1.status).toBe(302);
    expect(repo.getApplicant(id)!.lifecycle).toBe("documents_received");

    // Advance 2: → documents_checked is GATED — refused with the missing
    // items named (never a silent rewrite, never a decision).
    const step2 = await post(`/case/${id}/action`, { action: "advance" });
    expect(step2.status).toBe(302);
    expect(decodeURIComponent(step2.headers.get("location") ?? "")).toContain("Cannot move to");
    expect(decodeURIComponent(step2.headers.get("location") ?? "")).toContain("proof_of_address");
    expect(repo.getApplicant(id)!.lifecycle).toBe("documents_received"); // unchanged

    // Staff add the two documents (real record inserts, as uploads would):
    for (const t of ["proof_of_address", "id_photo"] as DocType[]) {
      repo.insertDocument({
        applicant_id: id,
        document_type: t,
        source_email_id: "dl-case-1",
        extraction_method: "text" as ExtractionMethod,
        extracted_text: `the ${t.replace(/_/g, " ")} is on file`,
        extracted_fields: {},
        confidence: "high",
        confidence_score: 95,
        received_at: new Date().toISOString(),
      });
    }

    // Now the very same advance succeeds:
    const step3 = await post(`/case/${id}/action`, { action: "advance" });
    expect(step3.status).toBe(302);
    expect(repo.getApplicant(id)!.lifecycle).toBe("documents_checked");

    // The case page surfaces what the gated stage needs:
    const page = await get(`/case/${id}`);
    expect(page).toContain("Required for this stage");
    expect(page).toContain("proof_of_address");
  });
});
