/**
 * Message categories — a tenant's own allow-list for classifying inbound mail.
 *
 * Classification is a sensor, never a decision-maker:
 *  - with no categories configured, categorization is the deterministic
 *    keyword matcher and the model is never asked;
 *  - with categories configured AND a Gemini key reachable, the model is
 *    handed the allow-list and may return exactly one of its labels. Anything
 *    else — an off-list label, a malformed answer, a timeout, a dead key —
 *    falls back to the deterministic label, and intake never stops;
 *  - only the eight workflow categories drive routing; a custom label is
 *    recorded on the message and routes as "other" (stated in the UI, pinned
 *    here);
 *  - the label list is tenant data, edited through real admin routes, and the
 *    model credential is installation-wide (organization 1 only).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { hashPassword } from "../src/util/password";
import { createApp } from "../src/web/server";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";
import { processEmail } from "../src/pipeline";
import type { CategoryLabeler, ConfiguredCategoryLabel } from "../src/categorize";
import type { IncomingEmail } from "../src/types";
import { configureTestOrganization, webLogin } from "./helpers";

let repo: Repo;
let sender: MockSender;
let ctx: PipelineContext;
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let base = "";
let admin: { cookie: string; csrf: string };

/** Every classification call the pipeline makes, with the allow-list it was given. */
let calls: Array<{ subject: string; categories: string[] }> = [];

/** A pipeline context with an injected labeler. Deliberately NOT built through
 *  createApp: the web layer rebuilds adapters from the credential store, which
 *  would replace the test double with a real (network) client. */
function pipelineCtx(categorizer?: CategoryLabeler): PipelineContext {
  return { repo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender, categorizer } };
}

/** The same context, plus a real HTTP server for the admin-route tests. */
function boot(categorizer?: CategoryLabeler): PipelineContext {
  ctx = pipelineCtx(categorizer);
  const app = createApp({ repo, ctx });
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return ctx;
}

beforeEach(() => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  configureTestOrganization(repo);
  repo.createStaff("admin", "Category Admin", hashPassword("admin123"), "admin");
  sender = new MockSender();
  calls = [];
});

afterEach(() => { server?.close(); });

let n = 0;
function mail(over: Partial<IncomingEmail> = {}): IncomingEmail {
  n += 1;
  return {
    id: `cat-${n}`, threadId: `cat-thread-${n}`, from: `contact${n}@example.org`, fromName: `Contact ${n}`,
    subject: "Service request about our account", body: "Please advise on our service request.",
    receivedAt: new Date().toISOString(), organizationId: 1, caseTypeCode: "SERVICE_REQUEST",
    attachments: [], ...over,
  } as IncomingEmail;
}

async function post(path: string, body: Record<string, string>, session = admin): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { cookie: session.cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: session.csrf, ...body }).toString(),
    redirect: "manual",
  });
}

/** A labeler that records what it was offered and returns a fixed answer. */
function labeler(answer: Partial<ConfiguredCategoryLabel> | Error): CategoryLabeler {
  return async (input, categories) => {
    calls.push({ subject: input.subject, categories: [...categories] });
    if (answer instanceof Error) throw answer;
    return { label: answer.label ?? "other", confidence: answer.confidence ?? 0.5, source: "gemini" };
  };
}

describe("classification without a configured allow-list", () => {
  it("never asks the model and uses the deterministic matcher", async () => {
    const local = pipelineCtx(labeler({ label: "complaint", confidence: 1 }));
    const res = await processEmail(mail(), local);
    expect(res.skipped).toBeFalsy();
    expect(calls.length).toBe(0); // nothing configured → nothing to choose from
    expect(res.category).toBe("general_enquiry"); // "please advise" + a service word
    const audit = repo.auditForApplicant(res.applicantId!).reverse();
    expect(audit.find((a) => a.event === "email_classifier_gemini")!.detail).toMatch(/outcome=not_run/);
    expect(audit.find((a) => a.event === "email_classifier_fallback")!.detail).toMatch(/label=general_enquiry/);
    expect(audit.find((a) => a.event === "email_labelled")!.detail).toContain("source=deterministic_regex");
  });
});

describe("the allow-list is tenant data, edited through real routes", () => {
  it("adds, shows and retires categories on the Settings page", async () => {
    boot();
    admin = await webLogin(base, "admin", "admin123");

    expect(repo.listEmailCategories(1)).toEqual([]);
    const page0 = await (await fetch(`${base}/settings`, { headers: { cookie: admin.cookie } })).text();
    expect(page0).toContain('id="categories"');
    expect(page0).toContain("Message categories");
    expect(page0).toContain("No categories configured");
    expect(page0).toContain('action="/settings/categories/create"');
    // Honest about what a label can and cannot do.
    expect(page0).toMatch(/never approves, rejects or decides/i);
    expect(page0).toMatch(/No Gemini key is saved/i);
    const config = await (await fetch(`${base}/config?tab=requirements`, { headers: { cookie: admin.cookie } })).text();
    expect(config).toContain("Categories live in Settings");
    expect(config).toContain('href="/settings#categories"');
    expect(config).not.toContain('action="/settings/categories/create"');

    expect((await post("/settings/categories/create", { key: "general_enquiry", label: "General enquiry" })).status).toBe(302);
    expect((await post("/settings/categories/create", { key: "complaint", label: "Complaint" })).status).toBe(302);
    expect(repo.listEmailCategories(1).map((r) => r.key)).toEqual(["general_enquiry", "complaint"]);

    const page = await (await fetch(`${base}/settings`, { headers: { cookie: admin.cookie } })).text();
    expect(page).toContain("general_enquiry");
    expect(page).toContain("General enquiry");
    expect(page).toContain('action="/settings/categories/remove"');
    expect(page).not.toContain("No categories configured");

    // A key that cannot be a machine name is refused, loudly.
    const bad = await post("/settings/categories/create", { key: "No Spaces!", label: "" });
    expect(decodeURIComponent(bad.headers.get("location") ?? "")).toMatch(/2-40 characters|needs a label/);
    expect(repo.listEmailCategories(1).length).toBe(2);

    // Retiring removes it from the allow-list; it is not a deletion of history.
    expect((await post("/settings/categories/remove", { key: "complaint" })).status).toBe(302);
    expect(repo.listEmailCategories(1).map((r) => r.key)).toEqual(["general_enquiry"]);
    expect((await post("/settings/categories/remove", { key: "not_there" })).status).toBe(302);
  });

  it("files a category under the acting administrator's own organization", async () => {
    const other = repo.createOrganization({ name: "Hillcrest Cooperative", refPrefix: "HLC" });
    repo.createStaff("admin2", "Hillcrest Admin", hashPassword("admin2pass99"), "admin", false, other.id);
    boot();
    admin = await webLogin(base, "admin", "admin123");
    const other2 = await webLogin(base, "admin2", "admin2pass99");

    expect((await post("/settings/categories/create", { key: "follow_up", label: "Following up" }, other2)).status).toBe(302);
    expect(repo.listEmailCategories(other.id).map((r) => r.key)).toEqual(["follow_up"]);
    expect(repo.listEmailCategories(1)).toEqual([]); // nothing leaked into org 1
  });

  it("treats the model credential as installation-wide (head office only)", async () => {
    const other = repo.createOrganization({ name: "Hillcrest Cooperative", refPrefix: "HLC" });
    repo.createStaff("admin2", "Hillcrest Admin", hashPassword("admin2pass99"), "admin", false, other.id);
    boot();
    const other2 = await webLogin(base, "admin2", "admin2pass99");
    const res = await post("/settings/gemini", { gemini_api_key: "AIza-tenant-two", gemini_model: "gemini-test" }, other2);
    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toMatch(/installation-wide/);
    expect(repo.hasSecret("gemini_api_key", 1)).toBe(false);
    expect(repo.hasSecret("gemini_api_key", other.id)).toBe(false);
  });
});

describe("the model may only answer from the allow-list", () => {
  beforeEach(async () => {
    repo.addEmailCategory(1, { key: "general_enquiry", label: "General enquiry" });
    repo.addEmailCategory(1, { key: "complaint", label: "Complaint" });
    repo.addEmailCategory(1, { key: "freight_quote", label: "Freight quote" });
  });

  it("uses an on-list label and records where it came from", async () => {
    const local = pipelineCtx(labeler({ label: "complaint", confidence: 0.87 }));
    const res = await processEmail(mail(), local);
    expect(calls.length).toBe(1);
    expect(calls[0].categories).toEqual(["general_enquiry", "complaint", "freight_quote"]);
    expect(res.category).toBe("complaint");
    const label = repo.auditForApplicant(res.applicantId!).find((a) => a.event === "email_labelled");
    expect(label).toBeTruthy();
    expect(label!.detail).toContain("label=complaint");
    expect(label!.detail).toContain("confidence=0.87");
    expect(label!.detail).toContain("source=gemini");
    expect(label!.detail).toMatch(/routing metadata only/);
    // A complaint raises priority — the label routes, it never decides.
    expect(repo.getApplicant(res.applicantId!)!.priority).toBe("high");
    expect(repo.getApplicant(res.applicantId!)!.outcome).toBe("undecided");
  });

  it("rejects an off-list label and falls back to the deterministic matcher", async () => {
    const local = pipelineCtx(labeler({ label: "approve_everything", confidence: 1 }));
    const res = await processEmail(mail(), local);
    expect(calls.length).toBe(1);
    expect(res.category).toBe("general_enquiry"); // what the matcher says
    const label = repo.auditForApplicant(res.applicantId!).find((a) => a.event === "email_labelled");
    expect(label!.detail).toContain("source=fallback");
    expect(label!.detail).not.toContain("approve_everything");
    expect(repo.getApplicant(res.applicantId!)!.outcome).toBe("undecided");
  });

  it("a dead model never stops intake", async () => {
    const local = pipelineCtx(labeler(new Error("429 rate limited")));
    const res = await processEmail(mail(), local);
    expect(calls.length).toBe(1);
    expect(res.skipped).toBeFalsy();
    expect(res.category).toBe("general_enquiry");
    expect(repo.auditForApplicant(res.applicantId!).find((a) => a.event === "email_labelled")!.detail).toContain("source=fallback");
  });

  it("records a custom label and routes it as 'other'", async () => {
    const local = pipelineCtx(labeler({ label: "freight_quote", confidence: 0.9 }));
    const res = await processEmail(mail({ subject: "Quote for a consignment", body: "Please quote our consignment." }), local);
    expect(res.category).toBe("other"); // only the eight workflow keys route
    const label = repo.auditForApplicant(res.applicantId!).find((a) => a.event === "email_labelled");
    expect(label!.detail).toContain("label=freight_quote");
  });

  it("tells the administrator that a custom label routes as 'other'", async () => {
    boot();
    admin = await webLogin(base, "admin", "admin123");
    const page = await (await fetch(`${base}/settings`, { headers: { cookie: admin.cookie } })).text();
    expect(page).toMatch(/routes as <span class="mono">other<\/span>/);
    expect(page).toMatch(/deterministic keyword matching/i); // no key saved in tests
  });

  it("a retired category is no longer offered to the model", async () => {
    repo.setEmailCategoryActive(1, "complaint", false);
    const local = pipelineCtx(labeler({ label: "complaint", confidence: 1 }));
    const res = await processEmail(mail(), local);
    expect(calls[0].categories).toEqual(["general_enquiry", "freight_quote"]);
    // The off-list answer is rejected, so the deterministic matcher decides.
    expect(res.category).not.toBe("complaint");
  });
});
