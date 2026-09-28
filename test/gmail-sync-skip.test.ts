/**
 * "Sync now" must never report success for a pass that never ran.
 *
 * History: the onceAtATime guard returned null both for "finished, no error"
 * and "skipped — a pass is already in flight", so a manual sync clicked
 * during a background pass rendered "Inbox synced" for a pass that never
 * happened. The guard now returns { ran, result } and the routes say so.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { createApp } from "../src/web/server";
import { hashPassword } from "../src/util/password";
import { webLogin } from "./helpers";
import { onceAtATime } from "../src/util/once";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";

let repo: Repo;
let server: Server;
let base = "";
let admin: { cookie: string; csrf: string };
// Production wires ONE guarded pass to the poll, "Sync now" AND the backfill
// — mirror that so cross-route skipping is covered.
let passStarted = 0;
let releasePass!: () => void;

function holdPass(): void {
  passStarted = 0;
  const gate = new Promise<void>((r) => { releasePass = r; });
  currentGate = gate;
}
let currentGate: Promise<void> = Promise.resolve();

async function post(path: string, fields: Record<string, string>): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: admin.cookie },
    body: new URLSearchParams({ _csrf: admin.csrf, ...fields }).toString(),
    redirect: "manual",
  });
}

async function waitForPassStart(): Promise<void> {
  for (let i = 0; i < 200 && passStarted === 0; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(passStarted).toBe(1);
}

beforeAll(async () => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  repo.createStaff("admin", "Sync Admin", hashPassword("admin123"), "admin");
  const sender = new MockSender();
  const ctx: PipelineContext = { repo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender } };

  const guarded = onceAtATime(async () => {
    passStarted++;
    await currentGate;
    return null;
  });

  const app = createApp({ repo, ctx, gmailSync: guarded, gmailBackfill: guarded });
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const login = await webLogin(base, "admin", "admin123");
  expect(login.status).toBe(302);
  admin = { cookie: login.cookie, csrf: login.csrf };
});

afterAll(() => {
  server?.close();
});

describe("Sync now vs an in-flight pass", () => {
  it("a sync clicked while a pass runs reports the SKIP, not success", async () => {
    holdPass();
    const inFlight = post("/settings/gmail/sync", {});
    await waitForPassStart();

    const second = await post("/settings/gmail/sync", {});
    expect(second.status).toBe(302);
    expect(second.headers.get("location") || "").toContain(encodeURIComponent("A sync is already running"));

    releasePass();
    const first = await inFlight;
    expect(first.status).toBe(302);
    expect(first.headers.get("location") || "").toContain(encodeURIComponent("Inbox synced"));
  });

  it("a backfill during a running pass is skipped with the same honesty — then works once free", async () => {
    holdPass();
    const inFlight = post("/settings/gmail/sync", {});
    await waitForPassStart();

    const backfill = await post("/settings/gmail/backfill", { days: "30" });
    expect(backfill.status).toBe(302);
    expect(backfill.headers.get("location") || "").toContain(encodeURIComponent("already running"));

    releasePass();
    const first = await inFlight;
    expect(first.headers.get("location") || "").toContain(encodeURIComponent("Inbox synced"));

    // Once the guard is free, the backfill runs for real.
    const ok = await post("/settings/gmail/backfill", { days: "30" });
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location") || "").toContain(encodeURIComponent("History pulled"));
  });
});
