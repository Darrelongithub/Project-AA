/**
 * v2 repository behaviour: reference numbers, programme/intake requirement
 * resolution, status history, SLA/escalation, search.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { DEFAULT_REQUIREMENTS } from "../src/config";

let repo: Repo;

beforeEach(() => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  repo.seedBaseRequirements(DEFAULT_REQUIREMENTS);
});

describe("reference numbers (feature 1)", () => {
  it("issues sequential, permanent, searchable ref numbers", () => {
    const year = new Date().getFullYear();
    const a = repo.getOrCreateApplicant("one@example.org", "t1");
    const b = repo.getOrCreateApplicant("two@example.org", "t2");
    expect(a.ref_number).toBe(`RU-${year}-000001`);
    expect(b.ref_number).toBe(`RU-${year}-000002`);
    expect(repo.findByRef("ru-" + year + "-000002")?.id).toBe(b.id); // case-insensitive
  });
});

describe("requirement resolution (features 8, 36, 37)", () => {
  it("base rules apply to everyone", () => {
    const reqs = repo.resolveRequirements(null, null);
    // The KCPE certificate is not part of the published application basics.
    expect(reqs.find((r) => r.document_type === "kcpe_cert")?.required).toBe(false);
    expect(reqs.find((r) => r.document_type === "id")?.required).toBe(true);
    // The general minimum lives in the structured entry requirements:
    // university-wide degree floor = KCSE mean grade C+.
    const kcse = repo.listSystemBlocks(null).find((b) => b.level === "degree" && b.system === "KCSE");
    expect(kcse?.overall).toBe("C+");
  });

  it("programme-specific rules override base", () => {
    repo.upsertSystemBlock("LAW", "degree", { system: "KCSE", enabled: true, overall: "B", subjects: [] });
    const law = repo.resolveBlocks("LAW").find((b) => b.system === "KCSE");
    const bcs = repo.resolveBlocks("BCS").find((b) => b.system === "KCSE");
    expect(law?.overall).toBe("B");
    // BCS keeps its own seeded block — unaffected by LAW's override.
    expect(bcs?.overall).toBe("C+");
    // A system the course never configured falls back to the university-wide default.
    expect(repo.resolveBlocks("BCS").find((b) => b.system === "IGCSE")?.minCredits).toBe(5);
  });

  it("programme+intake is the most specific", () => {
    repo.upsertRule({ programme: "BCS", intake: null, document_type: "birth_cert", required: true, meanGrade: null });
    repo.upsertRule({ programme: "BCS", intake: "January 2027", document_type: "birth_cert", required: false, meanGrade: null });
    expect(repo.resolveRequirements("BCS", "January 2027").find((r) => r.document_type === "birth_cert")?.required).toBe(false);
    expect(repo.resolveRequirements("BCS", "September 2026").find((r) => r.document_type === "birth_cert")?.required).toBe(true);
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

  it("filters by programme and lifecycle states", () => {
    const a = repo.getOrCreateApplicant("p1@example.org", "t");
    repo.updateApplicant(a.id, { programme: "LAW", lifecycle: "awaiting_review" });
    expect(repo.searchApplicants({ programme: "LAW" })[0]?.id).toBe(a.id);
    expect(repo.searchApplicants({ filter: "human_review" })[0]?.id).toBe(a.id);
    expect(repo.searchApplicants({ programme: "BCS" }).length).toBe(0);
  });
});
