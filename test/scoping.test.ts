/**
 * OR-8 — Assignment & visibility scoping.
 *
 * Acceptance:
 *  1. A staff member scoped to case types sees ONLY cases of those types on
 *     EVERY surface: queue, case levels, dashboard counts, search, direct case
 *     URLs, case actions and the search API.
 *  2. Scoping is assigned in ONE action (a single save covers the whole
 *     case-type set) from ONE matrix page (Staff configuration) — nowhere else.
 *  3. Admins are never scoped; unscoped staff keep full visibility, while an
 *     explicitly empty scope means no access.
 *  4. A case with no case type is never visible to scoped staff (no accidental
 *     over-sharing), and out-of-scope access is refused loudly.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureTestOrganization, webLogin } from "./helpers";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { hashPassword } from "../src/util/password";
import { createApp } from "../src/web/server";
import type { PipelineContext } from "../src/pipeline/adapters";
import { QUEUES } from "../src/rules/queues";
import { MockSender } from "../src/pipeline/adapters";

let repo: Repo;

beforeEach(() => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  configureTestOrganization(repo);
  repo.createStaff("admin", "System Administrator", hashPassword("admin123"), "admin");
  repo.createStaff("requests", "Requests Officer", hashPassword("req-pass-99"), "user");
  repo.createStaff("vendors", "Vendor Officer", hashPassword("ven-pass-99"), "user");
  repo.createStaff("flo", "Floating Officer", hashPassword("flo-pass-99"), "user");
  // Scoped in ONE action each.
  repo.setCaseTypeScopes(repo.getStaffByUsername("requests")!.id, ["SERVICE_REQUEST"]);
  repo.setCaseTypeScopes(repo.getStaffByUsername("vendors")!.id, ["VENDOR_INTAKE"]);
});

function mkCase(email: string, caseTypeCode: string | undefined, fullName: string) {
  const a = repo.createCase({ emailAddress: email, threadId: `t-${email}`, organizationId: 1, fullName, caseTypeCode });
  return repo.getApplicant(a.id)!;
}

let cases: {
  request: { id: number; ref_number: string };
  vendor: { id: number; ref_number: string };
  access: { id: number; ref_number: string };
  untyped: { id: number; ref_number: string };
};

beforeEach(() => {
  const r = mkCase("requests@example.org", "SERVICE_REQUEST", "Alex Morgan");
  const v = mkCase("vendors@example.org", "VENDOR_INTAKE", "Sam Okonkwo");
  const ac = mkCase("access@example.org", "ACCESS_REQUEST", "Uma Muturi");
  const un = mkCase("untyped@example.org", undefined, "Unclassified Case");
  cases = {
    request: { id: r.id, ref_number: r.ref_number },
    vendor: { id: v.id, ref_number: v.ref_number },
    access: { id: ac.id, ref_number: ac.ref_number },
    untyped: { id: un.id, ref_number: un.ref_number },
  };
});

describe("queue, case levels and dashboard are scoped", () => {
  it("the queue shows only the scoped case types (every queue tab)", async () => {
    const { base } = await startServer();
    const requests = await loginAs(base, "requests", "req-pass-99");
    let sawOwn = false;
    for (const q of QUEUES.map((x) => x.key)) {
      const page = await (await fetch(`${base}/applicants?queue=${q}`, { headers: { cookie: requests.cookie } })).text();
      if (page.includes(cases.request.ref_number)) sawOwn = true;
      expect(page).not.toContain(cases.vendor.ref_number);
      expect(page).not.toContain(cases.access.ref_number);
      expect(page).not.toContain(cases.untyped.ref_number);
    }
    expect(sawOwn).toBe(true);
    // An unscoped officer sees everything somewhere.
    const flo = await loginAs(base, "flo", "flo-pass-99");
    const combined = (await Promise.all(QUEUES.map(async (x) =>
      (await fetch(`${base}/applicants?queue=${x.key}`, { headers: { cookie: flo.cookie } })).text()
    ))).join("\n");
    for (const c of Object.values(cases)) expect(combined).toContain(c.ref_number);
  });

  it("search finds only in-scope cases", async () => {
    const { base } = await startServer();
    const requests = await loginAs(base, "requests", "req-pass-99");
    const hit = await (await fetch(`${base}/applicants?q=Sam`, { headers: { cookie: requests.cookie } })).text();
    expect(hit).not.toContain(cases.vendor.ref_number);
    const own = await (await fetch(`${base}/applicants?q=${encodeURIComponent("Alex Morgan")}`, { headers: { cookie: requests.cookie } })).text();
    expect(own).toContain(cases.request.ref_number);
  });

  it("the case levels and dashboard counts only count in-scope files", async () => {
    const { base } = await startServer();
    const requests = await loginAs(base, "requests", "req-pass-99");
    const levels = await (await fetch(`${base}/cases`, { headers: { cookie: requests.cookie } })).text();
    expect(levels).toContain(cases.request.ref_number);
    expect(levels).not.toContain(cases.vendor.ref_number);
    const dash = await (await fetch(`${base}/`, { headers: { cookie: requests.cookie } })).text();
    expect(dash).not.toContain(cases.vendor.ref_number);
    // An admin still sees everyone.
    const admin = await loginAs(base, "admin", "admin123");
    const all = await (await fetch(`${base}/cases`, { headers: { cookie: admin.cookie } })).text();
    for (const c of Object.values(cases)) expect(all).toContain(c.ref_number);
  });
});

describe("direct URLs and actions are scoped", () => {
  it("an out-of-scope case URL is refused", async () => {
    const { base } = await startServer();
    const requests = await loginAs(base, "requests", "req-pass-99");
    const res = await fetch(`${base}/case/${cases.vendor.id}`, { headers: { cookie: requests.cookie }, redirect: "manual" });
    expect([403, 404]).toContain(res.status);
    const ok = await fetch(`${base}/case/${cases.request.id}`, { headers: { cookie: requests.cookie } });
    expect(ok.status).toBe(200);
  });

  it("a case with no case type is invisible to scoped staff but visible to admins", async () => {
    const { base } = await startServer();
    const requests = await loginAs(base, "requests", "req-pass-99");
    const res = await fetch(`${base}/case/${cases.untyped.id}`, { headers: { cookie: requests.cookie }, redirect: "manual" });
    expect([403, 404]).toContain(res.status);
    const admin = await loginAs(base, "admin", "admin123");
    const ok = await fetch(`${base}/case/${cases.untyped.id}`, { headers: { cookie: admin.cookie } });
    expect(ok.status).toBe(200);
  });

  it("out-of-scope case actions are refused too", async () => {
    const { base } = await startServer();
    const requests = await loginAs(base, "requests", "req-pass-99");
    const res = await fetch(`${base}/case/${cases.vendor.id}/note`, {
      method: "POST", headers: { cookie: requests.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${requests.csrf}&body=sneaky note`, redirect: "manual",
    });
    expect([403, 404]).toContain(res.status);
    expect(repo.notesForApplicant(cases.vendor.id).length).toBe(0);
    // Compose is refused as well.
    const comp = await fetch(`${base}/case/${cases.vendor.id}/compose?template=missing_documents`, {
      headers: { cookie: requests.cookie }, redirect: "manual",
    });
    expect([403, 404]).toContain(comp.status);
  });

  it("the search API never leaks out-of-scope cases", async () => {
    const { base } = await startServer();
    const requests = await loginAs(base, "requests", "req-pass-99");
    const res = await fetch(`${base}/api/search?q=${encodeURIComponent("Sam Okonkwo")}`, { headers: { cookie: requests.cookie } });
    const json = (await res.json()) as { applicants: Array<{ ref_number: string }> };
    expect(json.applicants.map((a) => a.ref_number)).not.toContain(cases.vendor.ref_number);
    const own = await fetch(`${base}/api/search?q=${encodeURIComponent("Alex Morgan")}`, { headers: { cookie: requests.cookie } });
    const ownJson = (await own.json()) as { applicants: Array<{ ref_number: string }> };
    expect(ownJson.applicants.map((a) => a.ref_number)).toContain(cases.request.ref_number);
  });
});

describe("one matrix page, one action", () => {
  it("the staff page carries the case-type × staff scope matrix", async () => {
    const { base } = await startServer();
    const admin = await loginAs(base, "admin", "admin123");
    const page = await (await fetch(`${base}/staff`, { headers: { cookie: admin.cookie } })).text();
    expect(page).toContain("Visibility scope");
    for (const type of ["service request", "vendor intake", "access request"]) {
      expect(page).toContain(type);
    }
    expect(page).toContain('action="/staff/scopes"');
    expect(page).toContain('name="case_types"');
    // Officers cannot manage scopes.
    const requests = await loginAs(base, "requests", "req-pass-99");
    const denied = await fetch(`${base}/staff`, { headers: { cookie: requests.cookie }, redirect: "manual" });
    expect([302, 403]).toContain(denied.status);
  });

  it("saving the matrix updates a whole case-type set in ONE action", async () => {
    const { base } = await startServer();
    const admin = await loginAs(base, "admin", "admin123");
    const floId = repo.getStaffByUsername("flo")!.id;
    const res = await fetch(`${base}/staff/scopes`, {
      method: "POST", headers: { cookie: admin.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${admin.csrf}&staff_id=${floId}&case_types=SERVICE_REQUEST&case_types=ACCESS_REQUEST`,
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(repo.caseTypeScopesFor(floId)).toEqual(["ACCESS_REQUEST", "SERVICE_REQUEST"]);
    expect(repo.caseTypeScopeModeFor(floId)).toBe("scoped");
    // Saving again with fewer case types REPLACES the set (still one action).
    const res2 = await fetch(`${base}/staff/scopes`, {
      method: "POST", headers: { cookie: admin.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${admin.csrf}&staff_id=${floId}&case_types=VENDOR_INTAKE`,
      redirect: "manual",
    });
    expect(res2.status).toBe(302);
    expect(repo.caseTypeScopesFor(floId)).toEqual(["VENDOR_INTAKE"]);
  });

  it("an unknown case type is refused instead of silently hiding cases", async () => {
    const { base } = await startServer();
    const admin = await loginAs(base, "admin", "admin123");
    const floId = repo.getStaffByUsername("flo")!.id;
    const res = await fetch(`${base}/staff/scopes`, {
      method: "POST", headers: { cookie: admin.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${admin.csrf}&staff_id=${floId}&case_types=NOT_A_TYPE`,
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toContain("Unknown case type");
    expect(repo.caseTypeScopesFor(floId)).toEqual([]);
    expect(repo.caseTypeScopeModeFor(floId)).toBe("unscoped");
  });

  it("an empty saved selection is explicit no access, and full visibility is a separate action", async () => {
    const { base } = await startServer();
    const admin = await loginAs(base, "admin", "admin123");
    const floId = repo.getStaffByUsername("flo")!.id;
    const noAccess = await fetch(`${base}/staff/scopes`, {
      method: "POST", headers: { cookie: admin.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${admin.csrf}&staff_id=${floId}`,
      redirect: "manual",
    });
    expect(noAccess.status).toBe(302);
    expect(repo.visibleCaseTypesFor(repo.getStaff(floId)!)).toEqual([]);
    expect(repo.mailFolderCounts({ caseTypes: [] }).all).toBe(0);

    const restore = await fetch(`${base}/staff/scopes`, {
      method: "POST", headers: { cookie: admin.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${admin.csrf}&staff_id=${floId}&scope_mode=unscoped`,
      redirect: "manual",
    });
    expect(restore.status).toBe(302);
    expect(repo.visibleCaseTypesFor(repo.getStaff(floId)!)).toBeNull();
    const page = await (await fetch(`${base}/staff`, { headers: { cookie: admin.cookie } })).text();
    expect(page).toContain("Saving an empty selection gives");
    expect(page).toContain("Restore full visibility");
  });

  it("no other page hosts scope editing", async () => {
    const { base } = await startServer();
    const admin = await loginAs(base, "admin", "admin123");
    for (const path of ["/config", "/settings", "/templates"]) {
      const page = await (await fetch(`${base}${path}`, { headers: { cookie: admin.cookie } })).text();
      expect(page, `${path} must not host scope editing`).not.toContain('action="/staff/scopes"');
    }
  });
});

// ── harness ────────────────────────────────────────────────────────────────

let server: ReturnType<ReturnType<typeof createApp>["listen"]> | undefined;

async function startServer(): Promise<{ base: string }> {
  const ctx: PipelineContext = { repo, adapters: { vision: null as never, watcher: null as never, sender: new MockSender() } };
  const app = createApp({ repo, ctx });
  server = app.listen(0);
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

async function loginAs(base: string, username: string, password: string): Promise<{ cookie: string; csrf: string }> {
  const { cookie, csrf } = await webLogin(base, username, password);
  return { cookie, csrf };
}

afterEach(() => {
  server?.close();
  server = undefined;
});
