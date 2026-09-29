/** Audit Group B — organization scoping of admin write surfaces.
 * Tenant admins must not reach other organizations' CaseType catalogues,
 * the Organization-1 academic-compat routes, other orgs' templates, or
 * other orgs' cases via bulk re-evaluate. Installation-owner admins keep
 * their (test-pinned) cross-org CaseType management.
 */
import { describe, expect, it } from "vitest";
import type { Server } from "http";
import { webLogin } from "./helpers";
import { createApp } from "../src/web/server";
import { hashPassword } from "../src/util/password";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";

function fresh(): { repo: Repo; org2: number; hrType: number; org1Type: number } {
  const repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  repo.createStaff("admin", "Administrator", hashPassword("admin123"), "admin");
  const org = repo.createOrganization({ name: "People Operations", refPrefix: "HR" });
  repo.createStaff("admin2", "HR Admin", hashPassword("hrpass99"), "admin", false, org.id);
  const hr = repo.createCaseType(org.id, { code: "HR_ONBOARDING", name: "HR onboarding", category: "people" });
  const org1 = repo.createCaseType(1, { code: "ORG1_SENTINEL", name: "Org1 Sentinel Type", category: "academic" });
  return { repo, org2: org.id, hrType: hr.id, org1Type: org1.id };
}

async function boot(repo: Repo): Promise<{ base: string; close: () => Promise<void> }> {
  const sender = new MockSender();
  const ctx: PipelineContext = { repo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender } };
  const app = createApp({ repo, ctx });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = server.address() as { port: number };
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

async function post(base: string, cookie: string, csrf: string, path: string, body: Record<string, string>) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: csrf, ...body }),
    redirect: "manual",
  });
}

describe("audit B — tenant admins are confined to their own organization", () => {
  it("refuses cross-org CaseType writes", async () => {
    const { repo, hrType } = fresh();
    const { base, close } = await boot(repo);
    try {
      const auth = await webLogin(base, "admin2", "hrpass99");
      expect(auth.status).toBe(302);
      const before = repo.listCaseTypes(1).length;

      const create = await post(base, auth.cookie, auth.csrf, "/config/case-types/create",
        { organization_id: "1", code: "HIJACK", name: "Hijacked", category: "general" });
      expect(create.status).toBe(302);
      expect(decodeURIComponent(create.headers.get("location") ?? "")).toContain("outside your administration scope");
      expect(repo.listCaseTypes(1).length).toBe(before);

      const axes = await post(base, auth.cookie, auth.csrf, "/config/case-types/axes",
        { organization_id: "1", axes_json: JSON.stringify([{ key: "x", label: "X", values: ["y"] }]) });
      expect(axes.status).toBe(302);
      expect(decodeURIComponent(axes.headers.get("location") ?? "")).toContain("outside your administration scope");
      expect(repo.listOrganizationDocumentAxes(1)).toEqual([]);

      const rules = await post(base, auth.cookie, auth.csrf, "/config/case-types/rules",
        { organization_id: "1", case_type_id: String(hrType), rules_json: "[]" });
      expect(decodeURIComponent(rules.headers.get("location") ?? "")).toContain("outside your administration scope");

      // Own-org writes still work.
      const own = await post(base, auth.cookie, auth.csrf, "/config/case-types/axes",
        { organization_id: String(repo.getOrganization(2)!.id), axes_json: JSON.stringify([{ key: "x", label: "X", values: ["y"] }]) });
      expect(own.status).toBe(302);
      expect(decodeURIComponent(own.headers.get("location") ?? "")).not.toContain("outside your administration scope");
    } finally {
      await close();
    }
  });

  it("pins the tenant case-types tab to the tenant's own catalogue", async () => {
    const { repo } = fresh();
    const { base, close } = await boot(repo);
    try {
      const auth = await webLogin(base, "admin2", "hrpass99");
      const res = await fetch(`${base}/config?tab=case-types&organization=1`, { headers: { cookie: auth.cookie } });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain('<select name="organization"');
      expect(html).toContain("People Operations");
      expect(html).not.toContain("Org1 Sentinel Type");
    } finally {
      await close();
    }
  });

  it("refuses tenant writes on academic-compat and global routes", async () => {
    const { repo } = fresh();
    const { base, close } = await boot(repo);
    try {
      const auth = await webLogin(base, "admin2", "hrpass99");

      const school = await post(base, auth.cookie, auth.csrf, "/config/schools/add", { name: "Hijack Faculty" });
      expect(school.headers.get("location")).toContain("Organization+1+only");
      expect(repo.listSchools()).not.toContain("Hijack Faculty");

      const cat = await post(base, auth.cookie, auth.csrf, "/config/requirements/catalogue-add", { system: "KCSE", name: "Hijack Subject" });
      expect(cat.headers.get("location")).toContain("Organization+1+only");

      const intake = await post(base, auth.cookie, auth.csrf, "/settings/lists/add", { intake: "Hijack Intake" });
      expect(intake.headers.get("location")).toContain("Use+CaseTypes");
      expect(repo.listIntakes()).not.toContain("Hijack Intake");

      const org = await post(base, auth.cookie, auth.csrf, "/config/organizations/create", { name: "Hijack Org", ref_prefix: "HJ" });
      expect(decodeURIComponent(org.headers.get("location") ?? "")).toContain("installation administrator");
      expect(repo.listOrganizations().some((o) => o.name === "Hijack Org")).toBe(false);

      const dl = await post(base, auth.cookie, auth.csrf, "/settings/intake-deadline", { name: "x", deadline: "2030-01-01" });
      expect(dl.headers.get("location")).toContain("Use+CaseTypes");
    } finally {
      await close();
    }
  });

  it("scopes bulk re-evaluate to the acting org and education cases", async () => {
    const { repo } = fresh();
    // Legacy (casetype-less) org-1 applicant = education case.
    const edu = repo.getOrCreateApplicant("student@example.test", "thread-edu");
    // Generic org-2 HR case.
    const gen = repo.createCase({ emailAddress: "worker@example.test", threadId: "thread-hr", organizationId: 2, caseTypeCode: "HR_ONBOARDING" });
    expect(repo.educationCaseFor(repo.requireApplicant(edu.id))).toBe(true);
    expect(repo.educationCaseFor(repo.requireApplicant(gen.id))).toBe(false);
    const { base, close } = await boot(repo);
    try {
      const tenant = await webLogin(base, "admin2", "hrpass99");
      const r1 = await post(base, tenant.cookie, tenant.csrf, "/config/reevaluate-open", {});
      expect(r1.status).toBe(302);
      expect(decodeURIComponent(r1.headers.get("location") ?? "")).toContain("skipped");
      const reruns = (id: number) => repo.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE applicant_id = ? AND event = 'evaluation_rerun'").get(id) as { n: number };
      expect(reruns(edu.id).n).toBe(0);
      expect(reruns(gen.id).n).toBe(0);

      const owner = await webLogin(base, "admin", "admin123");
      const r2 = await post(base, owner.cookie, owner.csrf, "/config/reevaluate-open", {});
      expect(r2.status).toBe(302);
      expect(reruns(edu.id).n).toBe(1);
      expect(reruns(gen.id).n).toBe(0);
    } finally {
      await close();
    }
  });

  it("validates template CaseType links", async () => {
    const { repo, org1Type, hrType } = fresh();
    const { base, close } = await boot(repo);
    try {
      const tenant = await webLogin(base, "admin2", "hrpass99");
      const bad = await post(base, tenant.cookie, tenant.csrf, "/templates/create",
        { key: "x_tenant", name: "X Tenant", case_type_id: String(org1Type) });
      expect(bad.status).toBe(302);
      expect(decodeURIComponent(bad.headers.get("location") ?? "")).toContain("Unknown CaseType");
      expect(repo.getTemplate("x_tenant", 2)).toBeFalsy();

      const good = await post(base, tenant.cookie, tenant.csrf, "/templates/create",
        { key: "hr_welcome", name: "HR Welcome", case_type_id: String(hrType) });
      expect(good.status).toBe(302);
      expect(repo.getTemplate("hr_welcome", 2, hrType)).toBeTruthy();
    } finally {
      await close();
    }
  });

  it("refuses junk automation categories", async () => {
    const { repo } = fresh();
    expect(() => repo.setAutomationMode("NURSING", "draft")).toThrow("Unknown automation category");
    expect(() => repo.setAutomationMode("normal", "draft")).not.toThrow();
    repo.setAutomationMode("normal", "auto");
    const { base, close } = await boot(repo);
    try {
      const owner = await webLogin(base, "admin", "admin123");
      const bad = await post(base, owner.cookie, owner.csrf, "/settings/automation/category", { category: "NURSING", mode: "draft" });
      expect(bad.status).toBe(302);
      expect(decodeURIComponent(bad.headers.get("location") ?? "")).toContain("Unknown automation category");
      expect(repo.db.prepare("SELECT COUNT(*) AS n FROM automation_config WHERE category = 'NURSING'").get() as { n: number }).toMatchObject({ n: 0 });
    } finally {
      await close();
    }
  });

  it("control: installation owners keep cross-org CaseType management", async () => {
    const { repo } = fresh();
    const { base, close } = await boot(repo);
    try {
      const owner = await webLogin(base, "admin", "admin123");
      const res = await post(base, owner.cookie, owner.csrf, "/config/case-types/create",
        { organization_id: "2", code: "HR_EXIT", name: "HR exit", category: "people" });
      expect(res.status).toBe(302);
      expect(decodeURIComponent(res.headers.get("location") ?? "")).not.toContain("outside your administration scope");
      expect(repo.listCaseTypes(2).some((t) => t.code === "HR_EXIT")).toBe(true);
    } finally {
      await close();
    }
  });
});
