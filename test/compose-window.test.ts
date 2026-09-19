/**
 * New-window compose — acceptance tests (RED first).
 *
 * Staff can open a composer in a NEW browser window: either globally
 * (nav → Compose, pick the recipient first) or straight from a case.
 * The composer is case-based (replies always belong to a case file),
 * honours scoping end to end, and its sends record attachments exactly
 * like every other send path.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { hashPassword } from "../src/util/password";
import { createApp } from "../src/web/server";
import type { PipelineContext } from "../src/pipeline/adapters";
import { MockSender } from "../src/pipeline/adapters";
import type { ApplicantRow } from "../src/types";
import { webLogin } from "./helpers";

let repo: Repo;
let sender: MockSender;
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;

beforeEach(() => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  repo.createStaff("admin", "System Administrator", hashPassword("admin123"), "admin");
  sender = new MockSender();
});
afterEach(() => { server?.close(); });

async function startServer(): Promise<{ base: string; cookie: string; csrf: string }> {
  const ctx: PipelineContext = { repo, adapters: { vision: null as never, watcher: null as never, sender } };
  const app = createApp({ repo, ctx });
  server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { cookie, csrf } = await webLogin(base, "admin", "admin123");
  return { base, cookie, csrf };
}

function mkApplicant(email: string, opts: Partial<ApplicantRow> = {}): ApplicantRow {
  const a = repo.getOrCreateApplicant(email, `t-${Math.random().toString(36).slice(2)}`);
  repo.updateApplicant(a.id, { full_name: "Compose Tester", ...opts });
  return repo.getApplicant(a.id)!;
}

describe("the new-window composer", () => {
  it("is reachable from the nav and asks WHO the reply is for", async () => {
    const { base, cookie } = await startServer();
    const home = await (await fetch(`${base}/`, { headers: { cookie } })).text();
    expect(home).toContain('href="/compose"');
    expect(home).toContain('target="_blank"'); // opens in a new window

    const page = await (await fetch(`${base}/compose`, { headers: { cookie } })).text();
    expect(page).toContain("Compose");
    expect(page).toMatch(/recipient|applicant/i); // recipient picker present
  });

  it("finds recipients through the scoped search", async () => {
    mkApplicant("amara.nurse@example.org", { full_name: "Amara Nurse", programme: "BNS" });
    const { base, cookie } = await startServer();
    const page = await (await fetch(`${base}/compose?q=amara`, { headers: { cookie } })).text();
    expect(page).toContain("Amara Nurse");
    expect(page).toContain("amara.nurse@example.org");
  });

  it("opens pre-addressed from a case, and the case page offers it as a new window", async () => {
    const a = mkApplicant("cased@example.org");
    const { base, cookie } = await startServer();
    const page = await (await fetch(`${base}/compose?case=${a.id}`, { headers: { cookie } })).text();
    expect(page).toContain("cased@example.org");
    expect(page).toContain('name="subject"');
    expect(page).toContain('name="body"');

    const casePage = await (await fetch(`${base}/case/${a.id}`, { headers: { cookie } })).text();
    expect(casePage).toContain(`/case/${a.id}/compose`);
    expect(casePage).toContain('target="_blank"'); // new-window affordance on the case file
  });

  it("loads a template into the draft before sending (prepare step)", async () => {
    const a = mkApplicant("prep@example.org");
    const { base, cookie, csrf } = await startServer();
    const res = await fetch(`${base}/compose`, {
      method: "POST", redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${encodeURIComponent(csrf)}&action=prepare&case=${a.id}&template=ack_received`,
    });
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("Your application documents have been received");
    expect(page).toContain(a.ref_number);
  });

  it("sends and records the outgoing mail with its pack attachments", async () => {
    const a = mkApplicant("sendme@example.org");
    const { base, cookie, csrf } = await startServer();
    const res = await fetch(`${base}/compose`, {
      method: "POST", redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${encodeURIComponent(csrf)}&case=${a.id}&template=admission_letter&subject=Congratulations&body=Welcome+aboard`,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain(`/case/${a.id}`);
    expect(sender.sent.length).toBe(1);
    expect(sender.sent[0].attachments.length).toBe(7); // admission pack rides along

    const out = repo.emailsForApplicant(a.id).find((e) => e.direction === "out")!;
    expect(out.subject).toBe("Congratulations");
    const attached = JSON.parse(out.attachments || "[]") as string[];
    expect(attached.length).toBe(7);
    expect(attached.some((f) => /Hostels/i.test(f))).toBe(true);
  });

  it("refuses to send without a subject and a body — loudly, sending nothing", async () => {
    const a = mkApplicant("empty@example.org");
    const { base, cookie, csrf } = await startServer();
    const res = await fetch(`${base}/compose`, {
      method: "POST", redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${encodeURIComponent(csrf)}&case=${a.id}&subject=&body=`,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/subject|body/i);
    expect(sender.sent.length).toBe(0);
    expect(repo.emailsForApplicant(a.id).filter((e) => e.direction === "out").length).toBe(0);
  });
});

describe("compose scoping", () => {
  it("scoped staff only see and reach their own schools' cases", async () => {
    // Two programmes in two different schools
    const progs = repo.listProgrammes();
    const schoolA = repo.listSchools()[0];
    const progA = progs.find((p) => p.school === schoolA)!;
    const otherSchool = repo.listSchools().find((s) => s !== schoolA)!;
    const progB = progs.find((p) => p.school === otherSchool) ?? progs[progs.length - 1];

    const mine = mkApplicant("mine@example.org", { programme: progA.code });
    mkApplicant("theirs@example.org", { programme: progB.code, full_name: "Theirs Person" });

    repo.createStaff("scoped", "Scoped Officer", hashPassword("scoped-pass-1"), "user");
    const officer = repo.getStaffByUsername("scoped")!;
    repo.setScopes(officer.id, [schoolA]);

    const ctx: PipelineContext = { repo, adapters: { vision: null as never, watcher: null as never, sender } };
    const app = createApp({ repo, ctx });
    server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const { cookie, csrf } = await webLogin(base, "scoped", "scoped-pass-1");

    // search sees only their school's case
    const search = await (await fetch(`${base}/compose?q=example.org`, { headers: { cookie } })).text();
    expect(search).toContain("mine@example.org");
    expect(search).not.toContain("theirs@example.org");

    // opening the composer on an out-of-scope case is refused like any other case surface
    const theirs = repo.findByEmailAny("theirs@example.org")!;
    const openRes = await fetch(`${base}/compose?case=${theirs.id}`, { headers: { cookie }, redirect: "manual" });
    expect(openRes.status).toBe(403);

    // and so is a forged POST straight to the send action
    const sendRes = await fetch(`${base}/compose`, {
      method: "POST", redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${encodeURIComponent(csrf)}&case=${theirs.id}&subject=Hi&body=Sneaky`,
    });
    expect(sendRes.status).toBe(403);
    expect(sender.sent.length).toBe(0);

    // their own case composes fine
    const okRes = await fetch(`${base}/compose`, {
      method: "POST", redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${encodeURIComponent(csrf)}&case=${mine.id}&subject=Hello&body=All+ours`,
    });
    expect(okRes.status).toBe(302);
    expect(sender.sent.length).toBe(1);
  });
});
