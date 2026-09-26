/** CTR — CaseType configuration, tenant prefixes, deterministic fallback and
 * the generic pipeline path. This deliberately exercises organization-owned
 * data rather than the migrated academic catalogue. */
import { describe, expect, it } from "vitest";
import type { Server } from "http";
import { webLogin } from "./helpers";
import { createApp } from "../src/web/server";
import { hashPassword } from "../src/util/password";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { evaluateCaseTypeRules } from "../src/admissions/evaluate";
import { classifyWithConfiguredCategories } from "../src/categorize";
import { processEmail } from "../src/pipeline";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";
import { makeTextPdf } from "../src/simulation/pdfFactory";
import type { IncomingEmail, RuleNode } from "../src/types";

function fresh(): Repo {
  const repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  return repo;
}

describe("CTR — CaseType round", () => {
  it("keeps references and template preview data organization-owned", () => {
    const repo = fresh();
    const org = repo.createOrganization({ name: "People Operations", refPrefix: "HR" });
    const hr = repo.createCaseType(org.id, { code: "HR_ONBOARDING", name: "HR onboarding", category: "people" });
    const a = repo.createCase({ emailAddress: "a@example.test", threadId: "a", organizationId: org.id, caseTypeCode: hr.code });
    const b = repo.createCase({ emailAddress: "b@example.test", threadId: "b", organizationId: 1, caseTypeCode: "GENERAL" });
    expect(a.ref_number).toMatch(/^HR-\d{4}-\d{6}$/);
    expect(b.ref_number).toMatch(/^RU-\d{4}-\d{6}$/);
    expect(repo.organizationRefPrefix(org.id)).toBe("HR");
  });

  it("uses organization document slots and the generic rule tree", () => {
    const repo = fresh();
    const org = repo.createOrganization({ name: "People Operations", refPrefix: "HR" });
    const hr = repo.createCaseType(org.id, { code: "HR_ONBOARDING", name: "HR onboarding", category: "people" });
    repo.replaceDocumentDefinitions(hr.id, [{ key: "employee_id", label: "Employee ID", required: true, blocking: true }]);
    const caseRow = repo.createCase({ emailAddress: "worker@example.test", threadId: "hr", organizationId: org.id, caseTypeCode: hr.code });
    expect(repo.effectiveRequirements(caseRow)).toMatchObject([{ document_type: "employee_id", required: true, blocking: true }]);

    const rules: RuleNode[] = [{ kind: "condition", field: "employment_type", comparator: "=", value: "staff" }];
    repo.updateCaseTypeRules(hr.id, rules);
    expect(evaluateCaseTypeRules(repo, hr, repo.caseTypeRules(repo.getCaseType(hr.code, org.id)!), { employment_type: "staff" }).result).toBe("passed");
    expect(evaluateCaseTypeRules(repo, hr, rules, {}).routing).toBe("human_review");
  });

  it("runs a configured non-academic case through extraction, matrix, rules and the human gate", async () => {
    const repo = fresh();
    const org = repo.createOrganization({ name: "People Operations", refPrefix: "HR" });
    const hr = repo.createCaseType(org.id, { code: "HR_ONBOARDING", name: "HR onboarding", category: "people" });
    repo.replaceDocumentDefinitions(hr.id, [{ key: "employee_id", label: "Employee ID", required: true, blocking: true }]);
    repo.updateCaseTypeRules(hr.id, [{ kind: "condition", field: "name", comparator: "=", value: "ALICE" }]);
    const attachment = await makeTextPdf(["Employee ID", "Name: ALICE"]);
    const email: IncomingEmail = {
      id: "ctr-1", threadId: "ctr-thread", from: "worker@example.test", subject: "HR onboarding",
      body: "Please process my onboarding", receivedAt: new Date().toISOString(), organizationId: org.id,
      caseTypeCode: hr.code, attachments: [{ filename: "employee-id.pdf", mimeType: "application/pdf", content: attachment }],
    };
    const ctx: PipelineContext = { repo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender: new MockSender() } };
    const result = await processEmail(email, ctx);
    expect(result.skipped).not.toBe(true);
    expect(result.autoSent).toBe(false);
    expect(result.reasoning).toMatch(/human review|CaseType matrix/i);
    const gateAudit = repo.db.prepare("SELECT event FROM audit_log WHERE applicant_id = ? AND event = 'case_type_gate'").get(result.applicantId!);
    expect(gateAudit).toBeTruthy();
    expect(repo.getApplicant(result.applicantId!)?.outcome).toBe("undecided");
  });

  it("configures a second organization through the admin CaseType routes", async () => {
    const repo = fresh();
    repo.createStaff("admin", "Administrator", hashPassword("admin123"), "admin");
    const sender = new MockSender();
    const ctx: PipelineContext = { repo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender } };
    const app = createApp({ repo, ctx });
    let server: Server | undefined;
    await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
    try {
      const address = server!.address() as { port: number };
      const base = `http://127.0.0.1:${address.port}`;
      const auth = await webLogin(base, "admin", "admin123");
      expect(auth.status).toBe(302);
      const createOrg = await fetch(`${base}/config/organizations/create`, {
        method: "POST", headers: { cookie: auth.cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ _csrf: auth.csrf, name: "People Operations", ref_prefix: "HR" }), redirect: "manual",
      });
      expect(createOrg.status).toBe(302);
      const org = repo.listOrganizations().find((o) => o.name === "People Operations")!;
      const saveAxes = await fetch(`${base}/config/case-types/axes`, {
        method: "POST", headers: { cookie: auth.cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ _csrf: auth.csrf, organization_id: String(org.id), axes_json: JSON.stringify([{ key: "employment_status", label: "Employment status", values: ["staff", "contractor"] }]) }), redirect: "manual",
      });
      expect(saveAxes.status).toBe(302);
      expect(repo.listOrganizationDocumentAxes(org.id)[0]).toMatchObject({ key: "employment_status", values: ["staff", "contractor"] });
      const createType = await fetch(`${base}/config/case-types/create`, {
        method: "POST", headers: { cookie: auth.cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ _csrf: auth.csrf, organization_id: String(org.id), code: "HR_ONBOARDING", name: "HR onboarding", category: "people" }), redirect: "manual",
      });
      expect(createType.status).toBe(302);
      const hr = repo.getCaseType("HR_ONBOARDING", org.id)!;
      const addDocument = await fetch(`${base}/config/case-types/document`, {
        method: "POST", headers: { cookie: auth.cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ _csrf: auth.csrf, organization_id: String(org.id), case_type_id: String(hr.id), key: "employee_id", label: "Employee ID", required: "1", blocking: "1" }), redirect: "manual",
      });
      expect(addDocument.status).toBe(302);
      const saveRules = await fetch(`${base}/config/case-types/rules`, {
        method: "POST", headers: { cookie: auth.cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ _csrf: auth.csrf, organization_id: String(org.id), case_type_id: String(hr.id), rules_json: JSON.stringify([{ kind: "condition", field: "employment_type", comparator: "=", value: "staff" }]) }), redirect: "manual",
      });
      expect(saveRules.status).toBe(302);
      const page = await (await fetch(`${base}/config?tab=case-types&organization=${org.id}`, { headers: { cookie: auth.cookie } })).text();
      expect(page).toContain("HR onboarding");
      expect(page).toContain("Employee ID");
      expect(page).toContain("employment_type");
      expect(repo.listDocumentDefinitions(hr.id).map((d) => d.key)).toEqual(["employee_id"]);
      expect(repo.caseTypeRules(repo.getCaseType(hr.code, org.id)!)[0].field).toBe("employment_type");
    } finally {
      server?.close();
    }
  });

  it("uses deterministic keyword labels as a real second-tier fallback", async () => {
    const fail = async () => { throw new Error("Gemini unavailable"); };
    const complaint = await classifyWithConfiguredCategories({ subject: "Complaint about fees", body: "This is unacceptable" }, ["complaint", "fee_enquiry", "other"], fail);
    const fee = await classifyWithConfiguredCategories({ subject: "Fees", body: "What is the tuition payment?" }, ["complaint", "fee_enquiry", "other"], fail);
    expect(complaint).toMatchObject({ label: "complaint", source: "fallback" });
    expect(fee).toMatchObject({ label: "fee_enquiry", source: "fallback" });
  });
});
