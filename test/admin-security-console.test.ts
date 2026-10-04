import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { createApp } from "../src/web/server";
import { hashPassword } from "../src/util/password";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";
import { configureTestOrganization, webLogin } from "./helpers";

let repo: Repo;
let server: Server | undefined;
let base: string;
let primaryOrganizationId: number;
let otherOrganizationId: number;
let primaryCookie: string;
let otherCookie: string;
let providerCalls: number;
let primaryRef: string;
let otherRef: string;

beforeEach(async () => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  primaryOrganizationId = configureTestOrganization(repo).organizationId;
  otherOrganizationId = repo.createOrganization({ name: "Other Tenant", refPrefix: "OTH" }).id;

  repo.createStaff("admin-one", "Primary Admin", hashPassword("primary-pass-1"), "admin", false, primaryOrganizationId);
  repo.createStaff("admin-two", "Other Tenant Admin", hashPassword("other-pass-1"), "admin", false, otherOrganizationId);
  repo.createStaff("member-one", "Primary Member", hashPassword("member-pass-1"), "user", false, primaryOrganizationId);

  const ownCase = repo.getOrCreateApplicant("primary-case@example.test", "primary-thread", {
    organizationId: primaryOrganizationId,
    fullName: "Primary Case",
  });
  const otherCase = repo.getOrCreateApplicant("other-case@example.test", "other-thread", {
    organizationId: otherOrganizationId,
    fullName: "Other Tenant Case",
  });
  primaryRef = ownCase.ref_number;
  otherRef = otherCase.ref_number;

  repo.insertDecisionLog({
    applicant_id: ownCase.id,
    triggering_email_id: "primary-message-id",
    computed_status: "Orange",
    reasoning: "PRIMARY_PROVENANCE_ONLY",
    auto_sent: false,
  });
  repo.insertDecisionLog({
    applicant_id: otherCase.id,
    triggering_email_id: "other-message-id",
    computed_status: "Red",
    reasoning: "OTHER_TENANT_PROVENANCE_SECRET",
    auto_sent: false,
  });
  repo.audit(ownCase.id, "admin-one", "human_outcome_recorded", "PRIMARY_CHANGE_SIGNAL");
  repo.audit(otherCase.id, "admin-two", "human_override", "OTHER_TENANT_CHANGE_SECRET");
  repo.audit(ownCase.id, "system", "send_failed", "PRIMARY_SEND_FAILURE_DETAIL");
  repo.audit(otherCase.id, "system", "send_failed", "OTHER_TENANT_ERROR_SECRET");
  for (const [applicant, organizationId, messageId, error] of [
    [ownCase, primaryOrganizationId, "primary-dead-letter", "PRIMARY_DEAD_LETTER_DETAIL"],
    [otherCase, otherOrganizationId, "other-dead-letter", "OTHER_TENANT_DEAD_LETTER_SECRET"],
  ] as const) {
    repo.insertEmail({
      organization_id: organizationId,
      applicant_id: applicant.id,
      message_id: messageId,
      thread_id: applicant.thread_id,
      direction: "in",
      from_addr: "sender@example.test",
      to_addr: "inbox@example.test",
      subject: "Synthetic failed message",
      body: "Offline test fixture",
      category: "other",
      auto: 0,
      at: new Date().toISOString(),
    });
    repo.parkDeadLetter({ message_id: messageId, subject: "Synthetic failed message", from_addr: "sender@example.test", error });
  }
  repo.audit(null, "admin-one", "gmail_test_failed", "PRIMARY_GMAIL_FAILURE_DETAIL");
  repo.audit(null, "admin-two", "gemini_test_failed", "OTHER_TENANT_SERVICE_ERROR_SECRET");
  repo.audit(null, "system", "process_crash", "uncaughtException: RangeError");

  providerCalls = 0;
  const ctx: PipelineContext = {
    repo,
    adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender: new MockSender() },
  };
  const app = createApp({
    repo,
    ctx,
    gmailSync: async () => { providerCalls++; return { ran: true, result: null }; },
    gmailTest: async () => { providerCalls++; return null; },
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const primaryLogin = await webLogin(base, "admin-one", "primary-pass-1");
  const otherLogin = await webLogin(base, "admin-two", "other-pass-1");
  primaryCookie = primaryLogin.cookie;
  otherCookie = otherLogin.cookie;
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  repo?.db.close();
});

const pageFor = (cookie: string, path = "/admin/security") => fetch(`${base}${path}`, { headers: { cookie } });

describe("admin security console", () => {
  it("shows existing access, decision, integrity and error data for only the admin's tenant", async () => {
    const res = await pageFor(primaryCookie);
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain("Security Console");
    expect(html).toContain('href="/admin/security"');
    expect(html).toContain("Successful staff logins");
    expect(html).toContain("Active staff sessions");
    expect(html).toContain("Pipeline runs &amp; decision provenance");
    expect(html).toContain("Case-tampering / decision-change signals");
    expect(html).toContain("Crashes, errors &amp; failed work");
    expect(html).toContain("Gemini &amp; Gmail service health");

    expect(html).toContain(primaryRef);
    expect(html).toContain("PRIMARY_PROVENANCE_ONLY");
    expect(html).toContain("PRIMARY_CHANGE_SIGNAL");
    expect(html).toContain("PRIMARY_SEND_FAILURE_DETAIL");
    expect(html).toContain("PRIMARY_DEAD_LETTER_DETAIL");
    expect(html).toContain("Fatal process exception (shared runtime)");
    expect(html).toContain("Shared runtime");
    expect(html).toContain("admin-one");
    expect(html).not.toContain(otherRef);
    expect(html).not.toContain("admin-two");
    expect(html).not.toContain("OTHER_TENANT_PROVENANCE_SECRET");
    expect(html).not.toContain("OTHER_TENANT_CHANGE_SECRET");
    expect(html).not.toContain("OTHER_TENANT_ERROR_SECRET");
    expect(html).not.toContain("OTHER_TENANT_DEAD_LETTER_SECRET");
    expect(html).not.toContain("OTHER_TENANT_SERVICE_ERROR_SECRET");

    const sessionToken = primaryCookie.slice("sid=".length);
    expect(html).not.toContain(sessionToken);
    expect(html).toContain("Session tokens and CSRF values are never displayed.");
    expect(providerCalls).toBe(0);
  });

  it("scopes an admin in another organization to that tenant's own records", async () => {
    const res = await pageFor(otherCookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(otherRef);
    expect(html).toContain("OTHER_TENANT_PROVENANCE_SECRET");
    expect(html).toContain("OTHER_TENANT_DEAD_LETTER_SECRET");
    expect(html).not.toContain(primaryRef);
    expect(html).not.toContain("PRIMARY_PROVENANCE_ONLY");
    expect(html).not.toContain("PRIMARY_SEND_FAILURE_DETAIL");
  });

  it("rejects a cross-organization override and denies non-admins", async () => {
    const crossOrg = await pageFor(primaryCookie, `/admin/security?organization_id=${otherOrganizationId}`);
    expect(crossOrg.status).toBe(404);
    expect(await crossOrg.text()).not.toContain(otherRef);

    const memberLogin = await webLogin(base, "member-one", "member-pass-1");
    const forbidden = await pageFor(memberLogin.cookie);
    expect(forbidden.status).toBe(403);
  });

  it("records only a minimal tenant-attributed marker for an unhandled web error", async () => {
    vi.spyOn(repo, "securityConsoleSnapshot").mockImplementationOnce(() => {
      throw new Error("PRIVATE_DETAIL_MUST_NOT_BE_PERSISTED");
    });

    const res = await pageFor(primaryCookie);
    expect(res.status).toBe(500);
    const incident = repo.db.prepare(
      "SELECT actor, event, detail FROM audit_log WHERE event = 'server_error' ORDER BY id DESC LIMIT 1"
    ).get() as { actor: string; event: string; detail: string };
    expect(incident).toMatchObject({ actor: "admin-one", event: "server_error" });
    expect(incident.detail).toContain("GET /admin/security");
    expect(incident.detail).toContain("Error");
    expect(incident.detail).not.toContain("PRIVATE_DETAIL_MUST_NOT_BE_PERSISTED");
  });
});
