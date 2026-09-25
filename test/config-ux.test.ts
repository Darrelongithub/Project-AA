/**
 * Requirements builder UX (round 9) — plain words, no jargon.
 *
 * The reported gripe: "what is add top level group??" The builder used to
 * greet the admin with "+ Top-level condition" / "+ Top-level group" and an
 * empty state full of insider language. Now it explains in plain words what
 * a requirement is, what an either/or group is, and how the whole list is
 * read. The underlying forms (node-add kind=condition / kind=group) are
 * unchanged — only the words changed.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { hashPassword } from "../src/util/password";
import { createApp } from "../src/web/server";
import type { PipelineContext } from "../src/pipeline/adapters";
import { MockSender } from "../src/pipeline/adapters";
import { webLogin } from "./helpers";

let repo: Repo;
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let base = "";
let admin: { cookie: string; csrf: string };

beforeEach(() => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  repo.createStaff("admin", "Config Admin", hashPassword("admin123"), "admin");
  const sender = new MockSender();
  const ctx: PipelineContext = { repo, adapters: { vision: null as never, watcher: null as never, sender } };
  const app = createApp({ repo, ctx });
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(() => {
  server?.close();
});

async function configPage(): Promise<string> {
  return (await fetch(`${base}/config?tab=requirements`, { headers: { cookie: admin.cookie } })).text();
}

async function addNode(kind: "condition" | "group"): Promise<number> {
  const body = new URLSearchParams({
    _csrf: admin.csrf,
    target: "BASE:degree",
    system: "KCSE",
    kind,
  });
  const res = await fetch(`${base}/config/requirements/node-add`, {
    method: "POST",
    headers: { cookie: admin.cookie, "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    redirect: "manual",
  });
  return res.status;
}

describe("requirements builder — usable by a human", () => {
  it("says 'Add a requirement', explains either/or, and drops the 'top-level' jargon", async () => {
    admin = await webLogin(base, "admin", "admin123");
    const html = await configPage();
    expect(html).toContain("+ Add a requirement");
    expect(html).toMatch(/either\/or/i);
    // How the whole list is read, in one sentence.
    expect(html).toMatch(/must all be met/i);
    // The jargon that confused the admin is gone from the buttons.
    expect(html).not.toContain("Top-level condition");
    expect(html).not.toContain("Top-level group");
  });

  it("renders a group as 'Either/or' with plain-words logic options", async () => {
    admin = await webLogin(base, "admin", "admin123");
    expect(await addNode("group")).toBe(302);
    const html = await configPage();
    expect(html).toMatch(/Either\/or/);
    expect(html).toContain("any of these");
    expect(html).toContain("all of these");
  });

  it("still adds a requirement (functional regression: the forms are unchanged)", async () => {
    admin = await webLogin(base, "admin", "admin123");
    expect(await addNode("condition")).toBe(302);
    const html = await configPage();
    expect(html).toContain('name="field"'); // the condition editor is there
    // And the preview renders the new rule in plain language.
    expect(html).toMatch(/Rule rendering/);
  });
});
