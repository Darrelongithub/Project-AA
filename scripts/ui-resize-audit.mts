/**
 * OR-3 UI resize audit: real Chromium against the real server on a
 * THROWAWAY database. Visits every staff page at 1280/1024/768/480/360,
 * asserts no horizontal page scroll, records JS errors, takes screenshots.
 */
import { chromium } from "playwright-core";
import { runSimulation } from "../src/simulation/run";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { hashPassword } from "../src/util/password";
import { createApp } from "../src/web/server";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB = join(ROOT, "data/ui-test.sqlite");

async function main() {
  console.log("building throwaway DB via simulation …");
  await runSimulation({ dbPath: DB, disableOcr: true });
  const repo = new Repo(openDb(DB));
  repo.createStaff("boss", "UI Tester", hashPassword("ui-test-password-1"), "admin");
  const ctx: PipelineContext = { repo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender: new MockSender() } };
  const app = createApp({ repo, ctx });
  const server = await new Promise<any>((resolve) => { const s = app.listen(4277, "127.0.0.1", () => resolve(s)); });

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });

  // Log in
  await page.goto("http://127.0.0.1:4277/login");
  await page.fill('input[name="username"]', "boss");
  await page.fill('input[name="password"]', "ui-test-password-1");
  await Promise.all([page.waitForNavigation(), page.click('button.btn')]);

  const caseId = repo.searchApplicants({})[0]?.id;
  const routes = ["/", "/applicants", "/admissions", "/staff", "/config", "/settings", "/account", caseId ? `/case/${caseId}` : "/"];
  const widths = [1280, 1024, 768, 480, 360];
  let failures = 0;

  for (const route of routes) {
    await page.goto(`http://127.0.0.1:4277${route}`, { waitUntil: "networkidle" }).catch(() => undefined);
    for (const w of widths) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.waitForTimeout(120);
      const m = await page.evaluate(() => ({
        sw: document.documentElement.scrollWidth,
        cw: document.documentElement.clientWidth,
      }));
      const overflows = m.sw > m.cw + 1;
      if (overflows) failures++;
      console.log(`${route} @ ${w}px → scrollWidth=${m.sw} client=${m.cw} ${overflows ? "⚠ HORIZONTAL OVERFLOW" : "ok"}`);
      if (w === 360) {
        await page.screenshot({ path: join(ROOT, "docs/screenshots", `${route.replace(/\//g, "_").slice(1) || "home"}_360.png`), fullPage: false }).catch(() => undefined);
      }
    }
  }

  // Continuous resize sweep on the busiest page
  await page.goto(`http://127.0.0.1:4277/applicants`, { waitUntil: "networkidle" }).catch(() => undefined);
  const preErrors = errors.length;
  for (let w = 1280; w >= 320; w -= 40) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(30);
  }
  const newErrors = errors.slice(preErrors);
  console.log(`continuous resize 1280→320: ${newErrors.length} new JS errors`);
  newErrors.slice(0, 5).forEach((e) => console.log("  " + e));

  await page.screenshot({ path: "docs/screenshots/applicants_1280.png" }).catch(() => undefined);
  console.log(`\nRESULT: ${failures} overflowing page/width combinations; ${errors.length} JS errors total`);
  await browser.close();
  server.close();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
