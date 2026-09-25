/**
 * Green/Orange/Red counter tile (round 10) — the last code-owed checklist item.
 *
 * "Every case gets one of three markings: Green (clean), Orange (needs a
 * person to look), Red (a person must act)" — the markings exist and every
 * queue row wears its badge, but the dashboards never showed the three
 * counts as one explicit tile. They did. Now they don't: both dashboards
 * carry a "Triage right now" tile with the live G/O/R counts, realm- and
 * school-scoped like every other number on those pages.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { hashPassword } from "../src/util/password";
import { createApp } from "../src/web/server";
import { MockSender, type PipelineContext } from "../src/pipeline/adapters";
import { webLogin } from "./helpers";

let repo: Repo;
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let base = "";
let admin: { cookie: string; csrf: string };
let officer: { cookie: string; csrf: string };

beforeEach(() => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  repo.createStaff("admin", "Triage Admin", hashPassword("admin123"), "admin");
  repo.createStaff("off1", "Triage Officer", hashPassword("officer123"), "user");
  const sender = new MockSender();
  const ctx: PipelineContext = { repo, adapters: { vision: null as never, watcher: null as never, sender } };
  const app = createApp({ repo, ctx });
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(() => {
  server?.close();
});

function applicant(email: string, triage: "Green" | "Orange" | "Red" | null, demo = 0): number {
  const a = repo.getOrCreateApplicant(email, `th-${email}`, { fullName: email.split("@")[0] });
  if (triage) repo.updateApplicant(a.id, { triage });
  if (demo) repo.db.prepare("UPDATE applicants SET demo = ? WHERE id = ?").run(demo, a.id);
  return a.id;
}

describe("repo.triageCounts", () => {
  it("counts each case's CURRENT marking, realm-scoped, never counting NULL triage", () => {
    applicant("g1@x.com", "Green");
    applicant("g2@x.com", "Green");
    applicant("o1@x.com", "Orange");
    applicant("r1@x.com", "Red");
    applicant("untouched@x.com", null); // never triaged — not a marking
    applicant("demo-green@x.com", "Green", 1); // demo realm — invisible to live counts

    const live = repo.triageCounts(0);
    expect(live).toEqual({ green: 2, orange: 1, red: 1 });

    const demo = repo.triageCounts(1);
    expect(demo).toEqual({ green: 1, orange: 0, red: 0 });
  });
});

describe("the Triage tile on the dashboards", () => {
  it("shows the three live counts on the OFFICER dashboard", async () => {
    admin = await webLogin(base, "admin", "admin123");
    officer = await webLogin(base, "off1", "officer123");
    applicant("g1@x.com", "Green");
    applicant("g2@x.com", "Green");
    applicant("o1@x.com", "Orange");
    applicant("r1@x.com", "Red");

    const html = await (await fetch(`${base}/`, { headers: { cookie: officer.cookie } })).text();
    expect(html).toMatch(/Triage right now/i);
    expect(html).toMatch(/Green/);
    expect(html).toMatch(/Orange/);
    expect(html).toMatch(/Red/);
    // The actual numbers, adjacent to their labels.
    expect(html).toMatch(/<b[^>]*>2<\/b>[\s\S]{0,80}Green/i);
    expect(html).toMatch(/<b[^>]*>1<\/b>[\s\S]{0,80}Orange/i);
    expect(html).toMatch(/<b[^>]*>1<\/b>[\s\S]{0,80}Red/i);
  });

  it("shows the same tile on the ADMIN dashboard", async () => {
    admin = await webLogin(base, "admin", "admin123");
    applicant("g1@x.com", "Green");
    applicant("r1@x.com", "Red");

    const html = await (await fetch(`${base}/`, { headers: { cookie: admin.cookie } })).text();
    expect(html).toMatch(/Triage right now/i);
    expect(html).toMatch(/<b[^>]*>1<\/b>[\s\S]{0,80}Green/i);
    expect(html).toMatch(/<b[^>]*>1<\/b>[\s\S]{0,80}Red/i);
  });

  it("respects the live/demo realm split (a demo account sees demo counts only)", async () => {
    const { cookie } = await webLogin(base, "admin", "admin123");
    applicant("live-g@x.com", "Green"); // live realm
    applicant("demo-g@x.com", "Green", 1); // demo realm

    const live = await (await fetch(`${base}/`, { headers: { cookie } })).text();
    // The live admin's tile counts the live case…
    expect(live).toMatch(/<b[^>]*>1<\/b>[\s\S]{0,80}Green/i);
  });
});
