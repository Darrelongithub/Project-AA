/**
 * The automation kill switch is displayed as it actually is.
 *
 * The pipeline reads the switch through `Repo.automationAllowedGlobally()`: no
 * row means HELD. The console asked the same key with its own default —
 * `getSetting("automation_mode", "auto")` for the Overview strip, and a raw
 * `settings["automation_mode"] !== "draft"` for the Settings <select> — so on a
 * database that has no row (never opened Settings, or purged), staff saw
 * "auto" and a preselected `auto` option while every automated reply was being
 * held, and the category table beside it contradicted the global line above it.
 * A safety switch shown as the opposite of its state is worse than no switch:
 * nobody queues up to release what is already released, and nobody notices that
 * nothing will send.
 *
 * Both screens now go through `Repo.globalAutomationMode()`, so there is one
 * predicate to be right.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { hashPassword } from "../src/util/password";
import { createApp } from "../src/web/server";
import { processEmail } from "../src/pipeline";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";
import { makeTextPdf } from "../src/simulation/pdfFactory";
import { configureTestOrganization, docLines, releaseAutomation, webLogin } from "./helpers";
import { EMAIL_CATEGORIES } from "../src/types";
import type { IncomingEmail } from "../src/types";

let repo: Repo;
let sender: MockSender;
let ctx: PipelineContext;
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let base = "";
let session: { cookie: string; csrf: string };
let n = 0;

async function mail(): Promise<IncomingEmail> {
  n += 1;
  const attachments = await Promise.all(
    [["form.pdf", "request_form"], ["id.pdf", "id"]].map(async ([filename, docType]) => ({
      filename, mimeType: "application/pdf", content: await makeTextPdf(docLines(docType, { name: "SWITCH PANEL" })),
    }))
  );
  return {
    id: `switch-${n}`, threadId: `switch-thread-${n}`, from: `contact${n}@example.org`, fromName: `Contact ${n}`,
    to: "intake@example.org", subject: "Service request documents",
    body: "Please process my service request.\nConsent: yes",
    receivedAt: new Date().toISOString(), organizationId: 1, caseTypeCode: "SERVICE_REQUEST",
    attachments,
  } as IncomingEmail;
}

const selected = (html: string, value: "auto" | "draft"): boolean =>
  new RegExp(`<option value="${value}"[^>]*\\bselected`).test(html);

beforeEach(async () => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  configureTestOrganization(repo);
  repo.createStaff("admin", "Switch Admin", hashPassword("admin123"), "admin", false, 1);
  sender = new MockSender(true);
  ctx = { repo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender } };
  const type = repo.getCaseType("SERVICE_REQUEST", 1)!;
  repo.updateCaseTypeProfile(type.id, { default_reply_action: "auto", evidence_gate: 0 });
  const rule = repo.listWorkflowRules(1, { caseTypeId: type.id, kind: "response" })
    .find((r) => r.name === "Prepare a factual status draft")!;
  repo.saveWorkflowRule({
    id: rule.id, organizationId: 1, caseTypeId: type.id, kind: "response",
    name: rule.name, position: rule.position, conditions: rule.conditions,
    action: { ...rule.action, reply_action: "send", template_key: "ack_received" },
  });
  server = createApp({ repo, ctx }).listen(0);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  session = await webLogin(base, "admin", "admin123");
});

afterEach(() => { server?.close(); });

describe("the global automation switch on screen", () => {
  it("reads as held when the database has no stored mode", async () => {
    // An old or purged database: the key simply isn't there.
    repo.db.prepare("DELETE FROM settings WHERE key = 'automation_mode'").run();
    expect(repo.getSetting("automation_mode", "MISSING")).toBe("MISSING");
    expect(repo.automationAllowedGlobally()).toBe(false);

    const home = await (await fetch(`${base}/`, { headers: { cookie: session.cookie } })).text();
    expect(home).toContain("draft first");

    const settings = await (await fetch(`${base}/settings`, { headers: { cookie: session.cookie } })).text();
    expect(selected(settings, "draft")).toBe(true);
    expect(selected(settings, "auto")).toBe(false);
    // And the screen is telling the truth: nothing goes out.
    const result = await processEmail(await mail(), ctx);
    expect(result.autoSent).toBe(false);
    expect(sender.sent).toHaveLength(0);
  });

  it("reads as released once an administrator releases it", async () => {
    releaseAutomation(repo);
    const home = await (await fetch(`${base}/`, { headers: { cookie: session.cookie } })).text();
    expect(home).toContain("Automation</span><b>auto");
    const settings = await (await fetch(`${base}/settings`, { headers: { cookie: session.cookie } })).text();
    expect(selected(settings, "auto")).toBe(true);
    expect(selected(settings, "draft")).toBe(false);
  });

  it("keeps the global line and the category table consistent", async () => {
    // The category rows already went through automationMode(); the bug made the
    // headline above them disagree with every row below it.
    repo.db.prepare("DELETE FROM settings WHERE key = 'automation_mode'").run();
    repo.setAutomationMode("document_submission", "auto"); // allowlisted, globally held
    const settings = await (await fetch(`${base}/settings`, { headers: { cookie: session.cookie } })).text();
    expect(selected(settings, "draft")).toBe(true);
    // Every row follows the global switch, so the headline and the table agree.
    expect(settings).toContain("draft for approval");
  });
});

describe("the automation allowlist table", () => {
  it("offers exactly the product's workflow categories — one row each", async () => {
    // The table used to iterate a hand-copied list of eight strings, also
    // duplicated in the category-editor route. A category added to the
    // vocabulary was then classifiable and labelable but impossible to allowlist
    // from the screen, with nothing failing to say so.
    const settings = await (await fetch(`${base}/settings`, { headers: { cookie: session.cookie } })).text();
    for (const cat of EMAIL_CATEGORIES) {
      expect(settings.includes(`<td>${cat.replace(/_/g, " ")}</td>`), cat).toBe(true);
    }
    expect((settings.match(/action="\/settings\/automation\/category"/g) ?? []).length).toBe(EMAIL_CATEGORIES.length);
  });
});
