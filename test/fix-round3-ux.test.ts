/**
 * Round-3 UX fixes — owner complaints from the master-checklist audit:
 *
 *  U1  Mail / Compose must NEVER open a new browser tab — same-tab
 *      navigation on every surface (nav, mail page, case file).
 *  U2  Course setup = list courses → inside each, tick required items via
 *      checkboxes. The per-course document checklist becomes staff-
 *      configurable and actually drives what the engine requires.
 *  U3  Course configuration appears in ONE place — the staff area — not
 *      also on the Configuration page (old link redirects).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { DEFAULT_REQUIREMENTS } from "../src/config";
import { hashPassword } from "../src/util/password";
import { createApp } from "../src/web/server";
import type { PipelineContext } from "../src/pipeline/adapters";
import { MockSender } from "../src/pipeline/adapters";
import { webLogin } from "./helpers";

let repo: Repo;
let server: ReturnType<ReturnType<typeof createApp>["listen"]> | undefined;

beforeEach(() => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  repo.seedBaseRequirements(DEFAULT_REQUIREMENTS);
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

function mkApplicant(email: string, programme: string): number {
  const a = repo.getOrCreateApplicant(email, `t-${email}`);
  repo.updateApplicant(a.id, { programme });
  return a.id;
}

describe("U1 — no new browser tabs, ever, on mail/compose surfaces", () => {
  it("nav, mail, compose and case pages never emit target=_blank", async () => {
    const a = mkApplicant("tabfree@example.org", "BNS");
    const { base, cookie } = await boot();
    for (const url of ["/", "/mail", `/compose?case=${a}`, `/case/${a}`]) {
      const page = await (await fetch(`${base}${url}`, { headers: { cookie } })).text();
      expect(page, `target=_blank leaked on ${url}`).not.toContain('target="_blank"');
    }
  });

  it("the case page still offers a composer link (same tab)", async () => {
    const a = mkApplicant("still@example.org", "BNS");
    const { base, cookie } = await boot();
    const page = await (await fetch(`${base}/case/${a}`, { headers: { cookie } })).text();
    expect(page).toContain(`/case/${a}/compose`);
  });
});

describe("U3 — course configuration lives in ONE place (the staff area)", () => {
  it("/config?tab=courses redirects to the staff area", async () => {
    const { base, cookie } = await boot();
    const res = await fetch(`${base}/config?tab=courses`, { headers: { cookie }, redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") ?? "").toContain("/staff");
  });

  it("the Configuration page no longer offers a Course configuration tab", async () => {
    const { base, cookie } = await boot();
    const page = await (await fetch(`${base}/config`, { headers: { cookie } })).text();
    expect(page).not.toContain('/config?tab=courses');
    expect(page).not.toContain("Course configuration");
  });

  it("the staff area now carries the full course configuration: schools, rename, details, ownership, enforced rules", async () => {
    const { base, cookie } = await boot();
    const page = await (await fetch(`${base}/staff`, { headers: { cookie } })).text();
    for (const school of ["School of Law", "School of Business", "School of Nursing", "School of Computing Sciences"]) {
      expect(page).toContain(school);
    }
    expect(page).toContain("LLB");
    expect(page).toContain('action="/config/schools/rename"');
    expect(page).toContain('action="/config/programme/edit"');
    expect(page).toContain('action="/config/course-owner"');
    expect(page).toContain('action="/settings/lists/add"'); // add a course
    // display == enforce: the enforced rule trees are still printed here
    expect(page).toContain("Enforced entry requirements");
  });

  it("school add/rename flows land back on the staff area, not Configuration", async () => {
    const { base, cookie, csrf } = await boot();
    const res = await fetch(`${base}/config/schools/add`, {
      method: "POST", redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${csrf}&name=School of Aviation`,
    });
    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toContain("/staff");
    const page = await (await fetch(`${base}/staff`, { headers: { cookie } })).text();
    expect(page).toContain("School of Aviation");
  });
});

describe("U2 — per-course document checklists via checkboxes", () => {
  it("lists every course with its required items as tickable boxes (defaults pre-ticked)", async () => {
    const { base, cookie } = await boot();
    const page = await (await fetch(`${base}/staff`, { headers: { cookie } })).text();
    expect(page).toContain('action="/staff/course-docs"');
    // the defaults for a degree course are present as checked boxes
    const llbBlock = /<details id="docs-LLB"[\s\S]*?<\/details>/.exec(page);
    expect(llbBlock).toBeTruthy();
    expect(llbBlock![0]).toContain('name="docs" value="application_form"');
    expect(llbBlock![0]).toMatch(/name="docs" value="application_form"[^>]*checked/);
    // a law-specific item is in LLB's list too
    expect(llbBlock![0]).toContain('name="docs" value="law_personal_statement"');
  });

  it("saving the checkboxes rewrites what the engine requires for that course only", async () => {
    const { base, cookie, csrf } = await boot();
    const res = await fetch(`${base}/staff/course-docs`, {
      method: "POST", redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${csrf}&programme=LLB&docs=application_form&docs=exam_result_slip`,
    });
    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toContain("/staff");
    expect([...(repo.courseDocConfig("LLB") ?? [])].sort()).toEqual(["application_form", "exam_result_slip"]);

    const llb = repo.getApplicant(mkApplicant("conf-llb@example.org", "LLB"))!;
    const required = repo.effectiveRequirements(llb).filter((e) => e.required).map((e) => e.document_type);
    expect(required.sort()).toEqual(["application_form", "exam_result_slip"]);

    // the other courses are untouched — still the full matrix checklist
    const mba = repo.getApplicant(mkApplicant("conf-mba@example.org", "MBA"))!;
    const mbaRequired = repo.effectiveRequirements(mba).filter((e) => e.required).map((e) => e.document_type);
    expect(mbaRequired).toContain("application_form");
    expect(mbaRequired.length).toBeGreaterThan(2);
  });

  it("adding a document not in the course's defaults is respected", async () => {
    const { base, cookie, csrf } = await boot();
    const res = await fetch(`${base}/staff/course-docs`, {
      method: "POST", redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${csrf}&programme=MBA&docs=application_form&docs=undergraduate_transcript&docs=kcpe_cert`,
    });
    expect(res.status).toBe(302);
    const mba = repo.getApplicant(mkApplicant("conf-add@example.org", "MBA"))!;
    const required = repo.effectiveRequirements(mba).filter((e) => e.required).map((e) => e.document_type);
    expect(required).toContain("kcpe_cert"); // staff added a non-default
  });

  it("reset returns the course to the generated defaults", async () => {
    const { base, cookie, csrf } = await boot();
    await fetch(`${base}/staff/course-docs`, {
      method: "POST", redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${csrf}&programme=LLB&docs=application_form`,
    });
    const res = await fetch(`${base}/staff/course-docs/reset`, {
      method: "POST", redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${csrf}&programme=LLB`,
    });
    expect(res.status).toBe(302);
    expect(repo.courseDocConfig("LLB") ?? null).toBeNull(); // back to defaults
    const llb = repo.getApplicant(mkApplicant("conf-reset@example.org", "LLB"))!;
    const required = repo.effectiveRequirements(llb).filter((e) => e.required).map((e) => e.document_type);
    expect(required.length).toBeGreaterThan(1);
  });

  it("non-admin staff cannot change checklists", async () => {
    repo.createStaff("officer", "Officer", hashPassword("officer123"), "user");
    const { base } = await boot();
    const { cookie, csrf } = await webLogin(base, "officer", "officer123");
    const res = await fetch(`${base}/staff/course-docs`, {
      method: "POST", redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${csrf}&programme=LLB&docs=application_form`,
    });
    expect(res.status).toBe(403);
    expect(repo.courseDocConfig("LLB") ?? null).toBeNull();
  });
});
