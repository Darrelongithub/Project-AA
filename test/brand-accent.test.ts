/**
 * Brand accent — the default accent is refined purple (#9a78c7), not red/gold.
 *
 * History: older organization themes used red/pink/gold defaults. Those legacy
 * pairs still migrate, while the current presentation palette resolves to purple
 * and lavender for both dark and light modes.
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

describe("brand accent: purple, not red/gold", () => {
  it("organizations still on the pink default migrate to the purple accent", () => {
    const repo = new Repo(openDb(":memory:"));
    seedDefaults(repo);
    repo.createOrganization({ name: "Example Service Cooperative", refPrefix: "ORG" });
    // A database created before the change stores the pink default pair.
    repo.db.prepare("UPDATE organizations SET theme = ? WHERE id = 1")
      .run(JSON.stringify({ primary: "#650019", accent: "#e18b9a" }));
    const theme = organizationTheme(repo, 1);
    expect(theme.primary.toLowerCase()).toBe("#3b1d5f");
    expect(theme.accent.toLowerCase()).toBe("#9a78c7");
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

  it("new organizations default to purple, and the light theme deepens it for paper", async () => {
    const repo = new Repo(openDb(":memory:"));
    seedDefaults(repo);
    repo.createOrganization({ name: "Example Service Cooperative", refPrefix: "ORG" });
    expect(organizationTheme(repo, 1).accent.toLowerCase()).toBe("#9a78c7");

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
      expect(home).toContain("--plum-mid:#9a78c7");
      // …and the light theme gets the deepened plum (#4d3c64 = purple × 0.5).
      expect(home).toContain('[data-theme="light"]{--plum-mid:#4d3c64');
      // No trace of the pink default anywhere in the page's brand overrides.
      expect(home).not.toContain("#e18b9a");
    } finally {
      server?.close();
    }
  });
});
