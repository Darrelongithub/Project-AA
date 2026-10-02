/**
 * User-reported defects (2026-09-21):
 *
 * D1 — Google OAuth 400 invalid_request:
 *      The connect route built redirect_uri from the request Host, so anyone
 *      who opened the console via the bind address handed Google
 *      "http://0.0.0.0:8080/settings/gmail/callback" — which Google rejects
 *      outright (OAuth 2.0 policy). The redirect URI must be a stable
 *      loopback/public origin, identical at authorize time and at the token
 *      exchange. Bare-bind hosts (0.0.0.0 / [::]) are rewritten to
 *      `localhost` (rewriting is what makes authorize + callback agree); an
 *      optional `gmail_public_base_url` setting pins a public/HTTPS origin
 *      for reverse-proxy deployments.
 *
 * D2 — "Email watcher should be the same so remove this":
 *      The Settings → Connections card must no longer expose a
 *      "Mailbox label to watch" field. The watcher reads the inbox — exactly
 *      like before — and saving credentials must not persist a label.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as http from "node:http";
import { Repo } from "../src/db/repo";
import { openDb } from "../src/db/db";
import { seedDefaults } from "../src/db/seed";
import { createApp } from "../src/web/server";
import { hashPassword } from "../src/util/password";
import {webLogin, configureTestOrganization } from "./helpers";
import type { PipelineContext } from "../src/pipeline/adapters";
import type { Server } from "http";

let repo: Repo;
let server: Server | undefined;

beforeEach(() => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  configureTestOrganization(repo);
  repo.createStaff("admin", "OAuth Admin", hashPassword("admin123"), "admin");
});
afterEach(() => { server?.close(); server = undefined; });

async function boot(): Promise<string> {
  const ctx: PipelineContext = { repo, adapters: { vision: null as never, watcher: null as never, sender: null as never } };
  const s = createApp({ repo, ctx }).listen(0);
  server = s;
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
}

/** Same helper the routes use — pinned here so it can never regress to
 *  unconditional Host strings. */
async function redirectUri(protocol: string, host: string): Promise<string> {
  const mod = (await import("../src/web/oauth")) as { gmailRedirectUri?: (r: Repo, p: string, h: string) => string };
  return mod.gmailRedirectUri!(repo, protocol, host);
}

describe("D1 — OAuth redirect_uri is never a bare bind address", () => {
  it("helper: 0.0.0.0 / [::] become localhost; real hosts and protocol pass through", async () => {
    expect(await redirectUri("http", "0.0.0.0:8080")).toBe("http://localhost:8080/settings/gmail/callback");
    expect(await redirectUri("http", "[::]:8080")).toBe("http://localhost:8080/settings/gmail/callback");
    expect(await redirectUri("http", "localhost:8080")).toBe("http://localhost:8080/settings/gmail/callback");
    expect(await redirectUri("http", "127.0.0.1:8080")).toBe("http://127.0.0.1:8080/settings/gmail/callback");
    expect(await redirectUri("https", "intake.example.org")).toBe("https://intake.example.org/settings/gmail/callback");
  });

  it("helper: a configured public base URL wins (reverse proxy / HTTPS), trailing slashes trimmed", async () => {
    repo.setSetting("gmail_public_base_url", "https://intake.example.org/");
    expect(await redirectUri("http", "0.0.0.0:8080")).toBe("https://intake.example.org/settings/gmail/callback");
  });

  it("route: connecting from a 0.0.0.0 visit hands Google a localhost redirect_uri", async () => {
    const base = await boot();
    const { cookie } = await webLogin(base, "admin", "admin123");
    repo.setSetting("gmail_client_id", "12345-abc.apps.googleusercontent.com");

    const port = (server!.address() as { port: number }).port;
    const location: string = await new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: "/settings/gmail/connect", headers: { Host: "0.0.0.0:8080", Cookie: cookie } }, (res: http.IncomingMessage) => {
        resolve(String(res.headers.location ?? ""));
        res.resume();
      }).on("error", reject);
    });
    expect(location).toContain("accounts.google.com");
    expect(location).toContain(encodeURIComponent("http://localhost:8080/settings/gmail/callback"));
    expect(location).not.toContain("0.0.0.0");
  });
});

describe("D2 — the mailbox-label field is gone; the watcher always reads the inbox", () => {
  it("settings page has no gmail_label input and shows the exact redirect URI to register", async () => {
    const base = await boot();
    const { cookie } = await webLogin(base, "admin", "admin123");
    const page = await (await fetch(`${base}/settings`, { headers: { cookie } })).text();
    expect(page).not.toContain('name="gmail_label"');
    // The console tells the admin EXACTLY what to paste into Google Cloud —
    // a full URI, not "this console's URL plus …".
    expect(page).toContain(`${base}/settings/gmail/callback`);
  });

  it("saving credentials no longer persists gmail_label", async () => {
    const base = await boot();
    const { cookie, csrf } = await webLogin(base, "admin", "admin123");
    const res = await fetch(`${base}/settings/gmail/credentials`, {
      method: "POST", redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${encodeURIComponent(csrf)}&gmail_address=a%40b.ke&gmail_client_id=cid&gmail_client_secret=&gmail_label=intake-2026`,
    });
    expect(res.status).toBe(302);
    expect(repo.getSetting("gmail_client_id", "")).toBe("cid");
    expect(repo.getSetting("gmail_label", "")).toBe(""); // ← ignored from now on
  });
});

describe("D3 — the connect flow requests the narrowest scope that works", () => {
  it("asks Google for gmail.readonly + gmail.send, and never gmail.modify", async () => {
    repo.setSetting("gmail_client_id", "pilot-client-id");
    repo.setSecret("gmail_client_secret", "GOCSPX-not-a-real-secret");
    const base = await boot();
    const { cookie } = await webLogin(base, "admin", "admin123");
    const res = await fetch(`${base}/settings/gmail/connect`, { headers: { cookie }, redirect: "manual" });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(location.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send"
    );
    expect(location.searchParams.get("scope")).not.toContain("gmail.modify");
    // A refresh token requires both of these; losing either breaks ingestion.
    expect(location.searchParams.get("access_type")).toBe("offline");
    expect(location.searchParams.get("prompt")).toBe("consent");
    // The anti-CSRF state is random and stored for the callback to check.
    const state = location.searchParams.get("state")!;
    expect(state).toMatch(/^[0-9a-f]{32}$/);
    expect(repo.getSetting("gmail_oauth_state", "")).toBe(state);
    expect(location.searchParams.get("client_id")).toBe("pilot-client-id");
    // The secret never travels in the URL.
    expect(res.headers.get("location")).not.toContain("GOCSPX-not-a-real-secret");
  });

  it("refuses to start the flow without a client id", async () => {
    const base = await boot();
    const { cookie } = await webLogin(base, "admin", "admin123");
    const res = await fetch(`${base}/settings/gmail/connect`, { headers: { cookie }, redirect: "manual" });
    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.headers.get("location")!)).toContain("Save the OAuth client ID and secret first.");
    expect(res.headers.get("location")).not.toContain("accounts.google.com");
  });
});
