/**
 * The Workflow rules flowchart — Config → Workflow rules → "Flowchart editor".
 *
 * These tests exist because the flowchart was drawn and saved by code that did
 * not agree with the engine that runs the rules:
 *
 *   BUG-04  the panel showed one condition row, so saving dropped conditions 2-3
 *   BUG-05  the panel submitted 6 of 15 action fields, so saving reset the rest
 *   BUG-06  the save route hard-coded enabled:true, re-arming parked rules
 *   BUG-07  the diagram ordered by position; the engine orders by case type first
 *   BUG-08  an empty condition list was rendered as "Any message" and saved as a
 *           catch-all, turning a rule that could never fire into one that always did
 *
 * Two properties are pinned here, and they are the two the whole feature rests on:
 *
 *   1. WHAT IS DRAWN IS WHAT RUNS — the order on the page is the order
 *      `firstMatchingRule` evaluates.
 *   2. WHAT IS NOT SHOWN IS NOT LOST — a submission in the shape this panel
 *      produces round-trips every condition and every action setting.
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
import { compareRuleOrder, firstMatchingRule, rulesForCaseScope, type WorkflowRule } from "../src/rules/workflow";

let repo: Repo;
let server: Server;
let base = "";
let admin: { cookie: string; csrf: string };
let orgId = 1;
let caseTypeId = 0;

function post(fields: Record<string, string>): Promise<Response> {
  return fetch(`${base}/config/workflow-rules/save`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: admin.cookie },
    body: new URLSearchParams({ _csrf: admin.csrf, ...fields }).toString(),
    redirect: "manual",
  });
}

async function rulesPage(): Promise<string> {
  return (await fetch(`${base}/config?tab=rules`, { headers: { cookie: admin.cookie } })).text();
}

/** Rule ids in the order the page draws them. */
function drawnOrder(page: string): number[] {
  return [...page.matchAll(/data-rule-id="(\d+)"/g)].map((m) => Number(m[1]));
}

/** The order the engine would evaluate, for one case type and one kind. */
function engineOrder(caseType: number | null, kind: "intake" | "response"): number[] {
  const all = repo.listWorkflowRules(orgId).filter((r) => r.kind === kind);
  return [...rulesForCaseScope(all, caseType)].sort(compareRuleOrder).map((r) => r.id);
}

function rule(id: number): WorkflowRule {
  return repo.getWorkflowRule(id)!;
}

beforeAll(async () => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  configureTestOrganization(repo); // organization 1, case types SERVICE_REQUEST / VENDOR_INTAKE / ACCESS_REQUEST
  orgId = 1;
  caseTypeId = repo.getCaseType("SERVICE_REQUEST", orgId)!.id;
  repo.createStaff("fcadmin", "Flow Admin", hashPassword("flowpass123"), "admin", false, orgId);

  const ctx: PipelineContext = {
    repo,
    adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender: new MockSender() },
  };
  const app = createApp({ repo, ctx });
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const login = await webLogin(base, "fcadmin", "flowpass123");
  expect(login.status).toBe(302);
  admin = { cookie: login.cookie, csrf: login.csrf };
});

afterAll(() => {
  server?.close();
});

describe("BUG-07 — the diagram is ordered the way the engine runs the rules", () => {
  it("a case-type rule outranks an organization-wide rule with a lower position", async () => {
    // The trap: position says the org-wide rule is first, the engine says the
    // case-type rule is. The old diagram followed position and lied.
    const wide = repo.saveWorkflowRule({
      organizationId: orgId, caseTypeId: null, kind: "intake", name: "FC wide first-by-position",
      position: 1, conditions: [{ field: "always", value: true }], action: { decision: "create" },
    });
    const scoped = repo.saveWorkflowRule({
      organizationId: orgId, caseTypeId, kind: "intake", name: "FC case-type later-by-position",
      position: 9, conditions: [{ field: "always", value: true }], action: { decision: "attach" },
    });

    // What the engine actually does — this is the ground truth, not an opinion.
    const truth = engineOrder(caseTypeId, "intake");
    expect(truth.indexOf(scoped.id)).toBeLessThan(truth.indexOf(wide.id));

    // And what the page draws, restricted to the rules in scope for this type.
    const page = await rulesPage();
    const drawn = drawnOrder(page).filter((id) => truth.includes(id));
    expect(drawn).toEqual(truth);

    // Sanity: the case-type rule really is drawn above the org-wide one.
    expect(drawn.indexOf(scoped.id)).toBeLessThan(drawn.indexOf(wide.id));
  });

  it("every case type's chain is drawn in its own group, in evaluation order", async () => {
    const page = await rulesPage();
    for (const kind of ["intake", "response"] as const) {
      for (const ct of repo.listCaseTypes(orgId)) {
        const truth = engineOrder(ct.id, kind);
        if (truth.length < 2) continue;
        const drawn = drawnOrder(page).filter((id) => truth.includes(id));
        expect(drawn).toEqual(truth);
      }
    }
  });

  it("rules belonging to another case type are grouped separately, not interleaved", async () => {
    const other = repo.getCaseType("VENDOR_INTAKE", orgId)!;
    const foreign = repo.saveWorkflowRule({
      organizationId: orgId, caseTypeId: other.id, kind: "intake", name: "FC vendor-only rule",
      position: 0, conditions: [{ field: "always", value: true }], action: { decision: "create" },
    });
    const page = await rulesPage();
    // In scope for SERVICE_REQUEST? No — so it must not appear in that chain.
    const inScope = engineOrder(caseTypeId, "intake");
    expect(inScope).not.toContain(foreign.id);
    const drawn = drawnOrder(page);
    // It IS drawn (nothing is hidden), inside its own labelled group.
    expect(drawn).toContain(foreign.id);
    expect(page).toContain("flow-group");
    expect(page).toMatch(/this case type only|organization-wide/);
  });

  it("the preview route names the same winner the pipeline would pick", async () => {
    // Preview used to sort on position alone and could disagree with
    // firstMatchingRule, which is the one that decides real mail.
    const input = {
      senderState: "unknown" as const,
      subject: "hello",
      body: "please advise",
      hasAttachments: false,
      category: "enquiry",
      bodyIsRef: false,
      intakeSignals: "open" as const,
      docsState: "empty" as const,
      docsOnFile: 0,
    };
    const all = repo.listWorkflowRules(orgId).filter((r) => r.kind === "intake");
    const inScope = rulesForCaseScope(all, caseTypeId);
    const expected = firstMatchingRule(inScope, input);
    expect(expected).not.toBeNull();
    const res = await fetch(`${base}/config/workflow-rules/preview`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: admin.cookie },
      body: new URLSearchParams({
        _csrf: admin.csrf,
        name: "probe", kind: "intake", case_type_id: String(caseTypeId), position: "999",
        sample_subject: input.subject, sample_body: input.body,
        sample_docs_state: input.docsState, sample_sender_state: input.senderState,
      }).toString(),
    });
    const html = await res.text();
    // The named winner must be the engine's winner, not whoever sorts first.
    expect(html).toContain(expected!.name);
  });
});

describe("BUG-04 — the panel round-trips every condition", () => {
  it("the page carries one row per stored condition, up to the parser's three", async () => {
    const r = repo.saveWorkflowRule({
      organizationId: orgId, caseTypeId, kind: "intake", name: "FC three conditions",
      position: 40,
      conditions: [
        { field: "sender_state", value: "known" },
        { field: "has_attachments", value: true },
        { field: "docs_state", values: ["complete"] },
      ],
      action: { decision: "create" },
    });
    const page = await rulesPage();
    // The embedded payload the editor reads must carry all three, untouched.
    const payload = /var rules = (\[.*?\]);\s*\n/.exec(page)?.[1] ?? "";
    expect(payload).toBeTruthy();
    const parsed = JSON.parse(payload) as Array<{ id: number; conditions: unknown[] }>;
    const mine = parsed.find((x) => x.id === r.id);
    expect(mine?.conditions).toHaveLength(3);
    // And the server accepts three rows back without dropping any.
    await post({
      id: String(r.id), kind: "intake", name: "FC three conditions", position: "40",
      case_type_id: String(caseTypeId), enabled: "1",
      cond_field_0: "sender_state", cond_value_0: "known",
      cond_field_1: "has_attachments", cond_value_1: "yes",
      cond_field_2: "docs_state", cond_value_2: "complete",
    });
    expect(rule(r.id).conditions).toHaveLength(3);
  });

  it("a rule with more conditions than the rows can show is flagged and opens as JSON, not truncated", async () => {
    // More conditions than the panel renders as rows (FLOW_MAX_CONDITIONS).
    const many = [
      { field: "sender_state", value: "known" },
      { field: "has_attachments", value: true },
      { field: "body_is_ref", value: true },
      { field: "signals", value: "configured_intake" },
      { field: "subject", op: "contains_any", values: ["a"] },
      { field: "body", op: "contains_any", values: ["b"] },
      { field: "text", op: "contains_any", values: ["c"] },
      { field: "category", op: "in", values: ["application"] },
      { field: "docs_state", values: ["complete"] },
    ] as WorkflowRule["conditions"];
    const r = repo.saveWorkflowRule({
      organizationId: orgId, caseTypeId, kind: "intake", name: "FC too many conditions",
      position: 41, conditions: many, action: { decision: "create" },
    });
    const page = await rulesPage();
    const payload = /var rules = (\[.*?\]);\s*\n/.exec(page)?.[1] ?? "";
    const parsed = JSON.parse(payload) as Array<{ id: number; unsupported: string }>;
    // Still flagged on the card, so nobody is surprised when it opens as JSON…
    expect(parsed.find((x) => x.id === r.id)?.unsupported).toMatch(/9 conditions/);
    expect(page).toContain("flow-node editable");
    // …but the panel carries the whole condition list, so it opens into the
    // raw-JSON editor instead of refusing and silently shrinking the rule.
    const mine = parsed.find((x) => x.id === r.id) as { conditions: unknown[] } | undefined;
    expect(mine?.conditions).toHaveLength(9);
    expect(page).toContain('id="fp-conditions-json"');
  });

  it("a condition beyond the row limit round-trips through the JSON box untouched", async () => {
    const many = [
      { field: "sender_state", value: "known" },
      { field: "body_is_ref", value: true },
      { field: "signals", value: "configured_intake" },
      { field: "subject", op: "contains_any", values: ["a"] },
      { field: "body", op: "contains_any", values: ["b"] },
      { field: "text", op: "contains_any", values: ["c"] },
      { field: "category", op: "in", values: ["application"] },
      { field: "docs_state", values: ["complete"] },
      { field: "has_attachments", value: true },
    ] as WorkflowRule["conditions"];
    const r = repo.saveWorkflowRule({
      organizationId: orgId, caseTypeId, kind: "intake", name: "FC json round trip",
      position: 44, conditions: many, action: { decision: "create" },
    });
    await post({
      id: String(r.id), kind: "intake", name: "FC json round trip", position: "44",
      case_type_id: String(caseTypeId), enabled: "1",
      conditions_json: JSON.stringify(many),
    });
    expect(rule(r.id).conditions).toEqual(many);
  });

  it("a negated condition row round-trips as 'does not contain' / 'not in'", async () => {
    const r = repo.saveWorkflowRule({
      organizationId: orgId, caseTypeId, kind: "intake", name: "FC negated",
      position: 45, conditions: [{ field: "always", value: true }], action: { decision: "create" },
    });
    await post({
      id: String(r.id), kind: "intake", name: "FC negated", position: "45",
      case_type_id: String(caseTypeId), enabled: "1",
      cond_field_0: "subject", cond_value_0: "invoice", cond_op_0: "not",
      cond_field_1: "category", cond_value_1: "complaint", cond_op_1: "not",
    });
    expect(rule(r.id).conditions).toEqual([
      { field: "subject", op: "not_contains", values: ["invoice"] },
      { field: "category", op: "not_in", values: ["complaint"] },
    ]);
  });
});

describe("BUG-05 — the panel round-trips every action setting", () => {
  it("a save in the panel's own shape preserves SLA, attachment set, ladder, map and audit code", async () => {
    const r = repo.saveWorkflowRule({
      organizationId: orgId, caseTypeId, kind: "response", name: "FC fully configured",
      position: 50,
      conditions: [{ field: "always", value: true }],
      action: {
        decision: "create",
        reply_action: "draft",
        stage: "awaiting_review",
        queue: "human_review",
        priority: "high",
        sla_hours: 48,
        attachment_set: "welcome_pack",
        request_info: true,
        followup: "ladder",
        followup_action: "draft",
        audit_code: "fc_audit",
        fallback: "none",
        template_map: { green: "tpl_green", empty: "tpl_empty" },
      },
    });

    // Exactly the shape the panel posts: the six visible fields, plus the
    // hidden mirrors carrying everything the panel does not surface.
    await post({
      id: String(r.id), kind: "response", name: "FC fully configured", position: "50",
      case_type_id: String(caseTypeId), enabled: "1",
      cond_field_0: "always", cond_value_0: "",
      decision: "create", reply_action: "draft",
      stage: "awaiting_review", queue: "human_review",
      sla_hours: "48", attachment_set: "welcome_pack",
      // ── hidden mirrors ──
      priority: "high", assign: "", request_info: "1",
      followup: "ladder", followup_action: "draft",
      audit_code: "fc_audit", fallback: "none",
      map_green: "tpl_green", map_empty: "tpl_empty", map_missing: "",
    });

    const a = rule(r.id).action;
    expect(a.sla_hours).toBe(48);
    expect(a.attachment_set).toBe("welcome_pack");
    expect(a.followup).toBe("ladder");
    expect(a.followup_action).toBe("draft");
    expect(a.audit_code).toBe("fc_audit");
    expect(a.fallback).toBe("none");
    expect(a.priority).toBe("high");
    expect(a.request_info).toBe(true);
    expect(a.template_map).toEqual({ green: "tpl_green", empty: "tpl_empty" });
    expect(rule(r.id).conditions).toHaveLength(1);
  });

  it("the panel gives every action setting a real input — nothing is only preserved", async () => {
    const page = await rulesPage();
    // The flowchart's own edit panel (not the advanced form further down).
    const panel = /<form[^>]*id="flow-panel-form"[\s\S]*?<\/form>/.exec(page)?.[0] ?? "";
    expect(panel).toBeTruthy();
    // Every field the engine understands is editable in the panel, so a save
    // from here can neither reset a setting nor silently keep one the
    // administrator never saw. No field may appear twice either: a duplicated
    // name would make req.body an array.
    const surfaced = [
      "decision", "reply_action", "template_key", "stage", "queue", "priority", "assign",
      "sla_hours", "attachment_set", "followup", "followup_action", "audit_code", "fallback",
      "map_green", "map_empty", "map_missing", "request_info", "position", "enabled",
      "conditions_json", "name", "case_type_id", "kind",
    ];
    for (const name of surfaced) {
      const inputs = [...panel.matchAll(new RegExp(`<(?:input|select|textarea)\\b[^>]*\\sname="${name}"(?=[\\s>])`, "g"))];
      expect(inputs.length, `${name} must appear exactly once in the panel`).toBe(1);
    }
    // Nothing travels as an invisible mirror any more.
    expect(page).not.toContain('id="fp-x-');
    // And the payload carries the values the script writes into them.
    expect(page).toContain('"sla_hours":48');
  });

  it("a rule that never armed a follow-up ladder still has none after an edit", async () => {
    const r = repo.saveWorkflowRule({
      organizationId: orgId, caseTypeId, kind: "response", name: "FC no ladder",
      position: 51,
      conditions: [{ field: "always", value: true }],
      action: { reply_action: "draft", followup: "none", sla_hours: null, attachment_set: null },
    });
    await post({
      id: String(r.id), kind: "response", name: "FC no ladder renamed", position: "51",
      case_type_id: String(caseTypeId), enabled: "1",
      cond_field_0: "always", cond_value_0: "",
      reply_action: "draft",
      followup: "", sla_hours: "", attachment_set: "",
    });
    expect(rule(r.id).name).toBe("FC no ladder renamed");
    expect(rule(r.id).action.followup).toBe("none");
    expect(rule(r.id).action.sla_hours).toBeNull();
    expect(rule(r.id).action.attachment_set).toBeNull();
  });
});

describe("BUG-06 — editing a parked rule leaves it parked", () => {
  it("enabled=0 is preserved through a save", async () => {
    const r = repo.saveWorkflowRule({
      organizationId: orgId, caseTypeId, kind: "intake", name: "FC parked",
      position: 60, enabled: false,
      conditions: [{ field: "always", value: true }], action: { decision: "create" },
    });
    expect(rule(r.id).enabled).toBe(0);
    await post({
      id: String(r.id), kind: "intake", name: "FC parked renamed", position: "60",
      case_type_id: String(caseTypeId), enabled: "0",
      cond_field_0: "always", cond_value_0: "",
    });
    expect(rule(r.id).name).toBe("FC parked renamed");
    expect(rule(r.id).enabled).toBe(0);
  });

  it("a submission with no enabled field keeps the advanced form's behaviour (enables)", async () => {
    const r = repo.saveWorkflowRule({
      organizationId: orgId, caseTypeId, kind: "intake", name: "FC legacy form",
      position: 61, enabled: false,
      conditions: [{ field: "always", value: true }], action: { decision: "create" },
    });
    await post({
      id: String(r.id), kind: "intake", name: "FC legacy form", position: "61",
      case_type_id: String(caseTypeId),
      cond_field_0: "always", cond_value_0: "",
    });
    expect(rule(r.id).enabled).toBe(1);
  });

  it("a parked rule is drawn as off", async () => {
    repo.saveWorkflowRule({
      organizationId: orgId, caseTypeId, kind: "intake", name: "FC drawn off",
      position: 62, enabled: false,
      conditions: [{ field: "always", value: true }], action: { decision: "create" },
    });
    expect(await rulesPage()).toContain("· off");
  });
});

describe("BUG-08 — an empty condition list stays empty", () => {
  it("a rule with no conditions is labelled as never matching, not as a catch-all", async () => {
    repo.saveWorkflowRule({
      organizationId: orgId, caseTypeId, kind: "intake", name: "FC never fires",
      position: 70, conditions: [], action: { decision: "create" },
    });
    const page = await rulesPage();
    expect(page).toContain("Never matches — no conditions yet");
  });

  it("conditions_json=[] round-trips instead of becoming 'any message'", async () => {
    const r = repo.saveWorkflowRule({
      organizationId: orgId, caseTypeId, kind: "intake", name: "FC empty conditions",
      position: 71, conditions: [], action: { decision: "create" },
    });
    await post({
      id: String(r.id), kind: "intake", name: "FC empty conditions", position: "71",
      case_type_id: String(caseTypeId), enabled: "1",
      conditions_json: "[]",
    });
    expect(rule(r.id).conditions).toEqual([]);
    // And it still cannot fire — the whole point of preserving "[]".
    const before = rule(r.id);
    expect(firstMatchingRule([before], {
      senderState: "known", subject: "x", body: "y", hasAttachments: false,
      category: "enquiry", bodyIsRef: false, intakeSignals: "open", docsState: "empty", docsOnFile: 0,
    })).toBeNull();
  });

  it("the panel offers an explicit 'never matches' option for that state", async () => {
    expect(await rulesPage()).toContain("Never matches (park this rule)");
  });
});

describe("BUG-09 — the editor is reachable without a mouse", () => {
  it("nodes are buttons that respond to the keyboard, not just to clicks", async () => {
    const page = await rulesPage();
    expect(page).toContain('role="button"');
    expect(page).toContain('tabindex="0"');
    // A role="button" that only listens for click is not a button.
    expect(page).toContain('addEventListener("keydown"');
    expect(page).toMatch(/e\.key !== "Enter"/);
  });

  it("the on/off control is reachable on a device with no hover", async () => {
    const home = await (await fetch(`${base}/`, { headers: { cookie: admin.cookie } })).text();
    // :hover alone hid it forever on touch; focus-within reveals it.
    expect(home).toContain("flow-node.editable:focus-within");
  });
});
