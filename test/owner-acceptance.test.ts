/**
 * Owner acceptance gates (OR-1 … OR-8). One describe block per issue ID.
 * Every test here was written BEFORE the fix and watched fail (RED), then
 * pass (GREEN). See OWNER_ISSUES.md for the evidence log.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Server } from "http";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { createApp } from "../src/web/server";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";
import { hashPassword, verifyPassword } from "../src/util/password";
import { purgeMockData } from "../src/db/purge";
import { runSimulation } from "../src/simulation/run";
import { loadConfig } from "../src/config";

function freshCtx(): { repo: Repo; ctx: PipelineContext } {
  const repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  const ctx: PipelineContext = {
    repo,
    adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender: new MockSender() },
  };
  return { repo, ctx };
}

async function startServer(repo: Repo, ctx: PipelineContext): Promise<{ base: string; server: Server }> {
  const app = createApp({ repo, ctx });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const addr = server.address() as { port: number };
  return { base: `http://127.0.0.1:${addr.port}`, server };
}

// ─────────────────────────────────────────────────────────────────────────────
// OR-1 — No mock data in the app
// ─────────────────────────────────────────────────────────────────────────────
describe("OR-1: the product contains no mock data", () => {
  it("a fresh database seeds NO staff accounts — there is no default login", () => {
    const { repo } = freshCtx();
    expect(repo.staffCount()).toBe(0);
    const admin = repo.getStaffByUsername("admin");
    expect(admin).toBeUndefined();
  });

  it("first-run setup creates the admin account over HTTP; old defaults never work", async () => {
    const { repo, ctx } = freshCtx();
    const { base, server } = await startServer(repo, ctx);
    try {
      // The login page redirects a first-run install to the setup screen.
      const loginPage = await fetch(`${base}/login`, { redirect: "manual" });
      expect(loginPage.status).toBe(302);
      expect(loginPage.headers.get("location")).toBe("/setup");

      const setupPage = await fetch(`${base}/setup`);
      expect(setupPage.status).toBe(200);
      const html = await setupPage.text();
      const token = (html.match(/name="_setup" value="([a-f0-9]+)"/) || [])[1] || "";
      expect(token.length).toBeGreaterThan(10);

      // Old hard-coded defaults must never grant a session — on a fresh
      // install the login post is bounced to the setup screen.
      const bad = await fetch(`${base}/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "username=admin&password=admin123",
        redirect: "manual",
      });
      expect(bad.headers.get("location") ?? "/setup").toBe("/setup");
      expect(bad.headers.get("set-cookie") ?? "").not.toContain("sid=");

      // Create the admin through the setup form.
      const res = await fetch(`${base}/setup`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          _setup: token,
          display_name: "Darrel",
          username: "darrel",
          password: "owner-chosen-passphrase",
          confirm: "owner-chosen-passphrase",
        }).toString(),
        redirect: "manual",
      });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/");
      const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
      expect(cookie).toContain("sid=");

      // The setup endpoint is gone forever once one account exists.
      const again = await fetch(`${base}/setup`);
      expect(again.status).toBe(404);

      // And the created account works.
      const home = await fetch(`${base}/`, { headers: { cookie } });
      expect(home.status).toBe(200);
      const created = repo.getStaffByUsername("darrel");
      expect(created?.role).toBe("admin");
      expect(verifyPassword("owner-chosen-passphrase", created!.password_hash)).toBe(true);
    } finally {
      server.close();
    }
  });

  it("setup rejects short passwords and mismatched confirmation", async () => {
    const { repo, ctx } = freshCtx();
    const { base, server } = await startServer(repo, ctx);
    try {
      const page = await fetch(`${base}/setup`);
      const token = ((await page.text()).match(/name="_setup" value="([a-f0-9]+)"/) || [])[1] || "";
      const res = await fetch(`${base}/setup`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ _setup: token, display_name: "X", username: "x", password: "short", confirm: "other" }).toString(),
        redirect: "manual",
      });
      expect(res.status).toBe(200); // re-renders with the error, nothing created
      expect(repo.staffCount()).toBe(0);
    } finally {
      server.close();
    }
  });

  it("a fresh console shows zero mock/demo wording on every page", async () => {
    const { repo, ctx } = freshCtx();
    const { base, server } = await startServer(repo, ctx);
    try {
      // First-run admin via the repo (same path the setup form takes).
      repo.createStaff("boss", "Owner", hashPassword("first-run-password-1"), "admin");
      const login = await fetch(`${base}/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "username=boss&password=first-run-password-1",
        redirect: "manual",
      });
      const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
      const pages = ["/", "/applicants", "/admissions", "/settings", "/staff", "/account", "/login"];
      for (const p of pages) {
        const res = await fetch(`${base}${p}`, { headers: { cookie }, redirect: "manual" });
        expect(res.status, p).toBe(200);
        const html = await res.text();
        expect(html, `${p} must not mention demo data`).not.toMatch(/demo/i);
        expect(html, `${p} must not tell users to seed samples`).not.toContain("npm run demo");
      }
    } finally {
      server.close();
    }
  });

  it("the simulation corpus refuses to run against the server database", async () => {
    const cfg = loadConfig();
    // The simulation's default target is in-memory…
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "simulation", "run.ts"), "utf8");
    expect(src).toContain('opts.dbPath ?? ":memory:"');
    // …and it hard-refuses the exact file the server reads.
    await expect(runSimulation({ dbPath: cfg.dbPath })).rejects.toThrow(/refusing/i);
    // Same refusal for a file-based throwaway DB passed explicitly is NOT
    // triggered — only the server's own database is protected.
  });

  it("purge-mock removes ONLY synthetic rows, backs up first, and is idempotent", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "or1-purge-"));
    const dbPath = path.join(tmpDir, "contaminated.sqlite");
    const repo = new Repo(openDb(dbPath));
    seedDefaults(repo);
    repo.createStaff("realadmin", "Real Admin", hashPassword("real-password-99"), "admin");
    // Contamination exactly like an old `npm run demo` left behind:
    repo.createStaff("demo_admin", "Demo Admin", hashPassword("demo123"), "admin", true);
    repo.createStaff("demo_user", "Demo User", hashPassword("demo123"), "user", true);
    const real = repo.getOrCreateApplicant("real.student@gmail.com", "t-real");
    const mock1 = repo.getOrCreateApplicant("fixture-one@simulation.example", "t-mock1");
    const mock2 = repo.getOrCreateApplicant("fixture-two@simulation.example", "t-mock2");
    for (const a of [mock1, mock2]) repo.updateApplicant(a.id, { programme: "BBIT" });
    // The old demo tool flagged every applicant as mock — simulate exactly that…
    repo.db.prepare("UPDATE applicants SET demo = 1").run();
    // …then keep the genuinely-real row clean, as a live DB would have it.
    repo.db.prepare("UPDATE applicants SET demo = 0 WHERE id = ?").run(real.id);
    repo.setSetting("demo_dataset", "1");

    const backupPath = path.join(tmpDir, "backup.sqlite");
    const removed = purgeMockData(repo, { backupPath });
    expect(removed.applicants).toBe(2);
    expect(removed.staff).toBe(2);
    // Real data survived
    expect(repo.getApplicant(real.id)?.email_address).toBe("real.student@gmail.com");
    expect(repo.getStaffByUsername("realadmin")).toBeDefined();
    expect(repo.getStaffByUsername("demo_admin")).toBeUndefined();
    expect(repo.getSetting("demo_dataset", "")).toBe("");
    // Backup exists and contains the old rows
    expect(fs.existsSync(backupPath)).toBe(true);
    const backupRepo = new Repo(openDb(backupPath));
    expect(backupRepo.getStaffByUsername("demo_admin")).toBeDefined();
    // Idempotent: second pass removes nothing
    const second = purgeMockData(repo, { backupPath: path.join(tmpDir, "backup2.sqlite") });
    expect(second.applicants).toBe(0);
    expect(second.staff).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OR-2 — the status/queue model must follow the pipeline
// ─────────────────────────────────────────────────────────────────────────────
import { queueOf } from "../src/admissions/queues";
import type { ApplicantRow } from "../src/types";

function rowFor(over: Partial<ApplicantRow>): ApplicantRow {
  return {
    id: 1, ref_number: "RU-1", email_address: "x@example.com", thread_id: "t",
    full_name: null, phone: null, programme: null, intake: null, priority: "normal",
    lifecycle: "application_received", assigned_to: null, escalated: 0,
    sla_due_at: null, sla_handled_at: null, routing: null, routing_reason: null,
    admission_decision: "undecided", followup_next_at: null, created_at: "", updated_at: "",
    demo: 0, nationality: null, applicant_type: null,
    ...over,
  } as unknown as ApplicantRow;
}

describe("OR-2: queue placement follows the pipeline", () => {
  it("documents received but no routing yet => review path, never an enquiry", () => {
    const a = rowFor({ lifecycle: "documents_received" });
    expect(queueOf(a, { hasDocuments: true, lastDirection: null })).toEqual({
      queue: "human_review",
      sub: "manual_decision_required",
    });
  });

  it("documents checked and awaiting review => still the review path", () => {
    const a = rowFor({ lifecycle: "awaiting_review" });
    expect(queueOf(a, { hasDocuments: true, lastDirection: "in" })).toEqual({
      queue: "human_review",
      sub: "manual_decision_required",
    });
  });

  it("missing documents with a follow-up out => waiting on the applicant, plainly worded", () => {
    const a = rowFor({ routing: "waiting_documents", routing_reason: "missing_documents", followup_next_at: "2026-09-30T00:00:00Z" });
    const p = queueOf(a, { hasDocuments: false, lastDirection: "out" });
    expect(p.queue).toBe("waiting_documents");
    expect(p.sub).toBe("awaiting_applicant_response");
  });

  it("an escalated case with documents never drops to enquiries", () => {
    const a = rowFor({ lifecycle: "documents_checked", escalated: 1 });
    expect(queueOf(a, { hasDocuments: true, lastDirection: null }).queue).toBe("human_review");
  });

  it("a true enquiry (no documents, nothing routed) stays in enquiries", () => {
    const a = rowFor({ lifecycle: "application_received" });
    expect(queueOf(a, { hasDocuments: false, lastDirection: "in" }).queue).toBe("enquiries");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OR-4 — Gmail/Gemini connections: one home in Settings, guided, live status
// ─────────────────────────────────────────────────────────────────────────────

async function or4Server() {
  const repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  repo.createStaff("boss", "Owner", hashPassword("first-run-password-1"), "admin");
  const ctx: PipelineContext = {
    repo,
    adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender: new MockSender() },
  };
  return { repo, ctx, ...(await startServer(repo, ctx)) };
}

async function or4Login(base: string): Promise<string> {
  const res = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "username=boss&password=first-run-password-1",
    redirect: "manual",
  });
  return (res.headers.get("set-cookie") || "").split(";")[0];
}

async function csrfFor(base: string, cookie: string): Promise<string> {
  const html = await (await fetch(`${base}/settings`, { headers: { cookie } })).text();
  return (html.match(/<meta name="csrf" content="([a-f0-9]+)">/) || [])[1] || "";
}

describe("OR-4: connections live in Settings, nowhere else", () => {
  it("Settings renders a Connections section with step-by-step Gmail + Gemini guides", async () => {
    const { base, server } = await or4Server();
    try {
      const cookie = await or4Login(base);
      const html = await (await fetch(`${base}/settings`, { headers: { cookie } })).text();
      expect(html).toContain('id="connections"');
      expect(html).toContain('id="gmail"');
      expect(html).toContain('id="gemini"');
      // guide content
      expect(html).toContain("Google Cloud");
      expect(html).toContain("Gmail API");
      expect(html).toContain("OAuth client");
      expect(html).toContain("gmail.modify");
      expect(html).toContain("/settings/gmail/callback");
      expect(html).toContain("OAuth Playground");
      expect(html).toContain("aistudio.google.com");
    } finally {
      server.close();
    }
  });

  it("Configuration no longer hosts the connection controls", async () => {
    const { base, server } = await or4Server();
    try {
      const cookie = await or4Login(base);
      for (const path of ["/config", "/config?tab=replies"]) {
        const html = await (await fetch(`${base}${path}`, { headers: { cookie } })).text();
        expect(html, path).not.toContain('id="gmail"');
        expect(html, path).not.toContain('id="gemini"');
        expect(html, path).not.toContain("Connect with Google");
      }
    } finally {
      server.close();
    }
  });

  it("saving Gmail credentials persists and redirects to Settings#connections", async () => {
    const { repo, base, server } = await or4Server();
    try {
      const cookie = await or4Login(base);
      const csrf = await csrfFor(base, cookie);
      const res = await fetch(`${base}/settings/gmail/credentials`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie },
        body: new URLSearchParams({
          _csrf: csrf,
          gmail_address: "admissions@riara.example",
          gmail_client_id: "12345-abc.apps.googleusercontent.com",
          gmail_client_secret: "GOCSPX-fake-secret",
          gmail_label: "",
        }).toString(),
        redirect: "manual",
      });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("/settings");
      expect(res.headers.get("location")).toContain("#connections");
      expect(repo.getSetting("gmail_client_id", "")).toBe("12345-abc.apps.googleusercontent.com");
    } finally {
      server.close();
    }
  });

  it("Gmail test-connection with unusable credentials reports a helpful error, never silent", async () => {
    const { repo, base, server } = await or4Server();
    try {
      const cookie = await or4Login(base);
      const csrf = await csrfFor(base, cookie);
      // Full fake credential set incl. refresh token, then hit the test route.
      await fetch(`${base}/settings/gmail/credentials`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie },
        body: new URLSearchParams({
          _csrf: csrf,
          gmail_address: "admissions@riara.example",
          gmail_client_id: "12345-abc.apps.googleusercontent.com",
          gmail_client_secret: "GOCSPX-fake-secret",
          gmail_label: "",
        }).toString(),
        redirect: "manual",
      });
      repo.setSetting("gmail_refresh_token", "1//fake-refresh-token");
      const res = await fetch(`${base}/settings/gmail/test`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie },
        body: `_csrf=${csrf}`,
        redirect: "manual",
      });
      expect(res.status).toBe(302);
      const loc = decodeURIComponent(res.headers.get("location") || "");
      expect(loc).toMatch(/failed|not connected/i);
      expect(repo.getSetting("gmail_last_error", "")).not.toBe("");
    } finally {
      server.close();
    }
  });

  it("Gemini bad key: failure is stored and visible; a restart keeps the state", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "or4-"));
    const dbPath = path.join(tmp, "db.sqlite");
    const repo = new Repo(openDb(dbPath));
    seedDefaults(repo);
    repo.createStaff("boss", "Owner", hashPassword("first-run-password-1"), "admin");
    const ctx: PipelineContext = {
      repo,
      adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender: new MockSender() },
    };
    const { base, server } = await startServer(repo, ctx);
    try {
      const cookie = await or4Login(base);
      const csrf = await csrfFor(base, cookie);
      const res = await fetch(`${base}/settings/gemini`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie },
        body: new URLSearchParams({ _csrf: csrf, gemini_api_key: "AIza-fake-key-not-real", gemini_model: "gemini-1.5-flash" }).toString(),
        redirect: "manual",
      });
      expect(res.status).toBe(302);
      const loc = decodeURIComponent(res.headers.get("location") || "");
      expect(loc).toMatch(/failed/i);
      expect(repo.getSetting("gemini_last_error", "")).not.toBe("");
      const html = await (await fetch(`${base}/settings`, { headers: { cookie } })).text();
      expect(html).toContain("Last test failed");
    } finally {
      server.close();
    }
    // Restart: a fresh Repo over the same file still has the key + the error.
    const reborn = new Repo(openDb(dbPath));
    expect(reborn.getSetting("gemini_api_key", "")).toBe("AIza-fake-key-not-real");
    expect(reborn.getSetting("gemini_last_error", "")).not.toBe("");
  }, 60_000);
});
