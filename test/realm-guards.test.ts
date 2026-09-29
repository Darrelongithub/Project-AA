/**
 * Realm guards outside the /case/:id choke point (audit follow-up to BL-14-01).
 *
 * BL-14-01 closed cross-realm mutations at the /case/:id choke point, but the
 * composer and the mail window take case/thread ids on their OWN routes and
 * only checked school visibility — a demo-realm account could open a LIVE
 * case in the composer and SEND to it, and could read + relabel live mail
 * threads (and vice versa). Cross-realm access now 404s exactly like the
 * choke point: indistinguishable from a non-existent case/conversation.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "http";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { hashPassword } from "../src/util/password";
import { createApp } from "../src/web/server";
import { MockSender, type PipelineContext } from "../src/pipeline/adapters";
import { webLogin } from "./helpers";

let repo: Repo;
let server: Server | undefined;
let sender: MockSender;

beforeEach(() => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
});

afterEach(() => {
  server?.close();
  server = undefined;
});

async function boot(): Promise<string> {
  repo.createStaff("live-admin", "Live Admin", hashPassword("live12345"), "admin");
  repo.createStaff("demo-admin", "Demo Admin", hashPassword("demo12345"), "admin", true);
  sender = new MockSender();
  const ctx: PipelineContext = { repo, adapters: { vision: null as never, watcher: null as never, sender } };
  const s = createApp({ repo, ctx }).listen(0);
  server = s as unknown as Server;
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
}

function mkCase(email: string, thread: string, demo: 0 | 1): number {
  const a = repo.getOrCreateApplicant(email, thread);
  repo.db.prepare("UPDATE applicants SET demo = ? WHERE id = ?").run(demo, a.id);
  repo.insertEmail({
    applicant_id: a.id, message_id: `m-${thread}`, thread_id: thread, direction: "in",
    from_addr: email, to_addr: "", subject: `hello ${thread}`, body: "hi",
    category: null, auto: 0, at: new Date().toISOString(),
  });
  return a.id;
}

function postForm(base: string, path: string, cookie: string, csrf: string, fields: Record<string, string>): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: new URLSearchParams({ _csrf: csrf, ...fields }).toString(),
    redirect: "manual",
  });
}

describe("compose realm guard", () => {
  it("404s cross-realm opens and sends (both directions), same-realm still works", async () => {
    const base = await boot();
    const liveId = mkCase("live@example.ke", "thr-live", 0);
    const demoId = mkCase("demo@example.ke", "thr-demo", 1);
    const live = await webLogin(base, "live-admin", "live12345");
    const demo = await webLogin(base, "demo-admin", "demo12345");

    // Opens: cross-realm 404s like a missing case.
    expect((await fetch(`${base}/compose?case=${liveId}`, { headers: { cookie: demo.cookie } })).status).toBe(404);
    expect((await fetch(`${base}/compose?case=${demoId}`, { headers: { cookie: live.cookie } })).status).toBe(404);
    // Same-realm opens still work.
    expect((await fetch(`${base}/compose?case=${liveId}`, { headers: { cookie: live.cookie } })).status).toBe(200);
    expect((await fetch(`${base}/compose?case=${demoId}`, { headers: { cookie: demo.cookie } })).status).toBe(200);

    // Sends: cross-realm 404s and nothing goes out.
    const refused = await postForm(base, "/compose", demo.cookie, demo.csrf, {
      case: String(liveId), subject: "sneaky", body: "cross-realm send attempt",
    });
    expect(refused.status).toBe(404);
    expect(sender.sent).toEqual([]);
    expect(repo.emailsForApplicant(liveId).some((e) => e.direction === "out")).toBe(false);

    // Same-realm send still works.
    const ok = await postForm(base, "/compose", demo.cookie, demo.csrf, {
      case: String(demoId), subject: "legit", body: "same-realm send",
    });
    expect(ok.status).toBe(302);
    expect(sender.sent.map((s) => s.to)).toEqual(["demo@example.ke"]);
  });
});

describe("mail thread realm guard", () => {
  it("404s cross-realm thread reads and label writes (both directions)", async () => {
    const base = await boot();
    mkCase("live@example.ke", "thr-live", 0);
    mkCase("demo@example.ke", "thr-demo", 1);
    // Live parked mail (no applicant at all).
    repo.insertEmail({
      applicant_id: null, message_id: "m-parked", thread_id: "thr-parked", direction: "in",
      from_addr: "stranger@example.ke", to_addr: "", subject: "Live parked secret", body: "x",
      category: null, auto: 0, at: new Date().toISOString(),
    });
    const live = await webLogin(base, "live-admin", "live12345");
    const demo = await webLogin(base, "demo-admin", "demo12345");

    // Reads.
    expect((await fetch(`${base}/mail/thread/thr-live`, { headers: { cookie: demo.cookie } })).status).toBe(404);
    expect((await fetch(`${base}/mail/thread/thr-demo`, { headers: { cookie: live.cookie } })).status).toBe(404);
    expect((await fetch(`${base}/mail/thread/thr-parked`, { headers: { cookie: demo.cookie } })).status).toBe(404);
    const own = await fetch(`${base}/mail/thread/thr-live`, { headers: { cookie: live.cookie } });
    expect(own.status).toBe(200);
    expect(await own.text()).toContain("hello thr-live");

    // Label writes.
    const refused = await postForm(base, "/mail/thread/thr-live/action", demo.cookie, demo.csrf, { action: "spam" });
    expect(refused.status).toBe(404);
    expect(repo.threadLabelState("thr-live").spam).toBe(false);
    const refusedParked = await postForm(base, "/mail/thread/thr-parked/action", demo.cookie, demo.csrf, { action: "bin" });
    expect(refusedParked.status).toBe(404);
    expect(repo.threadLabelState("thr-parked").bin).toBe(false);
    const ok = await postForm(base, "/mail/thread/thr-live/action", live.cookie, live.csrf, { action: "star" });
    expect(ok.status).toBe(302);
    expect(repo.threadLabelState("thr-live").starred).toBe(true);
  });
});
