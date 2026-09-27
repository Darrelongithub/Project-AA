/**
 * PPR P0-5 acceptance: attachment sets replace the hardcoded packs, and the
 * transfer-pack send hole (E3) is structurally closed.
 *  - a NEW organization defines its own attachment set from uploaded files
 *    through the real admin routes, sends it, and the outgoing mail carries
 *    exactly those files — none of the migrated education profile's ten
 *    bundled documents appear;
 *  - E3: there is no privileged pack channel — a template cannot name a set
 *    the organization does not own (`upsertTemplate` refuses it), another
 *    organization's sets never resolve, and the old "transfer" vocabulary is
 *    just a set name like any other;
 *  - the migrated education profile's seeded sets reproduce its own legacy
 *    packs file-for-file, so every existing send keeps its documents.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { applicationPack, admissionPack } from "../src/pack";
import { createApp } from "../src/web/server";
import { hashPassword } from "../src/util/password";
import { webLogin } from "./helpers";
import { processEmail } from "../src/pipeline";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";
import type { IncomingEmail } from "../src/types";

/** A minimal but valid PDF payload for upload routes. */
function fakePdf(tag: string): Buffer {
  const body = `%PDF-1.4\n% ${tag}\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`;
  return Buffer.concat([Buffer.from(body), Buffer.alloc(600, 0x20)]);
}

function fresh(): Repo {
  const repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  return repo;
}

describe("PPR P0-5: attachment sets replace hardcoded packs (E3 closed)", () => {
  let repo: Repo;
  let ctx: PipelineContext;
  let sender: MockSender;
  let server: Server | undefined;
  let base = "";
  let auth: { cookie: string; csrf: string };

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
    sender = new MockSender();
    ctx = { repo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender } };
    const app = createApp({ repo, ctx });
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    base = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
    const login = await webLogin(base, "admin", "admin123");
    expect(login.status).toBe(302);
    auth = { cookie: login.cookie, csrf: login.csrf };
  });

  afterAll(() => server?.close());

  it("a new organization defines its own set from uploaded files and sends it — zero Riara files", async () => {
    // ── real admin routes: new organization + non-academic profile ─────
    expect((await post("/config/organizations/create", { name: "Greenfield College", ref_prefix: "GC" })).status).toBe(302);
    const org = repo.listOrganizations().find((o) => o.name === "Greenfield College")!;
    expect((await post("/config/case-types/create", {
      organization_id: String(org.id), code: "ENQ", name: "Enquiry", category: "general",
    })).status).toBe(302);
    const enq = repo.getCaseType("ENQ", org.id)!;

    // ── the set is defined from THIS organization's uploads ───────────
    expect((await post("/config/attachment-sets/create", {
      organization_id: String(org.id), name: "Enquiry pack", description: "Handbook + map for enquirers",
    })).status).toBe(302);
    const set = repo.attachmentSetByName(org.id, "Enquiry pack")!;
    expect(set).toBeTruthy();
    for (const filename of ["greenfield-handbook.pdf", "greenfield-campus-map.pdf"]) {
      const res = await fetch(`${base}/config/attachment-sets/upload?set=${set.id}&filename=${encodeURIComponent(filename)}`, {
        method: "POST",
        headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf, "content-type": "application/pdf" },
        body: fakePdf(filename),
      });
      expect(res.status).toBe(200);
    }
    // The management UI shows the organization's own set and its files:
    repo.db.prepare("UPDATE staff_users SET organization_id = ? WHERE username = 'admin'").run(org.id);
    const packTab = await (await fetch(`${base}/config?tab=pack`, { headers: { cookie: auth.cookie } })).text();
    expect(packTab).toMatch(/Enquiry pack/);
    expect(packTab).toMatch(/greenfield-handbook\.pdf/);
    expect(packTab).toMatch(/greenfield-campus-map\.pdf/);

    // ── the profile's first-email rule opens cases (rules as data) ────
    expect((await post("/config/workflow-rules/save", {
      name: "Information requests open a case",
      kind: "intake", case_type_id: String(enq.id), position: "0",
      cond_field_0: "text", cond_value_0: "information, programme, programmes",
      decision: "create", audit_code: "rule_enq_intake", fallback: "human_draft",
    })).status).toBe(302);

    // ── a template names the set; a real send carries exactly those files ──
    expect((await post("/templates/save", {
      key: "enq_reply", name: "Enquiry reply", subject: "Our information", body: "Hello {name},\n\nHere is our information.\n\nRegards,\n{institution}",
      attach_pack: "Enquiry pack",
    })).status).toBe(302);
    // (the save route only edits known template keys — create the org's own)
    repo.upsertTemplate("enq_reply", "Enquiry reply", "Our information", "Hello {name},\n\nHere is our information.", true, "Enquiry pack", org.id);
    repo.updateCaseTypeProfile(enq.id, { default_reply_action: "auto", qualification_gate: 0 });
    expect((await post("/config/workflow-rules/save", {
      name: "Enquiries get the handbook",
      kind: "response", case_type_id: String(enq.id), position: "0",
      cond_field_0: "always", cond_value_0: "true",
      reply_action: "send", template_key: "enq_reply", attachment_set: "Enquiry pack",
      audit_code: "rule_enq_pack", fallback: "human_draft",
    })).status).toBe(302);

    sender.sent.length = 0;
    const result = await processEmail({
      id: "as-1", threadId: "as-t1", from: "curious@example.test",
      subject: "Please send information about Greenfield College",
      body: "I would like to know more about your programmes.",
      receivedAt: new Date().toISOString(), attachments: [],
      organizationId: org.id, caseTypeCode: "ENQ",
    } as IncomingEmail, ctx);
    expect(result.skipped).not.toBe(true);
    expect(sender.sent.length).toBe(1);
    expect(sender.sent[0].attachments.sort()).toEqual(["greenfield-campus-map.pdf", "greenfield-handbook.pdf"]);
    // THE invariant: none of the migrated education profile's bundled files.
    const bundled = [...applicationPack().files, ...admissionPack().files].map((f) => f.filename);
    for (const name of sender.sent[0].attachments) expect(bundled).not.toContain(name);

    // Put the admin back on the migrated tenant for the later tests.
    repo.db.prepare("UPDATE staff_users SET organization_id = 1 WHERE username = 'admin'").run();
  });

  it("E3: no privileged pack channel exists any more", async () => {
    // (a) A template cannot name a set the organization does not own —
    //     validation lives in the repo, not just one route. “transfer” is no
    //     privileged vocabulary: org 1 owns an ordinary set by that name
    //     (its migrated credit-transfer form), and other orgs can't borrow it.
    expect(() => repo.upsertTemplate("evil", "Evil", "S", "B", true, "no_such_set", 1)).toThrow(/Unknown attachment set/);
    expect(repo.attachmentSetByName(1, "transfer")).toBeTruthy();
    const transfer = repo.attachmentSetFiles(1, "transfer");
    expect(transfer.files.map((f) => f.filename)).toEqual(["Credit transfer form.pdf"]);

    // (b) Another organization's sets never resolve — org 2 cannot attach
    //     the migrated "admission" or "transfer" sets to its mail.
    const org2 = repo.listOrganizations().find((o) => o.name === "Greenfield College")!;
    expect(() => repo.upsertTemplate("evil2", "Evil", "S", "B", true, "transfer", org2.id)).toThrow(/Unknown attachment set/);
    const foreign = repo.attachmentSetFiles(org2.id, "admission");
    expect(foreign.files).toEqual([]);
    expect(foreign.issues.join(" ")).toMatch(/does not exist/);

    // (c) The save route refuses an unknown set and keeps the template as it was.
    repo.upsertTemplate("legit", "Legit", "S", "B", true, "none", org2.id);
    // move admin to org 2 so the route edits that org's templates
    repo.db.prepare("UPDATE staff_users SET organization_id = ? WHERE username = 'admin'").run(org2.id);
    const res = await post("/templates/save", {
      key: "legit", name: "Legit", subject: "S", body: "B", attach_pack: "transfer",
    });
    expect(res.status).toBe(302);
    // The refusal is explained in the redirect message and nothing changed:
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toMatch(/Unknown attachment set/);
    expect(repo.getTemplate("legit", org2.id)!.attach_pack).toBe("none");
  });

  afterEach(() => {
    // Tests must not leak the session's organization into later ones.
    repo.db.prepare("UPDATE staff_users SET organization_id = 1 WHERE username = 'admin'").run();
  });

  it("the migrated education profile's sets reproduce its legacy packs file-for-file", () => {
    const app = repo.attachmentSetFiles(1, "application");
    const legacyApp = applicationPack().files.map((f) => f.filename).sort();
    expect(app.files.map((f) => f.filename).sort()).toEqual(legacyApp);
    const adm = repo.attachmentSetFiles(1, "admission");
    const legacyAdm = admissionPack().files.map((f) => f.filename).sort();
    expect(adm.files.map((f) => f.filename).sort()).toEqual(legacyAdm);
    // Byte-for-byte, not just by name:
    for (const [i, f] of adm.files.entries()) {
      const legacy = admissionPack().files.find((x) => x.filename === f.filename)!;
      expect(f.content.equals(legacy.content)).toBe(true);
      void i;
    }
  });

  it("an education send still carries its configured documents (the sets ride along)", async () => {
    sender.sent.length = 0;
    const email: IncomingEmail = {
      id: "as-2", threadId: "as-t2", from: "pupil@example.test",
      subject: "Application for BCS admission",
      body: "I am applying for the BCS programme this September 2026 intake. What documents do you need?",
      receivedAt: new Date().toISOString(), attachments: [],
    };
    const result = await processEmail(email, ctx);
    expect(result.skipped).not.toBe(true);
    // The seeded chase template (docs_request → application set) is HELD for
    // staff under the qualification gate — prepared as a queued draft that
    // names the same application-set files when sent.
    const held = repo.queuedOutbox(result.applicantId!);
    expect(held).toBeTruthy();
    const sent = repo.attachmentSetFiles(1, "application").files.map((f) => f.filename).sort();
    expect(sent.length).toBeGreaterThan(0);
    // Manual template send through the real route attaches the set:
    const res = await post(`/case/${result.applicantId}/send`, {
      template: "docs_request", subject: "Documents needed", body: "Please send the documents.",
    });
    expect(res.status).toBe(302);
    expect(sender.sent.length).toBe(1);
    expect(sender.sent[0].attachments.sort()).toEqual(sent);
  });
});
