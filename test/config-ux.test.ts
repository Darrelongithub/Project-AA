/**
 * Case-type configuration UX (round 9, generalized) — plain words, no jargon.
 *
 * The reported gripe: "what is add top level group??" The builder used to
 * greet the administrator with insider language and an empty state that
 * explained nothing. Configuration now lives on the case-type editor: a
 * document matrix with contact-facing labels, a rule tree that explains
 * itself in one sentence, and a plain-English read-back of whatever was
 * saved. The forms post to the real routes, and a malformed tree is refused
 * loudly instead of being half-saved.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { hashPassword } from "../src/util/password";
import { createApp } from "../src/web/server";
import type { PipelineContext } from "../src/pipeline/adapters";
import { MockSender } from "../src/pipeline/adapters";
import { webLogin, configureTestOrganization } from "./helpers";

let repo: Repo;
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let base = "";
let admin: { cookie: string; csrf: string };

beforeEach(() => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  configureTestOrganization(repo);
  repo.createStaff("admin", "Config Admin", hashPassword("admin123"), "admin");
  const sender = new MockSender();
  const ctx: PipelineContext = { repo, adapters: { vision: null as never, watcher: null as never, sender } };
  const app = createApp({ repo, ctx });
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(() => {
  server?.close();
});

async function configPage(tab = "case-types"): Promise<string> {
  return (await fetch(`${base}/config?tab=${tab}`, { headers: { cookie: admin.cookie } })).text();
}

async function post(path: string, body: Record<string, string>): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { cookie: admin.cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: admin.csrf, ...body }).toString(),
    redirect: "manual",
  });
}

describe("the case-type editor — usable by a human", () => {
  it("explains the rule tree in plain words and drops the jargon", async () => {
    admin = await webLogin(base, "admin", "admin123");
    const html = await configPage();
    expect(html).toContain("Rule tree");
    // What the evaluator supports and what happens when a tree cannot decide.
    expect(html).toMatch(/nested AND, OR and NOT/i);
    expect(html).toMatch(/routes to human review, never an automatic rejection/i);
    // A configured tree is read back in words, not dumped as raw JSON.
    expect(html).toMatch(/class="rule-summary"/);
    // The jargon that confused the administrator is gone from the buttons.
    expect(html).not.toContain("Top-level condition");
    expect(html).not.toContain("Top-level group");
  });

  it("adds a document requirement through the real route and shows it in the matrix", async () => {
    admin = await webLogin(base, "admin", "admin123");
    const type = repo.getCaseType("SERVICE_REQUEST", 1)!;
    const res = await post("/config/case-types/document", {
      organization_id: "1",
      case_type_id: String(type.id),
      key: "signed_form",
      label: "Signed request form",
      required: "1",
      blocking: "0",
    });
    expect(res.status).toBe(302);
    const html = await configPage();
    expect(html).toContain("Signed request form");
    expect(html).toContain("signed_form");
    expect(html).toMatch(/required/i);
    expect(html).toMatch(/non-blocking/i);
    expect(repo.listDocumentDefinitions(type.id).some((d) => d.key === "signed_form")).toBe(true);
  });

  it("saves a rule tree and reads it back in plain language", async () => {
    admin = await webLogin(base, "admin", "admin123");
    const type = repo.getCaseType("SERVICE_REQUEST", 1)!;
    const tree = [{
      kind: "group",
      logic: "OR",
      children: [
        { kind: "condition", field: "consent", comparator: "=", value: "yes" },
        { kind: "condition", field: "coverage", comparator: ">=", value: "100000" },
      ],
    }];
    const res = await post("/config/case-types/rules", {
      organization_id: "1",
      case_type_id: String(type.id),
      rules_json: JSON.stringify(tree),
    });
    expect(res.status).toBe(302);
    expect(repo.caseTypeRules(repo.getCaseType("SERVICE_REQUEST", 1)!)).toEqual(tree);
    // The editor shows the tree, and the requirements tab reads it in words.
    expect(await configPage()).toContain("consent = yes OR coverage &gt;= 100000");
    const requirements = await configPage("requirements");
    expect(requirements).toContain("Configured requirements");
    expect(requirements).toContain("consent = yes OR coverage &gt;= 100000");
  });

  it("refuses a malformed rule tree loudly and saves nothing", async () => {
    admin = await webLogin(base, "admin", "admin123");
    const type = repo.getCaseType("SERVICE_REQUEST", 1)!;
    const before = repo.caseTypeRules(type);
    const res = await post("/config/case-types/rules", {
      organization_id: "1",
      case_type_id: String(type.id),
      rules_json: "[{ kind: \"group\", logic: \"MAYBE\", children: [] }]",
    });
    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toContain("Rule tree was not saved");
    expect(repo.caseTypeRules(repo.getCaseType("SERVICE_REQUEST", 1)!)).toEqual(before);
  });

  it("refuses to write another organization's case type", async () => {
    admin = await webLogin(base, "admin", "admin123");
    const other = repo.createOrganization({ name: "Elsewhere Cooperative", refPrefix: "ELS" });
    const foreign = repo.createCaseType(other.id, { code: "ELSEWHERE", name: "Elsewhere", category: "general" });
    const type = repo.getCaseType("SERVICE_REQUEST", 1)!;
    const res = await post("/config/case-types/document", {
      organization_id: String(other.id),
      case_type_id: String(foreign.id),
      key: "injected",
      label: "Injected slot",
      required: "1",
      blocking: "1",
    });
    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toContain("belongs to another organization");
    expect(repo.listDocumentDefinitions(type.id).some((d) => d.key === "injected")).toBe(false);
    expect(repo.listDocumentDefinitions(foreign.id)).toEqual([]);
  });
});
