/**
 * Gmail folders for the mail window — acceptance tests (RED first).
 *
 * The mail window mirrors Gmail's folder/label model, in our UI:
 * Inbox, Unread, Starred, Important, Sent, All Mail, Spam, Bin —
 * with live sidebar counts, one-click star from the list, and a full
 * action bar on the conversation. Labels apply to the whole conversation
 * (Gmail semantics): bin/spam hide it from every other folder; restore
 * brings it back where it was. Scoped + CSRF-checked like every POST.
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
  repo.createStaff("admin", "Folder Admin", hashPassword("admin123"), "admin");
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

function mail(applicantId: number, direction: "in" | "out", subject: string, body: string, thread: string, at: string): void {
  repo.insertEmail({
    applicant_id: applicantId, message_id: `m-${Math.random().toString(36).slice(2)}`, thread_id: thread,
    direction, from_addr: direction === "in" ? "them@example.org" : "noreply@riara.ac.ke",
    to_addr: direction === "in" ? "admissions@riara.ac.ke" : "them@example.org",
    subject, body, category: null, auto: 0, at,
  });
}

async function act(base: string, cookie: string, csrf: string, tkey: string, action: string, back = "/mail"): Promise<Response> {
  return fetch(`${base}/mail/thread/${encodeURIComponent(tkey)}/action`, {
    method: "POST", redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: `_csrf=${encodeURIComponent(csrf)}&action=${action}&back=${encodeURIComponent(back)}`,
  });
}

describe("gmail folders", () => {
  it("shows the gmail sidebar: Inbox, Unread, Starred, Important, Sent, All Mail, Spam, Bin with counts", async () => {
    const aid = mkApplicant("folder@example.org", "thr-folder", "Folder Person");
    mail(aid, "in", "Unread incoming", "hello", "thr-folder", "2026-09-19T07:00:00Z");

    const { base, cookie } = await startServer();
    const page = await (await fetch(`${base}/mail`, { headers: { cookie } })).text();
    for (const f of ["inbox", "unread", "starred", "important", "sent", "all", "spam", "bin"]) {
      expect(page).toContain(`href="/mail?f=${f}"`);
    }
    for (const label of ["Inbox", "Unread", "Starred", "Important", "Sent", "All Mail", "Spam", "Bin"]) {
      expect(page.toLowerCase()).toContain(label.toLowerCase());
    }
    // one unread conversation → live inbox badge
    expect(page).toMatch(/Inbox <b class="mail-count">1<\/b>/);
    // unread conversation counter also counts 1
    expect(page).toMatch(/Unread <b class="mail-count">1<\/b>/);
  });

  it("incoming conversations live in Inbox; conversations with replies also live in Sent", async () => {
    const aid = mkApplicant("both@example.org", "thr-both", "Both Ways");
    mail(aid, "in", "Two-way conversation", "question", "thr-both", "2026-09-19T07:00:00Z");
    mail(aid, "out", "Two-way conversation", "answer", "thr-both", "2026-09-19T08:00:00Z");
    // an outgoing-only conversation (proactive contact) must NOT appear in Inbox
    const oid = mkApplicant("outonly@example.org", "thr-outonly", "Outbound Contact");
    mail(oid, "out", "Proactive outreach", "we wrote first", "thr-outonly", "2026-09-19T09:00:00Z");

    const { base, cookie } = await startServer();
    const inbox = await (await fetch(`${base}/mail`, { headers: { cookie } })).text();
    expect(inbox).toContain("Two-way conversation");
    expect(inbox).not.toContain("Proactive outreach");

    const sent = await (await fetch(`${base}/mail?f=sent`, { headers: { cookie } })).text();
    expect(sent).toContain("Two-way conversation");
    expect(sent).toContain("Proactive outreach");
  });

  it("stars from the conversation list and surfaces starred mail in Starred — without leaving Inbox", async () => {
    const aid = mkApplicant("star@example.org", "thr-star", "Star Person");
    mail(aid, "in", "Star this chat", "body", "thr-star", "2026-09-19T07:00:00Z");

    const { base, cookie, csrf } = await startServer();
    const list = await (await fetch(`${base}/mail`, { headers: { cookie } })).text();
    expect(list).toContain('class="starform"'); // inline star affordance like gmail's row star

    const res = await act(base, cookie, csrf, "thr-star", "star");
    expect(res.status).toBe(302);

    const starred = await (await fetch(`${base}/mail?f=starred`, { headers: { cookie } })).text();
    expect(starred).toContain("Star this chat");
    const inbox = await (await fetch(`${base}/mail`, { headers: { cookie } })).text();
    expect(inbox).toContain("Star this chat"); // gmail semantics: labels add, never move

    // unstar removes it from Starred
    await act(base, cookie, csrf, "thr-star", "unstar");
    const unstarred = await (await fetch(`${base}/mail?f=starred`, { headers: { cookie } })).text();
    expect(unstarred).not.toContain("Star this chat");
  });

  it("marks conversations important and lists them under Important", async () => {
    const aid = mkApplicant("imp@example.org", "thr-imp", "Important Person");
    mail(aid, "in", "Priority matter", "body", "thr-imp", "2026-09-19T07:00:00Z");

    const { base, cookie, csrf } = await startServer();
    await act(base, cookie, csrf, "thr-imp", "important");
    const imp = await (await fetch(`${base}/mail?f=important`, { headers: { cookie } })).text();
    expect(imp).toContain("Priority matter");

    await act(base, cookie, csrf, "thr-imp", "unimportant");
    const gone = await (await fetch(`${base}/mail?f=important`, { headers: { cookie } })).text();
    expect(gone).not.toContain("Priority matter");
  });

  it("Bin hides a conversation from Inbox and All Mail — restore puts it back", async () => {
    const aid = mkApplicant("bin@example.org", "thr-bin", "Bin Person");
    mail(aid, "in", "Bin me softly", "body", "thr-bin", "2026-09-19T07:00:00Z");

    const { base, cookie, csrf } = await startServer();
    let inbox = await (await fetch(`${base}/mail`, { headers: { cookie } })).text();
    expect(inbox).toContain("Bin me softly");

    await act(base, cookie, csrf, "thr-bin", "bin");
    inbox = await (await fetch(`${base}/mail`, { headers: { cookie } })).text();
    expect(inbox).not.toContain("Bin me softly");
    const all = await (await fetch(`${base}/mail?f=all`, { headers: { cookie } })).text();
    expect(all).not.toContain("Bin me softly");
    const bin = await (await fetch(`${base}/mail?f=bin`, { headers: { cookie } })).text();
    expect(bin).toContain("Bin me softly");

    await act(base, cookie, csrf, "thr-bin", "restore");
    inbox = await (await fetch(`${base}/mail`, { headers: { cookie } })).text();
    expect(inbox).toContain("Bin me softly");
    const binAfter = await (await fetch(`${base}/mail?f=bin`, { headers: { cookie } })).text();
    expect(binAfter).not.toContain("Bin me softly");
  });

  it("Report spam hides from Inbox; Not spam restores it", async () => {
    const aid = mkApplicant("spam@example.org", "thr-spam", "Spam Person");
    mail(aid, "in", "Maybe junk", "body", "thr-spam", "2026-09-19T07:00:00Z");

    const { base, cookie, csrf } = await startServer();
    await act(base, cookie, csrf, "thr-spam", "spam");
    let inbox = await (await fetch(`${base}/mail`, { headers: { cookie } })).text();
    expect(inbox).not.toContain("Maybe junk");
    const spam = await (await fetch(`${base}/mail?f=spam`, { headers: { cookie } })).text();
    expect(spam).toContain("Maybe junk");

    await act(base, cookie, csrf, "thr-spam", "notspam");
    inbox = await (await fetch(`${base}/mail`, { headers: { cookie } })).text();
    expect(inbox).toContain("Maybe junk");
  });

  it("the conversation view carries the full gmail action bar", async () => {
    const aid = mkApplicant("bar@example.org", "thr-bar", "Action Bar");
    mail(aid, "in", "Actionable thread", "body", "thr-bar", "2026-09-19T07:00:00Z");

    const { base, cookie } = await startServer();
    const page = await (await fetch(`${base}/mail/thread/thr-bar`, { headers: { cookie } })).text();
    for (const label of ["Star", "Mark important", "Mark unread", "Report spam", "Move to Bin"]) {
      expect(page).toContain(label);
    }
  });

  it("Mark unread puts a read conversation back into Unread", async () => {
    const aid = mkApplicant("unread@example.org", "thr-unread", "Unread Person");
    mail(aid, "in", "Flip me unread", "body", "thr-unread", "2026-09-19T07:00:00Z");

    const { base, cookie, csrf } = await startServer();
    // open → read
    await fetch(`${base}/mail/thread/thr-unread`, { headers: { cookie } });
    let unreadList = await (await fetch(`${base}/mail?f=unread`, { headers: { cookie } })).text();
    expect(unreadList).not.toContain("Flip me unread");

    await act(base, cookie, csrf, "thr-unread", "unread");
    unreadList = await (await fetch(`${base}/mail?f=unread`, { headers: { cookie } })).text();
    expect(unreadList).toContain("Flip me unread");
  });
});

describe("folder action security", () => {
  it("action POSTs require CSRF and respect school scope", async () => {
    const progs = repo.listProgrammes();
    const schoolA = repo.listSchools()[0];
    const progA = progs.find((p) => p.school === schoolA)!;
    const otherSchool = repo.listSchools().find((s) => s !== schoolA)!;
    const progB = progs.find((p) => p.school === otherSchool) ?? progs[progs.length - 1];

    const mineId = mkApplicant("mine-f@example.org", "thr-minf", "Mine F", { programme: progA.code });
    const theirsId = mkApplicant("theirs-f@example.org", "thr-thf", "Theirs F", { programme: progB.code });
    mail(mineId, "in", "Mine folder chat", "mine", "thr-minf", "2026-09-19T07:00:00Z");
    mail(theirsId, "in", "Their folder chat", "theirs", "thr-thf", "2026-09-19T07:00:00Z");

    repo.createStaff("scoped", "Scoped F", hashPassword("scoped-pass-1"), "user");
    repo.setScopes(repo.getStaffByUsername("scoped")!.id, [schoolA]);

    const ctx: PipelineContext = { repo, adapters: { vision: null as never, watcher: null as never, sender } };
    const app = createApp({ repo, ctx });
    server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const { cookie, csrf } = await webLogin(base, "scoped", "scoped-pass-1");

    // no CSRF → 403
    const noCsrf = await fetch(`${base}/mail/thread/thr-minf/action`, {
      method: "POST", redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `action=bin`,
    });
    expect(noCsrf.status).toBe(403);

    // forged action on an out-of-scope thread → 403, labels untouched
    const forged = await act(base, cookie, csrf, "thr-thf", "bin");
    expect(forged.status).toBe(403);
    const theirThread = repo.emailsForThread("thr-thf");
    expect(theirThread.every((e) => !(e.labels ?? "").includes("bin"))).toBe(true);

    // own thread bins fine
    const own = await act(base, cookie, csrf, "thr-minf", "bin");
    expect(own.status).toBe(302);
    expect(repo.emailsForThread("thr-minf").every((e) => (e.labels ?? "").includes("bin"))).toBe(true);
  });
});
