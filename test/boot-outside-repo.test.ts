/**
 * C-1 regression — bundled data resolution must not depend on DB_PATH.
 *
 * `src/pack.ts` used to derive DATA_DIR from `dirname(DB_PATH)`. Any DB_PATH
 * outside the checkout therefore looked for `data/migrated/organization-1.json`
 * next to the database, found nothing, seeded zero attachment sets, and died in
 * `seedDefaults()`:
 *
 *   Error: Unknown attachment set 'application' for organization 1
 *       at Repo.upsertTemplate (src/db/repo.ts)
 *       at seedDefaults (src/db/seed.ts)
 *       at main (src/cli/serve.ts)
 *
 * …before `listen()` ever ran. The old suite missed it because every test used
 * `:memory:`, which still resolved inside the repository's own `data/` folder.
 *
 * Audit repro (now part of CI):
 *   DB_PATH=$(mktemp -d)/email-sorter.sqlite PORT=8137 npm run serve
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { configureTestOrganization } from "./helpers";

const repoRoot = path.resolve(__dirname, "..");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForBoot(child: ChildProcess, getOutput: () => string, timeoutMs = 60_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (getOutput().includes("listening on")) return;
    if (child.exitCode !== null) {
      throw new Error(`server exited before listen() with code ${child.exitCode}:\n${getOutput()}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server did not start listening within ${timeoutMs}ms:\n${getOutput()}`);
}

describe("C-1: booting with DB_PATH outside the repository", () => {
  let child: ChildProcess | null = null;
  let tmpDir: string | null = null;

  afterEach(() => {
    child?.kill("SIGKILL");
    child = null;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("ships no bundled tenant data: packs come from the database only", async () => {
    // Set DB_PATH BEFORE the module is loaded: the resolution happens at
    // import time, and nothing may reach for a bundled data directory.
    const outside = mkdtempSync(path.join(os.tmpdir(), "aa-db-outside-"));
    const previousDbPath = process.env.DB_PATH;
    process.env.DB_PATH = path.join(outside, "email-sorter.sqlite");
    try {
      const pack = await import("../src/pack");
      expect(Object.keys(pack).sort()).toEqual(["defaultEmailBanner", "organizationPack", "packManifest"]);
      expect(existsSync(path.join(repoRoot, "data", "migrated"))).toBe(false);
      expect(existsSync(path.join(repoRoot, "data", "presets"))).toBe(false);
      const bundled = existsSync(path.join(repoRoot, "data", "pack"))
        ? readdirSync(path.join(repoRoot, "data", "pack")).filter((name) => !name.startsWith("."))
        : [];
      expect(bundled).toEqual([]);

      // A tenant's pack is database-owned: an empty install has no files.
      const repo = new Repo(openDb(path.join(outside, "pack-check.sqlite")));
      seedDefaults(repo);
      configureTestOrganization(repo);
      expect(pack.packManifest(repo, 1)).toEqual([]);
      expect(pack.organizationPack(repo, 1).files).toEqual([]);
    } finally {
      if (previousDbPath === undefined) delete process.env.DB_PATH;
      else process.env.DB_PATH = previousDbPath;
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("boots the real server (npm run serve) with the database in a temp directory", async () => {
    const tsxBin = path.resolve(repoRoot, "node_modules/.bin/tsx");
    if (!existsSync(tsxBin)) throw new Error("tsx binary missing — run `npm install` before this gate");

    tmpDir = mkdtempSync(path.join(os.tmpdir(), "aa-boot-outside-"));
    // Guard the test itself: the temp dir really is outside the checkout.
    expect(tmpDir.startsWith(repoRoot + path.sep)).toBe(false);
    const port = await freePort();

    let output = "";
    child = spawn(tsxBin, [path.resolve(repoRoot, "src/cli/serve.ts")], {
      cwd: repoRoot,
      env: {
        ...process.env,
        MODE: "mock",
        DB_PATH: path.join(tmpDir, "email-sorter.sqlite"),
        PORT: String(port),
        LOG_TO_FILE: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (d: Buffer) => { output += d.toString(); });
    child.stderr!.on("data", (d: Buffer) => { output += d.toString(); });

    await waitForBoot(child, () => output);

    // The old crash must not appear anywhere in the boot log.
    expect(output).not.toContain("Unknown attachment set");
    expect(output).toContain("listening on");

    // And it really serves HTTP: a fresh database redirects /login to /setup.
    const res = await fetch(`http://127.0.0.1:${port}/login`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toContain("setup");
  }, 90_000);
});
