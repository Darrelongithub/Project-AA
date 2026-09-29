/** Audit Group C — session lifecycle and cookie flags.
 * A self-service password change must end every OTHER session (a stolen
 * cookie must not survive it) while keeping the changer's session alive;
 * the login-CSRF cookie must carry Secure behind TLS like the session
 * cookie does. (Reset-enumeration is pinned in forgot-password.test.ts.)
 */
import { describe, expect, it } from "vitest";
import type { Server } from "http";
import { webLogin } from "./helpers";
import { createApp } from "../src/web/server";
import { hashPassword } from "../src/util/password";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";

function fresh(): Repo {
  const repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  repo.createStaff("jane", "Jane Officer", hashPassword("officer123"), "user");
  return repo;
}

async function boot(repo: Repo): Promise<{ base: string; close: () => Promise<void> }> {
  const ctx: PipelineContext = { repo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender: new MockSender() } };
  const app = createApp({ repo, ctx });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = server.address() as { port: number };
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

describe("audit C — password change ends other sessions, keeps this one", () => {
  it("kills the thief's cookie but not the changer's", async () => {
    const repo = fresh();
    const { base, close } = await boot(repo);
    try {
      const changer = await webLogin(base, "jane", "officer123");
      const thief = await webLogin(base, "jane", "officer123");
      expect(changer.status).toBe(302);
      expect(thief.status).toBe(302);

      const change = await fetch(`${base}/account/password`, {
        method: "POST",
        headers: { cookie: changer.cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ _csrf: changer.csrf, current: "officer123", next: "newpassword9", confirm: "newpassword9" }),
        redirect: "manual",
      });
      expect(change.status).toBe(302);
      expect(decodeURIComponent(change.headers.get("location") ?? "")).toContain("1 other session(s)");

      const alive = await fetch(`${base}/`, { headers: { cookie: changer.cookie }, redirect: "manual" });
      expect(alive.status).toBe(200);
      const dead = await fetch(`${base}/`, { headers: { cookie: thief.cookie }, redirect: "manual" });
      expect(dead.status).toBe(302);
      expect(dead.headers.get("location")).toContain("/login");
    } finally {
      await close();
    }
  });
});

describe("audit C — login-CSRF cookie follows COOKIE_SECURE", () => {
  it("sets Secure on lcsrf behind TLS, omits it otherwise", async () => {
    const repo = fresh();
    const prev = process.env.COOKIE_SECURE;
    try {
      process.env.COOKIE_SECURE = "1";
      const tls = await boot(repo);
      try {
        const res = await fetch(`${tls.base}/login`);
        expect(res.headers.get("set-cookie")).toMatch(/lcsrf=[^;]+;[^]*Secure/);
      } finally {
        await tls.close();
      }
      delete process.env.COOKIE_SECURE;
      const plain = await boot(repo);
      try {
        const res = await fetch(`${plain.base}/login`);
        expect(res.headers.get("set-cookie")).not.toMatch(/Secure/);
      } finally {
        await plain.close();
      }
    } finally {
      if (prev === undefined) delete process.env.COOKIE_SECURE;
      else process.env.COOKIE_SECURE = prev;
    }
  });
});
