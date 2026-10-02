/**
 * Brand accent — the default accent is antique gold (#c89a4a), not pink.
 *
 * History: the seeded/default organization theme carried a pink accent
 * (#e18b9a), which the layout maps onto --wine-mid/--wine-soft — headings,
 * links, kickers and highlight borders all rendered pink, and washed out
 * (near-invisible pale pink) on light paper. The default is now antique gold
 * (garnet & gold), organizations still carrying the pink default migrate
 * automatically, and the layout deepens light accents for the light theme so
 * they stay readable on paper.
 */
import { describe, expect, it } from "vitest";
import type { Server } from "http";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { createApp } from "../src/web/server";
import { organizationTheme } from "../src/branding";
import { hashPassword } from "../src/util/password";
import { webLogin } from "./helpers";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";

describe("brand accent: antique gold, not pink", () => {
  it("organizations still on the pink default migrate to the gold accent", () => {
    const repo = new Repo(openDb(":memory:"));
    seedDefaults(repo);
    repo.createOrganization({ name: "Example Service Cooperative", refPrefix: "ORG" });
    // A database created before the change stores the pink default pair.
    repo.db.prepare("UPDATE organizations SET theme = ? WHERE id = 1")
      .run(JSON.stringify({ primary: "#650019", accent: "#e18b9a" }));
    const theme = organizationTheme(repo, 1);
    expect(theme.primary.toLowerCase()).toBe("#650019");
    expect(theme.accent.toLowerCase()).toBe("#c89a4a");
  });

  it("a deliberately customized theme is never overwritten", () => {
    const repo = new Repo(openDb(":memory:"));
    seedDefaults(repo);
    repo.createOrganization({ name: "Example Service Cooperative", refPrefix: "ORG" });
    repo.db.prepare("UPDATE organizations SET theme = ? WHERE id = 1")
      .run(JSON.stringify({ primary: "#123456", accent: "#654321" }));
    const theme = organizationTheme(repo, 1);
    expect(theme.primary.toLowerCase()).toBe("#123456");
    expect(theme.accent.toLowerCase()).toBe("#654321");
  });

  it("new organizations default to gold, and the light theme deepens it for paper", async () => {
    const repo = new Repo(openDb(":memory:"));
    seedDefaults(repo);
    repo.createOrganization({ name: "Example Service Cooperative", refPrefix: "ORG" });
    expect(organizationTheme(repo, 1).accent.toLowerCase()).toBe("#c89a4a");

    repo.createStaff("admin", "Administrator", hashPassword("admin123"), "admin");
    const sender = new MockSender();
    const ctx: PipelineContext = { repo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender } };
    const app = createApp({ repo, ctx });
    let server: Server | undefined;
    await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
    try {
      const base = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
      const login = await webLogin(base, "admin", "admin123");
      expect(login.status).toBe(302);
      const home = await (await fetch(`${base}/`, { headers: { cookie: login.cookie } })).text();
      // The dark shell carries the accent as-is…
      expect(home).toContain("--wine-mid:#c89a4a");
      // …and the light theme gets the deepened bronze (#644d25 = gold × 0.5).
      expect(home).toContain('[data-theme="light"]{--wine-mid:#644d25');
      // No trace of the pink default anywhere in the page's brand overrides.
      expect(home).not.toContain("#e18b9a");
    } finally {
      server?.close();
    }
  });
});
