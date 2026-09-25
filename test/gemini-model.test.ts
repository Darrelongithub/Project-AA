/**
 * Gemini model defaults (round 10) — the shipped default model died.
 *
 * Production reported: `404 Not Found — models/gemini-1.5-flash is not found
 * for API version v1beta`. The 1.5 generation has been removed from the
 * Gemini API, and since 2026-09-18 access to the 2.5 generation is limited to
 * users who actively used them in the past — so neither is a safe default
 * for a new project/key. The current GA Flash model is `gemini-3.8-flash`
 * (GA 2026-09-02). The model was ALWAYS configurable via the settings
 * field — what was broken is every DEFAULT that still says 1.5-flash:
 * fresh installs (empty field, env unset) still point at a dead model.
 */
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { hashPassword } from "../src/util/password";
import { createApp } from "../src/web/server";
import { MockSender, type PipelineContext } from "../src/pipeline/adapters";
import { DEFAULT_GEMINI_MODEL, DEAD_GEMINI_MODELS, GeminiVisionAdapter } from "../src/extraction/gemini";
import { GeminiWatcher } from "../src/watcher";
import { loadConfig } from "../src/config";
import { webLogin } from "./helpers";

describe("gemini model defaults", () => {
  it("the default model is the current GA flash model, not a dead one", () => {
    expect(DEFAULT_GEMINI_MODEL).toBe("gemini-3.8-flash");
    expect(DEAD_GEMINI_MODELS.has("gemini-1.5-flash")).toBe(true);
    expect(DEAD_GEMINI_MODELS.has(DEFAULT_GEMINI_MODEL)).toBe(false);
  });

  it("loadConfig() falls back to the current model when GEMINI_MODEL is unset", () => {
    const prev = process.env.GEMINI_MODEL;
    delete process.env.GEMINI_MODEL;
    try {
      expect(loadConfig().geminiModel).toBe(DEFAULT_GEMINI_MODEL);
    } finally {
      if (prev !== undefined) process.env.GEMINI_MODEL = prev;
    }
  });

  // The SDK stores the model as "models/<name>" — assert through that shape.
  it("the vision adapter constructed with only a key uses the current default", () => {
    const a = new GeminiVisionAdapter("AIzaFakeKeyForUnitTestsOnly");
    expect((a as unknown as { model: { model: string } }).model.model).toBe(`models/${DEFAULT_GEMINI_MODEL}`);
  });

  it("the watcher constructed with only a key uses the current default", () => {
    const w = new GeminiWatcher("AIzaFakeKeyForUnitTestsOnly");
    expect((w as unknown as { model: { model: string } }).model.model).toBe(`models/${DEFAULT_GEMINI_MODEL}`);
  });
});

describe("gemini model on the settings page", () => {
  let repo: Repo;
  let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
  let base = "";

  function boot(withStoredModel: boolean): string {
    repo = new Repo(openDb(":memory:"));
    seedDefaults(repo);
    repo.createStaff("admin", "Admin", hashPassword("admin123"), "admin");
    if (withStoredModel) repo.setSetting("gemini_model", "gemini-1.5-flash");
    const sender = new MockSender();
    const ctx: PipelineContext = { repo, adapters: { vision: null as never, watcher: null as never, sender } };
    const app = createApp({ repo, ctx });
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    return base;
  }

  afterEach(() => {
    server?.close();
  });

  it("pre-fills the CURRENT model when none is stored (no fresh install points at a dead model)", async () => {
    boot(false);
    const { cookie } = await webLogin(base, "admin", "admin123");
    const html = await (await fetch(`${base}/settings`, { headers: { cookie } })).text();
    expect(html).toContain(`name="gemini_model" value="gemini-3.8-flash"`);
    expect(html).not.toMatch(/no longer exists/i);
  });

  it("tells the admin plainly when the stored model is one Google has removed", async () => {
    boot(true);
    const { cookie } = await webLogin(base, "admin", "admin123");
    const html = await (await fetch(`${base}/settings`, { headers: { cookie } })).text();
    // The stored (dead) model is still shown in the field…
    expect(html).toContain(`name="gemini_model" value="gemini-1.5-flash"`);
    // …and the page says it is dead and names the current model.
    expect(html).toMatch(/no longer exists/i);
    expect(html).toContain("gemini-3.8-flash");
  });
});
