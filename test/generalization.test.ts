/**
 * GR — Generalization round acceptance tests.
 * These are intentionally written before the generic model implementation:
 * the admissions vocabulary remains available as a compatibility view, but
 * new deployments are organized around organizations, case types and cases.
 */
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { institutionName } from "../src/branding";
import { documentRequirementsForCaseType } from "../src/documents/matrix";
import { evaluateCaseTypeRules } from "../src/admissions/evaluate";
import type { RuleNode } from "../src/types";

function fresh(): Repo {
  const repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  return repo;
}

describe("GR-1: organizations, cases and case types", () => {
  it("migrates the existing Riara data into organization one without losing compatibility", () => {
    const repo = fresh();
    // Simulate a pre-Generalization Riara row, then rerun the idempotent
    // migration path. A fresh database has no applicant fixtures by design.
    const legacy = repo.getOrCreateApplicant("legacy@riara.example", "legacy-thread");
    repo.db.prepare("UPDATE applicants SET programme = 'BCS', organization_id = NULL, case_type_id = NULL WHERE id = ?").run(legacy.id);
    seedDefaults(repo);
    const org = repo.getOrganization(1);
    expect(org).toBeTruthy();
    expect(org!.id).toBe(1);
    expect(repo.listCases(0)).toEqual(repo.allApplicants(0));
    expect(repo.listCaseTypes(1).length).toBeGreaterThan(0);

    const row = repo.db.prepare("SELECT category, outcome, organization_id FROM cases WHERE id = 1").get() as {
      category: string | null; outcome: string; organization_id: number;
    } | undefined;
    expect(row?.organization_id).toBe(1);
    expect(row).toHaveProperty("category");
    expect(row).toHaveProperty("outcome");
  });

  it("can create a non-academic case type owned by an organization", () => {
    const repo = fresh();
    const type = repo.createCaseType(1, { code: "HIRING", name: "Hiring enquiry", category: "recruitment" });
    expect(type.organization_id).toBe(1);
    expect(repo.getCaseType("HIRING", 1)?.name).toBe("Hiring enquiry");
    expect(repo.getCaseType("BCS", 1)?.name).toContain("Computer Science");
  });
});

describe("GR-2: per-case-type document definitions", () => {
  it("uses definitions for a workplace case instead of the academic matrix", () => {
    const repo = fresh();
    const type = repo.createCaseType(1, { code: "HIRING", name: "Hiring enquiry", category: "recruitment" });
    repo.replaceDocumentDefinitions(type.id, [
      { key: "resume", label: "Resume", required: true, blocking: true },
      { key: "portfolio", label: "Portfolio", required: false, blocking: false },
    ]);
    const defs = repo.listDocumentDefinitions(type.id);
    expect(defs.map((d) => d.key)).toEqual(["resume", "portfolio"]);
    expect(documentRequirementsForCaseType({ caseType: type, definitions: defs })).toMatchObject([
      { key: "resume", required: true },
      { key: "portfolio", required: false },
    ]);
  });
});

describe("GR-3: generic rule trees", () => {
  it("evaluates the existing AND/OR/NOT logic against a case type", () => {
    const repo = fresh();
    const type = repo.createCaseType(1, { code: "HIRING", name: "Hiring enquiry", category: "recruitment" });
    const nodes: RuleNode[] = [{
      id: 1, kind: "group", logic: "AND", children: [
        { id: 2, kind: "condition", field: "numeric", comparator: ">=", value: "5" },
        { id: 3, kind: "group", logic: "OR", children: [
          { id: 4, kind: "condition", field: "numeric", comparator: ">=", value: "10" },
          { id: 5, kind: "condition", field: "numeric", comparator: ">=", value: "7" },
        ] },
      ],
    }];
    const result = evaluateCaseTypeRules(repo, type, nodes, { numeric: 7 });
    expect(result.result).toBe("passed");
    expect(result.routing).toBe("human_review");
    expect(result.outcome).toBe("undecided");
  });
});

describe("GR-4: organization categories and safe AI labels", () => {
  it("has configurable admission and normal labels", () => {
    const repo = fresh();
    expect(repo.listEmailCategories(1).map((x) => x.key)).toEqual(expect.arrayContaining(["admission", "normal"]));
    repo.addEmailCategory(1, { key: "support", label: "Customer support" });
    expect(repo.listEmailCategories(1).map((x) => x.key)).toContain("support");
  });

  it("AI labels do not decide the case outcome", async () => {
    const { classifyWithConfiguredCategories } = await import("../src/categorize");
    const result = await classifyWithConfiguredCategories(
      { subject: "Please consider my request", body: "I attached a file." },
      ["admission", "normal"],
      async () => ({ label: "admission", confidence: 0.99 })
    );
    expect(result.label).toBe("admission");
    expect(result).not.toHaveProperty("outcome");
  });
});

describe("GR-5/6: organization branding and packs", () => {
  it("uses organization branding rather than a Riara constant", () => {
    const repo = fresh();
    repo.updateOrganization(1, { name: "Acme Foundation", theme: { primary: "#123456", accent: "#f97316" } });
    expect(institutionName(repo)).toBe("Acme Foundation");
    expect(repo.getOrganization(1)!.theme.primary).toBe("#123456");
  });

  it("organization pack slots start empty and can be uploaded", () => {
    const repo = fresh();
    expect(repo.listOrganizationPackSlots(1).every((slot) => !slot.filename)).toBe(true);
    repo.setOrganizationPackSlot(1, "application", { filename: "application.pdf", mime: "application/pdf", content: Buffer.from("pdf") });
    expect(repo.listOrganizationPackSlots(1).find((x) => x.key === "application")!.filename).toBe("application.pdf");
  });
});

describe("GR-7: case-type scope", () => {
  it("supports case-type visibility without changing old school scope data", () => {
    const repo = fresh();
    const staff = repo.createStaffAndReturn("reviewer", "Reviewer", "hash", "user");
    repo.setCaseTypeScopes(staff.id, ["BCS"]);
    expect(repo.caseTypeScopesFor(staff.id)).toEqual(["BCS"]);
    expect(repo.visibleSchoolsFor(staff)).toBeNull();
  });
});
