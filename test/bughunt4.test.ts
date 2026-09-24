/**
 * Bug hunt 4 — the post-round-5 scan. One defect found:
 *
 *  N1  Removing the Gemini API key never returned the server to mock
 *      reading. `rebuildAdapters()` (server.ts) starts with
 *      `if (!key) return;`, and the /settings/gemini clear branch
 *      returns without rebuilding at all — so after a key is removed
 *      the STALE live Gemini adapters stay in place. Consequences in
 *      production:
 *        - the watcher keeps making live Gemini calls; with a dead key
 *          it FAILS CLOSED on every Green file (flagged: true) and the
 *          auto-reply silently stops for the whole intake — no error
 *          anywhere, because the UI and audit both claim "back to mock
 *          reading";
 *        - vision keeps burning the daily budget on a key that no
 *          longer works.
 *
 *  The test mirrors the real production sequence: the server BOOTS with
 *  a saved key (the boot-time rebuild activates the live adapters — the
 *  same object construction a successful "Test key" does), then an admin
 *  removes the key through the real settings route. After the removal the
 *  adapters must be the mock ones. RED before the fix, GREEN after.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { hashPassword } from "../src/util/password";
import { createApp } from "../src/web/server";
import { MockSender, type PipelineContext } from "../src/pipeline/adapters";
import { webLogin } from "./helpers";

let repo: Repo;
let server: ReturnType<ReturnType<typeof createApp>["listen"]> | undefined;
let base = "";
let ctx: PipelineContext;

beforeEach(() => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  repo.createStaff("admin", "System Administrator", hashPassword("admin123"), "admin");
});

afterEach(() => {
  server?.close();
  server = undefined;
});

async function startServer(): Promise<{ cookie: string; csrf: string }> {
  ctx = { repo, adapters: { vision: null as never, watcher: null as never, sender: new MockSender() } };
  const app = createApp({ repo, ctx });
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { cookie, csrf } = await webLogin(base, "admin", "admin123");
  return { cookie, csrf };
}

describe("N1 — removing the Gemini key must return the server to mock reading", () => {
  it("boot with a saved key activates the live adapters (pre-state)", async () => {
    repo.setSetting("gemini_api_key", "AIzaFAKE-KEY");
    await startServer();
    // Boot-time rebuild saw the saved key and built the live adapters —
    // exactly what a previously-verified key does in production.
    expect(ctx.adapters.vision.constructor.name).toBe("BudgetedVisionAdapter");
  });

  it("clearing the key restores mock vision + heuristic watcher (RED: stale Gemini stayed live)", async () => {
    repo.setSetting("gemini_api_key", "AIzaFAKE-KEY");
    const { cookie, csrf } = await startServer();
    expect(ctx.adapters.vision.constructor.name).toBe("BudgetedVisionAdapter");

    // Admin removes the key through the real settings route.
    const res = await fetch(`${base}/settings/gemini`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: `clear=1&_csrf=${encodeURIComponent(csrf)}`,
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(repo.getSetting("gemini_api_key", "")).toBe("");

    // The live adapters must be GONE. (Before the fix: the stale Gemini
    // vision + watcher are still live, contradicting the "back to mock
    // reading" message and audit line the same request produces.)
    expect(ctx.adapters.vision.constructor.name).toBe("MockVisionAdapter");

    // And the Green-safety watcher must be the deterministic heuristic one
    // again: it runs with no network and lets a clean file pass. With the
    // stale Gemini watcher still in place this returns source:"gemini",
    // flagged:true (fail-closed on the dead key) — which is exactly how a
    // removed key silently kills every auto-reply.
    const w = await ctx.adapters.watcher({
      applicantEmail: "jane.doe@example.org",
      subject: "My documents",
      docs: [
        {
          document_type: "academic_cert",
          extraction_method: "pdf_text",
          confidence: "high",
          name: "JANE DOE",
          textExcerpt: "Kenya Certificate of Secondary Education — certificate of achievement",
        },
      ],
    });
    expect(w.source).toBe("heuristic");
    expect(w.flagged).toBe(false);
  });
});
