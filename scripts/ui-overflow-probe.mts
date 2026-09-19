import { chromium } from "playwright-core";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { createApp } from "../src/web/server";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";

async function main() {
  const repo = new Repo(openDb("../data/ui-test.sqlite"));
  const ctx: PipelineContext = { repo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender: new MockSender() } };
  const app = createApp({ repo, ctx });
  const server = await new Promise<any>((resolve) => { const s = app.listen(4277, "127.0.0.1", () => resolve(s)); });
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  await page.goto("http://127.0.0.1:4277/login");
  await page.fill('input[name="username"]', "boss");
  await page.fill('input[name="password"]', "ui-test-password-1");
  await Promise.all([page.waitForNavigation(), page.click('button.btn')]);

  const cases: Array<[string, number]> = [["/", 360], ["/applicants", 1024], ["/applicants", 360], ["/case/26", 480]];
  for (const [route, width] of cases) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`http://127.0.0.1:4277${route}`, { waitUntil: "networkidle" }).catch(() => {});
    const worst = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const out: string[] = [];
      document.querySelectorAll<HTMLElement>("*").forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width > vw + 1 && r.width < 5000) {
          const cls = (el.className && typeof el.className === "string" ? el.className : "").slice(0, 60);
          out.push(`${el.tagName.toLowerCase()}.${cls} → ${Math.round(r.width)}px`);
        }
      });
      return out.slice(0, 8);
    });
    console.log(`\n${route} @ ${width}px:`);
    worst.forEach((w) => console.log("  " + w));
  }
  await browser.close();
  server.close();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
