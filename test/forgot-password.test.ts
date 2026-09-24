/**
 * Forgot-password mechanism — one-time reset code issued by an admin.
 *
 * Flow (per the owner's direction: "go for code from admin"):
 *   1. Admin opens Staff → Accounts, presses "Reset code" for a member.
 *      The page re-renders with the one-time code (200, never a redirect —
 *      the code must not land in a URL).
 *   2. The admin gives the code to the member out-of-band.
 *   3. The member opens the public "Forgot your password?" page, enters
 *      username + code + new password (min 8, confirmed).
 *   4. Success: password updated, the member's existing sessions are ended,
 *      the code is consumed, and it is audited.
 *
 * Security invariants pinned here:
 *   - code is one-time, expires (30 min), and a fresh issue revokes the old one;
 *   - a weak password does NOT burn the code;
 *   - code + wrong username is rejected (codes belong to one member);
 *   - identical generic refusal for every failure (no account enumeration);
 *   - the public endpoint is rate-limited per IP;
 *   - only admins can issue; every issue/use is audited.
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
let server: ReturnType<ReturnType<typeof createApp>["listen"]> | undefined;
let base = "";

let adminCookie = "";
let adminCsrf = "";

beforeEach(() => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  repo.createStaff("admin", "System Administrator", hashPassword("admin123"), "admin");
  repo.createStaff("jane", "Jane Officer", hashPassword("officer123"), "user");
});

afterEach(() => {
  server?.close();
  server = undefined;
});

async function startServer(): Promise<void> {
  const ctx: PipelineContext = { repo, adapters: { vision: null as never, watcher: null as never, sender: new MockSender() } };
  const app = createApp({ repo, ctx });
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const a = await webLogin(base, "admin", "admin123");
  adminCookie = a.cookie;
  adminCsrf = a.csrf;
}

async function staffResetCode(staffId: number): Promise<{ status: number; html: string }> {
  const res = await fetch(`${base}/staff/reset-code`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: adminCookie },
    body: `_csrf=${encodeURIComponent(adminCsrf)}&id=${staffId}`,
  });
  return { status: res.status, html: await res.text() };
}

/** Issue a code via the admin UI and pull the 10-char code out of the page. */
async function issueCodeFor(staffId: number): Promise<string> {
  const { html } = await staffResetCode(staffId);
  const m = /id="reset-code"[\s\S]*?class="mono"[^>]*>([A-HJ-KM-NP-Z2-9]{10})</.exec(html);
  if (!m) throw new Error(`no code found in staff page: ${html.slice(0, 400)}`);
  return m[1];
}

async function officerId(): Promise<number> {
  return repo.listStaff().find((s) => s.username === "jane")!.id;
}

async function login(username: string, password: string): Promise<{ cookie: string; csrf: string; status: number }> {
  return webLogin(base, username, password);
}

async function publicResetPost(fields: Record<string, string>): Promise<{ status: number; html: string }> {
  // Fresh anonymous visitor: GET the page (collects the lcsrf cookie), then POST.
  const page = await fetch(`${base}/reset-password`);
  const lcsrfCookie = ((page.headers.get("set-cookie") || "").match(/lcsrf=([^;]+)/) || [])[1] ?? "";
  const html = await page.text();
  const hidden = (/name="_lcsrf" value="([^"]+)"/.exec(html) || [])[1] ?? lcsrfCookie;
  const body = new URLSearchParams({ ...fields, _lcsrf: hidden }).toString();
  const res = await fetch(`${base}/reset-password`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: `lcsrf=${lcsrfCookie}` },
    body,
    redirect: "manual", // the success path 302s to /login?msg=… — we assert the hop, not the target
  });
  return { status: res.status, html: await res.text() };
}

// Note: the page HTML-escapes the apostrophe (couldn&#39;t), so match on
// the apostrophe-free part of the generic refusal.
const GENERIC = /verify that username and code|check the|invalid|try again/i;

describe("public surface", () => {
  it("login page offers the forgot-password path", async () => {
    await startServer();
    const html = await (await fetch(`${base}/login`)).text();
    expect(html).toContain("/reset-password");
    expect(html.toLowerCase()).toContain("forgot your password");
  });

  it("GET /reset-password renders the anonymous reset form", async () => {
    await startServer();
    const res = await fetch(`${base}/reset-password`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('name="code"');
    expect(html).toContain('name="password"');
    expect(html).toContain('name="confirm"');
  });
});

describe("admin issues a one-time code", () => {
  it("renders the code on a 200 (never in a URL) and audits it", async () => {
    await startServer();
    const { status, html } = await staffResetCode(await officerId());
    expect(status).toBe(200);
    expect(html).toMatch(/\b[A-HJ-KM-NP-Z2-9]{10}\b/);
    const audit = repo.recentAudit(50);
    expect(JSON.stringify(audit)).toContain("password_reset_code_issued");
  });

  it("a non-admin cannot issue codes", async () => {
    await startServer();
    const j = await login("jane", "officer123");
    const res = await fetch(`${base}/staff/reset-code`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: j.cookie },
      body: `_csrf=${encodeURIComponent(j.csrf)}&id=1`,
    });
    expect(res.status).toBe(403);
  });
});

describe("public reset", () => {
  it("rejects a wrong code and does not change the password", async () => {
    await startServer();
    const r = await publicResetPost({ username: "jane", code: "AAAAAAAAAA", password: "newpassword9", confirm: "newpassword9" });
    expect(r.status).toBe(200);
    expect(r.html).toMatch(GENERIC);
    const ok = await login("jane", "officer123");
    expect(ok.status).toBe(302); // old password still works
  });

  it("rejects a code paired with the wrong username", async () => {
    await startServer();
    const code = await issueCodeFor(await officerId());
    const r = await publicResetPost({ username: "admin", code, password: "newpassword9", confirm: "newpassword9" });
    expect(r.html).toMatch(GENERIC);
    const ok = await login("admin", "admin123");
    expect(ok.status).toBe(302); // admin password untouched
  });

  it("a weak password does not burn the code", async () => {
    await startServer();
    const code = await issueCodeFor(await officerId());
    const weak = await publicResetPost({ username: "jane", code, password: "abc", confirm: "abc" });
    expect(weak.html).toMatch(/8 characters/i);
    const good = await publicResetPost({ username: "jane", code, password: "newpassword9", confirm: "newpassword9" });
    expect(good.status).toBe(302); // same code still valid
  });

  it("matching passwords are required", async () => {
    await startServer();
    const code = await issueCodeFor(await officerId());
    const r = await publicResetPost({ username: "jane", code, password: "newpassword9", confirm: "different999" });
    expect(r.html).toMatch(/match/i);
  });

  it("full success: new password works, old one dies, code consumed, sessions ended", async () => {
    await startServer();
    // Jane has a live session BEFORE the reset.
    const before = await login("jane", "officer123");
    // redirect:"manual" — undici follows 302s by default, which would turn
    // the login-redirect (dead session) into a 200 login page.
    expect((await fetch(`${base}/`, { headers: { cookie: before.cookie }, redirect: "manual" })).status).toBe(200);

    const code = await issueCodeFor(await officerId());
    const r = await publicResetPost({ username: "jane", code, password: "newpassword9", confirm: "newpassword9" });
    expect(r.status).toBe(302);

    // New password works, old one fails.
    expect((await login("jane", "newpassword9")).status).toBe(302);
    expect((await login("jane", "officer123")).status).toBe(401);

    // Code is single-use.
    const reuse = await publicResetPost({ username: "jane", code, password: "anotherpass9", confirm: "anotherpass9" });
    expect(reuse.html).toMatch(GENERIC);

    // The pre-reset session is dead (302 → /login, not the dashboard).
    expect((await fetch(`${base}/`, { headers: { cookie: before.cookie }, redirect: "manual" })).status).toBe(302);
  });

  it("an expired code is rejected", async () => {
    await startServer();
    const code = await issueCodeFor(await officerId());
    repo.db.prepare("UPDATE password_reset_codes SET expires_at = ? WHERE code = ?").run("2000-01-01T00:00:00.000Z", code);
    const r = await publicResetPost({ username: "jane", code, password: "newpassword9", confirm: "newpassword9" });
    expect(r.html).toMatch(GENERIC);
    expect((await login("jane", "officer123")).status).toBe(302);
  });

  it("issuing a second code revokes the first", async () => {
    await startServer();
    const id = await officerId();
    const first = await issueCodeFor(id);
    const second = await issueCodeFor(id);
    expect(first).not.toEqual(second);
    const stale = await publicResetPost({ username: "jane", code: first, password: "newpassword9", confirm: "newpassword9" });
    expect(stale.html).toMatch(GENERIC);
    const fresh = await publicResetPost({ username: "jane", code: second, password: "newpassword9", confirm: "newpassword9" });
    expect(fresh.status).toBe(302);
  });

  it("fails closed for unknown usernames with the same generic message", async () => {
    await startServer();
    const code = await issueCodeFor(await officerId());
    const r = await publicResetPost({ username: "ghost", code, password: "newpassword9", confirm: "newpassword9" });
    expect(r.html).toMatch(GENERIC);
  });

  it("rate-limits repeated failed attempts from one IP", async () => {
    await startServer();
    for (let i = 0; i < 5; i++) {
      await publicResetPost({ username: "jane", code: "AAAAAAAAAA", password: "newpassword9", confirm: "newpassword9" });
    }
    const blocked = await publicResetPost({ username: "jane", code: "AAAAAAAAAA", password: "newpassword9", confirm: "newpassword9" });
    expect(blocked.status).toBe(429);
  });
});
