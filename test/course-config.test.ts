/**
 * OR-6 — Course config: every subject × every system, extendable.
 *
 * Acceptance:
 *  1. Master's ≠ PhD — programme levels distinguish masters from phd, each
 *     with its own university-wide defaults.
 *  2. Click-to-reveal grade pickers — condition values for grade fields are
 *     picked from the system's valid ladder, never typed freehand.
 *  3. Editable catalogues — subjects can be added and renamed per system.
 *  4. Schools & courses live on ONE page — add/rename schools next to their
 *     courses.
 *  5. Display == enforce — the requirements shown on the course page are the
 *     exact rule trees the engine evaluates, and the legacy unenforced
 *     block editor is gone (explicit refusal, not silent write).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { webLogin } from "./helpers";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { hashPassword } from "../src/util/password";
import { createApp } from "../src/web/server";
import { describeRuleTree } from "../src/admissions/engine";
import { esc } from "../src/web/views";
import type { PipelineContext } from "../src/pipeline/adapters";
import { ADMISSION_SYSTEMS } from "../src/types";
import { MockSender } from "../src/pipeline/adapters";

let repo: Repo;

beforeEach(() => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  repo.createStaff("admin", "System Administrator", hashPassword("admin123"), "admin");
});

describe("levels: Master's ≠ PhD", () => {
  it("seeded postgraduate programmes carry distinct masters levels", () => {
    expect(repo.programmeByCode("MBA")?.level).toBe("masters");
    // every stored level is one of the five known levels — no legacy blob
    const levels = new Set(repo.listProgrammes().map((p) => p.level));
    for (const l of levels) {
      expect(["degree", "diploma", "certificate", "masters", "phd"]).toContain(l);
    }
  });

  it("a PhD programme can be created and gets PhD-level defaults, not Master's", () => {
    repo.addProgramme("PHD-COM", "PhD in Computing", "School of Computing Sciences", "", "phd");
    expect(repo.programmeByCode("PHD-COM")?.level).toBe("phd");
    const phdSets = repo.activeSetsForProgramme("PHD-COM");
    const mbaSets = repo.activeSetsForProgramme("MBA");
    // they must not be judged by the same level's defaults
    expect(phdSets.every((s) => s.level === "phd")).toBe(true);
    expect(mbaSets.every((s) => s.level === "masters")).toBe(true);
  });

  it("the builder offers separate university-wide defaults for Master's and PhD", async () => {
    const { base, cookie } = await startServer();
    const page = await (await fetch(`${base}/config?tab=requirements`, { headers: { cookie } })).text();
    expect(page).toContain('value="BASE:masters"');
    expect(page).toContain('value="BASE:phd"');
    expect(page).not.toContain('value="BASE:postgrad"');
  });

  it("legacy 'postgrad' rows migrate to masters on open", () => {
    const fs = require("fs") as typeof import("fs");
    const os = require("os") as typeof import("os");
    const path = require("path") as typeof import("path");
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "or6-")), "db.sqlite");
    // build a database the way an older version left it
    const db1 = openDb(file);
    const r1 = new Repo(db1);
    seedDefaults(r1);
    db1.prepare("UPDATE programmes SET level = 'postgrad' WHERE code = 'MBA'").run();
    db1.prepare("UPDATE admission_rules SET level = 'postgrad' WHERE level = 'masters'").run();
    db1.close();
    // re-opening applies the forward migration
    const repo2 = new Repo(openDb(file));
    expect(repo2.programmeByCode("MBA")?.level).toBe("masters");
    expect(repo2.listRuleSets({ programme: "MBA" }).concat(repo2.listRuleSets({ programme: null })).every((s) => (s.level as string) !== "postgrad")).toBe(true);
  });
});

describe("click-to-reveal grade pickers", () => {
  it("KCSE grade conditions render the full KCSE ladder as a picker", async () => {
    const { base, cookie } = await startServer();
    const page = await (await fetch(`${base}/config?tab=requirements&reqs=LLB&system=KCSE`, { headers: { cookie } })).text();
    // LLB KCSE has an overall mean-grade condition seeded from the published set
    const picker = /<select name="value"[^>]*data-grade-picker="KCSE"[^>]*>([\s\S]*?)<\/select>/.exec(page);
    expect(picker).not.toBeNull();
    for (const g of ["A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D+", "D", "D-", "E"]) {
      expect(picker![1]).toContain(`value="${g}"`);
    }
  });

  it("IGCSE pickers offer the A*–G ladder", async () => {
    const { base, cookie } = await startServer();
    // give LLB an IGCSE draft condition so a picker renders
    const set = repo.ensureDraftSet("LLB", "degree", "IGCSE", "admin");
    repo.addRuleNode(set.id, null, "condition");
    const page = await (await fetch(`${base}/config?tab=requirements&reqs=LLB&system=IGCSE`, { headers: { cookie } })).text();
    const picker = /<select name="value"[^>]*data-grade-picker="IGCSE"[^>]*>([\s\S]*?)<\/select>/.exec(page);
    expect(picker).not.toBeNull();
    expect(picker![1]).toContain('value="A*"');
    expect(picker![1]).toContain('value="G"');
  });

  it("degree-class conditions pick from the class ladder, not free text", async () => {
    const { base, cookie } = await startServer();
    const set = repo.ensureDraftSet("MBA", "masters", "DEGREE", "admin");
    const node = repo.addRuleNode(set.id, null, "condition");
    repo.db.prepare("UPDATE admission_rule_nodes SET field = 'class' WHERE id = ?").run(node);
    const page = await (await fetch(`${base}/config?tab=requirements&reqs=MBA&system=DEGREE`, { headers: { cookie } })).text();
    expect(page).toContain('data-grade-picker="class"');
    expect(page).toContain("Second Class Honours (Upper Division)");
    expect(page).toContain("First Class Honours");
  });

  it("numeric conditions (points, credits) keep numeric inputs, saved values survive", async () => {
    const { base, cookie, csrf } = await startServer();
    const set = repo.ensureDraftSet("BCS", "degree", "IB", "admin");
    const node = repo.addRuleNode(set.id, null, "condition");
    repo.db.prepare("UPDATE admission_rule_nodes SET field = 'points' WHERE id = ?").run(node);
    const page = await (await fetch(`${base}/config?tab=requirements&reqs=BCS&system=IB`, { headers: { cookie } })).text();
    expect(page).toContain('type="number"');
    // save a value through the real endpoint and see it re-rendered
    const res = await fetch(`${base}/config/requirements/node-save`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${csrf}&target=BCS&system=IB&node=${node}&field=points&comparator=%3E%3D&value=24`,
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const again = await (await fetch(`${base}/config?tab=requirements&reqs=BCS&system=IB`, { headers: { cookie } })).text();
    expect(again).toContain('value="24"');
  });
});

describe("editable subject catalogue", () => {
  it("a new subject can be added to a system and appears in the builder", async () => {
    const { base, cookie, csrf } = await startServer();
    const res = await fetch(`${base}/config/requirements/catalogue-add`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${csrf}&system=KCSE&name=Aviation Studies`,
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const row = repo.listSubjectCatalogue("KCSE").find((r) => r.name === "Aviation Studies");
    expect(row?.active).toBe(1);
    const page = await (await fetch(`${base}/config?tab=requirements&reqs=LLB&system=KCSE`, { headers: { cookie } })).text();
    expect(page).toContain("Aviation Studies");
  });

  it("adding a duplicate subject is refused politely", async () => {
    const { base, cookie, csrf } = await startServer();
    const before = repo.listSubjectCatalogue("KCSE").length;
    const res = await fetch(`${base}/config/requirements/catalogue-add`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${csrf}&system=KCSE&name=English`,
      redirect: "manual",
    });
    expect(decodeURIComponent(res.headers.get("location") || "")).toContain("already");
    expect(repo.listSubjectCatalogue("KCSE").length).toBe(before);
  });

  it("a subject can be renamed and keeps its active status", async () => {
    const { base, cookie, csrf } = await startServer();
    const target = repo.listSubjectCatalogue("KCSE").find((r) => r.name === "English")!;
    const res = await fetch(`${base}/config/requirements/catalogue-rename`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${csrf}&id=${target.id}&name=English Language`,
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const renamed = repo.listSubjectCatalogue("KCSE").find((r) => r.id === target.id);
    expect(renamed?.name).toBe("English Language");
    expect(renamed?.active).toBe(1);
  });
});

describe("schools & courses on one page", () => {
  it("the courses page lists every school with its courses together", async () => {
    const { base, cookie } = await startServer();
    const page = await (await fetch(`${base}/staff`, { headers: { cookie } })).text();
    for (const school of ["School of Law", "School of Business", "School of Nursing", "School of Computing Sciences"]) {
      expect(page).toContain(school);
    }
    expect(page).toContain("LLB");
    expect(page).toContain("MBA");
  });

  it("a new school can be added and shows up even before it has courses", async () => {
    const { base, cookie, csrf } = await startServer();
    const res = await fetch(`${base}/config/schools/add`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${csrf}&name=School of Aviation`,
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const page = await (await fetch(`${base}/staff`, { headers: { cookie } })).text();
    expect(page).toContain("School of Aviation");
  });

  it("renaming a school renames it for every course in that school", async () => {
    const { base, cookie, csrf } = await startServer();
    const res = await fetch(`${base}/config/schools/rename`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${csrf}&from=${encodeURIComponent("School of Law")}&to=${encodeURIComponent("Faculty of Law")}`,
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(repo.programmeByCode("LLB")?.school).toBe("Faculty of Law");
    const page = await (await fetch(`${base}/staff`, { headers: { cookie } })).text();
    expect(page).toContain("Faculty of Law");
    expect(page).not.toContain("School of Law");
  });
});

describe("display == enforce", () => {
  it("the courses page prints the exact enforced rule tree for each course", async () => {
    const { base, cookie } = await startServer();
    const page = await (await fetch(`${base}/staff`, { headers: { cookie } })).text();
    const llbKcse = repo.activeSetsForProgramme("LLB").find((s) => s.system === "KCSE");
    expect(llbKcse).toBeTruthy();
    const described = describeRuleTree(llbKcse!.nodes ?? []);
    expect(described.length).toBeGreaterThan(0);
    // the page renders the engine's own description (HTML-escaped) — same
    // data source the evaluator reads, so display == enforce
    expect(page).toContain(esc(described));
  });

  it("activating a draft changes what the courses page displays", async () => {
    const { base, cookie, csrf } = await startServer();
    const set = repo.ensureDraftSet("LLB", "degree", "KCSE", "admin");
    const node = repo.addRuleNode(set.id, null, "condition");
    repo.db.prepare("UPDATE admission_rule_nodes SET field = 'subject', subject = 'Biology', value = 'B' WHERE id = ?").run(node);
    await fetch(`${base}/config/requirements/activate`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${csrf}&target=LLB&system=KCSE`,
      redirect: "manual",
    });
    const page = await (await fetch(`${base}/staff`, { headers: { cookie } })).text();
    const active = repo.activeSetsForProgramme("LLB").find((s) => s.system === "KCSE")!;
    expect(describeRuleTree(active.nodes ?? [])).toContain("Biology");
    expect(page).toContain(esc(describeRuleTree(active.nodes ?? [])));
  });

  it("the legacy unenforced block editor is gone — stale POSTs are refused", async () => {
    const { base, cookie, csrf } = await startServer();
    const before = (repo.db.prepare("SELECT COUNT(*) AS n FROM course_requirements").get() as { n: number }).n;
    const res = await fetch(`${base}/config/entry-requirements`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${csrf}&target=LLB&system=KCSE&enabled=on&overall=C%2B`,
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.headers.get("location") || "")).toContain("Requirements tab");
    const after = (repo.db.prepare("SELECT COUNT(*) AS n FROM course_requirements").get() as { n: number }).n;
    expect(after).toBe(before); // nothing written to the unenforced table
    const page = await (await fetch(`${base}/staff`, { headers: { cookie } })).text();
    expect(page).not.toContain('action="/config/entry-requirements"');
  });

  it("every qualification system is reachable for every programme", async () => {
    const { base, cookie } = await startServer();
    for (const system of ADMISSION_SYSTEMS) {
      const res = await fetch(`${base}/config?tab=requirements&reqs=BCS&system=${system}`, { headers: { cookie } });
      const page = await res.text();
      expect(res.status).toBe(200);
      expect(page).toContain(`value="${system}" selected`);
    }
  });
});

// ── harness ────────────────────────────────────────────────────────────────

let server: ReturnType<ReturnType<typeof createApp>["listen"]> | undefined;
let base = "";

async function startServer(): Promise<{ base: string; cookie: string; csrf: string }> {
  const ctx: PipelineContext = { repo, adapters: { vision: null as never, watcher: null as never, sender: new MockSender() } };
  const app = createApp({ repo, ctx });
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { cookie, csrf } = await webLogin(base, "admin", "admin123");
  return { base, cookie, csrf };
}

afterEach(() => {
  server?.close();
  server = undefined;
});
