/**
 * v2 repository behaviour: reference numbers, requirement resolution from
 * organization configuration, status history, SLA/escalation, search.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { configureTestOrganization } from "./helpers";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";

let repo: Repo;

beforeEach(() => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  configureTestOrganization(repo);
});

describe("reference numbers (feature 1)", () => {
  it("issues sequential, permanent, searchable ref numbers", () => {
    const year = new Date().getFullYear();
    const a = repo.getOrCreateApplicant("one@example.org", "t1");
    const b = repo.getOrCreateApplicant("two@example.org", "t2");
    expect(a.ref_number).toBe(`ORG-${year}-000001`);
    expect(b.ref_number).toBe(`ORG-${year}-000002`);
    expect(repo.findByRef("org-" + year + "-000002")?.id).toBe(b.id); // case-insensitive
  });
});

describe("requirement resolution (features 8, 36, 37)", () => {
  it("resolves the checklist from the case's own configuration", () => {
    const reqs = repo.resolveRequirements("SERVICE_REQUEST", null);
    expect(reqs.map((row) => row.document_type)).toEqual(["request_form", "id", "supporting_document"]);
    expect(reqs.find((row) => row.document_type === "id")).toMatchObject({ required: true, blocking: true });
    expect(reqs.find((row) => row.document_type === "supporting_document")).toMatchObject({ required: false, blocking: false });
  });

  it("another case type resolves a different checklist", () => {
    expect(repo.resolveRequirements("VENDOR_INTAKE", null).map((row) => row.document_type))
      .toEqual(["services_agreement", "insurance_certificate"]);
    expect(repo.resolveRequirements("ACCESS_REQUEST", null).map((row) => row.document_type)).toEqual(["authorization"]);
  });

  it("an unknown or unconfigured type resolves to nothing — never a bundled default", () => {
    expect(repo.resolveRequirements("NOT_CONFIGURED", null)).toEqual([]);
    expect(repo.resolveRequirements(null, null)).toEqual([]);
  });

  it("checklists are independent per organization", () => {
    const second = repo.createOrganization({ name: "Second Tenant", refPrefix: "SEC" });
    const type = repo.createCaseType(second.id, { code: "SERVICE_REQUEST", name: "Service request", category: "services" });
    repo.replaceDocumentDefinitions(type.id, [{ key: "site_survey", label: "Site survey", required: true, blocking: true }]);
    expect(repo.resolveRequirements("SERVICE_REQUEST", null, second.id).map((row) => row.document_type)).toEqual(["site_survey"]);
    expect(repo.resolveRequirements("SERVICE_REQUEST", null, 1).map((row) => row.document_type)).toContain("request_form");
  });
});

describe("status history & SLA", () => {
  it("records who/what/when/why for every lifecycle change", () => {
    const a = repo.getOrCreateApplicant("x@example.org", "t");
    repo.setLifecycle(a.id, "documents_received", "system", "docs arrived");
    repo.setLifecycle(a.id, "awaiting_review", "system", "queued");
    repo.setLifecycle(a.id, "verification", "jane", "approved on review");
    const h = repo.statusHistory(a.id);
    expect(h.length).toBe(3);
    expect(h[2].actor).toBe("jane");
    expect(h[2].reason).toBe("approved on review");
    expect(h[2].from_status).toBe("awaiting_review");
  });

  it("escalation sweep flags overdue unhandled cases once", () => {
    const a = repo.getOrCreateApplicant("late@example.org", "t");
    repo.setLifecycle(a.id, "awaiting_review", "system", "queued");
    const past = new Date(Date.now() - 3600_000).toISOString();
    repo.updateApplicant(a.id, { sla_due_at: past });
    expect(repo.overdueCases().map((r) => r.id)).toContain(a.id);
    repo.escalate(a.id);
    expect(repo.overdueCases().length).toBe(0); // escalated=1 → not swept twice
    const applicant = repo.getApplicant(a.id)!;
    expect(applicant.priority).toBe("urgent");
    expect(applicant.escalated).toBe(1);
  });

  it("handled cases stop the SLA clock and are not escalated", () => {
    const a = repo.getOrCreateApplicant("ok@example.org", "t");
    const past = new Date(Date.now() - 3600_000).toISOString();
    repo.updateApplicant(a.id, { sla_due_at: past, sla_handled_at: new Date().toISOString(), lifecycle: "awaiting_review" });
    expect(repo.overdueCases().length).toBe(0);
  });
});

describe("search & filters (features 18, 19)", () => {
  it("searches by ref, name, email, phone", () => {
    const a = repo.getOrCreateApplicant("search@example.org", "t1", { fullName: "Zawadi Makena" });
    repo.updateApplicant(a.id, { phone: "+254700111222" });
    expect(repo.searchApplicants({ q: a.ref_number })[0]?.id).toBe(a.id);
    expect(repo.searchApplicants({ q: "zawadi" })[0]?.id).toBe(a.id);
    expect(repo.searchApplicants({ q: "0700111" })[0]?.id).toBe(a.id);
    expect(repo.searchApplicants({ q: "SEARCH@EXAMPLE" })[0]?.id).toBe(a.id);
  });

  it("filters by case type and lifecycle state", () => {
    const a = repo.createCase({ emailAddress: "p1@example.test", threadId: "t-filter", organizationId: 1, caseTypeCode: "SERVICE_REQUEST" });
    repo.updateApplicant(a.id, { lifecycle: "awaiting_review" });
    const b = repo.createCase({ emailAddress: "p2@example.test", threadId: "t-filter-2", organizationId: 1, caseTypeCode: "VENDOR_INTAKE" });
    expect(repo.searchApplicants({ caseTypeCode: "SERVICE_REQUEST" }).map((row) => row.id)).toContain(a.id);
    expect(repo.searchApplicants({ filter: "human_review" }).map((row) => row.id)).toContain(a.id);
    expect(repo.searchApplicants({ caseTypeCode: "SERVICE_REQUEST" }).map((row) => row.id)).not.toContain(b.id);
  });
});
