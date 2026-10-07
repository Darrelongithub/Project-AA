/**
 * The configuration sweep: every surface an administrator is offered has to be
 * usable, and usable means three things at once —
 *
 *   1. REACHABLE   — a control exists for it on a page an admin can open;
 *   2. EFFECTIVE   — submitting that control changes the stored value;
 *   3. LOSSLESS    — saving one thing does not silently reset another.
 *
 * Each test below failed against the console before this file existed. They are
 * grouped by the surface they pin, and they deliberately drive the app over
 * HTTP with the same shaped POST the rendered form produces rather than calling
 * repository methods directly, so a form that lost a field name is caught here.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { createApp } from "../src/web/server";
import { hashPassword } from "../src/util/password";
import { webLogin } from "./helpers";

let repo: Repo;
let server: Server;
let base = "";
let admin: { cookie: string; csrf: string };
let orgId = 1;

async function get(path: string): Promise<string> {
  return (await fetch(`${base}${path}`, { headers: { cookie: admin.cookie } })).text();
}

async function post(path: string, fields: Record<string, string>): Promise<{ status: number; location: string; html: string }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: admin.cookie },
    body: new URLSearchParams({ _csrf: admin.csrf, ...fields }).toString(),
    redirect: "manual",
  });
  const location = res.headers.get("location") ?? "";
  const html = location && location.startsWith("/") ? await get(location) : await res.text();
  return { status: res.status, location, html };
}

/** The `?msg=` a redirect carries is the authoritative outcome text. */
function msg(location: string): string {
  try { return new URL(location, base).searchParams.get("msg") ?? ""; } catch { return ""; }
}

beforeAll(async () => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  // Start from a genuinely blank organization: the point of these tests is
  // that the first thing an administrator tries to do is possible.
  const organization = repo.createOrganization({ name: "Sweep Cooperative", refPrefix: "SWP" });
  orgId = organization.id;
  repo.createStaff("sweepadmin", "Sweep Admin", hashPassword("sweeppass123"), "admin", false, orgId);
  const app = createApp({ repo, ctx: { repo, adapters: {} as never } });
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const login = await webLogin(base, "sweepadmin", "sweeppass123");
  expect(login.status).toBe(302);
  admin = { cookie: login.cookie, csrf: login.csrf };
});

afterAll(() => { server?.close(); });

describe("the flowchart is usable from an empty workspace", () => {
  it("offers an add control for both chains before any rule exists", async () => {
    // The empty-state hint used to say "use + Add step in a group below" while
    // no group — and therefore no button — was rendered at all, so the very
    // first rule could not be created from the diagram.
    const page = await get("/config?tab=rules");
    expect(page).toContain('data-scope-source="flow-scope-intake"');
    expect(page).toContain('data-scope-source="flow-scope-response"');
    expect(page).toContain('id="flow-scope-intake"');
    expect(page).toContain('id="flow-scope-response"');
  });

  it("the add bar lets a scope be chosen, including the organization-wide bucket", async () => {
    const type = repo.createCaseType(orgId, { code: "SWEEP_ONE", name: "Sweep one" });
    const page = await get("/config?tab=rules");
    const scopeSelect = new RegExp(`<select id="flow-scope-intake">([\\s\\S]*?)</select>`).exec(page)?.[1] ?? "";
    expect(scopeSelect).toContain(`value="${type.id}"`);
    expect(scopeSelect).toContain('value=""');
  });

  it("creates the first rule of a chain through the panel's own submit shape", async () => {
    const before = repo.listWorkflowRules(orgId).length;
    const res = await post("/config/workflow-rules/save", {
      name: "Sweep first intake rule", kind: "intake", case_type_id: "", position: "", enabled: "1",
      cond_field_0: "always", cond_value_0: "",
      decision: "create", reply_action: "draft",
    });
    expect(res.status).toBe(302);
    expect(msg(res.location)).toMatch(/saved/i);
    expect(repo.listWorkflowRules(orgId).length).toBe(before + 1);
    // With a rule present the group and its own add button appear too.
    expect(await get("/config?tab=rules")).toContain("data-add=\"intake\"");
  });
});

describe("the flowchart can reorder a step", () => {
  it("moving a rule up puts it earlier in the chain and the diagram agrees", async () => {
    const type = repo.createCaseType(orgId, { code: "SWEEP_ORDER", name: "Sweep order" });
    const first = repo.saveWorkflowRule({
      organizationId: orgId, caseTypeId: type.id, kind: "response", name: "Sweep A", position: 0,
      conditions: [{ field: "always", value: true }], action: { reply_action: "draft" },
    });
    const second = repo.saveWorkflowRule({
      organizationId: orgId, caseTypeId: type.id, kind: "response", name: "Sweep B", position: 10,
      conditions: [{ field: "always", value: true }], action: { reply_action: "hold" },
    });

    const drawn = (page: string) => [...page.matchAll(/data-rule-id="(\d+)"/g)].map((m) => Number(m[1]));
    expect(drawn(await get("/config?tab=rules")).indexOf(first.id)).toBeLessThan(drawn(await get("/config?tab=rules")).indexOf(second.id));

    const res = await post("/config/workflow-rules/move", { id: String(second.id), dir: "up" });
    expect(msg(res.location)).toMatch(/moved up/i);
    const page = await get("/config?tab=rules");
    expect(drawn(page).indexOf(second.id)).toBeLessThan(drawn(page).indexOf(first.id));
    expect(repo.getWorkflowRule(second.id)!.position).toBeLessThan(repo.getWorkflowRule(first.id)!.position);
  });

  it("the first and last steps of a chain are rendered as disabled, not silent", async () => {
    const page = await get("/config?tab=rules");
    expect(page).toContain('title="Already first in this chain"');
    expect(page).toContain('title="Already last in this chain"');
  });

  it("refuses to move a rule belonging to another organization", async () => {
    const other = repo.createOrganization({ name: "Other Sweep", refPrefix: "OTH" });
    const foreign = repo.saveWorkflowRule({
      organizationId: other.id, caseTypeId: null, kind: "intake", name: "Foreign rule", position: 0,
      conditions: [{ field: "always", value: true }], action: { decision: "create" },
    });
    const res = await post("/config/workflow-rules/move", { id: String(foreign.id), dir: "down" });
    expect(repo.getWorkflowRule(foreign.id)!.position).toBe(0);
    expect(res.status).toBe(302);
  });
});

describe("a case type can be renamed, re-coded and retired", () => {
  it("renames a case type and keeps its documents and rules", async () => {
    const type = repo.createCaseType(orgId, { code: "SWEEP_RENAME", name: "Typoed name" });
    repo.upsertDocumentDefinition(type.id, { key: "form", label: "Form", required: true, blocking: true });
    const res = await post("/config/case-types/update", {
      organization_id: String(orgId), case_type_id: String(type.id),
      name: "Corrected name", code: "SWEEP_RENAMED", category: "services",
    });
    expect(msg(res.location)).toMatch(/updated/i);
    const saved = repo.caseTypeById(type.id)!;
    expect(saved.name).toBe("Corrected name");
    expect(saved.code).toBe("SWEEP_RENAMED");
    expect(saved.category).toBe("services");
    expect(repo.listDocumentDefinitions(type.id)).toHaveLength(1);
  });

  it("refuses a code another active case type already holds", async () => {
    repo.createCaseType(orgId, { code: "SWEEP_TAKEN", name: "Taken" });
    const type = repo.createCaseType(orgId, { code: "SWEEP_CLASH", name: "Clash" });
    const res = await post("/config/case-types/update", {
      organization_id: String(orgId), case_type_id: String(type.id),
      name: "Clash", code: "SWEEP_TAKEN", category: "general",
    });
    expect(msg(res.location)).toMatch(/not updated|already/i);
    expect(repo.caseTypeById(type.id)!.code).toBe("SWEEP_CLASH");
  });

  it("retiring removes it from the picker, stops its aliases and rules, and is reversible", async () => {
    const type = repo.createCaseType(orgId, { code: "SWEEP_RETIRE", name: "Retire me" });
    const alias = repo.addCaseTypeAlias(orgId, type.id, "retire-me@example.org");
    expect(alias.ok).toBe(true);
    repo.saveWorkflowRule({
      organizationId: orgId, caseTypeId: type.id, kind: "intake", name: "Retired rule", position: 0,
      conditions: [{ field: "always", value: true }], action: { decision: "create" },
    });

    const res = await post("/config/case-types/retire", {
      organization_id: String(orgId), case_type_id: String(type.id),
    });
    expect(msg(res.location)).toMatch(/retired/i);
    expect(repo.listCaseTypes(orgId).map((t) => t.id)).not.toContain(type.id);
    expect(repo.listRetiredCaseTypes(orgId).map((t) => t.id)).toContain(type.id);
    expect(repo.listCaseTypeAliases(orgId).every((a) => a.address !== "retire-me@example.org" || !a.active)).toBe(true);
    expect(repo.listWorkflowRules(orgId).filter((r) => r.case_type_id === type.id).every((r) => !r.enabled)).toBe(true);

    // And it comes back from the page that lists retired types.
    const page = await get("/config?tab=case-types");
    expect(page).toContain("Retired case types");
    const restore = await post("/config/case-types/reactivate", {
      organization_id: String(orgId), case_type_id: String(type.id),
    });
    expect(msg(restore.location)).toMatch(/active again/i);
    expect(repo.listCaseTypes(orgId).map((t) => t.id)).toContain(type.id);
  });
});

describe("the document matrix is editable, not write-once", () => {
  it("a document slot carries a display-order control that is actually submitted", async () => {
    const type = repo.createCaseType(orgId, { code: "SWEEP_DOCS", name: "Sweep docs" });
    repo.upsertDocumentDefinition(type.id, { key: "second", label: "Second", required: true, blocking: true, position: 0 });
    repo.upsertDocumentDefinition(type.id, { key: "first", label: "First", required: true, blocking: true, position: 5 });

    // The row form must expose position, not just key/label/required/blocking.
    const page = await get(`/config?tab=case-types`);
    const rowForm = new RegExp(`<form[^>]*action="/config/case-types/document"[^>]*>[\\s\\S]*?value="second"[\\s\\S]*?</form>`).exec(page);
    expect(rowForm, "a document row must be an editable form").toBeTruthy();
    expect(rowForm![0]).toContain('name="position"');
    expect(rowForm![0]).toContain('name="required"');
    expect(rowForm![0]).toContain('name="blocking"');

    // And saving it reorders the checklist.
    await post("/config/case-types/document", {
      organization_id: String(orgId), case_type_id: String(type.id),
      key: "first", label: "First", required: "1", blocking: "1", position: "0",
    });
    await post("/config/case-types/document", {
      organization_id: String(orgId), case_type_id: String(type.id),
      key: "second", label: "Second", required: "0", blocking: "0", position: "9",
    });
    const saved = repo.listDocumentDefinitions(type.id);
    expect(saved.map((d) => d.key)).toEqual(["first", "second"]);
    expect(saved[1].required).toBe(false);
    expect(saved[1].blocking).toBe(false);
  });
});

describe("settings controls that could never be saved", () => {
  it("the webhook request budget input has a name, so the form can submit a value", async () => {
    const page = await get("/settings");
    const budget = /<form[^>]*id="aa-webhook-budget"[\s\S]*?<\/form>/.exec(page)?.[0] ?? "";
    expect(budget).toBeTruthy();
    // The input lives outside the form and is attached with the `form` attribute,
    // so a missing name silently posted nothing at all.
    const input = /<input type="number"[^>]*form="aa-webhook-budget"[^>]*>/.exec(page)?.[0] ?? "";
    expect(input).toBeTruthy();
    expect(input).toContain('name="webhook_rate_limit_per_minute"');

    const res = await post("/settings/webhook", { action: "limit", webhook_rate_limit_per_minute: "77" });
    expect(msg(res.location)).toMatch(/Rate limit saved/i);
    expect(repo.webhookRateLimitPerMinute(orgId)).toBe(77);
  });

  it("retention has a control, instead of existing only as a seeded setting", async () => {
    const page = await get("/settings");
    expect(page).toContain('name="retention_days"');
    const res = await post("/settings/general", { retention_days: "365", sla_target_hours: "4" });
    expect(msg(res.location)).toMatch(/saved/i);
    expect(repo.getSetting("retention_days", "")).toBe("365");
    // An invalid value keeps the stored one rather than storing garbage.
    await post("/settings/general", { retention_days: "soon" });
    expect(repo.getSetting("retention_days", "")).toBe("365");
  });
});

describe("Reply configuration configures replies", () => {
  it("carries the sender identity, the response targets and the auto-send dial", async () => {
    const page = await get("/config?tab=replies");
    for (const name of ["from_name", "reply_to", "sla_target_hours", "escalation_hours", "followup_ladder_days", "mode"]) {
      expect(page, `reply configuration must expose ${name}`).toContain(`name="${name}"`);
    }
    expect(page).toContain('action="/settings/automation/global"');
    expect(page).toContain('action="/settings/automation/category"');
  });

  it("saving the sender identity from that page changes what mail is sent as", async () => {
    const res = await post("/settings/organization", {
      organization_name: "Sweep Cooperative", ref_prefix: "SWP",
      primary_color: "#3b1d5f", accent_color: "#9a78c7",
      from_name: "Sweep Intake Desk", reply_to: "desk@example.org",
      locale: "en-GB", timezone: "UTC",
    });
    expect(msg(res.location)).toMatch(/saved/i);
    const saved = repo.getOrganization(orgId)!;
    expect(saved.from_name).toBe("Sweep Intake Desk");
    expect(saved.reply_to).toBe("desk@example.org");
  });

  it("saving the response targets from that page moves the SLA clock", async () => {
    const res = await post("/settings/general", {
      sla_target_hours: "2", escalation_hours: "6", unanswered_target_hours: "3", followup_ladder_days: "2,5,9",
    });
    expect(msg(res.location)).toMatch(/saved/i);
    expect(repo.getSetting("sla_target_hours", "")).toBe("2");
    expect(repo.getSetting("followup_ladder_days", "")).toBe("2,5,9");
  });
});

describe("organization axes actually change a checklist", () => {
  it("a document slot can be pinned to values of an axis, and the case page offers the matching control", async () => {
    // Axes were a write-only JSON textarea: they could be saved, but nothing in
    // the product ever read them back, so a slot could not be made conditional
    // and setting axes changed no checklist anywhere.
    const type = repo.createCaseType(orgId, { code: "SWEEP_AXES", name: "Sweep axes" });
    repo.upsertDocumentDefinition(type.id, { key: "id_form", label: "ID form", required: true, blocking: true, position: 0 });
    repo.replaceOrganizationDocumentAxes(orgId, [{ key: "country", label: "Applicant country", values: ["Kenya", "Ghana"] }]);

    // The row form now offers the axis, not just key/label/required/blocking.
    const page = await get("/config?tab=case-types");
    const rowForm = new RegExp(`<form[^>]*action="/config/case-types/document"[^>]*>[\\s\\S]*?value="id_form"[\\s\\S]*?</form>`).exec(page);
    expect(rowForm, "a document row must be an editable form").toBeTruthy();
    expect(rowForm![0]).toContain('name="axis"');
    expect(rowForm![0]).toContain('name="axis_values"');

    const res = await post("/config/case-types/document", {
      organization_id: String(orgId), case_type_id: String(type.id),
      key: "kra_pin", label: "KRA PIN", required: "1", blocking: "1", position: "1",
      axis: "country", axis_values: "Kenya",
    });
    expect(msg(res.location), "a valid axis slot must save").not.toMatch(/not saved/i);
    const saved = repo.listDocumentDefinitions(type.id).find((d) => d.key === "kra_pin")!;
    expect(saved.axis).toBe("country");
    expect(saved.axis_values).toEqual(["Kenya"]);

    // And the checklist honours it — with no selection the slot still applies,
    // but a Ghanaian case is not asked for a Kenyan tax number.
    const keys = (selections?: Record<string, string>) => repo.documentRequirementsForCase(type.id, selections).map((d) => d.key);
    expect(keys()).toEqual(["id_form", "kra_pin"]);
    expect(keys({ country: "Kenya" })).toEqual(["id_form", "kra_pin"]);
    expect(keys({ country: "Ghana" })).toEqual(["id_form"]);
  });

  it("refuses an axis that would silently disable a slot", async () => {
    const type = repo.createCaseType(orgId, { code: "SWEEP_AXES2", name: "Sweep axes 2" });
    // An axis with no values would never match, so the slot would look
    // configured and never appear. Better to say so than to hide it.
    const blank = await post("/config/case-types/document", {
      organization_id: String(orgId), case_type_id: String(type.id),
      key: "ghost", label: "Ghost", required: "1", blocking: "1", position: "0",
      axis: "country", axis_values: "  ",
    });
    expect(msg(blank.location)).toMatch(/Pick at least one value/i);
    expect(repo.listDocumentDefinitions(type.id).some((d) => d.key === "ghost")).toBe(false);

    // An axis that does not exist is rejected too, rather than stored as a
    // condition that can never be met.
    const unknown = await post("/config/case-types/document", {
      organization_id: String(orgId), case_type_id: String(type.id),
      key: "ghost", label: "Ghost", required: "1", blocking: "1", position: "0",
      axis: "campus", axis_values: "Main",
    });
    expect(msg(unknown.location)).toMatch(/not one of this organization's axes/i);
    expect(repo.listDocumentDefinitions(type.id).some((d) => d.key === "ghost")).toBe(false);
  });

  it("setting axes on a case re-freezes its checklist and leaves the verdict alone", async () => {
    const type = repo.createCaseType(orgId, { code: "SWEEP_AXCASE", name: "Sweep axis case" });
    repo.upsertDocumentDefinition(type.id, { key: "id_form", label: "ID form", required: true, blocking: true, position: 0 });
    repo.upsertDocumentDefinition(type.id, { key: "kra_pin", label: "KRA PIN", required: true, blocking: true, position: 1, axis: "country", values: ["Kenya"] });
    const a = repo.createCase({ emailAddress: "axis@example.org", threadId: "axis-thread", organizationId: orgId, caseTypeCode: "SWEEP_AXCASE", fullName: "Axis Person" });
    repo.freezeCaseConfig(a);

    const page = await get(`/case/${a.id}`);
    expect(page).toContain(`action="/case/${a.id}/axes"`);
    expect(page).toContain('name="axis_country"');

    const res = await post(`/case/${a.id}/axes`, { axis_country: "Ghana" });
    expect(msg(res.location)).toMatch(/checklist now shows only the slots/i);
    expect(repo.axisSelections(repo.getApplicant(a.id)!)).toEqual({ country: "Ghana" });

    const frozen = repo.caseConfigFrozen(repo.getApplicant(a.id)!)!;
    expect((frozen.documents ?? []).map((d) => d.key)).toEqual(["id_form"]);
    // The recorded outcome is untouched: only Re-evaluate re-checks evidence.
    expect(repo.getApplicant(a.id)!.outcome).toBe(a.outcome);

    // Clearing the value brings the slot back — the choice is reversible.
    await post(`/case/${a.id}/axes`, { axis_country: "" });
    expect(repo.axisSelections(repo.getApplicant(a.id)!)).toEqual({});
    const refrozen = repo.caseConfigFrozen(repo.getApplicant(a.id)!)!;
    expect((refrozen.documents ?? []).map((d) => d.key)).toEqual(["id_form", "kra_pin"]);
  });
});

describe("a new organization does not inherit a placeholder identity", () => {
  it("setup names the organization and the mail signature starts the same", () => {
    // The second field used to stay "Organization" until someone found it
    // buried under Letters & identity, so outgoing mail went out unsigned by
    // the real name.
    expect(repo.getSetting("institution_name", "")).toBe("Sweep Cooperative");
  });
});
