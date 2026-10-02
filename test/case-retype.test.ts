/**
 * Phase D2 (Q7 step 1) — the routing safety valve: a person moves a case to the
 * right case type.
 *
 * The invariants that matter:
 *  - it works, and the case's type, code, category and frozen checklist all move
 *    together (a case whose columns disagree would be two cases at once);
 *  - the target must belong to the CASE's organization — a forged id can never
 *    move a case into another tenant's configuration, and another tenant's staff
 *    cannot reach the case at all;
 *  - it is audited with the actor and both ends of the change;
 *  - it SENDS NOTHING and fires no rule, even with every automation switch
 *    released and a send rule waiting on the target type;
 *  - it does not re-run the requirements check (PROVISIONAL, QUESTIONS.md Q8):
 *    the recorded verdict survives untouched until a person re-evaluates.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { hashPassword } from "../src/util/password";
import { createApp } from "../src/web/server";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";
import { configureTestOrganization, releaseAutomation, webLogin } from "./helpers";

let repo: Repo;
let sender: MockSender;
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let base = "";
let admin: { cookie: string; csrf: string };
let org2Id = 0;

beforeEach(() => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  configureTestOrganization(repo); // organization 1: SERVICE_REQUEST, VENDOR_INTAKE, ACCESS_REQUEST
  org2Id = repo.createOrganization({ name: "Hillcrest Cooperative", refPrefix: "HLC" }).id;
  repo.createCaseType(org2Id, { code: "HLC_ONLY", name: "Hillcrest only", category: "people" });
  repo.createStaff("admin", "Org One Admin", hashPassword("admin123"), "admin", false, 1);
  repo.createStaff("officer", "Olive Officer", hashPassword("officer-pass-1"), "user", false, 1);
  repo.createStaff("admin2", "Hillcrest Admin", hashPassword("admin2pass99"), "admin", false, org2Id);
  sender = new MockSender();
  const ctx: PipelineContext = { repo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender } };
  server = createApp({ repo, ctx }).listen(0);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(() => { server?.close(); });

function mkCase(email = "contact@example.org", code = "SERVICE_REQUEST"): number {
  return repo.createCase({ emailAddress: email, threadId: `t-${email}`, organizationId: 1, fullName: "Alex Morgan", caseTypeCode: code }).id;
}

async function login(username: string, password: string): Promise<{ cookie: string; csrf: string }> {
  return webLogin(base, username, password);
}

async function retype(session: { cookie: string; csrf: string }, caseId: number, caseTypeId: string | number, opts: { csrf?: boolean } = {}): Promise<Response> {
  const params = new URLSearchParams({ case_type_id: String(caseTypeId) });
  if (opts.csrf !== false) params.set("_csrf", session.csrf);
  return fetch(`${base}/case/${caseId}/case-type`, {
    method: "POST", redirect: "manual",
    headers: { cookie: session.cookie, "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
}

const typeId = (code: string, orgId = 1): number => repo.getCaseType(code, orgId)!.id;
const flashOf = (res: Response): string => decodeURIComponent(res.headers.get("location") ?? "");

describe("re-typing a case", () => {
  it("moves the type, the code, the category and the frozen checklist together", async () => {
    admin = await login("admin", "admin123");
    const id = mkCase();
    expect(repo.caseTypeForCase(id)!.code).toBe("SERVICE_REQUEST");
    expect(repo.effectiveRequirements(repo.getApplicant(id)!).map((r) => r.document_type).sort()).toEqual(["id", "request_form", "supporting_document"]);

    const res = await retype(admin, id, typeId("VENDOR_INTAKE"));
    expect(res.status).toBe(302);
    expect(flashOf(res)).toContain("Moved to vendor intake");

    const row = repo.getApplicant(id)!;
    expect(repo.caseTypeForCase(id)!.code).toBe("VENDOR_INTAKE");
    expect(row.case_type_code).toBe("VENDOR_INTAKE");       // denormalised code follows
    expect(row.category).toBe("vendors");                    // and so does the category
    // The frozen configuration was re-taken from the NEW type, so what staff see
    // and what the next evaluation uses agree.
    expect(repo.effectiveRequirements(row).map((r) => r.document_type).sort()).toEqual(["insurance_certificate", "services_agreement"]);
    expect(repo.caseConfigFrozen(row)!.documents?.map((d) => d.key).sort()).toEqual(["insurance_certificate", "services_agreement"]);
  });

  it("refuses a case type from another organization, and leaves the case alone", async () => {
    admin = await login("admin", "admin123");
    const id = mkCase();
    const res = await retype(admin, id, typeId("HLC_ONLY", org2Id));
    expect(res.status).toBe(302);
    expect(flashOf(res)).toContain("Unknown case type for this organization");
    expect(repo.caseTypeForCase(id)!.code).toBe("SERVICE_REQUEST");
    expect(repo.getApplicant(id)!.case_type_code).toBe("SERVICE_REQUEST");
    expect(repo.auditForApplicant(id).some((a) => a.event === "case_type_changed")).toBe(false);
  });

  it("refuses garbage ids and a no-op re-type", async () => {
    admin = await login("admin", "admin123");
    const id = mkCase();
    expect(flashOf(await retype(admin, id, "not-a-number"))).toContain("Unknown case type");
    expect(flashOf(await retype(admin, id, 999999))).toContain("Unknown case type");
    expect(flashOf(await retype(admin, id, typeId("SERVICE_REQUEST")))).toContain("already");
    expect(repo.auditForApplicant(id).some((a) => a.event === "case_type_changed")).toBe(false);
  });

  it("another tenant's administrator cannot reach the case at all", async () => {
    const other = await login("admin2", "admin2pass99");
    const id = mkCase();
    const res = await retype(other, id, typeId("VENDOR_INTAKE"));
    // Refused outright — not a redirect with an explanation, and no change.
    expect([403, 404]).toContain(res.status);
    expect(repo.caseTypeForCase(id)!.code).toBe("SERVICE_REQUEST");
  });

  it("needs a CSRF token", async () => {
    admin = await login("admin", "admin123");
    const id = mkCase();
    const res = await retype(admin, id, typeId("VENDOR_INTAKE"), { csrf: false });
    expect(res.status).toBe(403);
    expect(repo.caseTypeForCase(id)!.code).toBe("SERVICE_REQUEST");
  });

  it("is audited with the actor and both ends of the change", async () => {
    const officer = await login("officer", "officer-pass-1");
    const id = mkCase();
    expect((await retype(officer, id, typeId("ACCESS_REQUEST"))).status).toBe(302);
    const entry = repo.auditForApplicant(id).find((a) => a.event === "case_type_changed");
    expect(entry).toBeTruthy();
    expect(entry!.actor).toBe("officer");
    expect(entry!.detail).toContain("SERVICE_REQUEST → ACCESS_REQUEST");
    expect(entry!.detail).toMatch(/nothing sent/i);
  });

  it("sends nothing and fires no rule, with every automation switch released", async () => {
    admin = await login("admin", "admin123");
    const id = mkCase();
    // Arm the target type to send on sight, and release every switch there is.
    releaseAutomation(repo);
    const vendor = typeId("VENDOR_INTAKE");
    repo.updateCaseTypeProfile(vendor, { default_reply_action: "auto", evidence_gate: 0 });
    repo.saveWorkflowRule({
      organizationId: 1, caseTypeId: vendor, kind: "response", name: "Say something on every message", position: -1,
      conditions: [{ field: "always", value: true }],
      action: { reply_action: "send", template_key: "ack_received", audit_code: "rule_vendor_ack" },
    });
    const outboxBefore = repo.db.prepare("SELECT COUNT(*) AS n FROM outbox").get() as { n: number };

    const res = await retype(admin, id, vendor);
    expect(res.status).toBe(302);
    expect(repo.caseTypeForCase(id)!.code).toBe("VENDOR_INTAKE");

    // Nothing left the building and nothing was queued for anybody.
    expect(sender.sent.length).toBe(0);
    expect((repo.db.prepare("SELECT COUNT(*) AS n FROM outbox").get() as { n: number }).n).toBe(outboxBefore.n);
    const events = repo.auditForApplicant(id).map((a) => a.event);
    expect(events).toContain("case_type_changed");
    expect(events).not.toContain("email_sent_auto");
    expect(events).not.toContain("rule_vendor_ack");
    expect(events).not.toContain("email_not_delivered");
    expect(events).not.toContain("requirements_checked"); // no evaluation ran either
  });

  it("leaves the recorded verdict alone (PROVISIONAL: no automatic re-evaluation)", async () => {
    admin = await login("admin", "admin123");
    const id = mkCase();
    repo.updateApplicant(id, { req_result: "passed", routing: "human_review", outcome: "approved_after_review" });
    repo.updateCase(id, { outcome: "approved_after_review" });
    const auditsBefore = repo.auditForApplicant(id).map((a) => a.event);

    expect((await retype(admin, id, typeId("VENDOR_INTAKE"))).status).toBe(302);

    const row = repo.getApplicant(id)!;
    expect(row.req_result).toBe("passed");                       // verdict untouched
    expect(row.outcome).toBe("approved_after_review");           // human outcome untouched
    expect(row.routing).toBe("human_review");
    const auditsAfter = repo.auditForApplicant(id).map((a) => a.event);
    expect(auditsAfter.filter((e) => e === "requirements_checked").length)
      .toBe(auditsBefore.filter((e) => e === "requirements_checked").length); // no new evaluation
    expect(auditsAfter.filter((e) => e === "case_type_changed").length).toBe(1);
    // And the flash tells the person how to recompute it deliberately.
    expect(flashOf(await retype(admin, id, typeId("VENDOR_INTAKE")))).toMatch(/already|Re-evaluate/);
  });

  it("offers the control on the case page, listing only this tenant's types", async () => {
    admin = await login("admin", "admin123");
    const id = mkCase();
    const page = await (await fetch(`${base}/case/${id}`, { headers: { cookie: admin.cookie } })).text();
    expect(page).toContain('id="retype-form"');
    expect(page).toContain(`action="/case/${id}/case-type"`);
    expect(page).toContain('name="case_type_id"');
    expect(page).toMatch(/sends nothing, decides nothing/);
    for (const code of ["SERVICE_REQUEST", "VENDOR_INTAKE", "ACCESS_REQUEST"]) expect(page).toContain(code);
    // The other tenant's type is not offered — it is not even rendered.
    expect(page).not.toContain("HLC_ONLY");
    expect(page).not.toContain("Hillcrest only");
  });
});
