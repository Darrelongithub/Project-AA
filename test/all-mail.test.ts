/**
 * All Mail — the whole history, not just the new (round 9).
 *
 * "I should be able to see all my emails not just the new ones."
 *
 * - All Mail is paginated, newest first — no hidden cap on the number of
 *   conversations you can scroll back through.
 * - Mail that was parked without an applicant (non-intake mail, round 9's
 *   hotword gate) still appears in the window: it can be listed, opened,
 *   labelled and counted. Parked means "not a case" — never "deleted".
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
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let base = "";
let admin: { cookie: string; csrf: string };

beforeEach(() => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  repo.createStaff("admin", "Mail Admin", hashPassword("admin123"), "admin");
  const sender = new MockSender();
  const ctx: PipelineContext = { repo, adapters: { vision: null as never, watcher: null as never, sender } };
  const app = createApp({ repo, ctx });
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(() => {
  server?.close();
});

const ROW = /onclick="location\.href=/g;
function rows(html: string): number {
  return html.match(ROW)?.length ?? 0;
}

function historyThreads(count: number): void {
  const app = repo.getOrCreateApplicant("history@students.ac.ke", "hist-thread", { fullName: "History Student" });
  const baseAt = Date.parse("2026-08-01T08:00:00.000Z");
  for (let i = 0; i < count; i += 1) {
    const nn = String(i + 1).padStart(3, "0");
    repo.insertEmail({
      applicant_id: app.id,
      message_id: `hist-${nn}`,
      thread_id: `hist-th-${nn}`,
      direction: "in",
      from_addr: "history@students.ac.ke",
      to_addr: "admissions@riara.ac.ke",
      subject: `History ${nn}`,
      body: `Convo ${nn}`,
      category: "other",
      auto: 0,
      at: new Date(baseAt + i * 3_600_000).toISOString(),
    });
  }
}

function park(subject: string, tkey: string, from = "parked@stranger.com"): void {
  repo.insertEmail({
    applicant_id: null,
    message_id: `park-${tkey}`,
    thread_id: tkey,
    direction: "in",
    from_addr: from,
    to_addr: "admissions@riara.ac.ke",
    subject,
    body: "Parked non-intake mail.",
    category: "other",
    auto: 0,
    at: new Date().toISOString(),
  });
}

async function csrfFrom(pageHtml: string): Promise<string> {
  return (/name="_csrf" value="([^"]+)"/.exec(pageHtml) || [])[1] ?? "";
}

describe("All Mail — history, not just the new", () => {
  it("paginates past the first page, newest first, with a working pager", async () => {
    admin = await webLogin(base, "admin", "admin123");
    historyThreads(75);

    const p1 = await fetch(`${base}/mail?f=all`, { headers: { cookie: admin.cookie } });
    const h1 = await p1.text();
    expect(p1.status).toBe(200);
    expect(rows(h1)).toBe(50); // one full page, not the whole 75
    expect(h1).toContain("History 075"); // newest on page one
    expect(h1).not.toContain("History 001"); // oldest is NOT on page one
    expect(h1).toMatch(/Older/); // pager offers more
    expect(h1).toMatch(/f=all&page=2/);

    const p2 = await fetch(`${base}/mail?f=all&page=2`, { headers: { cookie: admin.cookie } });
    const h2 = await p2.text();
    expect(rows(h2)).toBe(25);
    expect(h2).toContain("History 001"); // the oldest conversation is reachable
    expect(h2).toContain("History 025"); // …and the rest of page two
    expect(h2).not.toContain("History 026"); // page two ends where page one begins
    expect(h2).not.toContain("History 075");
    expect(h2).not.toMatch(/f=all&page=3/); // no pager beyond the last page
    expect(h2).toMatch(/Newer/); // and back up again

    const p3 = await fetch(`${base}/mail?f=all&page=3`, { headers: { cookie: admin.cookie } });
    const h3 = await p3.text();
    expect(rows(h3)).toBe(0); // nothing past the end
  });

  it("shows parked mail (no applicant) in All Mail and lets you open it", async () => {
    admin = await webLogin(base, "admin", "admin123");
    historyThreads(2);
    park("Parked promo mail", "parked-th-1");

    const all = await (await fetch(`${base}/mail?f=all`, { headers: { cookie: admin.cookie } })).text();
    expect(all).toContain("Parked promo mail");
    expect(all).toMatch(/not linked to a case/i); // and it says so plainly

    const threadPage = await fetch(`${base}/mail/thread/parked-th-1`, { headers: { cookie: admin.cookie } });
    expect(threadPage.status).toBe(200);
    const th = await threadPage.text();
    expect(th).toContain("Parked promo mail");
    expect(th).toMatch(/no case/i);

    // Labelling a parked conversation must not 500 on the missing applicant.
    const csrf = await csrfFrom(th);
    const star = await fetch(`${base}/mail/thread/parked-th-1/action`, {
      method: "POST",
      headers: { cookie: admin.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: csrf, action: "star", back: "/mail" }).toString(),
      redirect: "manual",
    });
    expect(star.status).toBe(302);
    const starred = repo.db.prepare(`SELECT labels FROM emails WHERE thread_id = 'parked-th-1'`).get() as { labels: string } | undefined;
    expect(starred?.labels).toContain("starred");
  });

  it("counts parked mail in the folder counts (it is mail, after all)", async () => {
    await webLogin(base, "admin", "admin123");
    historyThreads(1);
    park("Another parked one", "parked-th-2");
    const counts = repo.mailFolderCounts({ demo: 0 });
    expect(counts.all).toBe(2); // 1 applicant thread + 1 parked
    expect(counts.inbox).toBe(2);
    expect(counts.unread).toBe(2);
  });

  it("never shows live parked mail to demo accounts (realm guard)", async () => {
    admin = await webLogin(base, "admin", "admin123");
    park("Live parked secret", "parked-th-3");

    repo.createStaff("demo1", "Demo Officer", hashPassword("demo12345"), "admin", true);
    const demo = await webLogin(base, "demo1", "demo12345");
    const page = await (await fetch(`${base}/mail?f=all`, { headers: { cookie: demo.cookie } })).text();
    expect(page).not.toContain("Live parked secret");
    // …and the conversation itself is refused, not merely hidden.
    const thread = await fetch(`${base}/mail/thread/parked-th-3`, { headers: { cookie: demo.cookie } });
    expect([302, 403, 404]).toContain(thread.status);
  });
});
