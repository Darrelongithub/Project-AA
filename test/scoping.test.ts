/**
 * OR-8 — Assignment & visibility scoping.
 *
 * Acceptance:
 *  1. A staff member scoped to schools sees ONLY cases from those schools on
 *     EVERY surface: queue, admissions levels, dashboard counts, search,
 *     direct case URLs, case actions and the search API.
 *  2. Scoping is assigned in ONE action (a single save covers the whole
 *     school set) from ONE matrix page (Staff configuration) — nowhere else.
 *  3. Admins are never scoped; unscoped staff keep full visibility, while an
 *     explicitly empty scope means no access.
 *  4. Cases with no programme are never visible to scoped staff (no
 *     accidental over-sharing), and out-of-scope access is refused loudly.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { webLogin } from "./helpers";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { hashPassword } from "../src/util/password";
import { createApp } from "../src/web/server";
import type { PipelineContext } from "../src/pipeline/adapters";
import { QUEUES } from "../src/admissions/queues";
import { MockSender } from "../src/pipeline/adapters";

let repo: Repo;

beforeEach(() => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  repo.createStaff("admin", "System Administrator", hashPassword("admin123"), "admin");
  repo.createStaff("law", "Law Officer", hashPassword("law-pass-99"), "user");
  repo.createStaff("nurse", "Nursing Officer", hashPassword("nur-pass-99"), "user");
  repo.createStaff("flo", "Floating Officer", hashPassword("flo-pass-99"), "user");
  // scope in ONE action each
  repo.setScopes(repo.getStaffByUsername("law")!.id, ["School of Law"]);
  repo.setScopes(repo.getStaffByUsername("nurse")!.id, ["School of Nursing"]);
});

function mkCase(email: string, programme: string | null, name: string) {
  const a = repo.getOrCreateApplicant(email, `t-${email}`);
  repo.updateApplicant(a.id, { full_name: name, ...(programme ? { programme } : {}) });
  return repo.getApplicant(a.id)!;
}

let cases: { law: { id: number; ref_number: string }; nurse: { id: number; ref_number: string }; comp: { id: number; ref_number: string }; none: { id: number; ref_number: string } };

beforeEach(() => {
  const l = mkCase("law-applicant@example.org", "LLB", "Law Student");
  const n = mkCase("nurse-applicant@example.org", "BNS", "Nurse Student");
  const cp = mkCase("comp-applicant@example.org", "BCS", "Comp Student");
  const nn = mkCase("lost-applicant@example.org", null, "No Programme");
  cases = {
    law: { id: l.id, ref_number: l.ref_number },
    nurse: { id: n.id, ref_number: n.ref_number },
    comp: { id: cp.id, ref_number: cp.ref_number },
    none: { id: nn.id, ref_number: nn.ref_number },
  };
});

describe("queue, admissions and dashboard are scoped", () => {
  it("the queue shows only the scoped schools' cases (every queue tab)", async () => {
    const { base } = await startServer();
    const law = await loginAs(base, "law", "law-pass-99");
    let sawOwn = false;
    for (const q of QUEUES.map((x) => x.key)) {
      const page = await (await fetch(`${base}/applicants?queue=${q}`, { headers: { cookie: law.cookie } })).text();
      if (page.includes(cases.law.ref_number)) sawOwn = true;
      expect(page).not.toContain(cases.nurse.ref_number);
      expect(page).not.toContain(cases.comp.ref_number);
      expect(page).not.toContain(cases.none.ref_number);
    }
    expect(sawOwn).toBe(true);
    // unscoped officer sees everything somewhere
    const flo = await loginAs(base, "flo", "flo-pass-99");
    const combined = (await Promise.all(QUEUES.map(async (x) =>
      (await fetch(`${base}/applicants?queue=${x.key}`, { headers: { cookie: flo.cookie } })).text()
    ))).join("\n");
    for (const c of Object.values(cases)) expect(combined).toContain(c.ref_number);
  });

  it("search finds only in-scope cases", async () => {
    const { base } = await startServer();
    const law = await loginAs(base, "law", "law-pass-99");
    const hit = await (await fetch(`${base}/applicants?q=Nurse`, { headers: { cookie: law.cookie } })).text();
    expect(hit).not.toContain(cases.nurse.ref_number);
    const own = await (await fetch(`${base}/applicants?q=Law+Student`, { headers: { cookie: law.cookie } })).text();
    expect(own).toContain(cases.law.ref_number);
  });

  it("the admissions levels and dashboard counts only count in-scope files", async () => {
    const { base } = await startServer();
    const law = await loginAs(base, "law", "law-pass-99");
    const adm = await (await fetch(`${base}/admissions`, { headers: { cookie: law.cookie } })).text();
    expect(adm).toContain(cases.law.ref_number);
    expect(adm).not.toContain(cases.nurse.ref_number);
    const dash = await (await fetch(`${base}/`, { headers: { cookie: law.cookie } })).text();
    expect(dash).not.toContain(cases.nurse.ref_number);
    // admin still sees everyone
    const admin = await loginAs(base, "admin", "admin123");
    const admAll = await (await fetch(`${base}/admissions`, { headers: { cookie: admin.cookie } })).text();
    for (const c of Object.values(cases)) expect(admAll).toContain(c.ref_number);
  });
});

describe("direct URLs and actions are scoped", () => {
  it("an out-of-scope case URL is refused", async () => {
    const { base } = await startServer();
    const law = await loginAs(base, "law", "law-pass-99");
    const res = await fetch(`${base}/case/${cases.nurse.id}`, { headers: { cookie: law.cookie }, redirect: "manual" });
    expect([403, 404]).toContain(res.status);
    const ok = await fetch(`${base}/case/${cases.law.id}`, { headers: { cookie: law.cookie } });
    expect(ok.status).toBe(200);
  });

  it("caseless-programme cases are invisible to scoped staff but visible to admins", async () => {
    const { base } = await startServer();
    const law = await loginAs(base, "law", "law-pass-99");
    const res = await fetch(`${base}/case/${cases.none.id}`, { headers: { cookie: law.cookie }, redirect: "manual" });
    expect([403, 404]).toContain(res.status);
    const admin = await loginAs(base, "admin", "admin123");
    const ok = await fetch(`${base}/case/${cases.none.id}`, { headers: { cookie: admin.cookie } });
    expect(ok.status).toBe(200);
  });

  it("out-of-scope case actions are refused too", async () => {
    const { base } = await startServer();
    const law = await loginAs(base, "law", "law-pass-99");
    const res = await fetch(`${base}/case/${cases.nurse.id}/note`, {
      method: "POST", headers: { cookie: law.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${law.csrf}&body=sneaky note`, redirect: "manual",
    });
    expect([403, 404]).toContain(res.status);
    expect(repo.notesForApplicant(cases.nurse.id).length).toBe(0);
    // compose is refused as well
    const comp = await fetch(`${base}/case/${cases.nurse.id}/compose?template=missing_documents`, {
      headers: { cookie: law.cookie }, redirect: "manual",
    });
    expect([403, 404]).toContain(comp.status);
  });

  it("the search API never leaks out-of-scope applicants", async () => {
    const { base } = await startServer();
    const law = await loginAs(base, "law", "law-pass-99");
    const res = await fetch(`${base}/api/search?q=${encodeURIComponent("Nurse Student")}`, { headers: { cookie: law.cookie } });
    const json = (await res.json()) as { applicants: Array<{ ref_number: string }> };
    expect(json.applicants.map((a) => a.ref_number)).not.toContain(cases.nurse.ref_number);
    const own = await fetch(`${base}/api/search?q=${encodeURIComponent("Law Student")}`, { headers: { cookie: law.cookie } });
    const ownJson = (await own.json()) as { applicants: Array<{ ref_number: string }> };
    expect(ownJson.applicants.map((a) => a.ref_number)).toContain(cases.law.ref_number);
  });
});

describe("one matrix page, one action", () => {
  it("the staff page carries the school × staff scope matrix", async () => {
    const { base } = await startServer();
    const admin = await loginAs(base, "admin", "admin123");
    const page = await (await fetch(`${base}/staff`, { headers: { cookie: admin.cookie } })).text();
    expect(page).toContain("Visibility scope");
    for (const school of ["School of Law", "School of Nursing", "School of Computing Sciences"]) {
      expect(page).toContain(school);
    }
    expect(page).toContain('action="/staff/scopes"');
    // officers cannot manage scopes
    const law = await loginAs(base, "law", "law-pass-99");
    const denied = await fetch(`${base}/staff`, { headers: { cookie: law.cookie }, redirect: "manual" });
    expect([302, 403]).toContain(denied.status);
  });

  it("saving the matrix updates a whole school set in ONE action", async () => {
    const { base } = await startServer();
    const admin = await loginAs(base, "admin", "admin123");
    const floId = repo.getStaffByUsername("flo")!.id;
    const res = await fetch(`${base}/staff/scopes`, {
      method: "POST", headers: { cookie: admin.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${admin.csrf}&staff_id=${floId}&schools=${encodeURIComponent("School of Law")}&schools=${encodeURIComponent("School of Computing Sciences")}`,
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(repo.scopesFor(floId).sort()).toEqual(["School of Computing Sciences", "School of Law"]);
    // saving again with fewer schools REPLACES the set (still one action)
    const res2 = await fetch(`${base}/staff/scopes`, {
      method: "POST", headers: { cookie: admin.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${admin.csrf}&staff_id=${floId}&schools=${encodeURIComponent("School of Nursing")}`,
      redirect: "manual",
    });
    expect(res2.status).toBe(302);
    expect(repo.scopesFor(floId)).toEqual(["School of Nursing"]);
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
    expect(repo.visibleSchoolsFor(repo.getStaff(floId)!)).toEqual([]);
    expect(repo.mailFolderCounts({ schools: [] }).all).toBe(0);

    const restore = await fetch(`${base}/staff/scopes`, {
      method: "POST", headers: { cookie: admin.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${admin.csrf}&staff_id=${floId}&scope_mode=unscoped`,
      redirect: "manual",
    });
    expect(restore.status).toBe(302);
    expect(repo.visibleSchoolsFor(repo.getStaff(floId)!)).toBeNull();
    const page = await (await fetch(`${base}/staff`, { headers: { cookie: admin.cookie } })).text();
    expect(page).toContain("Saving an empty selection gives");
    expect(page).toContain("Restore full visibility");
  });

  it("no other page hosts scope editing", async () => {
    const { base } = await startServer();
    const admin = await loginAs(base, "admin", "admin123");
    // Round 3: /config?tab=courses now redirects to /staff — the staff page
    // IS the one (and only) place hosting scope editing, so it's excluded.
    for (const path of ["/config", "/settings", "/templates"]) {
      const page = await (await fetch(`${base}${path}`, { headers: { cookie: admin.cookie } })).text();
      expect(page).not.toContain('action="/staff/scopes"');
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
