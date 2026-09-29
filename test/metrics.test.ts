/**
 * Phase 6: operational metrics are recorded at source and visible to
 * admins only on /metrics (officers get 403, anonymous users redirect).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { webLogin } from "./helpers";
import type { Server } from "http";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { DEFAULT_REQUIREMENTS } from "../src/config";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";
import { createApp, runEscalationSweep } from "../src/web/server";
import { hashPassword } from "../src/util/password";

let server: Server;
let base = "";
let repo: Repo;
let adminCookie = "";
let janeCookie = "";

beforeAll(async () => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  repo.createStaff("admin", "System Administrator", hashPassword("admin123"), "admin");
  repo.createStaff("jane", "Jane Wairimu (User)", hashPassword("jane123"), "user");
  repo.seedBaseRequirements(DEFAULT_REQUIREMENTS);
  const ctx: PipelineContext = {
    repo,
    adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender: new MockSender() },
  };
  const app = createApp({ repo, ctx });
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
  adminCookie = (await webLogin(base, "admin", "admin123")).cookie;
  janeCookie = (await webLogin(base, "jane", "jane123")).cookie;
});

afterAll(() => {
  server.close();
});

describe("metrics", () => {
  it("admin sees recorded metrics", async () => {
    await fetch(`${base}/`, { headers: { cookie: adminCookie } });
    await fetch(`${base}/settings`, { headers: { cookie: adminCookie } });
    runEscalationSweep(repo, 8);
    const res = await fetch(`${base}/metrics`, { headers: { cookie: adminCookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    for (const name of ["http.requests", "http.GET./", "http.GET./settings", "login.success", "sweep.runs"]) {
      expect(html).toContain(name);
    }
    // Navbar exposes the page to admins.
    const dash = await fetch(`${base}/`, { headers: { cookie: adminCookie } });
    expect(await dash.text()).toContain('href="/metrics"');
  });

  it("officer is forbidden", async () => {
    const res = await fetch(`${base}/metrics`, { headers: { cookie: janeCookie } });
    expect(res.status).toBe(403);
    // ... and never sees the nav entry.
    const dash = await fetch(`${base}/`, { headers: { cookie: janeCookie } });
    expect(await dash.text()).not.toContain('href="/metrics"');
  });

  it("anonymous users redirect to login", async () => {
    const res = await fetch(`${base}/metrics`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/login");
  });
});
