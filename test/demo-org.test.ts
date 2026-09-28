/** DEMO — a real, navigable second organization. Proves the seeded demo org
 * is complete, reachable from visible UI, isolated end-to-end, and that no
 * Organization #1 (academic) data leaks into its rows or its case path. */
import { describe, expect, it } from "vitest";
import type { Server } from "http";
import { webLogin } from "./helpers";
import { createApp } from "../src/web/server";
import { hashPassword } from "../src/util/password";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { DEMO_CASE_TYPES, DEMO_ORG_NAME, DEMO_ORG_PREFIX, seedDemoOrganization } from "../src/db/demoOrg";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";
import { processEmail } from "../src/pipeline";
import { makeTextPdf } from "../src/simulation/pdfFactory";

/** Words that must never appear in the demo org's rows or screens. */
const LEAK = /riara|kcse|kcpe|igcse|programme|school|admission|applicant|university|mean grade/i;

function fresh(): Repo {
  const repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  return repo;
}

/** Every page an admin walks through in the demo workspace. */
const DEMO_PAGES = [
  "/", "/applicants", "/applicants?queue=waiting_docs", "/applicants?queue=completed", "/case/:case", "/case/:case/compose",
  "/config", "/config?tab=case-types", "/config?tab=workflow-rules", "/templates", "/intake/test", "/mail", "/compose",
  "/settings", "/staff", "/account",
];

/** The acceptance list: Organization #1 identity and academic catalogue words. */
const SCREEN_LEAK = /riara|kcse|kcpe|igcse|programme|school|university/i;
/** Pages on the demo walkthrough path are held to the stricter LEAK list too. */
const WALK_PAGES = new Set(["/", "/applicants", "/config?tab=case-types", "/templates", "/intake/test", "/case/:case"]);

/** Every leak hit with a little context — readable failures. */
function leakHits(text: string, re: RegExp = LEAK): string[] {
  return [...text.matchAll(new RegExp(re.source, "gi"))].map((m) => text.slice(Math.max(0, m.index! - 40), m.index! + 40));
}

/** Visible text of a page (tags, scripts and styles stripped). */
function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/g, " ")
    .replace(/\s+/g, " ");
}

/** Remove the organization pickers — the sidebar switcher and the CaseTypes
 *  admin picker deliberately list every organization by name. */
function withoutSwitcher(html: string): string {
  return html
    .replace(/<form method="post" action="\/org\/switch"[\s\S]*?<\/form>/, "")
    .replace(/<select name="organization"[\s\S]*?<\/select>/, "");
}

describe("DEMO — second organization", () => {
  it("seeds a complete, idempotent demo org without touching Organization #1", () => {
    const repo = fresh();
    const org1Before = JSON.stringify({
      org: repo.getOrganization(1),
      types: repo.db.prepare("SELECT * FROM case_types WHERE organization_id = 1 ORDER BY id").all(),
      docs: repo.db.prepare("SELECT d.* FROM document_definitions d JOIN case_types c ON c.id = d.case_type_id WHERE c.organization_id = 1 ORDER BY d.id").all(),
      tpl: repo.db.prepare("SELECT * FROM templates ORDER BY key").all(),
      orgTpl: repo.db.prepare("SELECT * FROM organization_templates WHERE organization_id = 1 ORDER BY key").all(),
      programmes: repo.db.prepare("SELECT * FROM programmes ORDER BY code").all(),
      rules: repo.db.prepare("SELECT COUNT(*) AS n FROM admission_rule_nodes").get(),
    });
    const first = seedDemoOrganization(repo);
    const second = seedDemoOrganization(repo);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.organizationId).toBe(first.organizationId);
    expect(repo.listOrganizations().filter((o) => o.ref_prefix === DEMO_ORG_PREFIX)).toHaveLength(1);
    const org1After = JSON.stringify({
      org: repo.getOrganization(1),
      types: repo.db.prepare("SELECT * FROM case_types WHERE organization_id = 1 ORDER BY id").all(),
      docs: repo.db.prepare("SELECT d.* FROM document_definitions d JOIN case_types c ON c.id = d.case_type_id WHERE c.organization_id = 1 ORDER BY d.id").all(),
      tpl: repo.db.prepare("SELECT * FROM templates ORDER BY key").all(),
      orgTpl: repo.db.prepare("SELECT * FROM organization_templates WHERE organization_id = 1 ORDER BY key").all(),
      programmes: repo.db.prepare("SELECT * FROM programmes ORDER BY code").all(),
      rules: repo.db.prepare("SELECT COUNT(*) AS n FROM admission_rule_nodes").get(),
    });
    expect(org1After).toBe(org1Before);

    const org = repo.getOrganization(first.organizationId)!;
    expect(org.name).toBe(DEMO_ORG_NAME);
    expect(org.theme.primary).not.toBe(repo.getOrganization(1)!.theme.primary);
    expect(org.logo).toMatch(/^data:image\/svg\+xml;base64,/);
    const types = repo.listCaseTypes(org.id);
    expect(types.map((t) => t.code).sort()).toEqual(DEMO_CASE_TYPES.map((d) => d.code).sort());
    for (const ct of types) {
      expect(ct.education_module).toBe(0);
      const docs = repo.listDocumentDefinitions(ct.id);
      expect(docs.length).toBeGreaterThanOrEqual(3);
      expect(docs.length).toBeLessThanOrEqual(5);
      const rules = repo.caseTypeRules(ct);
      expect(rules.length).toBeGreaterThan(0);
      const logics = JSON.stringify(rules);
      expect(logics).toContain('"AND"');
      expect(logics).toContain('"OR"');
      expect(logics).toContain('"NOT"');
      const own = repo.db.prepare("SELECT key FROM organization_templates WHERE organization_id = ? AND case_type_id = ?").all(org.id, ct.id);
      expect(own.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("grep: zero Organization #1 / academic vocabulary in any demo-org seeded row", () => {
    const repo = fresh();
    const { organizationId: id } = seedDemoOrganization(repo);
    const rows = [
      repo.db.prepare("SELECT name, ref_prefix, theme, from_name FROM organizations WHERE id = ?").all(id),
      repo.db.prepare("SELECT code, name, category, config, terminology, stages, queues FROM case_types WHERE organization_id = ?").all(id),
      repo.db.prepare("SELECT d.key, d.label FROM document_definitions d JOIN case_types c ON c.id = d.case_type_id WHERE c.organization_id = ?").all(id),
      repo.db.prepare("SELECT key, name, subject, body FROM organization_templates WHERE organization_id = ?").all(id),
    ];
    const dump = JSON.stringify(rows);
    expect(dump.length).toBeGreaterThan(2000);
    expect(dump).not.toMatch(LEAK);
    // And no legacy (Organization #1 store) template is visible to the demo org.
    for (const t of repo.listTemplates(id)) expect(`${t.subject} ${t.body}`).not.toMatch(LEAK);
    expect(repo.getTemplate("admission_letter", id)).toBeUndefined();
  });

  it("switches organization through the visible sidebar switcher and walks a full demo case end-to-end", async () => {
    const repo = fresh();
    const { organizationId: demoId } = seedDemoOrganization(repo);
    repo.createStaff("admin", "Administrator", hashPassword("admin123"), "admin");
    // A Riara (Organization #1) case that shares the SAME contact email.
    const riaraCase = repo.createCase({ emailAddress: "jordan.rivera@example.test", threadId: "org1-thread", organizationId: 1, caseTypeCode: "GENERAL", fullName: "Org One Person" });
    const sender = new MockSender();
    const ctx: PipelineContext = { repo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender } };
    const app = createApp({ repo, ctx });
    let server: Server | undefined;
    await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
    try {
      const base = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
      const auth = await webLogin(base, "admin", "admin123");
      const get = async (path: string) => (await fetch(`${base}${path}`, { headers: { cookie: auth.cookie } })).text();
      const post = (path: string, body: Record<string, string | string[]>) => {
        const form = new URLSearchParams({ _csrf: auth.csrf });
        for (const [k, v] of Object.entries(body)) for (const x of ([] as string[]).concat(v)) form.append(k, x);
        return fetch(`${base}${path}`, { method: "POST", headers: { cookie: auth.cookie, "content-type": "application/x-www-form-urlencoded" }, body: form, redirect: "manual" });
      };

      // 1. The switcher is visible on an ordinary page (no URL knowledge needed).
      const home = await get("/applicants");
      expect(home).toContain('action="/org/switch"');
      expect(home).toContain(DEMO_ORG_NAME);

      // 2. Switch through it.
      const sw = await post("/org/switch", { organization_id: String(demoId) });
      expect(sw.status).toBe(302);
      expect((repo.db.prepare("SELECT active_organization_id AS o FROM staff_users WHERE username = ?").get("admin") as { o: number }).o).toBe(demoId);

      // 3. CaseTypes with real matrices + rule trees in the demo workspace.
      const config = await get("/config?tab=case-types");
      for (const def of DEMO_CASE_TYPES) {
        expect(config).toContain(def.name);
        for (const d of def.documents) expect(config).toContain(d.key);
      }
      expect(config).toContain("employment_type = full-time OR employment_type = part-time");

      // 4. Walk a case through the visible Test intake page.
      const intakePage = await get("/intake/test?case_type=NEW_HIRE_ONBOARDING");
      expect(intakePage).toContain("Countersigned offer acceptance");
      const submit = await post("/intake/test", {
        case_type: "NEW_HIRE_ONBOARDING", from_name: "Jordan Rivera", from: "jordan.rivera@example.test",
        subject: "New Hire Onboarding — Jordan Rivera",
        body: "Hello,\n\nEmployment type: Full-time\nRight to work: yes\nBackground check: cleared\n\nThanks",
        doc: ["offer_acceptance", "photo_id", "tax_withholding", "payroll_banking"],
      });
      expect(submit.status).toBe(302);
      const location = submit.headers.get("location") ?? "";
      const caseId = Number(location.match(/^\/case\/(\d+)/)?.[1]);
      expect(caseId).toBeGreaterThan(0);
      const demoCase = repo.getApplicant(caseId)!;

      // Gets the demo prefix, lives in the demo org, is NOT the Riara case.
      expect(demoCase.ref_number).toMatch(new RegExp(`^${DEMO_ORG_PREFIX}-\\d{4}-\\d{6}$`));
      expect(demoCase.organization_id).toBe(demoId);
      expect(demoCase.id).not.toBe(riaraCase.id);
      expect(repo.getApplicant(riaraCase.id)!.ref_number).toMatch(/^RU-/);
      expect(repo.caseTypeForCase(caseId)?.code).toBe("NEW_HIRE_ONBOARDING");

      // Used ONLY the demo CaseType's own matrix + rule tree.
      const docs = repo.db.prepare("SELECT document_type FROM documents WHERE applicant_id = ?").all(caseId) as Array<{ document_type: string }>;
      expect(docs.map((d) => d.document_type).sort()).toEqual(["offer_acceptance", "payroll_banking", "photo_id", "tax_withholding"]);
      const reqs = repo.effectiveRequirements(demoCase).map((r) => r.document_type);
      expect(reqs.sort()).toEqual(DEMO_CASE_TYPES[0].documents.map((d) => d.key).sort());
      const gate = repo.db.prepare("SELECT detail FROM audit_log WHERE applicant_id = ? AND event = 'case_type_gate'").get(caseId) as { detail: string };
      expect(gate.detail).toContain("NEW_HIRE_ONBOARDING: matrix=true; rules=passed");
      expect(demoCase.outcome).toBe("undecided");
      // No academic engine / Riara templates touched this case.
      const trail = JSON.stringify(repo.db.prepare("SELECT event, detail FROM audit_log WHERE applicant_id = ?").all(caseId));
      expect(trail).not.toMatch(/admission_rule|structured_snapshot|kcse/i);
      const outbox = repo.db.prepare("SELECT subject, body, template_key FROM outbox WHERE applicant_id = ?").all(caseId);
      expect(JSON.stringify(outbox)).not.toMatch(LEAK);
      expect(sender.sent.map((m) => `${m.subject} ${m.body}`).join(" ")).not.toMatch(LEAK);

      // 5. Queues are isolated both ways.
      const demoQueues = await get("/applicants?queue=human_review&q=jordan");
      expect(demoQueues).toContain(demoCase.ref_number);
      expect(demoQueues).not.toContain(riaraCase.ref_number);

      // 6. Nothing on the demo org's screens names Organization #1 or academic concepts.
      const hits: Record<string, string[]> = {};
      for (const page of DEMO_PAGES) {
        const path = page.replace(":case", String(caseId));
        // The raw audit trail keeps internal event codes (e.g. applicant_created).
        const text = visibleText(withoutSwitcher(await get(path))).replace(/\bapplicant[_ ]created\b/gi, "");
        const found = leakHits(text, WALK_PAGES.has(page) ? LEAK : SCREEN_LEAK);
        if (found.length) hits[path] = found;
      }
      expect(hits).toEqual({});

      // 7. Switch back: the Riara case is there and the demo case is not.
      await post("/org/switch", { organization_id: "1" });
      const riaraQueues = await get("/applicants?q=jordan");
      expect(riaraQueues).toContain(riaraCase.ref_number);
      expect(riaraQueues).not.toContain(demoCase.ref_number);
      // Direct URL to a case in another organization is refused.
      const cross = await fetch(`${base}/case/${caseId}`, { headers: { cookie: auth.cookie }, redirect: "manual" });
      expect(await cross.text()).not.toContain(demoCase.ref_number);
    } finally {
      server?.close();
    }
  });

  it("mail explicitly addressed to the demo org never continues a Riara case with the same contact", async () => {
    const repo = fresh();
    const { organizationId: demoId } = seedDemoOrganization(repo);
    const riara = repo.createCase({ emailAddress: "shared@example.test", threadId: "t-1", organizationId: 1, caseTypeCode: "GENERAL" });
    const ctx: PipelineContext = { repo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender: new MockSender() } };
    const pdf = await makeTextPdf(["Equipment requisition", "Estimated cost: 900"]);
    const result = await processEmail({
      id: "eq-1", threadId: "eq-thread", from: "shared@example.test", subject: `Equipment Request (${riara.ref_number})`,
      body: "Estimated cost: 900\nManager approved: yes\nAsset outstanding: no", receivedAt: new Date().toISOString(),
      organizationId: demoId, caseTypeCode: "EQUIPMENT_REQUEST",
      attachments: [{ filename: "equipment_requisition.pdf", mimeType: "application/pdf", content: pdf }],
    }, ctx);
    const row = repo.getApplicant(result.applicantId!)!;
    expect(row.id).not.toBe(riara.id);
    expect(row.organization_id).toBe(demoId);
    expect(row.ref_number.startsWith(`${DEMO_ORG_PREFIX}-`)).toBe(true);
    const gate = repo.db.prepare("SELECT detail FROM audit_log WHERE applicant_id = ? AND event = 'case_type_gate'").get(row.id) as { detail: string };
    // Missing manager sign-off → matrix incomplete; the rule tree itself passes.
    expect(gate.detail).toContain("EQUIPMENT_REQUEST: matrix=false; rules=passed");
  });

  it("a tenant admin who belongs only to the demo org gets no switcher and cannot switch", async () => {
    const repo = fresh();
    const { organizationId: demoId } = seedDemoOrganization(repo);
    repo.createStaff("peopleops", "People Ops Admin", hashPassword("admin123"), "admin");
    repo.db.prepare("UPDATE staff_users SET organization_id = ? WHERE username = 'peopleops'").run(demoId);
    const ctx: PipelineContext = { repo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender: new MockSender() } };
    const app = createApp({ repo, ctx });
    let server: Server | undefined;
    await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
    try {
      const base = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
      const auth = await webLogin(base, "peopleops", "admin123");
      const page = await (await fetch(`${base}/applicants`, { headers: { cookie: auth.cookie } })).text();
      expect(page).not.toContain('action="/org/switch"');
      expect(page).not.toMatch(/riara/i);
      const sw = await fetch(`${base}/org/switch`, {
        method: "POST", headers: { cookie: auth.cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ _csrf: auth.csrf, organization_id: "1" }), redirect: "manual",
      });
      expect(sw.status).toBe(403);
    } finally {
      server?.close();
    }
  });
});
