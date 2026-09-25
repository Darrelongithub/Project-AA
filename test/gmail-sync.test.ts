/**
 * Gmail sync: visible window, configurable lookback, one-off backfill.
 *
 * Production feedback: "I can't see all my mail" / "Gmail doesn't refresh".
 * The 60-second poll exists and works — but it only ever fetched a 2-day
 * window (env-only), so everything older than 48h was never ingested and
 * the "All Mail" history could never actually be all mail. Now:
 *   - lookback window is a Settings value (default 14 days, env still
 *     overrides, clamped 1..365) and is SHOWN on the settings card;
 *   - a one-off "Pull older mail" backfill (30/90/365 days) brings in
 *     history the poll never saw;
 *   - when a credential is missing the failure names the missing part
 *     instead of the opaque "Gmail is not connected".
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { hashPassword } from "../src/util/password";
import { createApp } from "../src/web/server";
import { MockSender, type PipelineContext } from "../src/pipeline/adapters";
import { resolveLookbackDays, missingGmailCredentials } from "../src/ingestion/sync";
import { webLogin } from "./helpers";

let repo: Repo;

beforeEach(() => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
});

describe("resolveLookbackDays (settings > env > default, clamped)", () => {
  it("defaults to 14 days when nothing is configured", () => {
    expect(resolveLookbackDays(repo, undefined)).toBe(14);
  });
  it("the settings value wins over the env value", () => {
    repo.setSetting("gmail_lookback_days", "30");
    expect(resolveLookbackDays(repo, 2)).toBe(30);
  });
  it("the env value wins when no setting is stored", () => {
    expect(resolveLookbackDays(repo, 7)).toBe(7);
  });
  it("out-of-range values are clamped, not trusted", () => {
    repo.setSetting("gmail_lookback_days", "99999");
    expect(resolveLookbackDays(repo, undefined)).toBe(365);
    repo.setSetting("gmail_lookback_days", "0");
    expect(resolveLookbackDays(repo, undefined)).toBe(1);
  });
});

describe("missingGmailCredentials names the missing pieces", () => {
  it("all four present → nothing missing", () => {
    repo.setSetting("gmail_address", "a@b.c");
    repo.setSetting("gmail_client_id", "x");
    repo.setSetting("gmail_client_secret", "y");
    repo.setSetting("gmail_refresh_token", "z");
    expect(missingGmailCredentials(repo)).toEqual([]);
  });
  it("a token-only connect names the two missing credentials", () => {
    repo.setSetting("gmail_address", "a@b.c");
    repo.setSetting("gmail_refresh_token", "z");
    expect(missingGmailCredentials(repo).sort()).toEqual(["client id", "client secret"]);
  });
});

describe("backfill route + settings card", () => {
  let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
  let base = "";
  let backfillCalls: number[] = [];
  let admin: { cookie: string; csrf: string };

  function boot(): void {
    backfillCalls = [];
    repo.createStaff("admin", "Sync Admin", hashPassword("admin123"), "admin");
    const sender = new MockSender();
    const ctx: PipelineContext = { repo, adapters: { vision: null as never, watcher: null as never, sender } };
    const app = createApp({
      repo,
      ctx,
      gmailSync: async () => null,
      gmailBackfill: async (days: number) => {
        backfillCalls.push(days);
        return null;
      },
    });
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }

  beforeEach(boot);
  afterEach(() => server?.close());

  it("POST /settings/gmail/backfill runs one pass with the requested window and audits it", async () => {
    admin = await webLogin(base, "admin", "admin123");
    const res = await fetch(`${base}/settings/gmail/backfill`, {
      method: "POST",
      headers: { cookie: admin.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${encodeURIComponent(admin.csrf)}&days=90`,
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(backfillCalls).toEqual([90]);
    const audits = repo.recentAudit(5).filter((a) => a.event === "gmail_backfill");
    expect(audits.length).toBe(1);
    expect(audits[0].detail).toMatch(/90/);
  });

  it("rejects windows outside the offered choices", async () => {
    admin = await webLogin(base, "admin", "admin123");
    const res = await fetch(`${base}/settings/gmail/backfill`, {
      method: "POST",
      headers: { cookie: admin.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${encodeURIComponent(admin.csrf)}&days=7`,
      redirect: "manual",
    });
    expect(res.status).toBe(302); // bounced back with an error flash
    expect(backfillCalls).toEqual([]);
  });

  it("the settings card shows the fetch window and a backfill control when connected", async () => {
    admin = await webLogin(base, "admin", "admin123");
    repo.setSetting("gmail_address", "office@riara.ac.ke");
    repo.setSetting("gmail_client_id", "x");
    repo.setSetting("gmail_client_secret", "y");
    repo.setSetting("gmail_refresh_token", "z");
    const html = await (await fetch(`${base}/settings`, { headers: { cookie: admin.cookie } })).text();
    expect(html).toMatch(/last 14 days/i);
    expect(html).toMatch(/Pull older mail/i);
    expect(html).toContain("/settings/gmail/backfill");
  });

  it("a token-only connect warns about the exact missing credentials", async () => {
    admin = await webLogin(base, "admin", "admin123");
    repo.setSetting("gmail_address", "office@riara.ac.ke");
    repo.setSetting("gmail_refresh_token", "z");
    const html = await (await fetch(`${base}/settings`, { headers: { cookie: admin.cookie } })).text();
    expect(html).toMatch(/missing/i);
    expect(html).toMatch(/client id/i);
    expect(html).toMatch(/client secret/i);
  });
});
