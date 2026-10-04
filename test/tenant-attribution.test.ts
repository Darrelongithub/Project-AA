/**
 * Which tenant owns an inbound message.
 *
 * One mailbox can serve several organizations, so attribution is data: each
 * tenant declares the address it is reachable at, and a message is filed under
 * the tenant it was delivered to. Before this, ingestion never set
 * organizationId at all and the pipeline hard-coded organization 1 — every
 * tenant's mail was processed against the head office's case types, templates,
 * checklist and reference prefix, and its cases were created there.
 *
 * A message that names no tenant falls back (the only tenant, else the head
 * office) and the fallback is written to the audit trail: silent
 * mis-attribution is the failure mode this pins.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults, seedStarterTemplates } from "../src/db/seed";
import { hashPassword } from "../src/util/password";
import { createApp } from "../src/web/server";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";
import { ingestNewEmails } from "../src/ingestion";
import { processEmail } from "../src/pipeline";
import type { IncomingEmail } from "../src/types";
import { configureTestOrganization, webLogin } from "./helpers";

let repo: Repo;
let sender: MockSender;
let ctx: PipelineContext;

beforeEach(() => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  configureTestOrganization(repo); // organization 1 — Example Service Cooperative
  sender = new MockSender();
  ctx = { repo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender } };
});

afterEach(() => { /* in-memory only */ });

/** A second tenant, configured the way the console would configure it. */
function secondTenant(address: string | null): number {
  const org = repo.createOrganization({ name: "Hillcrest Freight", refPrefix: "HLC" });
  repo.updateOrganization(org.id, { inboundAddress: address });
  const type = repo.createCaseType(org.id, { code: "FREIGHT_QUOTE", name: "freight quote", category: "sales" });
  repo.replaceDocumentDefinitions(type.id, [{ key: "consignment_note", label: "Consignment note", required: true, blocking: true }]);
  repo.saveWorkflowRule({
    organizationId: org.id, caseTypeId: type.id, kind: "intake", name: "Quotes open a case", position: 0,
    conditions: [{ field: "text", op: "contains_any", values: ["quote", "consignment", "freight"] }],
    action: { decision: "create", audit_code: "rule_quote_open" },
  });
  seedStarterTemplates(repo, org.id);
  return org.id;
}

describe("resolving the tenant from the delivered address", () => {
  it("matches an organization's own inbound address, however it is written", () => {
    const org2 = secondTenant("freight@hillcrest.example");
    expect(repo.organizationForInboundAddress("freight@hillcrest.example")).toEqual({ organizationId: org2, matched: true });
    expect(repo.organizationForInboundAddress("FREIGHT@Hillcrest.Example")).toEqual({ organizationId: org2, matched: true });
    expect(repo.organizationForInboundAddress("<freight@hillcrest.example>")).toEqual({ organizationId: org2, matched: true });
    expect(repo.organizationForInboundAddress('"Hillcrest Freight" <freight@hillcrest.example>')).toEqual({ organizationId: org2, matched: true });
    // A shared mailbox: any one of several recipients is enough.
    expect(repo.organizationForInboundAddress("accounts@elsewhere.example, freight@hillcrest.example")).toEqual({ organizationId: org2, matched: true });
    expect(repo.organizationForInboundAddress(["", null, "freight@hillcrest.example"])).toEqual({ organizationId: org2, matched: true });
  });

  it("falls back honestly when nothing matches", () => {
    secondTenant("freight@hillcrest.example");
    // Two tenants, no match → the head office, flagged as a fallback.
    expect(repo.organizationForInboundAddress("someone@example.org")).toEqual({ organizationId: 1, matched: false });
    expect(repo.organizationForInboundAddress("")).toEqual({ organizationId: 1, matched: false });
    expect(repo.organizationForInboundAddress(undefined)).toEqual({ organizationId: 1, matched: false });
  });

  it("a single-tenant installation always resolves to that tenant", () => {
    expect(repo.listOrganizations().length).toBe(1);
    expect(repo.organizationForInboundAddress("whoever@example.org")).toEqual({ organizationId: 1, matched: false });
  });

  it("no tenants at all resolves to nothing (a fresh install stays empty)", () => {
    const blank = new Repo(openDb(":memory:"));
    seedDefaults(blank);
    expect(blank.organizationForInboundAddress("anyone@example.org")).toBeNull();
  });

  it("refuses a malformed inbound address and stores a valid one", () => {
    const org2 = secondTenant(null);
    expect(() => repo.updateOrganization(org2, { inboundAddress: "not an address" })).toThrow(/valid email/i);
    repo.updateOrganization(org2, { inboundAddress: "Freight@Hillcrest.Example" });
    expect(repo.getOrganization(org2)!.inbound_address).toBe("freight@hillcrest.example");
  });
});

describe("the inbound address is editable in Settings", () => {
  it("saves through the real route and refuses a malformed one", async () => {
    repo.createStaff("admin", "Administrator", hashPassword("admin123"), "admin");
    const server = createApp({ repo, ctx }).listen(0);
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const { cookie, csrf } = await webLogin(base, "admin", "admin123");
      const page = await (await fetch(`${base}/settings`, { headers: { cookie } })).text();
      expect(page).toContain('name="inbound_address"');
      expect(page).toMatch(/Mail delivered to this address belongs to this organization/);

      const post = (body: Record<string, string>) => fetch(`${base}/settings/organization`, {
        method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ _csrf: csrf, ...body }).toString(), redirect: "manual",
      });
      const bad = await post({ organization_name: "Example Service Cooperative", primary_color: "#650019", accent_color: "#c89a4a", ref_prefix: "ORG", inbound_address: "nope" });
      expect(decodeURIComponent(bad.headers.get("location") ?? "")).toMatch(/valid email address/);
      expect(repo.getOrganization(1)!.inbound_address ?? "").toBe("");

      const good = await post({ organization_name: "Example Service Cooperative", primary_color: "#650019", accent_color: "#c89a4a", ref_prefix: "ORG", inbound_address: "Intake@Example.Org" });
      expect(good.status).toBe(302);
      expect(repo.getOrganization(1)!.inbound_address).toBe("intake@example.org");
      expect(repo.organizationForInboundAddress("intake@example.org")).toEqual({ organizationId: 1, matched: true });
    } finally {
      server.close();
    }
  });
});

describe("ingestion files mail under the tenant it was delivered to", () => {
  const message = (over: Partial<IncomingEmail>): IncomingEmail => ({
    id: over.id ?? "att-1", threadId: over.threadId ?? "att-thread", from: "sam@example.org", fromName: "Sam Okonkwo",
    subject: "Freight quote for a consignment", body: "Please quote our consignment.",
    receivedAt: new Date().toISOString(), attachments: [], ...over,
  } as IncomingEmail);

  /** Stands in for GmailClient: the wire path itself is covered by
   *  test/gmail-sandbox.test.ts, this is about attribution. */
  function fakeMailbox(messages: IncomingEmail[]) {
    return {
      watchTarget: () => "sandbox",
      listRecentMessageIds: async () => messages.map((m) => m.id),
      fetchEmail: async (id: string) => messages.find((m) => m.id === id)!,
    };
  }

  it("a message addressed to tenant 2 opens a tenant-2 case with tenant-2 wording", async () => {
    const org2 = secondTenant("freight@hillcrest.example");
    const results = await ingestNewEmails(fakeMailbox([message({ id: "att-2", to: "freight@hillcrest.example" })]) as never, ctx, 14);
    expect(results.length).toBe(1);
    const caseRow = repo.getApplicant(results[0].applicantId!)!;
    expect(caseRow.organization_id).toBe(org2);
    expect(caseRow.ref_number).toMatch(/^HLC-\d{4}-\d{6}$/); // tenant 2's own prefix
    expect(repo.caseTypeForCase(caseRow.id)?.code).toBe("FREIGHT_QUOTE"); // its own case type
    expect(repo.auditForApplicant(caseRow.id).some((a) => a.event === "rule_quote_open")).toBe(true);
    // Nothing leaked into the head office.
    expect(repo.allApplicants(0, ["SERVICE_REQUEST", "VENDOR_INTAKE", "ACCESS_REQUEST"]).length).toBe(0);
    expect(repo.recentAudit(20).some((a) => a.event === "tenant_attribution_fallback")).toBe(false);
  });

  it("a message that names no tenant falls back to the head office and says so", async () => {
    secondTenant("freight@hillcrest.example");
    const results = await ingestNewEmails(fakeMailbox([message({ id: "att-3", to: "unknown@example.org", subject: "Service request", body: "Please advise on our service request." })]) as never, ctx, 14);
    const caseRow = repo.getApplicant(results[0].applicantId!)!;
    expect(caseRow.organization_id).toBe(1);
    expect(caseRow.ref_number).toMatch(/^ORG-/);
    const fallback = repo.recentAudit(20).find((a) => a.event === "tenant_attribution_fallback");
    expect(fallback).toBeTruthy();
    expect(fallback!.detail).toContain("named no organization");
    expect(fallback!.detail).toContain("unknown@example.org");
  });

  it("the pipeline attributes too, so no entry point depends on the caller", async () => {
    const org2 = secondTenant("freight@hillcrest.example");
    const result = await processEmail(message({ id: "att-4", to: "freight@hillcrest.example" }), ctx);
    expect(repo.getApplicant(result.applicantId!)!.organization_id).toBe(org2);
  });

  it("a connector that declares the tenant still wins over the address", async () => {
    secondTenant("freight@hillcrest.example");
    const result = await processEmail(message({ id: "att-5", to: "freight@hillcrest.example", organizationId: 1, subject: "Service request", body: "Please advise on our service request.", caseTypeCode: "SERVICE_REQUEST" }), ctx);
    expect(repo.getApplicant(result.applicantId!)!.organization_id).toBe(1);
  });
});
