/**
 * New-window compose — acceptance tests (RED first).
 *
 * Staff can open a composer in the SAME tab (the app never opens new
 * browser windows — round 3): either globally (nav → Compose, pick the
 * recipient first) or straight from a case.
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
import { configureTestOrganization, webLogin } from "./helpers";

let repo: Repo;
let sender: MockSender;
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;

beforeEach(() => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  configureTestOrganization(repo);
  repo.createStaff("admin", "System Administrator", hashPassword("admin123"), "admin");
  sender = new MockSender(true);
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

function mkCase(email: string, opts: { fullName?: string; caseTypeCode?: string } = {}): ApplicantRow {
  const a = repo.createCase({
    emailAddress: email, threadId: `t-${Math.random().toString(36).slice(2)}`, organizationId: 1,
    fullName: opts.fullName ?? "Compose Tester", caseTypeCode: opts.caseTypeCode,
  });
  return repo.getApplicant(a.id)!;
}

describe("the new-window composer", () => {
  it("is reachable from the nav and asks WHO the reply is for", async () => {
    const { base, cookie } = await startServer();
    const home = await (await fetch(`${base}/`, { headers: { cookie } })).text();
    expect(home).toContain('href="/compose"');
    expect(home).not.toContain('target="_blank"'); // same tab — never a new window

    const page = await (await fetch(`${base}/compose`, { headers: { cookie } })).text();
    expect(page).toContain("Compose");
    expect(page).toMatch(/recipient|contact/i); // recipient picker present
  });

  it("finds recipients through the scoped search", async () => {
    mkCase("amara.njoki@example.org", { fullName: "Amara Njoki", caseTypeCode: "SERVICE_REQUEST" });
    const { base, cookie } = await startServer();
    const page = await (await fetch(`${base}/compose?q=amara`, { headers: { cookie } })).text();
    expect(page).toContain("Amara Njoki");
    expect(page).toContain("amara.njoki@example.org");
  });

  it("opens pre-addressed from a case, and the case page offers it (same tab)", async () => {
    const a = mkCase("cased@example.org");
    const { base, cookie } = await startServer();
    const page = await (await fetch(`${base}/compose?case=${a.id}`, { headers: { cookie } })).text();
    expect(page).toContain("cased@example.org");
    expect(page).toContain('name="subject"');
    expect(page).toContain('name="body"');

    const casePage = await (await fetch(`${base}/case/${a.id}`, { headers: { cookie } })).text();
    expect(casePage).toContain(`/case/${a.id}/compose`);
    expect(casePage).not.toContain('target="_blank"'); // same-tab affordance on the case file
  });

  it("picks a template via GET and renders it into an editable draft", async () => {
    const a = mkCase("prep@example.org");
    const { base, cookie } = await startServer();
    const res = await fetch(`${base}/compose?case=${a.id}&template=ack_received`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("We received the information for your case");
    expect(page).toContain(a.ref_number);
    // the rendered template must sit in the editable fields
    expect(page).toMatch(/name="subject" value="[^"]*Information received/i);
  });

  it("has exactly ONE submit button — Send now — so Enter sends, never reloads or wipes", async () => {
    const a = mkCase("enter@example.org");
    const { base, cookie } = await startServer();
    const page = await (await fetch(`${base}/compose?case=${a.id}`, { headers: { cookie } })).text();
    const form = page.match(/<form method="post" action="\/compose">[\s\S]*?<\/form>/);
    expect(form).toBeTruthy();
    const submits = (form![0].match(/<button(?![^>]*type="button")[^>]*>/g) ?? []);
    expect(submits.length).toBe(1);
    expect(form![0]).toContain("Send now");
    expect(form![0]).not.toContain('name="action"');
    expect(page).toContain("ack_received"); // template choice still reachable (as chips/links, outside the form)
  });

  it("sends and records the outgoing mail with its attachment set", async () => {
    const a = mkCase("sendme@example.org");
    // Nothing ships with the product: the files that ride along are the
    // organization's OWN attachment set, named by one of its own templates.
    const set = repo.createAttachmentSet(1, "Welcome pack");
    for (const filename of ["welcome-pack.pdf", "service-guide.pdf", "contact-details.pdf"]) {
      repo.addAttachmentSetFile(set.id, { filename, content: Buffer.from(`%PDF-1.4\n${filename}\n`) });
    }
    repo.upsertTemplate("welcome", "Welcome", "Welcome aboard", "Hello {first_name},\n\nWelcome to the service.\n\n{institution}", true, "Welcome pack", 1);

    const { base, cookie, csrf } = await startServer();
    const res = await fetch(`${base}/compose`, {
      method: "POST", redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${encodeURIComponent(csrf)}&case=${a.id}&template=welcome&subject=Congratulations&body=Welcome+aboard`,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain(`/case/${a.id}`);
    expect(sender.sent.length).toBe(1);
    expect(sender.sent[0].attachments.length).toBe(3); // the organization's set rides along

    const out = repo.emailsForApplicant(a.id).find((e) => e.direction === "out")!;
    expect(out.subject).toBe("Congratulations");
    const attached = JSON.parse(out.attachments || "[]") as string[];
    expect(attached.sort()).toEqual(["contact-details.pdf", "service-guide.pdf", "welcome-pack.pdf"]);
  });

  it("refuses to send without a subject and a body — loudly, sending nothing", async () => {
    const a = mkCase("empty@example.org");
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
  it("scoped staff only see and reach their own case types", async () => {
    // Two case types, two officers, one scope each.
    const mine = mkCase("mine@example.org", { caseTypeCode: "SERVICE_REQUEST" });
    mkCase("theirs@example.org", { fullName: "Theirs Person", caseTypeCode: "VENDOR_INTAKE" });

    repo.createStaff("scoped", "Scoped Officer", hashPassword("scoped-pass-1"), "user");
    const officer = repo.getStaffByUsername("scoped")!;
    repo.setCaseTypeScopes(officer.id, ["SERVICE_REQUEST"]);

    const ctx: PipelineContext = { repo, adapters: { vision: null as never, watcher: null as never, sender } };
    const app = createApp({ repo, ctx });
    server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const { cookie, csrf } = await webLogin(base, "scoped", "scoped-pass-1");

    // search sees only their own case type
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
