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
 *  4. Each template can optionally attach a pack PDF set (application pack /
 *     admission pack); manual sends honour the flag and missing pack files
 *     are audited, never silent.
 *  5. The old location is removed: Configuration → Replies no longer hosts
 *     the template editor and the legacy save endpoint refuses writes.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  repo.createStaff("admin", "System Administrator", hashPassword("admin123"), "admin");
  sender = new MockSender();
});

function mkApplicant(opts: Partial<ApplicantRow> = {}): ApplicantRow {
  const a = repo.getOrCreateApplicant(opts.email_address ?? `or7-${Math.random().toString(36).slice(2)}@example.org`, `t-${Math.random()}`);
  repo.updateApplicant(a.id, { full_name: "Wanjiku Kamau", ...opts });
  return repo.getApplicant(a.id)!;
}

describe("the Templates section", () => {
  it("lists every outgoing type the system sends, with its sender annotated", async () => {
    const { base, cookie } = await startServer();
    const page = await (await fetch(`${base}/templates`, { headers: { cookie } })).text();
    for (const key of [...TEMPLATE_SEEDS.map((t) => t.key), "admission_letter"]) {
      expect(page).toContain(`value="${key}"`);
    }
    // nav shows it to admins
    expect(page).toContain('href="/templates"');
    // sender annotations: pipeline auto-replies, reminders, admission
    expect(page).toContain("automated");
    expect(page).toContain("reminder");
  });

  it("officers (user role) do not get the admin Templates section", async () => {
    repo.createStaff("jane", "Jane Officer", hashPassword("jane-pass-1"), "user");
    const { base } = await startServer();
    const login = await fetch(`${base}/login`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "username=jane&password=jane-pass-1", redirect: "manual",
    });
    const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
    const home = await (await fetch(`${base}/`, { headers: { cookie } })).text();
    expect(home).not.toContain('href="/templates"');
    const res = await fetch(`${base}/templates`, { headers: { cookie }, redirect: "manual" });
    expect([302, 403]).toContain(res.status);
  });

  it("documents every placeholder and renders a live preview", async () => {
    const { base, cookie } = await startServer();
    const page = await (await fetch(`${base}/templates?template=missing_documents`, { headers: { cookie } })).text();
    for (const ph of ["{ref}", "{name}", "{first_name}", "{missing_docs}", "{missing_docs_section}", "{checklist}", "{status}", "{institution}", "{programme}", "{reg_date}", "{orientation_dates}", "{read_back}", "{document_issues}"]) {
      expect(page).toContain(ph);
    }
    // preview rendered with sample data — the placeholder tokens themselves
    // must not survive into the preview box (the legend below it lists them
    // on purpose, so extract only the preview div)
    expect(page).toContain("Preview");
    const preview = /id="tpl-preview"[^>]*>([\s\S]*?)<\/div>/.exec(page)![1];
    expect(preview).not.toContain("{first_name}");
    expect(preview).not.toContain("{institution}");
    expect(preview).toContain("Wanjiku");
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

describe("optional pack attachments", () => {
  it("seeds the pack flag: application pack on docs_request, admission pack on the letter", () => {
    expect(repo.getTemplate("docs_request")?.attach_pack).toBe("application");
    expect(repo.getTemplate("admission_letter")?.attach_pack).toBe("admission");
    expect(repo.getTemplate("missing_documents")?.attach_pack).toBe("none");
  });

  it("manual template sends attach the pack when the flag says so", async () => {
    const { base, cookie, csrf } = await startServer();
    const a = mkApplicant();
    // flag missing_documents to carry the application pack
    repo.upsertTemplate("missing_documents", repo.getTemplate("missing_documents")!.name,
      repo.getTemplate("missing_documents")!.subject, repo.getTemplate("missing_documents")!.body, undefined, "application");
    const res = await fetch(`${base}/case/${a.id}/send`, {
      method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${csrf}&template=missing_documents`, redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(sender.sent.length).toBe(1);
    expect(sender.sent[0].attachments.length).toBeGreaterThan(0);
    expect(sender.sent[0].attachments.some((f) => /Application Form/i.test(f))).toBe(true);
  });

  it("manual sends attach nothing when the flag is none", async () => {
    const { base, cookie, csrf } = await startServer();
    const a = mkApplicant();
    await fetch(`${base}/case/${a.id}/send`, {
      method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${csrf}&template=missing_documents`, redirect: "manual",
    });
    expect(sender.sent.length).toBe(1);
    expect(sender.sent[0].attachments).toEqual([]);
  });

  it("compose sends honour the same flag", async () => {
    const { base, cookie, csrf } = await startServer();
    const a = mkApplicant();
    repo.upsertTemplate("under_review", "Under review", "S", "B", undefined, "application");
    const res = await fetch(`${base}/case/${a.id}/compose`, {
      method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${csrf}&template=under_review&subject=Hello&body=World`, redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(sender.sent[0].attachments.length).toBeGreaterThan(0);
  });

  it("the flag is editable from the Templates page", async () => {
    const { base, cookie, csrf } = await startServer();
    const res = await fetch(`${base}/templates/save`, {
      method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${csrf}&key=verification&name=Verification stage&subject=Your application has moved to verification&body=Dear {first_name}, moved.&attach_pack=application`,
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(repo.getTemplate("verification")?.attach_pack).toBe("application");
    const page = await (await fetch(`${base}/templates?template=verification`, { headers: { cookie } })).text();
    expect(page).toContain('value="application" selected');
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
  const res = await fetch(`${base}/login`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "username=admin&password=admin123", redirect: "manual",
  });
  const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  const page = await (await fetch(`${base}/`, { headers: { cookie } })).text();
  const csrf = /name="csrf" content="([^"]+)"/.exec(page)![1];
  return { base, cookie, csrf };
}

afterEach(() => {
  server?.close();
  server = undefined;
});
