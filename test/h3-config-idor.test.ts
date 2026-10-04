/**
 * H-3 follow-up — config surfaces are tenant-scoped too.
 *
 * The /staff/* IDOR fixes missed their /config/* siblings:
 *   - /config/attachment-sets/upload resolved ANY set id (getAttachmentSet
 *     has no org filter) — an org-2 admin could drop files into org-1's
 *     outgoing-mail attachment packs by id;
 *   - /config/workflow-rules/toggle flipped ANY rule id (delete was already
 *     scoped — toggle disagreed with it);
 *   - /config/workflow-rules/save hung rules on another tenant's CaseType.
 * An acting admin's writes now only reach their own organization.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { createApp } from "../src/web/server";
import { hashPassword } from "../src/util/password";
import { webLogin, configureTestOrganization } from "./helpers";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";

let repo: Repo;
let server: Server;
let base = "";
let org1: { cookie: string; csrf: string };
let org2: { cookie: string; csrf: string };
let org1Id = 0;
let org2Id = 0;

function fakePdf(): Buffer {
  return Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(700, 0x61)]);
}

async function post(
  session: { cookie: string; csrf: string },
  path: string,
  fields: Record<string, string>,
  raw?: Buffer
): Promise<Response> {
  if (raw) {
    return fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/pdf", cookie: session.cookie, "x-csrf-token": session.csrf },
      body: raw,
    });
  }
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: session.cookie },
    body: new URLSearchParams({ _csrf: session.csrf, ...fields }).toString(),
    redirect: "manual",
  });
}

beforeAll(async () => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  // Both tenants exist BEFORE any account is created, and every account is
  // told which one it belongs to — an account created before its organization
  // silently resolves to whichever tenant happens to exist first.
  configureTestOrganization(repo); // organization 1, fully configured
  org1Id = repo.getOrganization(1)!.id;
  org2Id = repo.createOrganization({ name: "Hillcrest Cooperative", refPrefix: "HLC" }).id;
  repo.createStaff("admin", "Org One Admin", hashPassword("admin123"), "admin", false, org1Id);
  repo.createStaff("admin2", "Org Two Admin", hashPassword("admin2pass99"), "admin", false, org2Id);

  const sender = new MockSender();
  const ctx: PipelineContext = { repo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender } };
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

describe("attachment-set upload is org-scoped", () => {
  it("an org-2 admin cannot inject files into an org-1 pack", async () => {
    const set1 = repo.createAttachmentSet(org1Id, "Org One Pack", "");
    const res = await post(org2, `/config/attachment-sets/upload?set=${set1.id}&filename=evil.pdf`, {}, fakePdf());
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Unknown attachment set.");
    expect(repo.listAttachmentSetFiles(set1.id)).toHaveLength(0);
  });

  it("own-org upload still works", async () => {
    const set2 = repo.createAttachmentSet(org2Id, "Org Two Pack", "");
    const res = await post(org2, `/config/attachment-sets/upload?set=${set2.id}&filename=handbook.pdf`, {}, fakePdf());
    expect(res.status).toBe(200);
    expect((await res.text())).toContain("Uploaded.");
    expect(repo.listAttachmentSetFiles(set2.id).map((f) => f.filename)).toEqual(["handbook.pdf"]);
  });
});

describe("workflow rules are org-scoped", () => {
  it("an org-2 admin cannot toggle an org-1 rule", async () => {
    const rule = repo.db.prepare("SELECT id, enabled FROM workflow_rules WHERE organization_id = ? ORDER BY id LIMIT 1").get(org1Id) as { id: number; enabled: number };
    expect(rule).toBeTruthy();
    const res = await post(org2, "/config/workflow-rules/toggle", { id: String(rule.id) });
    expect(res.status).toBe(302);
    const after = repo.db.prepare("SELECT enabled FROM workflow_rules WHERE id = ?").get(rule.id) as { enabled: number };
    expect(after.enabled).toBe(rule.enabled);
  });

  it("an org-2 admin cannot hang a rule on an org-1 CaseType", async () => {
    const ct1 = repo.getCaseType("SERVICE_REQUEST", org1Id)!;
    const before = repo.db.prepare("SELECT COUNT(*) AS n FROM workflow_rules WHERE organization_id = ?").get(org1Id) as { n: number };
    const res = await post(org2, "/config/workflow-rules/save", {
      name: "Foreign rule", kind: "intake", case_type_id: String(ct1.id), position: "9",
      cond_field_0: "text", cond_value_0: "free form", decision: "create", audit_code: "rule_foreign", fallback: "human_draft",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("another%20organization");
    const after = repo.db.prepare("SELECT COUNT(*) AS n FROM workflow_rules WHERE organization_id = ?").get(org1Id) as { n: number };
    expect(after.n).toBe(before.n);
  });

  it("own-org rules still save and toggle", async () => {
    const ct2 = repo.createCaseType(org2Id, { code: "HLC_INTAKE", name: "Hillcrest intake", category: "general" });
    const res = await post(org2, "/config/workflow-rules/save", {
      name: "Own intake rule", kind: "intake", case_type_id: String(ct2.id), position: "0",
      cond_field_0: "text", cond_value_0: "help", decision: "create", audit_code: "rule_hlc_intake", fallback: "human_draft",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("saved%20and%20enabled");
    const saved = repo.db.prepare("SELECT id, enabled FROM workflow_rules WHERE organization_id = ? ORDER BY id DESC LIMIT 1").get(org2Id) as { id: number; enabled: number };
    expect(saved.enabled).toBe(1);

    const back = await post(org2, "/config/workflow-rules/toggle", { id: String(saved.id) });
    expect(back.status).toBe(302);
    const toggled = repo.db.prepare("SELECT enabled FROM workflow_rules WHERE id = ?").get(saved.id) as { enabled: number };
    expect(toggled.enabled).toBe(0);

    // Cross-check: org-2's rule is untouchable from the ORG-1 console too.
    const res2 = await post(org1, "/config/workflow-rules/toggle", { id: String(saved.id) });
    expect(res2.status).toBe(302);
    const untouched = repo.db.prepare("SELECT enabled FROM workflow_rules WHERE id = ?").get(saved.id) as { enabled: number };
    expect(untouched.enabled).toBe(0);
  });
});
