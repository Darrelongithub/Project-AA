/**
 * Phase 18 part 2 — the Settings surface for the public ingest key, and the
 * security console's view of it.
 *
 * These are rendered-page tests, not pixel tests: what matters is which value
 * reaches which admin, whether the rotate control really changes the live
 * credential, whether the delivery log explains a broken integration, and that
 * the key never appears where a lower-privileged person or a log line can see it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { configureTestOrganization, webLogin } from "./helpers";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";
import { createApp } from "../src/web/server";
import { WEBHOOK_PATH_PREFIX } from "../src/web/webhook";
import { hashPassword } from "../src/util/password";

let server: Server;
let base = "";
let repo: Repo;
let adminCookie = "";
let adminCsrf = "";

beforeAll(async () => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  configureTestOrganization(repo);
  repo.createStaff("admin", "System Administrator", hashPassword("admin123"), "admin");
  repo.createStaff("officer", "Case Officer", hashPassword("officer123"), "user");
  const ctx: PipelineContext = { repo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender: new MockSender(true) } };
  const app = createApp({ repo, ctx });
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const login = await webLogin(base, "admin", "admin123");
  adminCookie = login.cookie;
  adminCsrf = login.csrf;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const settingsPage = async (cookie = adminCookie): Promise<{ status: number; html: string }> => {
  const res = await fetch(`${base}/settings`, { headers: { cookie }, redirect: "manual" });
  return { status: res.status, html: await res.text() };
};

async function postSettings(fields: Record<string, string>, cookie = adminCookie, csrf = adminCsrf): Promise<{ status: number; location: string | null; text: string }> {
  const res = await fetch(`${base}/settings/webhook`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: csrf, ...fields }).toString(),
    redirect: "manual",
  });
  return { status: res.status, location: res.headers.get("location"), text: await res.text() };
}

describe("Settings → Web submissions", () => {
  it("shows the full address with the live key, in a copyable field", async () => {
    const key = repo.webhookIngestKey(1)!;
    const { status, html } = await settingsPage();
    expect(status).toBe(200);
    expect(html).toContain('id="webhook"');
    expect(html).toContain(`${WEBHOOK_PATH_PREFIX}${key}`);
    expect(html).toContain("data-aa-copy=");
    expect(html).toContain("Rotate the key");
    // The card explains what the address can and cannot do, because that is the
    // question an administrator is actually asking.
    expect(html).toMatch(/cannot read, change or decide anything/);
  });

  it("issues a key for a tenant that predates the feature, with no migration", () => {
    const bare = repo.createOrganization({ name: "Legacy Desk", refPrefix: "LEG" });
    // An organization created before this feature exists has no key row at all;
    // deleting it reproduces that state, and the first Settings view must fix it.
    repo.db.prepare("DELETE FROM secrets WHERE organization_id = ? AND key = ?").run(bare.id, "webhook_ingest_key");
    expect(repo.webhookIngestKey(bare.id)).toBeNull();
    const issued = repo.ensureWebhookIngestKey(bare.id);
    expect(issued.length).toBeGreaterThanOrEqual(32);
    expect(repo.organizationForWebhookKey(issued)).toBe(bare.id);
  });

  it("carries copy-paste examples for all five integration paths", async () => {
    const { html } = await settingsPage();
    for (const label of ["Plain HTML form", "WordPress", "Zapier", "Make (Integromat)", "Webflow"]) {
      expect(html).toContain(label);
    }
    // Each example already contains this tenant's own address — an admin should
    // not have to paste anything to make the snippet runnable.
    const key = repo.webhookIngestKey(1)!;
    const occurrences = html.split(`${WEBHOOK_PATH_PREFIX}${key}`).length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(6);
    expect(html).toContain("wp_remote_post");
    expect(html).toContain("Webhooks by Zapier");
  });

  it("rotates behind an explicit action, and the old address dies in the same instant", async () => {
    // One accepted submission on the current key, so the replay below is a real
    // comparison and not a coincidence.
    const key = repo.webhookIngestKey(1)!;
    const before = await fetch(`${base}${WEBHOOK_PATH_PREFIX}${key}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "rotate-me@example.org", message: "A service request.", case_type: "SERVICE_REQUEST", external_id: "UI-ROTATE-1" }),
    });
    expect(before.status).toBe(200);

    const rotated = await postSettings({ action: "rotate" });
    expect(rotated.status).toBe(302);
    expect(rotated.location).toContain("#webhook");
    expect(rotated.text).not.toContain(key);

    const next = repo.webhookIngestKey(1)!;
    expect(next).not.toBe(key);
    // The page a browser follows the redirect into shows ONLY the new address.
    const page = await settingsPage();
    expect(page.html).toContain(`${WEBHOOK_PATH_PREFIX}${next}`);
    expect(page.html).not.toContain(`${WEBHOOK_PATH_PREFIX}${key}`);

    const stale = await fetch(`${base}${WEBHOOK_PATH_PREFIX}${key}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "rotate-me@example.org", message: "trying the old URL" }),
    });
    expect(stale.status).toBe(404);
    const fresh = await fetch(`${base}${WEBHOOK_PATH_PREFIX}${next}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "rotate-me@example.org", message: "A service request.", case_type: "SERVICE_REQUEST", external_id: "UI-ROTATE-1" }),
    });
    const freshJson = await fresh.json() as Record<string, unknown>;
    expect(fresh.status).toBe(200);
    // A rotated key does not resurrect a consumed external_id: the claim is
    // scoped to the organization, not to the credential that happened to carry it.
    expect(freshJson.deduplicated).toBe(true);
    expect((repo.db.prepare("SELECT COUNT(*) AS n FROM applicants WHERE email_address = 'rotate-me@example.org'").get() as { n: number }).n).toBe(1);

    const rotation = repo.db.prepare("SELECT actor, detail FROM audit_log WHERE event = 'webhook_key_rotated' ORDER BY id DESC LIMIT 1").get() as { actor: string; detail: string };
    expect(rotation.actor).toBe("admin");
    expect(rotation.detail).not.toContain(next);
    expect(rotation.detail).not.toContain(key);
  });

  it("refuses a tokenless rotate, and an unknown action changes nothing", async () => {
    const key = repo.webhookIngestKey(1)!;
    const noCsrf = await fetch(`${base}/settings/webhook`, {
      method: "POST",
      headers: { cookie: adminCookie, "content-type": "application/x-www-form-urlencoded" },
      body: "action=rotate",
      redirect: "manual",
    });
    expect(noCsrf.status).toBe(403);
    expect(repo.webhookIngestKey(1)).toBe(key);

    const unknown = await postSettings({ action: "revoke-everything" });
    expect(unknown.status).toBe(302);
    expect(decodeURIComponent(unknown.location ?? "")).toMatch(/Nothing changed/);
    expect(repo.webhookIngestKey(1)).toBe(key);
  });

  it("edits the request budget, and refuses a nonsense value without writing it", async () => {
    const saved = await postSettings({ action: "limit", webhook_rate_limit_per_minute: "7" });
    expect(saved.status).toBe(302);
    expect(repo.webhookRateLimitPerMinute()).toBe(7);
    expect(decodeURIComponent(saved.location ?? "")).toMatch(/7 accepted calls per minute/);

    const junk = await postSettings({ action: "limit", webhook_rate_limit_per_minute: "-4" });
    expect(decodeURIComponent(junk.location ?? "")).toMatch(/Rate limit unchanged/);
    expect(repo.webhookRateLimitPerMinute()).toBe(7);

    const page = await settingsPage();
    expect(page.html).toContain('value="7"');
    expect(page.html).toMatch(/Accepted calls per minute, per key/);
    repo.setSetting("webhook_rate_limit_per_minute", "1000");
  });

  it("lists recent deliveries with their outcome, timestamp and case link", async () => {
    repo.setSetting("webhook_rate_limit_per_minute", "1000");
    const key = repo.webhookIngestKey(1)!;
    await fetch(`${base}${WEBHOOK_PATH_PREFIX}${key}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "list-check@example.org", message: "needs an address", case_type: "SERVICE_REQUEST", external_id: "UI-LIST-1" }),
    });
    await postSettings({ action: "rotate" });
    const listKey = repo.webhookIngestKey(1)!;
    await fetch(`${base}${WEBHOOK_PATH_PREFIX}${listKey}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "No Address At All", message: "this one is refused" }),
    });

    const { html } = await settingsPage();
    expect(html).toContain("Recent deliveries");
    expect(html).toContain("list-check@example.org");
    expect(html).toContain("UI-LIST-1");
    expect(html).toContain("accepted");
    expect(html).toContain("refused 400");
    expect(html).toContain("/case/");
    // The refused call says why, in the caller's terms.
    expect(html).toMatch(/email is required/);
  });

  it("is not readable by a role that must not hold the credential", async () => {
    const officer = await webLogin(base, "officer", "officer123");
    expect(officer.status).toBe(302);
    const page = await settingsPage(officer.cookie);
    expect(page.status).toBe(403);
    expect(page.html).not.toContain(WEBHOOK_PATH_PREFIX);
    // …and it cannot rotate one either.
    const rotated = await fetch(`${base}/settings/webhook`, {
      method: "POST",
      headers: { cookie: officer.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${encodeURIComponent(officer.csrf)}&action=rotate`,
      redirect: "manual",
    });
    expect(rotated.status).toBe(403);
  });
});

describe("Security console", () => {
  it("shows public ingest as its own source, with the key nowhere on the page", async () => {
    const key = repo.webhookIngestKey(1)!;
    const res = await fetch(`${base}/admin/security`, { headers: { cookie: adminCookie } });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("Webhook deliveries");
    expect(html).toContain("public ingest");
    expect(html).toContain("accepted · 200");
    expect(html).toContain("list-check@example.org");
    expect(html).toContain("rejected · 400");
    expect(html).not.toContain(key);
    expect(html).toMatch(/The ingest key is never recorded/);
  });
});
