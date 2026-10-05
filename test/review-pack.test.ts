/**
 * Review-round fixes — outgoing mail must RECORD what was attached, and the
 * case page must show it. Held drafts honour the attachment set their template
 * promises. RED-first acceptance for the "I never saw the price list or the
 * data-protection form" finding.
 *
 * Nothing ships bundled: the files that ride along are the organization's OWN
 * attachment set, named by one of its own templates.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { hashPassword } from "../src/util/password";
import { createApp } from "../src/web/server";
import type { PipelineContext } from "../src/pipeline/adapters";
import { MockSender } from "../src/pipeline/adapters";
import type { ApplicantRow } from "../src/types";
import { webLogin, configureTestOrganization } from "./helpers";

const SET_FILES = ["price-list.pdf", "data-protection-form.pdf", "service-guide.pdf"];

describe("outgoing mail records its attachments", () => {
  let repo: Repo;
  let sender: MockSender;
  let server: ReturnType<ReturnType<typeof createApp>["listen"]>;

  beforeEach(() => {
    repo = new Repo(openDb(":memory:"));
    seedDefaults(repo);
    configureTestOrganization(repo);
    repo.createStaff("admin", "System Administrator", hashPassword("admin123"), "admin");
    sender = new MockSender(true);
  });
  afterEach(() => { server?.close(); });

  async function startServer(): Promise<{ base: string; cookie: string; csrf: string }> {
    const ctx: PipelineContext = { repo, adapters: { vision: null as never, watcher: null as never, sender } };
    const app = createApp({ repo, ctx });
    server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const { cookie, csrf } = await webLogin(base, "admin", "admin123");
    return { base, cookie, csrf };
  }

  function mkCase(): ApplicantRow {
    const a = repo.createCase({
      emailAddress: `pack-${Math.random().toString(36).slice(2)}@example.org`,
      threadId: `t-${Math.random()}`,
      organizationId: 1,
      fullName: "Wanjiku Kamau",
      caseTypeCode: "SERVICE_REQUEST",
    });
    return repo.getApplicant(a.id)!;
  }

  /** The organization uploads its own sendable files and names the set. */
  function welcomeSet(): string {
    const set = repo.createAttachmentSet(1, "Welcome pack");
    for (const filename of SET_FILES) {
      repo.addAttachmentSetFile(set.id, { filename, content: Buffer.from(`%PDF-1.4\n${filename}\n`) });
    }
    return set.name;
  }

  /** Point a seeded template at the organization's set. */
  function attachSetTo(key: string, setName: string): void {
    const t = repo.getTemplate(key, 1)!;
    repo.upsertTemplate(t.key, t.name, t.subject, t.body, t.include_banner === 1, setName, 1);
  }

  it("send-pack records every attached file and the case page shows them", async () => {
    const a = mkCase();
    welcomeSet();
    const { base, cookie, csrf } = await startServer();
    const res = await fetch(`${base}/case/${a.id}/send-pack`, {
      method: "POST", redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${encodeURIComponent(csrf)}&kind=${encodeURIComponent("Welcome pack")}`,
    });
    expect(res.status).toBe(302);
    expect(sender.sent.length).toBe(1);
    expect([...sender.sent[0].attachments].sort()).toEqual([...SET_FILES].sort());

    const out = repo.emailsForApplicant(a.id).find((e) => e.direction === "out")!;
    const attached = JSON.parse(out.attachments || "[]") as string[];
    expect(attached.sort()).toEqual([...SET_FILES].sort());

    const page = await (await fetch(`${base}/case/${a.id}`, { headers: { cookie } })).text();
    expect(page).toMatch(/price-list\.pdf/i);
    expect(page).toMatch(/data-protection-form\.pdf/i);
  });

  it("an unknown attachment set is refused loudly and sends nothing", async () => {
    const a = mkCase();
    const { base, cookie, csrf } = await startServer();
    const res = await fetch(`${base}/case/${a.id}/send-pack`, {
      method: "POST", redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${encodeURIComponent(csrf)}&kind=${encodeURIComponent("Not our set")}`,
    });
    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toContain("Unknown attachment set");
    expect(sender.sent.length).toBe(0);
    expect(repo.emailsForApplicant(a.id).filter((e) => e.direction === "out").length).toBe(0);
  });

  it("a held draft approved by staff carries its template's attachment set", async () => {
    const a = mkCase();
    attachSetTo("docs_request", welcomeSet());
    // The pipeline held an information request (evidence gate) — the outbox row
    // remembers WHICH template rendered it.
    repo.addOutbox({
      applicant_id: a.id, to_address: a.email_address,
      subject: `[${a.ref_number}] What we need from you`,
      body: "Please send the documents listed.", mode: "queued", template_key: "docs_request",
    });
    const { base, cookie, csrf } = await startServer();
    const res = await fetch(`${base}/case/${a.id}/draft`, {
      method: "POST", redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${encodeURIComponent(csrf)}&decision=send`,
    });
    expect(res.status).toBe(302);
    expect(sender.sent.length).toBe(1);
    expect([...sender.sent[0].attachments].sort()).toEqual([...SET_FILES].sort());
    const out = repo.emailsForApplicant(a.id).find((e) => e.direction === "out")!;
    const attached = JSON.parse(out.attachments || "[]") as string[];
    expect(attached.sort()).toEqual([...SET_FILES].sort());
    const page = await (await fetch(`${base}/case/${a.id}`, { headers: { cookie } })).text();
    expect(page).toMatch(/service-guide\.pdf/i);
  });

  it("manual template sends record their attachment set too", async () => {
    const a = mkCase();
    attachSetTo("ack_received", welcomeSet());
    const { base, cookie, csrf } = await startServer();
    const res = await fetch(`${base}/case/${a.id}/send`, {
      method: "POST", redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${encodeURIComponent(csrf)}&template=ack_received`,
    });
    expect(res.status).toBe(302);
    const out = repo.emailsForApplicant(a.id).find((e) => e.direction === "out")!;
    const attached = JSON.parse(out.attachments || "[]") as string[];
    expect(attached.sort()).toEqual([...SET_FILES].sort());
  });
});
