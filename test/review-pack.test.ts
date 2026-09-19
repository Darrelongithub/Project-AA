/**
 * Review-round fixes — outgoing mail must RECORD what was attached, and the
 * case page must show it. Held drafts honour the pack their template
 * promises. RED-first acceptance for the "I never saw the hostels list or
 * data-protection form" finding.
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
import { webLogin } from "./helpers";

describe("outgoing mail records its attachments", () => {
  let repo: Repo;
  let sender: MockSender;
  let server: ReturnType<ReturnType<typeof createApp>["listen"]>;

  beforeEach(() => {
    repo = new Repo(openDb(":memory:"));
    seedDefaults(repo);
    repo.createStaff("admin", "System Administrator", hashPassword("admin123"), "admin");
    sender = new MockSender();
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

  function mkApplicant(): ApplicantRow {
    const a = repo.getOrCreateApplicant(`pack-${Math.random().toString(36).slice(2)}@example.org`, `t-${Math.random()}`);
    repo.updateApplicant(a.id, { full_name: "Wanjiku Kamau" });
    return repo.getApplicant(a.id)!;
  }

  it("send-pack records every attached file and the case page shows them", async () => {
    const a = mkApplicant();
    const { base, cookie, csrf } = await startServer();
    const res = await fetch(`${base}/case/${a.id}/send-pack`, {
      method: "POST", redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${encodeURIComponent(csrf)}&kind=admission`,
    });
    expect(res.status).toBe(302);
    expect(sender.sent.length).toBe(1);
    expect(sender.sent[0].attachments.length).toBe(7); // the FULL admission pack

    const out = repo.emailsForApplicant(a.id).find((e) => e.direction === "out")!;
    const attached = JSON.parse(out.attachments || "[]") as string[];
    expect(attached.length).toBe(7);
    expect(attached.some((f) => /hostels/i.test(f))).toBe(true);
    expect(attached.some((f) => /data protection/i.test(f))).toBe(true);

    const page = await (await fetch(`${base}/case/${a.id}`, { headers: { cookie } })).text();
    expect(page).toMatch(/Hostels/i);
    expect(page).toMatch(/Data Protection/i);
  });

  it("a held draft approved by staff carries its template's pack", async () => {
    const a = mkApplicant();
    // The pipeline held a docs-request reply (qualification gate) — the
    // outbox row remembers WHICH template rendered it.
    repo.addOutbox({
      applicant_id: a.id, to_address: a.email_address,
      subject: `[${a.ref_number}] Your application: the documents we need from you`,
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
    // application pack = form + brochure — and the history says so
    expect(sender.sent[0].attachments.length).toBe(2);
    const out = repo.emailsForApplicant(a.id).find((e) => e.direction === "out")!;
    const attached = JSON.parse(out.attachments || "[]") as string[];
    expect(attached.length).toBe(2);
    const page = await (await fetch(`${base}/case/${a.id}`, { headers: { cookie } })).text();
    expect(page).toMatch(/Application Form/i);
    expect(page).toMatch(/Brochure/i);
  });

  it("manual template sends record their pack too", async () => {
    const a = mkApplicant();
    const { base, cookie, csrf } = await startServer();
    const res = await fetch(`${base}/case/${a.id}/send`, {
      method: "POST", redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${encodeURIComponent(csrf)}&template=admission_letter`,
    });
    expect(res.status).toBe(302);
    const out = repo.emailsForApplicant(a.id).find((e) => e.direction === "out")!;
    const attached = JSON.parse(out.attachments || "[]") as string[];
    expect(attached.length).toBe(7);
  });
});

