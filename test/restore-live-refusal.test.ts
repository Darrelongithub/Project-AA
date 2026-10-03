import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { acquireDatabaseRestoreLease, ActiveDatabaseRestoreRefusedError } from "../src/db/activity";
import { restoreDatabaseFromBackup } from "../src/db/restore";
import { FORCE_ACTIVE_DATABASE_FLAG, parseRestoreArgs } from "../src/cli/restoreArgs";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("restore-over-live safeguards", () => {
  it("refuses by default with a typed error while a process has the target database open", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "project-aa-restore-live-"));
    tempDirs.push(dir);
    const databaseFile = path.join(dir, "live.sqlite");
    const backupFile = path.join(dir, "backup.sqlite");
    fs.writeFileSync(backupFile, "backup contents must not replace the live database");

    const db = openDb(databaseFile);
    try {
      db.exec("CREATE TABLE restore_guard_probe (value TEXT NOT NULL); INSERT INTO restore_guard_probe VALUES ('live');");
      let thrown: unknown;
      try { restoreDatabaseFromBackup(backupFile, databaseFile); }
      catch (error) { thrown = error; }

      expect(thrown).toBeInstanceOf(ActiveDatabaseRestoreRefusedError);
      expect(thrown).toMatchObject({
        name: "ActiveDatabaseRestoreRefusedError",
        code: "RESTORE_REFUSED_ACTIVE_DATABASE",
        databasePath: databaseFile,
        activePids: [process.pid],
      });
      expect(db.prepare("SELECT value FROM restore_guard_probe").get()).toEqual({ value: "live" });
    } finally {
      db.close();
    }

    expect(() => restoreDatabaseFromBackup(backupFile, databaseFile)).not.toThrow();
  });

  it("allows the explicit force option to acquire a lease over an active target", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "project-aa-restore-force-"));
    tempDirs.push(dir);
    const databaseFile = path.join(dir, "live.sqlite");
    const db = openDb(databaseFile);
    try {
      const releaseLease = acquireDatabaseRestoreLease(databaseFile, true);
      expect(releaseLease).toBeTypeOf("function");
      releaseLease();
    } finally {
      db.close();
    }
  });

  it("restores an idle dataset and removes stale SQLite sidecars", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "project-aa-restore-idle-"));
    tempDirs.push(dir);
    const databaseFile = path.join(dir, "idle.sqlite");
    const backupFile = path.join(dir, "backup.sqlite");
    fs.writeFileSync(databaseFile, "old database");
    fs.writeFileSync(backupFile, "verified backup");
    fs.writeFileSync(`${databaseFile}-wal`, "stale wal");
    fs.writeFileSync(`${databaseFile}-shm`, "stale shm");

    const result = restoreDatabaseFromBackup(backupFile, databaseFile);

    expect(fs.readFileSync(result.databaseFile, "utf8")).toBe("verified backup");
    expect(fs.existsSync(`${databaseFile}-wal`)).toBe(false);
    expect(fs.existsSync(`${databaseFile}-shm`)).toBe(false);
  });

  it("requires the distinctly named force flag rather than silently enabling live overwrite", () => {
    expect(parseRestoreArgs(["./backups/test.sqlite"])).toEqual({
      backupFile: "./backups/test.sqlite",
      forceActiveDatabase: false,
    });
    expect(parseRestoreArgs([FORCE_ACTIVE_DATABASE_FLAG, "./backups/test.sqlite"])).toEqual({
      backupFile: "./backups/test.sqlite",
      forceActiveDatabase: true,
    });
    expect(() => parseRestoreArgs(["--force", "./backups/test.sqlite"])).toThrow(/Unknown restore option/);
  });
});
