/**
 * Phase 11 (AU-R4): theme-route CSRF review.
 *
 * Two theme routes exist, deliberately different:
 * - POST /account/theme (authenticated settings form) enforces the app's
 *   standard session CSRF check (csrfCheck → 403 "CSRF validation failed").
 * - POST /theme (public shell toggle) is intentionally CSRF-less: it must
 *   work pre-login where no session/token exists, it writes only a
 *   SameSite=Lax cookie, and it touches zero server state. Adding csrfCheck
 *   there would break the login-page toggle for legitimate users.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { createApp } from "../src/web/server";
import { hashPassword } from "../src/util/password";
import { webLogin } from "./helpers";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";

let repo: Repo;
let server: Server;
let base = "";
let admin: { cookie: string; csrf: string };

beforeAll(async () => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  repo.createStaff("admin", "Admin", hashPassword("adminpass99"), "admin");
  const sender = new MockSender();
  const ctx: PipelineContext = { repo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender } };
  const app = createApp({ repo, ctx });
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const l = await webLogin(base, "admin", "adminpass99");
  expect(l.status).toBe(302);
  admin = { cookie: l.cookie, csrf: l.csrf };
});

afterAll(() => {
  server?.close();
});

describe("AU-R4: theme CSRF", () => {
  it("POST /account/theme without a token fails the standard CSRF check (403)", async () => {
    const res = await fetch(`${base}/account/theme`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: admin.cookie },
      body: new URLSearchParams({ theme: "light" }).toString(),
      redirect: "manual",
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("CSRF validation failed");
  });

  it("POST /account/theme with a token succeeds and sets the cookie", async () => {
    const res = await fetch(`${base}/account/theme`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: admin.cookie },
      body: new URLSearchParams({ _csrf: admin.csrf, theme: "light" }).toString(),
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie") || "").toContain("theme=light");
  });

  it("POST /theme stays usable anonymously (intentional pre-login exemption)", async () => {
    const res = await fetch(`${base}/theme`, {
      method: "POST",
      headers: { referer: `${base}/login` },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie") || "").toMatch(/theme=(light|dark)/);
  });
});
