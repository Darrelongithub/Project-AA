/**
 * OR-7 — Templates section: one home for EVERY outgoing email type.
 *
 * Acceptance:
 *  1. A dedicated Templates section (top-level nav, /templates) lists every
 *     outgoing type the system sends, annotated with who sends it.
 *  2. Placeholders are documented, a live preview renders them, and unknown
 *     placeholders are flagged loudly — never left to render as literal text
 *     without warning.
 *  3. Every template can be RESET to the official seeded default.
 *  4. Each template can optionally attach one of the organization's OWN
 *     attachment sets; manual sends honour the choice and missing files are
 *     audited, never silent. Nothing ships bundled.
 *  5. The old location is removed: Configuration → Replies no longer hosts
 *     the template editor and the legacy save endpoint refuses writes.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { webLogin, configureTestOrganization } from "./helpers";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults, TEMPLATE_SEEDS } from "../src/db/seed";
import { hashPassword } from "../src/util/password";
import { createApp } from "../src/web/server";
import type { PipelineContext } from "../src/pipeline/adapters";
import { MockSender } from "../src/pipeline/adapters";
import type { ApplicantRow } from "../src/types";

let repo: Repo;
let sender: MockSender;

beforeEach(() => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  configureTestOrganization(repo);
  repo.createStaff("admin", "System Administrator", hashPassword("admin123"), "admin");
  sender = new MockSender(true);
});

function mkCase(): ApplicantRow {
  const a = repo.createCase({
    emailAddress: `or7-${Math.random().toString(36).slice(2)}@example.org`,
    threadId: `t-${Math.random()}`,
    organizationId: 1,
    fullName: "Wanjiku Kamau",
    caseTypeCode: "SERVICE_REQUEST",
  });
  return repo.getApplicant(a.id)!;
}

const SET_FILES = ["price-list.pdf", "data-protection-form.pdf"];

/** The organization's own sendable files — nothing ships with the product. */
function welcomeSet(): string {
  const set = repo.createAttachmentSet(1, "Welcome pack");
  for (const filename of SET_FILES) repo.addAttachmentSetFile(set.id, { filename, content: Buffer.from(`%PDF-1.4\n${filename}\n`) });
  return set.name;
}

describe("the Templates section", () => {
  it("lists every outgoing type the system sends, with its sender annotated", async () => {
    const { base, cookie } = await startServer();
    const page = await (await fetch(`${base}/templates`, { headers: { cookie } })).text();
    for (const key of TEMPLATE_SEEDS.map((t) => t.key)) {
      expect(page).toContain(`value="${key}"`);
    }
    // nav shows it to admins
    expect(page).toContain('href="/templates"');
    // sender annotations: which reply is automated and which is staff work
    expect(page).toContain("automatically");
    expect(page).toContain("Manual staff reply");
  });

  it("officers (user role) do not get the admin Templates section", async () => {
    repo.createStaff("jane", "Jane Officer", hashPassword("jane-pass-1"), "user");
    const { base } = await startServer();
    const { cookie } = await webLogin(base, "jane", "jane-pass-1");
    const home = await (await fetch(`${base}/`, { headers: { cookie } })).text();
    expect(home).not.toContain('href="/templates"');
    const res = await fetch(`${base}/templates`, { headers: { cookie }, redirect: "manual" });
    expect([302, 403]).toContain(res.status);
  });

  it("documents every placeholder and renders a live preview", async () => {
    const { base, cookie } = await startServer();
    const page = await (await fetch(`${base}/templates?template=missing_documents`, { headers: { cookie } })).text();
    for (const ph of ["{ref}", "{name}", "{first_name}", "{missing_docs}", "{missing_docs_section}", "{checklist}", "{status}", "{institution}", "{case_type}", "{category}", "{read_back}", "{document_issues}"]) {
      expect(page).toContain(ph);
    }
    // preview rendered with sample data — the placeholder tokens themselves
    // must not survive into the preview box (the legend below it lists them
    // on purpose, so extract only the preview div)
    expect(page).toContain("Preview");
    const preview = /id="tpl-preview"[^>]*>([\s\S]*?)<\/div>/.exec(page)![1];
    expect(preview).not.toContain("{first_name}");
    expect(preview).not.toContain("{institution}");
    expect(preview).toContain("Alex"); // the sample contact's name is rendered
  });

  it("saving a template with an unknown placeholder warns loudly but still saves", async () => {
    const { base, cookie, csrf } = await startServer();
    const res = await fetch(`${base}/templates/save`, {
      method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${csrf}&key=generic_enquiry&name=Generic enquiry&subject=Hello&body=Dear {first_name}, your {bogus_placeholder} is ready.`,
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const loc = decodeURIComponent(res.headers.get("location") || "");
    expect(loc).toContain("bogus_placeholder");
    expect(repo.getTemplate("generic_enquiry")?.body).toContain("{bogus_placeholder}");
  });

  it("documents, persists and previews reusable partial includes", async () => {
    const { base, cookie, csrf } = await startServer();
    const body = "{{> greeting}}\n\n{{> case_reference}}\n\n{{> organization_signature}}";
    const saved = await fetch(`${base}/templates/save`, {
      method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        _csrf: csrf,
        key: "generic_enquiry",
        name: "Generic enquiry",
        subject: "Update for {ref}",
        body,
      }),
      redirect: "manual",
    });
    expect(saved.status).toBe(302);
    expect(repo.getTemplate("generic_enquiry", 1)?.body).toBe(body);

    const page = await (await fetch(`${base}/templates?template=generic_enquiry`, { headers: { cookie } })).text();
    expect(page).toContain("Reusable partials");
    expect(page).toContain("{{&gt; greeting}}");
    const preview = /id="tpl-preview"[^>]*>([\s\S]*?)<\/div>/.exec(page)![1];
    expect(preview).toContain("Hello Alex,");
    expect(preview).toContain("Case reference: ORG-");
    expect(preview).not.toContain("{{&gt;");
  });

  it("refuses an unknown partial without overwriting the saved template", async () => {
    const { base, cookie, csrf } = await startServer();
    const before = repo.getTemplate("generic_enquiry", 1)!.body;
    const res = await fetch(`${base}/templates/save`, {
      method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        _csrf: csrf,
        key: "generic_enquiry",
        name: "Generic enquiry",
        subject: "Hello",
        body: "{{> tenant_secret_signature}}",
      }),
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.headers.get("location") || "")).toContain("unknown partial");
    expect(repo.getTemplate("generic_enquiry", 1)?.body).toBe(before);
  });
});

describe("reset to default", () => {
  it("restores the official seeded template after edits", async () => {
    const { base, cookie, csrf } = await startServer();
    const original = repo.getTemplate("missing_documents")!;
    repo.upsertTemplate("missing_documents", "Edited", "Edited subject", "Edited body");
    const res = await fetch(`${base}/templates/reset`, {
      method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${csrf}&key=missing_documents`, redirect: "manual",
    });
    expect(res.status).toBe(302);
    const back = repo.getTemplate("missing_documents")!;
    expect(back.subject).toBe(original.subject);
    expect(back.body).toBe(original.body);
    expect(back.name).toBe(original.name);
  });

  it("resetting an unknown key is refused politely", async () => {
    const { base, cookie, csrf } = await startServer();
    const res = await fetch(`${base}/templates/reset`, {
      method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${csrf}&key=nope_not_real`, redirect: "manual",
    });
    expect(decodeURIComponent(res.headers.get("location") || "")).toContain("No default");
  });
});

describe("optional attachment sets", () => {
  it("ships nothing bundled: every starter template attaches no files", () => {
    for (const key of TEMPLATE_SEEDS.map((t) => t.key)) {
      expect(repo.getTemplate(key, 1)?.attach_pack, key).toBe("none");
    }
    expect(repo.listAttachmentSets(1)).toEqual([]);
  });

  it("manual template sends attach the organization's set when the template names it", async () => {
    const { base, cookie, csrf } = await startServer();
    const a = mkCase();
    const t = repo.getTemplate("missing_documents", 1)!;
    repo.upsertTemplate(t.key, t.name, t.subject, t.body, t.include_banner === 1, welcomeSet(), 1);
    const res = await fetch(`${base}/case/${a.id}/send`, {
      method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${csrf}&template=missing_documents`, redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(sender.sent.length).toBe(1);
    expect([...sender.sent[0].attachments].sort()).toEqual([...SET_FILES].sort());
  });

  it("manual sends attach nothing when the choice is none", async () => {
    const { base, cookie, csrf } = await startServer();
    const a = mkCase();
    await fetch(`${base}/case/${a.id}/send`, {
      method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${csrf}&template=missing_documents`, redirect: "manual",
    });
    expect(sender.sent.length).toBe(1);
    expect(sender.sent[0].attachments).toEqual([]);
  });

  it("compose sends honour the same choice", async () => {
    const { base, cookie, csrf } = await startServer();
    const a = mkCase();
    repo.upsertTemplate("under_review", "Under review", "S", "B", false, welcomeSet(), 1);
    const res = await fetch(`${base}/case/${a.id}/compose`, {
      method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${csrf}&template=under_review&subject=Hello&body=World`, redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(sender.sent[0].attachments.length).toBeGreaterThan(0);
  });

  it("the choice is editable from the Templates page", async () => {
    const { base, cookie, csrf } = await startServer();
    const setName = welcomeSet();
    const res = await fetch(`${base}/templates/save`, {
      method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${csrf}&key=verification&name=Verification stage&subject=Your case has moved to verification&body=Dear {first_name}, moved.&attach_pack=${encodeURIComponent(setName)}`,
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(repo.getTemplate("verification", 1)?.attach_pack).toBe(setName);
    const page = await (await fetch(`${base}/templates?template=verification`, { headers: { cookie } })).text();
    expect(page).toContain(`value="${setName}" selected`);
  });

  it("an unknown set is refused at the repo level, never silently dropped", () => {
    expect(() => repo.upsertTemplate("verification", "V", "S", "B", false, "Not our set", 1))
      .toThrow(/Unknown attachment set/);
    expect(repo.getTemplate("verification", 1)?.attach_pack).toBe("none");
  });
});

describe("old location removed", () => {
  it("Configuration → Replies no longer hosts the template editor", async () => {
    const { base, cookie } = await startServer();
    const replies = await (await fetch(`${base}/config?tab=replies`, { headers: { cookie } })).text();
    expect(replies).not.toContain('id="templates"');
    expect(replies).not.toContain('action="/settings/template"');
  });

  it("the legacy save endpoint refuses stale writes", async () => {
    const { base, cookie, csrf } = await startServer();
    const before = repo.getTemplate("generic_enquiry")!.body;
    const res = await fetch(`${base}/settings/template`, {
      method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${csrf}&key=generic_enquiry&name=X&subject=Y&body=Z`, redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.headers.get("location") || "")).toContain("Templates section");
    expect(repo.getTemplate("generic_enquiry")!.body).toBe(before);
  });
});

// ── harness ────────────────────────────────────────────────────────────────

let server: ReturnType<ReturnType<typeof createApp>["listen"]> | undefined;

async function startServer(): Promise<{ base: string; cookie: string; csrf: string }> {
  const ctx: PipelineContext = { repo, adapters: { vision: null as never, watcher: null as never, sender } };
  const app = createApp({ repo, ctx });
  server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { cookie, csrf } = await webLogin(base, "admin", "admin123");
  return { base, cookie, csrf };
}

afterEach(() => {
  server?.close();
  server = undefined;
});
