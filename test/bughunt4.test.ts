/**
 * Bug hunt 4 — the post-round-5 scan + the live OAuth report. Defects found:
 *
 *  N1  Removing the Gemini API key never returned the server to mock
 *      reading. `rebuildAdapters()` (server.ts) starts with
 *      `if (!key) return;`, and the /settings/gemini clear branch
 *      returns without rebuilding at all — so after a key is removed
 *      the STALE live Gemini adapters stay in place. Consequences in
 *      production:
 *        - the watcher keeps making live Gemini calls; with a dead key
 *          it FAILS CLOSED on every Green file (flagged: true) and the
 *          auto-reply silently stops for the whole intake — no error
 *          anywhere, because the UI and audit both claim "back to mock
 *          reading";
 *        - vision keeps burning the daily budget on a key that no
 *          longer works.
 *
 *  AUX-1  The OAuth callback surfaced only Google's bare error code
 *      ("Google returned an error: access_denied") and discarded
 *      `error_description` — with no hint about the usual causes, an
 *      admin staring at a failed connection has nothing actionable.
 *
 *  AUX-2  Behind a reverse proxy / HTTPS preview (public host, plain
 *      http hop, no `gmail_public_base_url` set) the app computes a
 *      plain-`http://` redirect URI on a NON-LOOPBACK host — an address
 *      Google's OAuth console refuses to register for a web client —
 *      and the settings page showed it as the thing to register, with
 *      no warning and no pointer at the Public base URL field. The
 *      classic "OAuth just won't connect" wall.
 *
 *  N1 mirrors the real production sequence: the server BOOTS with a
 *  saved key (the boot-time rebuild activates the live adapters — the
 *  same object construction a successful "Test key" does), then an admin
 *  removes the key through the real settings route. After the removal the
 *  adapters must be the mock ones. All RED before the fix, GREEN after.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as http from "node:http";
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
let ctx: PipelineContext;
let cookie = "";

beforeEach(() => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  repo.createStaff("admin", "System Administrator", hashPassword("admin123"), "admin");
});

afterEach(() => {
  server?.close();
  server = undefined;
});

async function startServer(): Promise<{ csrf: string }> {
  ctx = { repo, adapters: { vision: null as never, watcher: null as never, sender: new MockSender() } };
  const app = createApp({ repo, ctx });
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { cookie: c, csrf } = await webLogin(base, "admin", "admin123");
  cookie = c;
  return { csrf };
}

/** GET with an arbitrary Host header — simulates a reverse proxy. */
function rawGet(path: string, hostHeader: string): Promise<{ status: number; html: string }> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port: Number(base.split(":")[2]), path, headers: { cookie, host: hostHeader, "user-agent": "probe" } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, html: body }));
      }
    );
    req.on("error", (e) => resolve({ status: -1, html: String(e) }));
  });
}

describe("N1 — removing the Gemini key must return the server to mock reading", () => {
  it("boot with a saved key activates the live adapters (pre-state)", async () => {
    repo.setSetting("gemini_api_key", "AIzaFAKE-KEY");
    await startServer();
    // Boot-time rebuild saw the saved key and built the live adapters —
    // exactly what a previously-verified key does in production.
    expect(ctx.adapters.vision.constructor.name).toBe("BudgetedVisionAdapter");
  });

  it("clearing the key restores mock vision + heuristic watcher (RED: stale Gemini stayed live)", async () => {
    repo.setSetting("gemini_api_key", "AIzaFAKE-KEY");
    const { csrf } = await startServer();
    expect(ctx.adapters.vision.constructor.name).toBe("BudgetedVisionAdapter");

    // Admin removes the key through the real settings route.
    const res = await fetch(`${base}/settings/gemini`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: `clear=1&_csrf=${encodeURIComponent(csrf)}`,
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(repo.getSetting("gemini_api_key", "")).toBe("");

    // The live adapters must be GONE. (Before the fix: the stale Gemini
    // vision + watcher are still live, contradicting the "back to mock
    // reading" message and audit line the same request produces.)
    expect(ctx.adapters.vision.constructor.name).toBe("MockVisionAdapter");

    // And the Green-safety watcher must be the deterministic heuristic one
    // again: it runs with no network and lets a clean file pass. With the
    // stale Gemini watcher still in place this returns source:"gemini",
    // flagged:true (fail-closed on the dead key) — which is exactly how a
    // removed key silently kills every auto-reply.
    const w = await ctx.adapters.watcher({
      applicantEmail: "jane.doe@example.org",
      subject: "My documents",
      docs: [
        {
          document_type: "academic_cert",
          extraction_method: "pdf_text",
          confidence: "high",
          name: "JANE DOE",
          textExcerpt: "Kenya Certificate of Secondary Education — certificate of achievement",
        },
      ],
    });
    expect(w.source).toBe("heuristic");
    expect(w.flagged).toBe(false);
  });
});

describe("AUX-1 — the OAuth callback must surface Google's error_description", () => {
  it("shows the description (and a hint), not just the opaque code", async () => {
    await startServer();
    repo.setSetting("gmail_oauth_state", "teststate123");

    const res = await fetch(
      `${base}/settings/gmail/callback?state=teststate123&error=access_denied&error_description=${encodeURIComponent("User denied the request")}`,
      { headers: { cookie }, redirect: "manual" }
    );
    expect(res.status).toBe(302);
    const msg = new URL(res.headers.get("location")!, base).searchParams.get("msg") ?? "";
    expect(msg).toContain("access_denied");
    // RED before the fix: the description was discarded.
    expect(msg).toContain("User denied the request");
    expect(repo.getSetting("gmail_oauth_state", "")).toBe(""); // state consumed
  });

  it("hint for redirect_uri_mismatch points at the registered URI", async () => {
    await startServer();
    repo.setSetting("gmail_oauth_state", "teststate456");

    const res = await fetch(`${base}/settings/gmail/callback?state=teststate456&error=redirect_uri_mismatch`, {
      headers: { cookie },
      redirect: "manual",
    });
    const msg = new URL(res.headers.get("location")!, base).searchParams.get("msg") ?? "";
    expect(msg).toContain("redirect_uri_mismatch");
    // RED before the fix: no hint at all.
    expect(msg.toLowerCase()).toContain("byte-for-byte");
  });
});

describe("AUX-2 — behind a proxy, the settings page must warn about the un-registerable http:// URI", () => {
  it("warns when the computed redirect URI is plain-http on a public host", async () => {
    await startServer();
    // Reverse proxy in front: public Host header, plain http hop, no base URL.
    const { html } = await rawGet("/settings", "admissions.example.ac.ke");
    // The (broken) URI is what the app would actually send to Google:
    expect(html).toContain("http://admissions.example.ac.ke/settings/gmail/callback");
    // RED before the fix: no warning, no pointer at the escape hatch.
    expect(html).toMatch(/behind a proxy/i);
    expect(html).toMatch(/Public base URL/i);
  });

  it("no warning once the public base URL is set (and the URI is https)", async () => {
    await startServer();
    repo.setSetting("gmail_public_base_url", "https://admissions.example.ac.ke");
    const { html } = await rawGet("/settings", "admissions.example.ac.ke");
    expect(html).not.toMatch(/behind a proxy/i);
    expect(html).toContain("https://admissions.example.ac.ke/settings/gmail/callback");
  });

  it("no warning for a plain local (loopback) deployment", async () => {
    await startServer();
    const { html } = await rawGet("/settings", "localhost");
    expect(html).not.toMatch(/behind a proxy/i);
  });
});
