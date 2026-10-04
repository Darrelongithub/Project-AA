/**
 * Round-3 UX fixes — owner complaints from the master-checklist audit:
 *
 *  U1  Mail / Compose must NEVER open a new browser tab — same-tab
 *      navigation on every surface (nav, mail page, case file).
 *  U2  Case-type setup lists each configured document slot with its
 *      required/blocking state; the checklist is administrator-configurable
 *      and actually drives what the engine requires.
 *  U3  Case-type configuration appears in ONE place — Configuration.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { hashPassword } from "../src/util/password";
import { createApp } from "../src/web/server";
import type { PipelineContext } from "../src/pipeline/adapters";
import { MockSender } from "../src/pipeline/adapters";
import {webLogin, configureTestOrganization } from "./helpers";

let repo: Repo;
let server: ReturnType<ReturnType<typeof createApp>["listen"]> | undefined;

beforeEach(() => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  configureTestOrganization(repo);
  repo.createStaff("admin", "Admin", hashPassword("admin123"), "admin");
});
afterEach(() => { server?.close(); server = undefined; });

async function boot(): Promise<{ base: string; cookie: string; csrf: string }> {
  const ctx: PipelineContext = { repo, adapters: { vision: null as never, watcher: null as never, sender: new MockSender() } };
  const s = createApp({ repo, ctx }).listen(0);
  server = s;
  const base = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
  const { cookie, csrf } = await webLogin(base, "admin", "admin123");
  return { base, cookie, csrf };
}

function mkCase(email: string, caseTypeCode = "SERVICE_REQUEST"): number {
  return repo.createCase({ emailAddress: email, threadId: `t-${email}`, organizationId: 1, caseTypeCode }).id;
}

describe("U1 — no new browser tabs, ever, on mail/compose surfaces", () => {
  it("nav, mail, compose and case pages never emit target=_blank", async () => {
    const a = mkCase("tabfree@example.org");
    const { base, cookie } = await boot();
    for (const url of ["/", "/mail", `/compose?case=${a}`, `/case/${a}`]) {
      const page = await (await fetch(`${base}${url}`, { headers: { cookie } })).text();
      expect(page, `target=_blank leaked on ${url}`).not.toContain('target="_blank"');
    }
  });

  it("the case page still offers a composer link (same tab)", async () => {
    const a = mkCase("still@example.org");
    const { base, cookie } = await boot();
    const page = await (await fetch(`${base}/case/${a}`, { headers: { cookie } })).text();
    expect(page).toContain(`/case/${a}/compose`);
  });
});

describe("U3 — case-type configuration lives in ONE place (Configuration)", () => {
  it("the legacy courses tab redirects to the staff area", async () => {
    const { base, cookie } = await boot();
    const res = await fetch(`${base}/config?tab=courses`, { headers: { cookie }, redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") ?? "").toContain("/staff");
  });

  it("the Configuration page no longer offers a legacy course tab", async () => {
    const { base, cookie } = await boot();
    const page = await (await fetch(`${base}/config`, { headers: { cookie } })).text();
    expect(page).not.toContain('/config?tab=courses');
    expect(page).not.toContain("Course configuration");
  });

  it("the staff area links to the one configuration home and hosts the visibility matrix", async () => {
    repo.createStaff("officer", "Case Officer", "x".repeat(60), "user");
    const { base, cookie } = await boot();
    const page = await (await fetch(`${base}/staff`, { headers: { cookie } })).text();
    expect(page).toContain("Workflow configuration");
    expect(page).toContain('href="/config?tab=case-types"');
    expect(page).toContain("3 configured case types");
    // The scope matrix is the staff area's own job: case types × staff.
    expect(page).toContain("Visibility scope");
    expect(page).toContain('action="/staff/scopes"');
    expect(page).toContain('name="case_types"');
    // No second, stale configuration surface.
    expect(page).not.toContain("Course configuration");
    expect(page).not.toContain("Enforced entry requirements");
  });

  it("saving a scope lands back on the staff area and is visible there", async () => {
    const { base, cookie, csrf } = await boot();
    repo.createStaff("officer", "Case Officer", "x".repeat(60), "user");
    const officer = repo.getStaffByUsername("officer")!;
    const res = await fetch(`${base}/staff/scopes`, {
      method: "POST", redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${csrf}&staff_id=${officer.id}&case_types=VENDOR_INTAKE`,
    });
    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toContain("/staff");
    expect(repo.caseTypeScopesFor(officer.id)).toEqual(["VENDOR_INTAKE"]);
    const page = await (await fetch(`${base}/staff`, { headers: { cookie } })).text();
    expect(page).toContain("vendor intake");
    expect(page).toContain("assigned case types only");
  });
});

describe("U2 — per-case-type document checklists via Configuration", () => {
  it("lists every configured slot with its required/blocking state", async () => {
    const { base, cookie } = await boot();
    const page = await (await fetch(`${base}/config?tab=case-types`, { headers: { cookie } })).text();
    expect(page).toContain('action="/config/case-types/document"');
    expect(page).toContain("SERVICE_REQUEST");
    expect(page).toContain("Request form");
    expect(page).toContain("Identity document");
  });

  it("saving a slot rewrites what the engine requires for that case type only", async () => {
    const { base, cookie, csrf } = await boot();
    const service = repo.getCaseType("SERVICE_REQUEST", 1)!;
    const vendor = repo.getCaseType("VENDOR_INTAKE", 1)!;
    const res = await fetch(`${base}/config/case-types/document`, {
      method: "POST", redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${csrf}&organization_id=1&case_type_id=${service.id}&key=site_survey&label=Site survey&required=1&blocking=1`,
    });
    expect(res.status).toBe(302);
    expect(repo.listDocumentDefinitions(service.id).map((row) => row.key)).toContain("site_survey");

    const serviceCase = repo.getCase(mkCase("conf-service@example.test", "SERVICE_REQUEST"))!;
    expect(repo.effectiveRequirements(serviceCase).map((row) => row.document_type)).toContain("site_survey");
    const vendorCase = repo.getCase(mkCase("conf-vendor@example.test", "VENDOR_INTAKE"))!;
    expect(repo.effectiveRequirements(vendorCase).map((row) => row.document_type)).not.toContain("site_survey");
    expect(repo.listDocumentDefinitions(vendor.id).map((row) => row.key)).toEqual(["services_agreement", "insurance_certificate"]);
  });

  it("a slot can be removed again", async () => {
    const { base, cookie, csrf } = await boot();
    const service = repo.getCaseType("SERVICE_REQUEST", 1)!;
    repo.upsertDocumentDefinition(service.id, { key: "site_survey", label: "Site survey", required: true, blocking: true });
    const res = await fetch(`${base}/config/case-types/document-delete`, {
      method: "POST", redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${csrf}&organization_id=1&case_type_id=${service.id}&key=site_survey`,
    });
    expect(res.status).toBe(302);
    expect(repo.listDocumentDefinitions(service.id).map((row) => row.key)).not.toContain("site_survey");
  });

  it("an invalid rule tree is refused and the previous configuration stays", async () => {
    const { base, cookie, csrf } = await boot();
    const service = repo.getCaseType("SERVICE_REQUEST", 1)!;
    const before = JSON.stringify(repo.caseTypeRules(service));
    const res = await fetch(`${base}/config/case-types/rules`, {
      method: "POST", redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${csrf}&organization_id=1&case_type_id=${service.id}&rules_json=${encodeURIComponent(JSON.stringify([{ kind: "condition", field: "__proto__", comparator: "=", value: "x" }]))}`,
    });
    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toContain("not saved");
    expect(JSON.stringify(repo.caseTypeRules(service))).toBe(before);
  });

  it("non-admin staff cannot change checklists", async () => {
    repo.createStaff("officer", "Officer", hashPassword("officer123"), "user");
    const { base } = await boot();
    const { cookie, csrf } = await webLogin(base, "officer", "officer123");
    const service = repo.getCaseType("SERVICE_REQUEST", 1)!;
    const res = await fetch(`${base}/config/case-types/document`, {
      method: "POST", redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${csrf}&organization_id=1&case_type_id=${service.id}&key=site_survey&label=Site survey&required=1&blocking=1`,
    });
    expect(res.status).toBe(403);
    expect(repo.listDocumentDefinitions(service.id).map((row) => row.key)).not.toContain("site_survey");
  });
});
