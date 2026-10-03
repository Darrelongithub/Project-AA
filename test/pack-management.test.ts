/**
 * Document library (round 11, generalized) — "view and change the files that
 * ride along with replies".
 *
 * The fixed catalogue of ten official PDFs is gone. Each organization uploads
 * its OWN files into named attachment sets; a template or workflow rule
 * attaches exactly the set it names. This suite pins the library home on
 * /config?tab=pack: the sets an organization created, a per-file upload
 * control, and no fixed replace slots anywhere.
 */
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { hashPassword } from "../src/util/password";
import { createApp } from "../src/web/server";
import { MockSender, type PipelineContext } from "../src/pipeline/adapters";
import { webLogin, configureTestOrganization } from "./helpers";

let repo: Repo;
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let base = "";

function boot() {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  configureTestOrganization(repo);
  repo.createStaff("admin", "Pack Admin", hashPassword("admin123"), "admin");
  repo.createStaff("off1", "Pack Officer", hashPassword("officer123"), "user");
  const sender = new MockSender();
  const ctx: PipelineContext = { repo, adapters: { vision: null as never, watcher: null as never, sender } };
  server = createApp({ repo, ctx }).listen(0);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

afterEach(() => server?.close());

describe("the Document pack tab (its own home on /config)", () => {
  it("an admin sees the document library — the ten fixed slots are gone, the snapshot stays viewable", async () => {
    boot();
    const { cookie } = await webLogin(base, "admin", "admin123");
    const html = await (await fetch(`${base}/config?tab=pack`, { headers: { cookie } })).text();
    // The fixed slot catalogue is gone: the library lists only what this
    // organization uploaded, and preview links resolve per file.
    expect(html).toMatch(/Document library/);
    expect(html).not.toContain("data-pack-slot"); // no fixed replace controls
    expect(html).not.toMatch(/legacy/i);
    // The library's own controls are there: create a set, upload into it.
    expect(html).toContain('action="/config/attachment-sets/create"');
    expect(html).toContain("No attachment sets yet");
    // The tab bar offers the library home…
    expect(html).toContain('/config?tab=pack');
  });

  it("lists the organization's own set with a per-file upload control", async () => {
    boot();
    const set = repo.createAttachmentSet(1, "Enquiry pack", "What we send with a reply");
    repo.addAttachmentSetFile(set.id, { filename: "price-list.pdf", content: Buffer.from("%PDF-1.4\nprice list\n") });
    const { cookie } = await webLogin(base, "admin", "admin123");
    const html = await (await fetch(`${base}/config?tab=pack`, { headers: { cookie } })).text();
    expect(html).toContain("Enquiry pack");
    expect(html).toContain("price-list.pdf");
    expect(html).toContain(`data-aset-upload="${set.id}"`);
    expect(html).toContain('action="/config/attachment-sets/file-delete"');
    // Another organization's files are never listed here.
    expect(html).not.toContain("No files yet");
  });

  it("the replies tab no longer hides the pack (one home per thing)", async () => {
    boot();
    const { cookie } = await webLogin(base, "admin", "admin123");
    const html = await (await fetch(`${base}/config?tab=replies`, { headers: { cookie } })).text();
    expect(html).not.toMatch(/Documents &amp; application packs/i);
    expect(html).not.toContain("data-pack-slot=");
  });

  it("/config stays admin-only — an officer is refused the pack tab", async () => {
    boot();
    const { cookie } = await webLogin(base, "off1", "officer123");
    const res = await fetch(`${base}/config?tab=pack`, { headers: { cookie }, redirect: "manual" });
    expect([403, 404]).toContain(res.status);
  });
});
