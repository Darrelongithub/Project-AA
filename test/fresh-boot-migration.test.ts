import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openDb } from "../src/db/db";

describe("fresh file-based database boot", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it("migrates a genuinely empty SQLite file before creating the cases view", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-aa-fresh-boot-"));
    const file = path.join(tempDir, "fresh.sqlite");
    fs.writeFileSync(file, "");
    expect(fs.statSync(file).size).toBe(0);

    const db = openDb(file);
    try {
      expect(db.name).toBe(file);
      expect(db.pragma("user_version", { simple: true })).toBe(2);
      expect(
        db.prepare("SELECT name, type FROM sqlite_master WHERE name IN (?, ?) ORDER BY name").all("applicants", "cases")
      ).toEqual([
        { name: "applicants", type: "table" },
        { name: "cases", type: "view" },
      ]);
      expect(db.prepare("SELECT COUNT(*) AS n FROM cases").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });
});
