/**
 * Document pack management (round 11) — "view and change the template PDF pack".
 *
 * The 10 official pack PDFs (application form, brochure, fee structure, …)
 * could only be replaced via an unreachable route and viewed via /pack/:key
 * links staff never saw. Settings now carries a "Document pack" card:
 * every slot with its purpose, current file size, an in-page PDF preview,
 * and an admin-only replace form per slot.
 */
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { hashPassword } from "../src/util/password";
import { createApp } from "../src/web/server";
import { MockSender, type PipelineContext } from "../src/pipeline/adapters";
import { PACK_SLOTS } from "../src/pack";
import { webLogin } from "./helpers";

let repo: Repo;
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let base = "";

function boot() {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  repo.createStaff("admin", "Pack Admin", hashPassword("admin123"), "admin");
  repo.createStaff("off1", "Pack Officer", hashPassword("officer123"), "user");
  const sender = new MockSender();
  const ctx: PipelineContext = { repo, adapters: { vision: null as never, watcher: null as never, sender } };
  server = createApp({ repo, ctx }).listen(0);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

afterEach(() => server?.close());

describe("the Document pack tab (its own home on /config)", () => {
  it("an admin sees every pack slot with purpose, preview link and replace control", async () => {
    boot();
    const { cookie } = await webLogin(base, "admin", "admin123");
    const html = await (await fetch(`${base}/config?tab=pack`, { headers: { cookie } })).text();
    expect(html).toMatch(/Document pack/);
    expect(html).toMatch(/Documents &amp; application packs/i);
    for (const slot of PACK_SLOTS) {
      expect(html).toContain(slot.pretty);
      expect(html).toContain(slot.purpose);
      expect(html).toContain(`/pack/${slot.key}`); // open/preview
      expect(html).toContain(`data-pack-slot="${slot.key}"`); // replace control
    }
    // The tab bar offers the pack home…
    expect(html).toContain('/config?tab=pack');
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
