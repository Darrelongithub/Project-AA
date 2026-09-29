/** Audit Group D — external-call key sources and timeouts.
 * R2: an env GEMINI_API_KEY must survive settings-route boot (rebuildAdapters
 *     used to silently rebuild env-live adapters back to mock).
 * R3: the intake label call must honour the stored secret, not env-only.
 * R5: the OAuth token exchange must be time-bounded.
 * R6: every Gmail API call must be time-bounded.
 * (R4 — the label-call timeout — shares the pinned withTimeout helper, whose
 * contract is covered in aur2-with-timeout.test.ts; the wiring is one call
 * site in categorize/index.ts.)
 */
import { describe, expect, it, vi } from "vitest";
import type { Server } from "http";
import { createApp } from "../src/web/server";
import { hashPassword } from "../src/util/password";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { processEmail } from "../src/pipeline";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";
import type { IncomingEmail } from "../src/types";

function fresh(): Repo {
  const repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  repo.createStaff("admin", "Administrator", hashPassword("admin123"), "admin");
  return repo;
}

function mockCtx(repo: Repo): PipelineContext {
  return { repo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender: new MockSender() } };
}

async function boot(repo: Repo, ctx: PipelineContext): Promise<{ base: string; close: () => Promise<void> }> {
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

describe("audit D — R2: env Gemini key survives settings-route boot", () => {
  it("builds live adapters from env when no secret is stored", () => {
    const prev = process.env.GEMINI_API_KEY;
    try {
      process.env.GEMINI_API_KEY = "env-key-for-r2-test";
      const repo = fresh();
      expect(repo.hasSecret("gemini_api_key")).toBe(false);
      const ctx = mockCtx(repo);
      createApp({ repo, ctx });
      // Pre-fix, settings-route boot rebuilt env-live adapters back to
      // mock: vision stayed MockVisionAdapter. Now the env key survives.
      expect(ctx.adapters.vision.constructor.name).toBe("BudgetedVisionAdapter");
      expect(repo.getSetting("gemini_last_error", "")).toBe("");
    } finally {
      if (prev === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prev;
    }
  });

  it("control: no key anywhere still boots clean mock with no error", () => {
    const prev = process.env.GEMINI_API_KEY;
    try {
      delete process.env.GEMINI_API_KEY;
      const repo = fresh();
      const ctx = mockCtx(repo);
      createApp({ repo, ctx });
      expect(repo.getSetting("gemini_last_error", "")).toBe("");
      expect(ctx.adapters.vision.constructor.name).toBe("MockVisionAdapter");
    } finally {
      if (prev === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prev;
    }
  });
});

describe("audit D — R3: intake labelling honours the stored secret", () => {
  it("attempts the label call from a settings-stored key with no env key", async () => {
    const prev = process.env.GEMINI_API_KEY;
    const realFetch = globalThis.fetch;
    try {
      delete process.env.GEMINI_API_KEY;
      // The SDK defaults to global fetch: fail fast so the test never
      // touches the network. The attempt still falls back deterministically
      // — the email_labelled row proves it happened. Pre-fix the env-only
      // gate skipped the call entirely and no row was written.
      globalThis.fetch = (async () => { throw new Error("network disabled in test"); }) as typeof fetch;
      const repo = fresh();
      repo.addEmailCategory(1, { key: "complaint", label: "Complaint" });
      repo.addEmailCategory(1, { key: "other", label: "Other" });
      repo.setSecret("gemini_api_key", "stored-key-for-r3-test");
      const email: IncomingEmail = {
        id: "r3-1", threadId: "r3-thread", from: "sender@example.test",
        subject: "Application documents", body: "Please find attached.",
        receivedAt: new Date().toISOString(), attachments: [],
      };
      await processEmail(email, mockCtx(repo));
      const row = repo.db.prepare("SELECT detail FROM audit_log WHERE event = 'email_labelled'").get() as { detail: string } | undefined;
      expect(row?.detail).toMatch(/source=fallback/);
    } finally {
      globalThis.fetch = realFetch;
      if (prev === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prev;
    }
  });
});

describe("audit D — R5: OAuth token exchange is time-bounded", () => {
  it("passes an abort signal to the token fetch", async () => {
    const repo = fresh();
    repo.setSetting("gmail_oauth_state", "state-123");
    repo.setSetting("gmail_client_id", "cid");
    repo.setSecret("gmail_client_secret", "csecret");
    const { base, close } = await boot(repo, mockCtx(repo));
    const realFetch = globalThis.fetch;
    let captured: { url: string; init: RequestInit } | undefined;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      captured = { url: String(url), init: init ?? {} };
      return { ok: true, json: async () => ({ refresh_token: "rt-1" }) };
    }) as typeof fetch;
    try {
      const auth = await realFetch(`${base}/login`);
      const lcsrfCookie = ((auth.headers.get("set-cookie") || "").match(/lcsrf=([^;]+)/) || [])[1] ?? "";
      const html = await auth.text();
      const hidden = (/name="_lcsrf" value="([^"]+)"/.exec(html) || [])[1] ?? lcsrfCookie;
      const login = await realFetch(`${base}/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: `lcsrf=${lcsrfCookie}` },
        body: new URLSearchParams({ username: "admin", password: "admin123", _lcsrf: hidden }).toString(),
        redirect: "manual",
      });
      const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
      const res = await realFetch(`${base}/settings/gmail/callback?state=state-123&code=code-1`, {
        headers: { cookie },
        redirect: "manual",
      });
      expect(res.status).toBe(302);
      expect(captured?.url).toBe("https://oauth2.googleapis.com/token");
      expect(captured?.init.signal).toBeInstanceOf(AbortSignal);
      expect(repo.getSecret("gmail_refresh_token")).toBe("rt-1");
    } finally {
      globalThis.fetch = realFetch;
      await close();
    }
  });
});

describe("audit D — R6: Gmail API calls are time-bounded", () => {
  it("the client wrapper rejects a hung SDK promise", async () => {
    const prev = process.env.GMAIL_TIMEOUT_MS;
    try {
      // The module reads the knob at load and is already loaded via the
      // server import chain — reset the registry so this import re-reads it.
      vi.resetModules();
      process.env.GMAIL_TIMEOUT_MS = "30";
      const { GmailClient, GMAIL_TIMEOUT_MS } = await import("../src/ingestion/gmailClient");
      expect(GMAIL_TIMEOUT_MS).toBe(30);
      // Bypass the constructor (it requires the googleapis SDK); call() only
      // needs the prototype.
      const client = Object.create(GmailClient.prototype) as unknown as { call(label: string, p: Promise<unknown>): Promise<unknown> };
      await expect(client.call("probe", new Promise(() => { /* never settles */ })))
        .rejects.toThrow("gmail probe timed out after 30ms");
    } finally {
      if (prev === undefined) delete process.env.GMAIL_TIMEOUT_MS;
      else process.env.GMAIL_TIMEOUT_MS = prev;
    }
  });
});
