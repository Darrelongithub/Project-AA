/** Missing-case regression coverage for every formerly asserted getApplicant(...)! site. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { openDb } from "../src/db/db";
import { ApplicantNotFoundError, Repo, type ApplicantLookupSite } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { processEmail } from "../src/pipeline";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";
import { createApp } from "../src/web/server";
import { hashPassword } from "../src/util/password";
import type { IncomingEmail } from "../src/types";
import { configureTestOrganization, webLogin } from "./helpers";

let repo: Repo;
let ctx: PipelineContext;
let server: Server | undefined;

function makeRepo(): Repo {
  const result = new Repo(openDb(":memory:"));
  seedDefaults(result);
  configureTestOrganization(result);
  return result;
}

function failAtRequiredLookup(target: ApplicantLookupSite): void {
  const original = repo.requireApplicant.bind(repo);
  vi.spyOn(repo, "requireApplicant").mockImplementation((id, site) => {
    if (site === target) vi.spyOn(repo, "getApplicant").mockReturnValueOnce(undefined);
    return original(id, site);
  });
}

function mail(id: string): IncomingEmail {
  return {
    id,
    threadId: `thread-${id}`,
    from: `${id}@example.test`,
    fromName: "Null Guard Test",
    subject: "Service request about our account",
    body: "Please advise on our service request.",
    receivedAt: "2026-10-03T00:00:00.000Z",
    organizationId: 1,
    caseTypeCode: "SERVICE_REQUEST",
    attachments: [],
  };
}

async function bootAdmin(): Promise<{ base: string; cookie: string; csrf: string }> {
  repo.createStaff("guard-admin", "Guard Admin", hashPassword("guard-admin-pass-1"), "admin");
  ctx = { repo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender: new MockSender() } };
  server = createApp({ repo, ctx }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const auth = await webLogin(base, "guard-admin", "guard-admin-pass-1");
  expect(auth.status).toBe(302);
  return { base, cookie: auth.cookie, csrf: auth.csrf };
}

beforeEach(() => {
  repo = makeRepo();
  ctx = { repo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender: new MockSender() } };
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

describe("Repo.getOrCreateApplicant missing-applicant boundary", () => {
  it("throws a typed error if the newly inserted case cannot be re-read", () => {
    failAtRequiredLookup("repo.create");

    let thrown: unknown;
    try {
      repo.getOrCreateApplicant("create@example.test", "create-thread", {
        organizationId: 1,
        caseTypeCode: "SERVICE_REQUEST",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ApplicantNotFoundError);
    expect(thrown).toMatchObject({ name: "ApplicantNotFoundError", code: "APPLICANT_NOT_FOUND", lookupSite: "repo.create" });
    expect(repo.db.prepare("SELECT COUNT(*) AS n FROM applicants WHERE email_address = ?").get("create@example.test")).toEqual({ n: 0 });
  });
});

describe("Repo.reFreezeCaseConfig missing-applicant boundaries", () => {
  it("repo.refreeze.requirements throws a typed error if the case vanishes before snapshot freezing", () => {
    const applicant = repo.createCase({ emailAddress: "freeze@example.test", threadId: "freeze-thread", organizationId: 1, caseTypeCode: "SERVICE_REQUEST" });
    failAtRequiredLookup("repo.refreeze.requirements");

    expect(() => repo.reFreezeCaseConfig(applicant)).toThrowError(ApplicantNotFoundError);
  });

  it("repo.refreeze.result throws a typed error if the case vanishes before returning its snapshot", () => {
    const applicant = repo.createCase({ emailAddress: "return@example.test", threadId: "return-thread", organizationId: 1, caseTypeCode: "SERVICE_REQUEST" });
    failAtRequiredLookup("repo.refreeze.result");

    expect(() => repo.reFreezeCaseConfig(applicant)).toThrowError(ApplicantNotFoundError);
  });
});

const PIPELINE_LOOKUPS: ApplicantLookupSite[] = [
  "pipeline.phone-enrichment",
  "pipeline.requirements-case",
  "pipeline.requirements",
  "pipeline.human-review",
  "pipeline.lifecycle",
  "pipeline.result",
];

describe.each(PIPELINE_LOOKUPS)("pipeline lookup %s", (site) => {
  it("fails explicitly when the applicant disappears at this pipeline stage", async () => {
    failAtRequiredLookup(site);
    await expect(processEmail(mail(`missing-${site.replace(/[^a-z]+/gi, "-")}`), ctx))
      .rejects.toMatchObject({ name: "ApplicantNotFoundError", code: "APPLICANT_NOT_FOUND", lookupSite: site });
  });
});

describe("case-route applicant re-reads", () => {
  it("/case/:id/assign returns 404 if the case disappears before the notification read", async () => {
    const auth = await bootAdmin();
    const applicant = repo.createCase({ emailAddress: "assign@example.test", threadId: "assign-thread", organizationId: 1, caseTypeCode: "SERVICE_REQUEST" });
    repo.createStaff("assignee", "Assignee", hashPassword("assignee-pass-1"), "user");
    const assignee = repo.getStaffByUsername("assignee");
    expect(assignee).toBeTruthy();
    const originalUpdate = repo.updateApplicant.bind(repo);
    vi.spyOn(repo, "updateApplicant").mockImplementation((id, patch) => {
      originalUpdate(id, patch);
      if (id === applicant.id && Object.prototype.hasOwnProperty.call(patch, "assigned_to")) repo.deleteApplicantFull(id);
    });

    const response = await fetch(`${auth.base}/case/${applicant.id}/assign`, {
      method: "POST",
      headers: { cookie: auth.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: auth.csrf, staff_id: String(assignee!.id) }),
      redirect: "manual",
    });

    expect(response.status).toBe(404);
    expect(await response.text()).toContain("Case not found");
    expect(repo.getApplicant(applicant.id)).toBeUndefined();
  });

  it("/case/:id/case-type returns 404 if the case disappears before re-freezing", async () => {
    const auth = await bootAdmin();
    const applicant = repo.createCase({ emailAddress: "retype@example.test", threadId: "retype-thread", organizationId: 1, caseTypeCode: "SERVICE_REQUEST" });
    const target = repo.getCaseType("VENDOR_INTAKE", 1);
    expect(target).toBeTruthy();
    const originalUpdate = repo.updateCase.bind(repo);
    vi.spyOn(repo, "updateCase").mockImplementation((id, patch) => {
      originalUpdate(id, patch);
      if (id === applicant.id && patch.case_type_id !== undefined) repo.deleteApplicantFull(id);
    });

    const response = await fetch(`${auth.base}/case/${applicant.id}/case-type`, {
      method: "POST",
      headers: { cookie: auth.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: auth.csrf, case_type_id: String(target!.id) }),
      redirect: "manual",
    });

    expect(response.status).toBe(404);
    expect(await response.text()).toContain("Case not found");
    expect(repo.getApplicant(applicant.id)).toBeUndefined();
  });
});
