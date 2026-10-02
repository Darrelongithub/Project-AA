/**
 * Phase D3 (Q7 step 2) — alias routing: an organization maps inbound addresses
 * to case types, so the sender chooses the route by picking an address and the
 * product never has to guess.
 *
 * Invariants pinned here:
 *  - an alias routes a message to its case type, and the audit names the alias;
 *  - matching is case-insensitive and honours plus-addressing (Q9, provisional);
 *  - two aliases on one message pointing at DIFFERENT case types are ambiguous:
 *    the case is left unconfigured for a person, never coin-tossed;
 *  - precedence: a connector's declaration, then an alias, then the
 *    single-case-type default;
 *  - tenant isolation both ways: an alias in tenant A never routes tenant B's
 *    mail, and no route lets an admin claim or retire another tenant's address;
 *  - an address belongs to ONE organization across the whole installation;
 *  - retiring keeps the record and stops the routing.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults, seedStarterTemplates } from "../src/db/seed";
import { hashPassword } from "../src/util/password";
import { createApp } from "../src/web/server";
import { processEmail } from "../src/pipeline";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";
import type { IncomingEmail } from "../src/types";
import { configureTestOrganization, webLogin } from "./helpers";

let repo: Repo;
let sender: MockSender;
let ctx: PipelineContext;
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let base = "";
let org1: { cookie: string; csrf: string };
let org2: { cookie: string; csrf: string };
let org2Id = 0;
let org2TypeId = 0;

beforeEach(() => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  configureTestOrganization(repo); // organization 1: SERVICE_REQUEST, VENDOR_INTAKE, ACCESS_REQUEST
  org2Id = repo.createOrganization({ name: "Hillcrest Cooperative", refPrefix: "HLC" }).id;
  org2TypeId = repo.createCaseType(org2Id, { code: "HLC_INTAKE", name: "Hillcrest intake", category: "general" }).id;
  seedStarterTemplates(repo, org2Id);
  repo.createStaff("admin", "Org One Admin", hashPassword("admin123"), "admin", false, 1);
  repo.createStaff("admin2", "Hillcrest Admin", hashPassword("admin2pass99"), "admin", false, org2Id);
  sender = new MockSender();
  ctx = { repo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender } };
  server = createApp({ repo, ctx }).listen(0);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(() => { server?.close(); });

let n = 0;
function mail(over: Partial<IncomingEmail> = {}): IncomingEmail {
  n += 1;
  return {
    id: `alias-${n}`, threadId: `alias-thread-${n}`, from: `sender${n}@example.org`, fromName: `Sender ${n}`,
    // The subject carries a configured intake signal ("service request" is one
    // of this tenant's case-type names), so the message opens a case even when
    // no case type could be resolved — which is exactly the situation the
    // ambiguity and cross-tenant tests are about.
    to: "intake@example.org", subject: "Service request", body: "Please help with this service request.",
    receivedAt: new Date().toISOString(), organizationId: 1, attachments: [], ...over,
  } as IncomingEmail;
}

const code = (id: number): string | undefined => repo.caseTypeForCase(id)?.code;
const events = (id: number): string[] => repo.auditForApplicant(id).map((a) => a.event);
const detail = (id: number, event: string): string => repo.auditForApplicant(id).find((a) => a.event === event)?.detail ?? "";

async function post(session: { cookie: string; csrf: string }, path: string, body: Record<string, string>): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST", redirect: "manual",
    headers: { cookie: session.cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: session.csrf, ...body }).toString(),
  });
}
const flash = (res: Response): string => decodeURIComponent(res.headers.get("location") ?? "");
const typeId = (c: string, orgId = 1): number => repo.getCaseType(c, orgId)!.id;

describe("alias routing", () => {
  it("routes a message to the case type its address points at, and says which alias did it", async () => {
    // Three case types: the single-type default cannot be what routed this.
    expect(repo.addCaseTypeAlias(1, typeId("VENDOR_INTAKE"), "billing@intake.example")).toEqual({ ok: true, address: "billing@intake.example" });
    const res = await processEmail(mail({ to: "billing@intake.example" }), ctx);
    expect(res.skipped).toBeFalsy();
    expect(code(res.applicantId!)).toBe("VENDOR_INTAKE");
    expect(events(res.applicantId!)).toContain("case_type_by_alias");
    expect(detail(res.applicantId!, "case_type_by_alias")).toContain("billing@intake.example");
    expect(events(res.applicantId!)).not.toContain("case_type_inferred");
    // Routing is not sending: the tenant is still draft-first.
    expect(res.autoSent).toBe(false);
    expect(sender.sent.length).toBe(0);
  });

  it("matches case-insensitively, through display names and angle brackets, and honours plus-addressing", async () => {
    repo.addCaseTypeAlias(1, typeId("ACCESS_REQUEST"), "claims@intake.example");
    const res = await processEmail(mail({ to: '"Accounts Desk" <Claims+March@Intake.Example>' }), ctx);
    expect(code(res.applicantId!)).toBe("ACCESS_REQUEST");
    expect(detail(res.applicantId!, "case_type_by_alias")).toContain("claims@intake.example");

    // The candidate list is explicit about what it tries: the address as
    // written, and its plus-addressing base.
    const candidates = repo.aliasKeyCandidates('"A B" <Claims+March@Intake.Example>, other@example.org');
    expect([...candidates].sort()).toEqual(["claims+march@intake.example", "claims@intake.example", "other@example.org"].sort());
    expect(repo.aliasKeyCandidates("no-at-sign")).toEqual([]);
    expect(repo.aliasKeyCandidates("")).toEqual([]);
  });

  it("two aliases on one message pointing at different case types leave it for a person", async () => {
    repo.addCaseTypeAlias(1, typeId("VENDOR_INTAKE"), "billing@intake.example");
    repo.addCaseTypeAlias(1, typeId("ACCESS_REQUEST"), "claims@intake.example");
    const res = await processEmail(mail({ to: "billing@intake.example, claims@intake.example" }), ctx);
    expect(res.skipped).toBeFalsy(); // retained, never dropped
    expect(code(res.applicantId!)).toBeUndefined(); // no guess
    expect(repo.activeFlags(res.applicantId!).map((f) => f.type)).toContain("unconfigured_case");
    expect(repo.activeFlags(res.applicantId!).find((f) => f.type === "unconfigured_case")!.detail).toMatch(/a person must choose/);
    expect(events(res.applicantId!)).toContain("case_type_alias_ambiguous");
    expect(detail(res.applicantId!, "case_type_alias_ambiguous")).toContain("billing@intake.example");
    expect(detail(res.applicantId!, "case_type_alias_ambiguous")).toContain("claims@intake.example");
    expect(sender.sent.length).toBe(0);
    // Two aliases for the SAME case type are not ambiguous.
    repo.addCaseTypeAlias(1, typeId("VENDOR_INTAKE"), "invoices@intake.example");
    const both = await processEmail(mail({ to: "billing@intake.example, invoices@intake.example" }), ctx);
    expect(code(both.applicantId!)).toBe("VENDOR_INTAKE");
    expect(events(both.applicantId!)).not.toContain("case_type_alias_ambiguous");
  });

  it("precedence: a connector declaration beats an alias, and an alias beats the single-type default", async () => {
    repo.addCaseTypeAlias(1, typeId("VENDOR_INTAKE"), "billing@intake.example");
    const declared = await processEmail(mail({ to: "billing@intake.example", caseTypeCode: "SERVICE_REQUEST" }), ctx);
    expect(code(declared.applicantId!)).toBe("SERVICE_REQUEST"); // the connector knew better
    expect(events(declared.applicantId!)).not.toContain("case_type_by_alias");

    // A tenant with exactly ONE case type: the alias is still what gets audited,
    // because it is consulted before the single-type default.
    repo.addCaseTypeAlias(org2Id, org2TypeId, "hello@hillcrest.example");
    const single = await processEmail(mail({
      to: "hello@hillcrest.example", organizationId: org2Id,
      subject: "Hillcrest intake request", body: "Please help with our Hillcrest intake.",
    }), ctx);
    expect(single.skipped).toBeFalsy();
    expect(repo.getApplicant(single.applicantId!)!.organization_id).toBe(org2Id);
    expect(code(single.applicantId!)).toBe("HLC_INTAKE");
    expect(events(single.applicantId!)).toContain("case_type_by_alias");
    expect(events(single.applicantId!)).not.toContain("case_type_inferred");
  });

  it("an alias in one tenant never routes another tenant's mail", async () => {
    repo.addCaseTypeAlias(org2Id, org2TypeId, "billing@hillcrest.example");
    // Same address, but this message belongs to organization 1.
    const res = await processEmail(mail({ to: "billing@hillcrest.example", organizationId: 1 }), ctx);
    expect(res.skipped).toBeFalsy();
    expect(code(res.applicantId!)).toBeUndefined(); // org 1 has three types and no matching alias
    expect(events(res.applicantId!)).not.toContain("case_type_by_alias");
    expect(repo.getApplicant(res.applicantId!)!.organization_id).toBe(1);
    // And the resolver only ever looks at the tenant it is given.
    expect(repo.resolveInboundAlias(1, "billing@hillcrest.example")).toEqual({ status: "none" });
    expect(repo.resolveInboundAlias(org2Id, "billing@hillcrest.example").status).toBe("match");
  });

  it("an address belongs to one organization across the whole installation", async () => {
    expect(repo.addCaseTypeAlias(1, typeId("VENDOR_INTAKE"), "shared@intake.example").ok).toBe(true);
    const stolen = repo.addCaseTypeAlias(org2Id, org2TypeId, "SHARED@intake.example");
    expect(stolen.ok).toBe(false);
    expect((stolen as { reason: string }).reason).toMatch(/another organization/);
    expect(repo.listCaseTypeAliases(org2Id)).toEqual([]);
    expect(repo.listCaseTypeAliases(1).map((a) => a.address)).toEqual(["shared@intake.example"]);
    // The same tenant may move or re-activate its own address.
    expect(repo.addCaseTypeAlias(1, typeId("ACCESS_REQUEST"), "shared@intake.example").ok).toBe(true);
    expect(repo.listCaseTypeAliases(1).map((a) => [a.address, a.case_type_code])).toEqual([["shared@intake.example", "ACCESS_REQUEST"]]);
    // Garbage is refused.
    expect(repo.addCaseTypeAlias(1, typeId("ACCESS_REQUEST"), "not an address").ok).toBe(false);
    expect(repo.addCaseTypeAlias(1, org2TypeId, "foreign@intake.example")).toEqual({ ok: false, reason: "unknown case type for this organization" });
  });

  it("retiring keeps the record and stops the routing", async () => {
    repo.addCaseTypeAlias(1, typeId("VENDOR_INTAKE"), "billing@intake.example");
    expect(repo.listCaseTypeAliases(1).map((a) => a.address)).toEqual(["billing@intake.example"]);
    expect(repo.retireCaseTypeAlias(1, "billing@intake.example")).toBe(true);
    expect(repo.listCaseTypeAliases(1)).toEqual([]); // gone from the live list
    expect(repo.listCaseTypeAliases(1, { includeRetired: true }).map((a) => [a.address, a.active])).toEqual([["billing@intake.example", 0]]);
    expect(repo.retireCaseTypeAlias(org2Id, "billing@intake.example")).toBe(false); // not theirs to retire
    const res = await processEmail(mail({ to: "billing@intake.example" }), ctx);
    expect(code(res.applicantId!)).toBeUndefined();
    expect(events(res.applicantId!)).not.toContain("case_type_by_alias");
  });
});

describe("the alias routes and UI", () => {
  it("adds and retires through the real routes, audited, for the acting admin's own tenant", async () => {
    org1 = await webLogin(base, "admin", "admin123");
    const added = await post(org1, "/config/case-type-aliases/create", { case_type_id: String(typeId("VENDOR_INTAKE")), address: " Billing@Intake.Example " });
    expect(added.status).toBe(302);
    expect(flash(added)).toContain("billing@intake.example");
    expect(repo.listCaseTypeAliases(1).map((a) => [a.address, a.case_type_code])).toEqual([["billing@intake.example", "VENDOR_INTAKE"]]);
    expect(repo.recentAudit(10).some((a) => a.event === "case_type_alias_added" && a.actor === "admin" && a.detail.includes("billing@intake.example"))).toBe(true);

    const retired = await post(org1, "/config/case-type-aliases/retire", { address: "billing@intake.example" });
    expect(retired.status).toBe(302);
    expect(repo.listCaseTypeAliases(1, { includeRetired: true })[0].active).toBe(0);
    expect(repo.recentAudit(10).some((a) => a.event === "case_type_alias_retired")).toBe(true);
    expect(flash(await post(org1, "/config/case-type-aliases/retire", { address: "never@intake.example" }))).toContain("Unknown address");
    expect(flash(await post(org1, "/config/case-type-aliases/create", { case_type_id: String(typeId("VENDOR_INTAKE")), address: "nope" }))).toContain("not a valid email address");
  });

  it("refuses cross-tenant writes: another tenant's case type, another tenant's address", async () => {
    org2 = await webLogin(base, "admin2", "admin2pass99");
    repo.addCaseTypeAlias(1, typeId("VENDOR_INTAKE"), "billing@intake.example");
    // An org-2 admin cannot claim an address for an org-1 case type…
    const foreign = await post(org2, "/config/case-type-aliases/create", { case_type_id: String(typeId("VENDOR_INTAKE")), address: "sneaky@hillcrest.example" });
    expect(flash(foreign)).toContain("unknown case type for this organization");
    expect(repo.listCaseTypeAliases(org2Id)).toEqual([]);
    // …cannot steal an address org 1 already holds…
    const steal = await post(org2, "/config/case-type-aliases/create", { case_type_id: String(org2TypeId), address: "billing@intake.example" });
    expect(flash(steal)).toContain("already used by another organization");
    expect(repo.listCaseTypeAliases(1).map((a) => a.address)).toEqual(["billing@intake.example"]);
    // …and cannot retire it.
    expect(flash(await post(org2, "/config/case-type-aliases/retire", { address: "billing@intake.example" }))).toContain("Unknown address");
    expect(repo.listCaseTypeAliases(1)[0].active).toBe(1);
  });

  it("shows the aliases on the CaseTypes tab with the forms only for the acting tenant", async () => {
    org1 = await webLogin(base, "admin", "admin123");
    repo.addCaseTypeAlias(1, typeId("VENDOR_INTAKE"), "billing@intake.example");
    const page = await (await fetch(`${base}/config?tab=case-types`, { headers: { cookie: org1.cookie } })).text();
    expect(page).toContain('id="aliases"');
    expect(page).toContain("Inbound addresses (routing aliases)");
    expect(page).toContain("billing@intake.example");
    expect(page).toContain('action="/config/case-type-aliases/create"');
    expect(page).toContain('action="/config/case-type-aliases/retire"');
    expect(page).toMatch(/honours plus-addressing/);
    expect(page).toMatch(/left unconfigured for a person to choose/);
    // A retired alias is still visible, marked as kept for history.
    repo.retireCaseTypeAlias(1, "billing@intake.example");
    const after = await (await fetch(`${base}/config?tab=case-types`, { headers: { cookie: org1.cookie } })).text();
    expect(after).toContain("retired (kept for history)");
  });
});
