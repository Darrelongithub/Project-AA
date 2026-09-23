/**
 * Round-3 security fixes — verified bugs from the master-checklist audit:
 *
 *  B1  /case/:id middleware must reject cross-realm access (live ↔ demo) for
 *      EVERY route under it, not just the two GETs that re-check manually.
 *  B2  All three CSV exports must filter realm + school scope.
 *  B3  Archive directory created with mode 0o700.
 *  B4  Login-failure map prunes by time, never a blunt clear at 5,000.
 *  B5  Retention defaults to the LIVE realm only (explicit flag to widen).
 *  B6  Admin password reset gets the same rules as first-run setup
 *      (≥8 chars + confirm match).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "node:child_process";
import { Repo } from "../src/db/repo";
import { openDb } from "../src/db/db";
import { seedDefaults } from "../src/db/seed";
import { DEFAULT_REQUIREMENTS } from "../src/config";
import { createApp } from "../src/web/server";
import { hashPassword, verifyPassword } from "../src/util/password";
import { webLogin } from "./helpers";
import type { PipelineContext } from "../src/pipeline/adapters";
import type { Server } from "http";

let repo: Repo;
let server: Server | undefined;

beforeEach(() => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  repo.seedBaseRequirements(DEFAULT_REQUIREMENTS);
});
afterEach(() => { server?.close(); server = undefined; });

async function boot(extraStaff: Array<{ u: string; p: string; demo?: boolean }> = []): Promise<string> {
  repo.createStaff("admin", "Live Admin", hashPassword("admin123"), "admin");
  for (const s of extraStaff) repo.createStaff(s.u, s.u, hashPassword(s.p), "admin", s.demo ?? false);
  const ctx: PipelineContext = { repo, adapters: { vision: null as never, watcher: null as never, sender: null as never } };
  const s = createApp({ repo, ctx }).listen(0);
  server = s;
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
}

function mkApplicant(ref: string, demo: 0 | 1): number {
  const a = repo.getOrCreateApplicant(`${ref}@example.ke`, `thr-${ref}`);
  (repo as unknown as { db: { prepare: (q: string) => { run: (...x: unknown[]) => unknown } } }).db
    .prepare("UPDATE applicants SET demo = ? WHERE id = ?").run(demo, a.id);
  return a.id;
}

describe("B1 — one realm guard at the /case/:id choke point", () => {
  it("cross-realm POST mutations return 404 (both directions), same-realm still works", async () => {
    const base = await boot([{ u: "demo", p: "demo12345", demo: true }]);
    const liveId = mkApplicant("live-case", 0);
    const demoId = mkApplicant("demo-case", 1);

    const { cookie: liveCk, csrf: liveCs } = await webLogin(base, "admin", "admin123");
    const { cookie: demoCk, csrf: demoCs } = await webLogin(base, "demo", "demo12345");

    const note = (id: number, cookie: string, csrf: string) =>
      fetch(`${base}/case/${id}/note`, {
        method: "POST", redirect: "manual",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: `_csrf=${encodeURIComponent(csrf)}&note=hello`,
      });
    // demo admin MUST NOT be able to mutate the live case (today: 302 — the bug)
    expect((await note(liveId, demoCk, demoCs)).status).toBe(404);
    // live admin MUST NOT be able to mutate the demo case either
    expect((await note(demoId, liveCk, liveCs)).status).toBe(404);
    // and a second mutation route, to prove the guard is the middleware, not luck
    const task = (id: number, cookie: string, csrf: string) =>
      fetch(`${base}/case/${id}/task/add`, {
        method: "POST", redirect: "manual",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: `_csrf=${encodeURIComponent(csrf)}&title=t&due=2026-10-01`,
      });
    expect((await task(liveId, demoCk, demoCs)).status).toBe(404);
    // same-realm still flows through
    expect((await note(liveId, liveCk, liveCs)).status).toBe(302);
    expect((await note(demoId, demoCk, demoCs)).status).toBe(302);
    // cross-realm reads were already 404; keep them pinned
    const read = await fetch(`${base}/case/${liveId}`, { headers: { cookie: demoCk } });
    expect(read.status).toBe(404);
  });
});

describe("B2 — CSV exports honour realm + school scope", () => {
  it("applicants.csv, queue.csv and audit.csv contain only the caller's realm", async () => {
    const base = await boot([{ u: "demo", p: "demo12345", demo: true }]);
    const liveId = mkApplicant("exp-live", 0);
    const demoId = mkApplicant("exp-demo", 1);
    (repo as unknown as { db: { prepare: (q: string) => { run: (...x: unknown[]) => unknown } } }).db
      .prepare("UPDATE applicants SET lifecycle = 'awaiting_review' WHERE id IN (?, ?)").run(liveId, demoId);
    repo.audit(liveId, "admin", "test_event", "live-detail");
    repo.audit(demoId, "demo", "test_event", "demo-detail");
    repo.audit(null, "admin", "system_event", "no applicant attached");

    const { cookie } = await webLogin(base, "admin", "admin123");
    const csv = async (p: string) => (await fetch(`${base}${p}`, { headers: { cookie } })).text();

    const apps = await csv("/export/applicants.csv");
    expect(apps).toContain("exp-live@example.ke");
    expect(apps).not.toContain("exp-demo@example.ke");
    const queue = await csv("/export/queue.csv");
    expect(queue).not.toContain("exp-demo@example.ke");
    const audit = await csv("/export/audit.csv");
    expect(audit).toContain("live-detail");
    expect(audit).toContain("system_event"); // unattached rows survive
    expect(audit).not.toContain("demo-detail");
  });
});

describe("B3+B5 — retention: archive dir locked, live realm by default", () => {
  it("archives old completed LIVE cases only; demo untouched; dir mode 0700", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retain-"));
    const dbPath = path.join(dir, "t.sqlite");
    const r = new Repo(openDb(dbPath));
    seedDefaults(r);
    r.seedBaseRequirements(DEFAULT_REQUIREMENTS);
    const raw = r as unknown as { db: { prepare: (q: string) => { run: (...x: unknown[]) => unknown; get: (...x: unknown[]) => { n: number } } } };
    const old = new Date(Date.now() - 1000 * 24 * 3600_000).toISOString();
    const live = r.getOrCreateApplicant("old-live@example.ke", "t1");
    raw.db.prepare("UPDATE applicants SET lifecycle='completed', demo=0, updated_at=? WHERE id=?").run(old, live.id);
    const demo = r.getOrCreateApplicant("old-demo@example.ke", "t2");
    raw.db.prepare("UPDATE applicants SET lifecycle='completed', demo=1, updated_at=? WHERE id=?").run(old, demo.id);

    const run = spawnSync("./node_modules/.bin/tsx", ["src/cli/retain.ts"], {
      cwd: path.resolve(__dirname, ".."),
      env: { ...process.env, DB_PATH: dbPath, DISABLE_OCR: "1" },
      timeout: 60_000,
    });
    expect(run.status).toBe(0);

    const r2 = new Repo(openDb(dbPath));
    expect(r2.getApplicant(live.id)).toBeUndefined();       // archived + removed
    expect(r2.getApplicant(demo.id)).toBeDefined();          // demo NOT swept
    const archiveDir = path.join(dir, "archive");
    const mode = fs.statSync(archiveDir).mode & 0o777;
    expect(mode).toBe(0o700);                                 // dir locked (today: 0755)
    const file = fs.readdirSync(archiveDir)[0];
    expect(fs.statSync(path.join(archiveDir, file)).mode & 0o777).toBe(0o600);
  });
});

describe("B4 — login throttle prunes by time, never blunt-clears", () => {
  it("blocks after 5 fails within a minute, recovers after the window, stays bounded", async () => {
    const { LoginThrottle } = await import("../src/web/throttle");
    const t = new LoginThrottle({ windowMs: 60_000, maxFails: 5, maxEntries: 1_000 });
    const now = Date.now();
    for (let i = 0; i < 4; i++) t.recordFail("1.2.3.4", now);
    expect(t.allowed("1.2.3.4", now)).toBe(true);
    t.recordFail("1.2.3.4", now);
    expect(t.allowed("1.2.3.4", now)).toBe(false);
    expect(t.allowed("1.2.3.4", now + 61_000)).toBe(true); // window rolls on

    // A flood of unique attackers must never grow the map without bound,
    // and must never bulk-wipe the memory (today: clear()): an IP that is
    // currently inside its block window stays blocked after the flood.
    for (let i = 0; i < 5_000; i++) t.recordFail(`10.0.${i & 255}.${i >> 8}`, now + 100);
    for (let i = 0; i < 5; i++) t.recordFail("9.9.9.9", now + 200);
    expect(t.size).toBeLessThanOrEqual(1_000);   // bounded memory
    expect(t.size).toBeGreaterThan(0);           // no bulk clear
    expect(t.allowed("9.9.9.9", now + 201)).toBe(false); // still blocked
  });
});

describe("B6 — admin password reset uses the same rules as first-run setup", () => {
  it("rejects missing/mismatched confirm and short passwords; accepts a matched pair", async () => {
    const base = await boot([]);
    const { cookie, csrf } = await webLogin(base, "admin", "admin123");
    const target = repo.getStaffByUsername("admin")!;

    const reset = (password: string, confirm: string) =>
      fetch(`${base}/staff/password`, {
        method: "POST", redirect: "manual",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: `_csrf=${encodeURIComponent(csrf)}&id=${target.id}&password=${encodeURIComponent(password)}&confirm=${encodeURIComponent(confirm)}`,
      }).then((r) => decodeURIComponent(r.headers.get("location") ?? ""));

    expect(await reset("newpass123", "")).toContain("do not match");      // no confirm (today: saves!)
    expect(await reset("newpass123", "different456")).toContain("do not match");
    expect(await reset("short", "short")).toContain("at least 8");
    expect(await reset("newpass123", "newpass123")).toContain("Password reset for");
    // getStaff() intentionally omits the hash column — read it from the DB.
    const row = (repo as unknown as { db: { prepare: (q: string) => { get: (...x: unknown[]) => { password_hash: string } } } })
      .db.prepare("SELECT password_hash FROM staff_users WHERE id = ?").get(target.id);
    expect(verifyPassword("newpass123", row.password_hash)).toBe(true);
  });
});
