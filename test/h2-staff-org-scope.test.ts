/**
 * H-2/H-3 — staff management is tenant-scoped end to end.
 *
 * History: Repo.createStaff hard-coded organization_id = 1, /staff/add never
 * passed a tenant, and the staff surfaces listed every account in the file.
 * An org-2 administrator logging in saw (and could reset, disable, scope and
 * re-permission) org-1 accounts by guessing their ids.
 *
 * Pins:
 *   (a) staffStats / staff surfaces resolve against the ACTING admin's org;
 *   (b) /staff/add creates the account inside the acting admin's org;
 *   (c) an org-2 admin's /staff/* writes against an org-1 id are refused
 *       (toggle, password, reset-code, scopes) and leave the target intact.
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
let sender: MockSender;
let ctx: PipelineContext;
let server: Server;
let base = "";
let org1: { cookie: string; csrf: string };
let org2: { cookie: string; csrf: string };
let org2Id = 0;
let agent1 = 0;
let agent2 = 0;

beforeAll(async () => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  repo.createStaff("admin", "Org One Admin", hashPassword("admin123"), "admin");
  repo.createStaff("agent1", "Org One Agent", hashPassword("agent1pass99"), "user");
  const org = repo.createOrganization({ name: "Hillcrest Academy", refPrefix: "HA" });
  org2Id = org.id;
  repo.createStaff("admin2", "Org Two Admin", hashPassword("admin2pass99"), "admin", false, org.id);
  repo.createStaff("agent2", "Org Two Agent", hashPassword("agent2pass99"), "user", false, org.id);
  agent1 = repo.getStaffByUsername("agent1")!.id;
  agent2 = repo.getStaffByUsername("agent2")!.id;

  sender = new MockSender();
  ctx = { repo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender } };

  const app = createApp({ repo, ctx });
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const l1 = await webLogin(base, "admin", "admin123");
  const l2 = await webLogin(base, "admin2", "admin2pass99");
  expect(l1.status).toBe(302);
  expect(l2.status).toBe(302);
  org1 = { cookie: l1.cookie, csrf: l1.csrf };
  org2 = { cookie: l2.cookie, csrf: l2.csrf };
});

afterAll(() => {
  server?.close();
});

async function postForm(
  path: string,
  session: { cookie: string; csrf: string },
  fields: Record<string, string>
): Promise<Response> {
  const body = new URLSearchParams({ _csrf: session.csrf, ...fields });
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: session.cookie },
    body: body.toString(),
    redirect: "manual",
  });
}

describe("H-2: staff surfaces resolve to the acting admin's organization", () => {
  it("repo.staffStats scopes by organization (unscoped call still works for back-compat)", () => {
    const all = repo.staffStats();
    expect(all.some((s) => s.username === "agent1")).toBe(true);
    expect(all.some((s) => s.username === "agent2")).toBe(true);

    const orgOne = repo.staffStats(undefined, 1);
    expect(orgOne.some((s) => s.username === "agent1")).toBe(true);
    expect(orgOne.some((s) => s.username === "agent2")).toBe(false);

    const orgTwo = repo.staffStats(undefined, org2Id);
    expect(orgTwo.some((s) => s.username === "agent2")).toBe(true);
    expect(orgTwo.some((s) => s.username === "agent1")).toBe(false);
  });

  it("an org-2 admin's /staff page lists ONLY org-2 accounts — and vice versa", async () => {
    const page2 = await (await fetch(`${base}/staff`, { headers: { cookie: org2.cookie } })).text();
    expect(page2).toContain("agent2");
    expect(page2).toContain("Org Two Agent");
    expect(page2).not.toContain("agent1");
    expect(page2).not.toContain("Org One Agent");

    const page1 = await (await fetch(`${base}/staff`, { headers: { cookie: org1.cookie } })).text();
    expect(page1).toContain("agent1");
    expect(page1).toContain("Org One Agent");
    expect(page1).not.toContain("agent2");
    expect(page1).not.toContain("Org Two Agent");
  });

  it("/staff/add creates the account inside the ACTING admin's organization", async () => {
    const res = await postForm("/staff/add", org2, {
      username: "registrar2",
      display_name: "Hillcrest Registrar",
      password: "registrar2pass",
      confirm: "registrar2pass",
      role: "user",
    });
    expect(res.status).toBe(302);
    const created = repo.getStaffByUsername("registrar2")!;
    expect(created).toBeTruthy();
    expect(created.organization_id ?? 1).toBe(org2Id);

    // The creator sees the new member; the other tenant's admin does not.
    const page2 = await (await fetch(`${base}/staff`, { headers: { cookie: org2.cookie } })).text();
    expect(page2).toContain("registrar2");
    const page1 = await (await fetch(`${base}/staff`, { headers: { cookie: org1.cookie } })).text();
    expect(page1).not.toContain("registrar2");
  });
});

describe("H-3: cross-tenant staff writes are refused", () => {
  it("org-2 admin cannot toggle org-1 staff", async () => {
    const before = repo.getStaff(agent1)!.active;
    const res = await postForm("/staff/toggle", org2, { id: String(agent1) });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").not.toMatch(/now\+(disabled|active)|is\+now/);
    expect(repo.getStaff(agent1)!.active).toBe(before);
  });

  it("org-2 admin cannot reset org-1 staff passwords", async () => {
    const res = await postForm("/staff/password", org2, {
      id: String(agent1),
      password: "attackerpass123",
      confirm: "attackerpass123",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain(encodeURIComponent("Unknown staff member."));
    // The original password still works for org-1's agent.
    const probe = await webLogin(base, "agent1", "agent1pass99");
    expect(probe.status).toBe(302);
  });

  it("org-2 admin cannot issue a reset code for org-1 staff", async () => {
    const res = await fetch(`${base}/staff/reset-code`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: org2.cookie },
      body: new URLSearchParams({ _csrf: org2.csrf, id: String(agent1) }).toString(),
    });
    expect(res.status).toBe(200); // re-render, deliberately not a redirect
    const html = await res.text();
    expect(html).toContain("Unknown staff member — no code issued.");
    expect(html).not.toMatch(/Reset code issued/);
    expect(html).not.toMatch(/[A-HJKMNPQRSTUVWXYZ2-9]{10}/);
  });

  it("org-2 admin cannot re-scope org-1 staff via /staff/scopes", async () => {
    const res = await postForm("/staff/scopes", org2, { staff_id: String(agent1), schools: "Riara University" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain(encodeURIComponent("Unknown staff member — nothing saved."));
    expect(repo.scopesFor(agent1)).toEqual([]);
  });

  it("same-tenant writes still work end to end", async () => {
    // org-2 admin toggles their OWN agent and restores them.
    const res = await postForm("/staff/toggle", org2, { id: String(agent2) });
    expect(res.status).toBe(302);
    expect(repo.getStaff(agent2)!.active).toBe(0);
    const back = await postForm("/staff/toggle", org2, { id: String(agent2) });
    expect(back.status).toBe(302);
    expect(repo.getStaff(agent2)!.active).toBe(1);

    // org-1 admin resets their own agent's password — new password logs in.
    const res2 = await postForm("/staff/password", org1, {
      id: String(agent1),
      password: "freshpass1234",
      confirm: "freshpass1234",
    });
    expect(res2.status).toBe(302);
    expect(res2.headers.get("location") || "").toContain(encodeURIComponent("sessions were ended"));
    const probe = await webLogin(base, "agent1", "freshpass1234");
    expect(probe.status).toBe(302);
  });

  it("an admin password reset ENDS the member's existing sessions", async () => {
    // agent1 signs in and holds a live session…
    const agentSession = await webLogin(base, "agent1", "freshpass1234");
    expect(agentSession.status).toBe(302);
    const before = await fetch(`${base}/`, { headers: { cookie: agentSession.cookie }, redirect: "manual" });
    expect(before.status).toBe(200); // live session → dashboard renders

    // …the admin resets the password (suspected compromise)…
    const res = await postForm("/staff/password", org1, {
      id: String(agent1),
      password: "rotatedpass99",
      confirm: "rotatedpass99",
    });
    expect(res.status).toBe(302);

    // …and the OLD session is dead immediately, even though the account
    // itself is still active.
    const after = await fetch(`${base}/`, { headers: { cookie: agentSession.cookie }, redirect: "manual" });
    expect(after.status).toBe(302);
    expect(after.headers.get("location") || "").toContain("login");
    const audits = repo.db.prepare("SELECT detail FROM audit_log WHERE event = 'staff_password_reset' ORDER BY id DESC LIMIT 1").get() as { detail: string };
    expect(audits.detail).toMatch(/session\(s\) ended/);
  });
});
