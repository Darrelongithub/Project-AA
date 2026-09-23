/**
 * Gmail-style Mail window — acceptance tests (RED first).
 *
 * The Gmail-style Mail view (same-tab — the app never opens new windows):
 * thread like Gmail, unread tracking (incoming mail arrives unread, opening
 * the conversation reads it), search, and a reply affordance that opens the
 * same-tab composer. Scoped end to end like every other surface.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { hashPassword } from "../src/util/password";
import { createApp } from "../src/web/server";
import type { PipelineContext } from "../src/pipeline/adapters";
import { MockSender } from "../src/pipeline/adapters";
import { webLogin } from "./helpers";

let repo: Repo;
let sender: MockSender;
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;

beforeEach(() => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  repo.createStaff("admin", "Mail Admin", hashPassword("admin123"), "admin");
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

function mkApplicant(email: string, thread: string, name: string, opts: Record<string, unknown> = {}): number {
  const a = repo.getOrCreateApplicant(email, thread, { fullName: name });
  if (Object.keys(opts).length) repo.updateApplicant(a.id, opts);
  return a.id;
}

function mail(applicantId: number, direction: "in" | "out", subject: string, body: string, thread: string, at: string, attachments: string[] = []): void {
  repo.insertEmail({
    applicant_id: applicantId, message_id: `m-${Math.random().toString(36).slice(2)}`, thread_id: thread,
    direction, from_addr: direction === "in" ? "them@example.org" : "noreply@riara.ac.ke",
    to_addr: direction === "in" ? "admissions@riara.ac.ke" : "them@example.org",
    subject, body, category: null, auto: 0, at, attachments,
  });
}

describe("the Gmail-style mail window", () => {
  it("is reachable from the nav and opens in the SAME tab (never a new window)", async () => {
    const { base, cookie } = await startServer();
    const home = await (await fetch(`${base}/`, { headers: { cookie } })).text();
    const link = home.match(/<a[^>]*href="\/mail"[^>]*>/);
    expect(link).toBeTruthy();
    expect(link![0]).not.toContain('target="_blank"');
  });

  it("groups conversations by thread like Gmail: latest subject, snippet, message count", async () => {
    const aid = mkApplicant("amara@example.org", "thr-amara", "Amara Nurse");
    mail(aid, "in", "Application enquiry", "Hello, I would like to apply for nursing. Here is my question about entry requirements.", "thr-amara", "2026-09-18T09:00:00Z");
    mail(aid, "out", "Re: Application enquiry", "Thank you for your enquiry — please find the requirements attached.", "thr-amara", "2026-09-18T10:00:00Z");
    mail(aid, "in", "Re: Application enquiry", "Thanks so much, sending my documents today.", "thr-amara", "2026-09-19T08:00:00Z");
    const bid = mkApplicant("biko@example.org", "thr-biko", "Biko Otieno");
    mail(bid, "in", "Transfer question", "I want to transfer into your IT programme.", "thr-biko", "2026-09-17T09:00:00Z");

    const { base, cookie } = await startServer();
    const page = await (await fetch(`${base}/mail`, { headers: { cookie } })).text();
    // thread 1 collapsed to ONE row carrying the latest subject + count of 3
    expect(page).toContain("Re: Application enquiry");
    expect(page).toContain("Thanks so much, sending my documents today.");
    expect(page).toMatch(/\(3\)/);
    // the older first subject must not appear as its own row
    expect(page.split("Application enquiry").length - 1).toBeLessThanOrEqual(3); // subject mentions only inside the one row
    // thread 2 present
    expect(page).toContain("Transfer question");
    // newest conversation first
    expect(page.indexOf("thr-amara-link") !== -1 ? true : page.indexOf("Re: Application enquiry")).toBeLessThan(page.indexOf("Transfer question"));
  });

  it("treats new incoming mail as unread until the conversation is opened", async () => {
    const aid = mkApplicant("fresh@example.org", "thr-fresh", "Fresh Applicant");
    mail(aid, "in", "Brand new unread message", "I just wrote in.", "thr-fresh", "2026-09-19T07:00:00Z");

    const { base, cookie } = await startServer();
    const before = await (await fetch(`${base}/mail?f=unread`, { headers: { cookie } })).text();
    expect(before).toContain("Brand new unread message");

    // open the conversation (thread id = the email thread key)
    const open = await fetch(`${base}/mail/thread/thr-fresh`, { headers: { cookie }, redirect: "manual" });
    expect(open.status).toBe(200);
    expect(await open.text()).toContain("I just wrote in.");

    const after = await (await fetch(`${base}/mail?f=unread`, { headers: { cookie } })).text();
    expect(after).not.toContain("Brand new unread message");
    // …but it still sits in All mail
    const all = await (await fetch(`${base}/mail`, { headers: { cookie } })).text();
    expect(all).toContain("Brand new unread message");
  });

  it("shows the whole conversation both directions, attachments, and a same-tab reply", async () => {
    const aid = mkApplicant("convo@example.org", "thr-convo", "Convo Person");
    mail(aid, "in", "Documents attached?", "Are my documents there?", "thr-convo", "2026-09-18T09:00:00Z");
    mail(aid, "out", "Yes — admission letter sent", "Please find everything attached.", "thr-convo", "2026-09-18T09:30:00Z", ["Admission-Letter.pdf", "Hostels-List.pdf"]);

    const { base, cookie } = await startServer();
    const page = await (await fetch(`${base}/mail/thread/thr-convo`, { headers: { cookie } })).text();
    expect(page).toContain("Are my documents there?");
    expect(page).toContain("Please find everything attached.");
    expect(page).toContain("Admission-Letter.pdf");
    expect(page).toContain("Hostels-List.pdf");
    // reply affordance opens the composer for this case in the same tab
    const reply = page.match(/<a[^>]*href="\/compose\?case=\d+"[^>]*>/);
    expect(reply).toBeTruthy();
    expect(reply![0]).not.toContain('target="_blank"');
    // chronological order: incoming first
    expect(page.indexOf("Are my documents there?")).toBeLessThan(page.indexOf("Please find everything attached."));
  });

  it("searches across conversations", async () => {
    const aid = mkApplicant("s1@example.org", "thr-s1", "Search One");
    mail(aid, "in", "Needle in haystack", "unique-needle-token appears here", "thr-s1", "2026-09-18T09:00:00Z");
    const bid = mkApplicant("s2@example.org", "thr-s2", "Search Two");
    mail(bid, "in", "Nothing relevant", "plain ordinary text", "thr-s2", "2026-09-18T09:00:00Z");

    const { base, cookie } = await startServer();
    const page = await (await fetch(`${base}/mail?q=unique-needle-token`, { headers: { cookie } })).text();
    expect(page).toContain("Needle in haystack");
    expect(page).not.toContain("Nothing relevant");
  });
});

describe("mail window scoping", () => {
  it("scoped staff see only their own schools' mail and cannot open other threads", async () => {
    const progs = repo.listProgrammes();
    const schoolA = repo.listSchools()[0];
    const progA = progs.find((p) => p.school === schoolA)!;
    const otherSchool = repo.listSchools().find((s) => s !== schoolA)!;
    const progB = progs.find((p) => p.school === otherSchool) ?? progs[progs.length - 1];

    const mineId = mkApplicant("mine-mail@example.org", "thr-mine", "Mine Person", { programme: progA.code });
    const theirsId = mkApplicant("theirs-mail@example.org", "thr-theirs", "Theirs Person", { programme: progB.code });
    mail(mineId, "in", "Our conversation", "mine body", "thr-mine", "2026-09-18T09:00:00Z");
    mail(theirsId, "in", "Their secret conversation", "theirs body", "thr-theirs", "2026-09-18T09:00:00Z");

    repo.createStaff("scoped", "Scoped Mailer", hashPassword("scoped-pass-1"), "user");
    const officer = repo.getStaffByUsername("scoped")!;
    repo.setScopes(officer.id, [schoolA]);

    const ctx: PipelineContext = { repo, adapters: { vision: null as never, watcher: null as never, sender } };
    const app = createApp({ repo, ctx });
    server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const { cookie } = await webLogin(base, "scoped", "scoped-pass-1");

    const list = await (await fetch(`${base}/mail`, { headers: { cookie } })).text();
    expect(list).toContain("Our conversation");
    expect(list).not.toContain("Their secret conversation");

    const peek = await fetch(`${base}/mail/thread/thr-theirs`, { headers: { cookie } });
    expect(peek.status).toBe(403);
    expect(await peek.text()).toMatch(/outside your assigned schools/i);

    const own = await fetch(`${base}/mail/thread/thr-mine`, { headers: { cookie } });
    expect(own.status).toBe(200);
    expect(await own.text()).toContain("mine body");
  });

  it("refuses unknown threads cleanly — no 500", async () => {
    const { base, cookie } = await startServer();
    const res = await fetch(`${base}/mail/thread/does-not-exist`, { headers: { cookie } });
    expect(res.status).toBe(404);
  });
});
