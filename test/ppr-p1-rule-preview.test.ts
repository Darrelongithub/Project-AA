/**
 * PPR P1-7 acceptance: an admin previews a sample email against an
 * UNPUBLISHED (draft, form-only) rule before publishing — through the real
 * preview route, with no DB writes. The preview says what would fire, who
 * would win the order, and never silently drops mail.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { createApp } from "../src/web/server";
import { hashPassword } from "../src/util/password";
import { webLogin } from "./helpers";

function fresh(): Repo {
  const repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  return repo;
}

describe("PPR P1-7: rule preview against unpublished rules", () => {
  let repo: Repo;
  let server: Server | undefined;
  let base = "";
  let auth: { cookie: string; csrf: string };
  let preId = 0;

  const post = (path: string, body: Record<string, string>) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { cookie: auth.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: auth.csrf, ...body }),
      redirect: "manual",
    });

  beforeAll(async () => {
    repo = fresh();
    repo.createStaff("admin", "Administrator", hashPassword("admin123"), "admin");
    const app = createApp({
      repo,
      ctx: {
        repo,
        adapters: {
          vision: new (await import("../src/pipeline/adapters")).MockVisionAdapter(),
          watcher: (await import("../src/watcher")).makeHeuristicWatcher(),
          sender: new (await import("../src/pipeline/adapters")).MockSender(),
        },
      },
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    base = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
    const login = await webLogin(base, "admin", "admin123");
    expect(login.status).toBe(302);
    auth = { cookie: login.cookie, csrf: login.csrf };

    expect((await post("/config/case-types/create", {
      organization_id: "1", code: "PRE", name: "Preview lab", category: "general",
    })).status).toBe(302);
    preId = repo.getCaseType("PRE", 1)!.id;

    // One PUBLISHED rule — the draft under test will compete with it.
    expect((await post("/config/workflow-rules/save", {
      name: "Volunteer applications open a case",
      kind: "intake",
      case_type_id: String(preId),
      position: "0",
      cond_field_0: "text",
      cond_value_0: "volunteer",
      decision: "create",
      reply_action: "draft",
      template_key: "docs_request",
      fallback: "human_draft",
    })).status).toBe(302);
  });

  afterAll(() => server?.close());

  it("previews a sample against an unsaved rule — match, order and no-match, with zero DB writes", async () => {
    // The rules form carries the preview panel:
    const page = await (await fetch(`${base}/config?tab=rules`, { headers: { cookie: auth.cookie } })).text();
    expect(page).toContain("Preview against this sample");
    expect(page).toContain("sample_subject");

    const rulesBefore = repo.listWorkflowRules(1, { kind: "intake" }).length;
    const auditBefore = (repo.db.prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n;

    // (1) A rule that EXISTS only in the form (never saved) matching the sample:
    const match = await post("/config/workflow-rules/preview", {
      name: "Marathon enquiries (DRAFT — not saved)",
      kind: "intake",
      case_type_id: String(preId),
      position: "5",
      cond_field_0: "text",
      cond_value_0: "marathon",
      decision: "create",
      reply_action: "draft",
      template_key: "status_answer",
      fallback: "human_draft",
      sample_from: "runner@example.test",
      sample_subject: "Marathon route question",
      sample_body: "Is the marathon route closed on Sunday?",
      sample_docs_state: "missing",
    });
    expect(match.status).toBe(200);
    const matchHtml = await match.text();
    expect(matchHtml).toContain("MATCH");
    expect(matchHtml).toContain("open a case");
    expect(matchHtml).toContain("draft");

    // (2) The same draft does NOT match a different message — and the preview
    //     names who would handle it instead (never silence).
    const noMatch = await post("/config/workflow-rules/preview", {
      name: "Marathon enquiries (DRAFT — not saved)",
      kind: "intake",
      case_type_id: String(preId),
      position: "5",
      cond_field_0: "text",
      cond_value_0: "marathon",
      decision: "create",
      reply_action: "draft",
      sample_subject: "Volunteer application",
      sample_body: "I would like to volunteer.",
      sample_docs_state: "missing",
    });
    const noMatchHtml = await noMatch.text();
    expect(noMatchHtml).toContain("NO MATCH");
    expect(noMatchHtml).toContain("Volunteer applications open a case");

    // (3) A draft that matches but sits AFTER the published rule: the preview
    //     says the earlier rule wins and how to take over.
    const ordered = await post("/config/workflow-rules/preview", {
      name: "Second opinion (DRAFT)",
      kind: "intake",
      case_type_id: String(preId),
      position: "9",
      cond_field_0: "text",
      cond_value_0: "volunteer",
      decision: "review",
      sample_subject: "Volunteer application",
      sample_body: "I would like to volunteer.",
      sample_docs_state: "missing",
    });
    const orderedHtml = await ordered.text();
    expect(orderedHtml).toContain("earlier rule wins");
    expect(orderedHtml).toContain("Volunteer applications open a case");

    // (4) Zero DB writes: no rules appeared, nothing was audited.
    expect(repo.listWorkflowRules(1, { kind: "intake" }).length).toBe(rulesBefore);
    expect((repo.db.prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n).toBe(auditBefore);
    // The draft rule is still NOT published:
    expect(repo.listWorkflowRules(1, { kind: "intake" }).some((r) => r.name.includes("DRAFT"))).toBe(false);
  });
});
