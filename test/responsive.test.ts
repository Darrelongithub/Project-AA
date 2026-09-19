/**
 * OR-3 — responsive regression: no horizontal page scroll at any common
 * width, on every staff page, verified in REAL Chromium (playwright-core).
 * Skips with a clear reason when no browser binary is installed
 * (`npx playwright install chromium-headless-shell` + system libs).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import { chromium, type Browser, type Page } from "playwright-core";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { hashPassword } from "../src/util/password";
import { createApp } from "../src/web/server";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";

let server: Server;
let base = "";
let browser: Browser | null = null;
let page: Page | null = null;
let launchError = "";

beforeAll(async () => {
  const repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  repo.createStaff("boss", "Responsive Tester", hashPassword("responsive-pass-1"), "admin");
  // One applicant so list/case pages render real table content.
  const a = repo.getOrCreateApplicant("resp@example.com", "t-resp");
  repo.updateApplicant(a.id, { programme: "BBIT", full_name: "Responsive Test" });
  const ctx: PipelineContext = {
    repo,
    adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender: new MockSender() },
  };
  const app = createApp({ repo, ctx });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  try {
    browser = await chromium.launch();
    page = await (await browser.newContext()).newPage();
    await page.goto(`${base}/login`);
    await page.fill('input[name="username"]', "boss");
    await page.fill('input[name="password"]', "responsive-pass-1");
    await Promise.all([page.waitForNavigation(), page.click('button.btn')]);
  } catch (e) {
    launchError = (e as Error).message.split("\n")[0];
    browser = null;
    page = null;
  }
}, 60_000);

afterAll(async () => {
  await browser?.close();
  server?.close();
});

describe("OR-3: responsive layout", () => {
  it("no horizontal page scroll on any staff page at 1280/1024/768/480/360", async (t) => {
    if (!page) {
      t.skip(`Chromium unavailable: ${launchError}`);
      return;
    }
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const routes = ["/", "/applicants", "/admissions", "/staff", "/config", "/settings", "/account", "/case/1"];
    const widths = [1280, 1024, 768, 480, 360];
    const bad: string[] = [];
    for (const route of routes) {
      await page.goto(`${base}${route}`, { waitUntil: "networkidle" }).catch(() => undefined);
      for (const w of widths) {
        await page.setViewportSize({ width: w, height: 900 });
        await page.waitForTimeout(80);
        const m = await page.evaluate(() => ({
          sw: document.documentElement.scrollWidth,
          cw: document.documentElement.clientWidth,
        }));
        if (m.sw > m.cw + 1) bad.push(`${route}@${w}px (${m.sw}>${m.cw})`);
      }
    }
    expect(bad).toEqual([]);
    expect(errors).toEqual([]);
  }, 120_000);
});
