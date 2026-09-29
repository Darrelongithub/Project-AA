/**
 * Phase 11 (CR-13): restoring over a live/active dataset fails loudly.
 * A target with WAL sidecars (a running server holds the database open)
 * is refused with a typed error and left untouched — unless the operator
 * passes force explicitly (e.g. stale sidecars after an unclean shutdown).
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { restoreDatabase, RestoreRefusedError } from "../src/db/restore";

function sandbox(): { dir: string; backup: string; target: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr13-"));
  const backup = path.join(dir, "backup.sqlite");
  const target = path.join(dir, "live.sqlite");
  fs.writeFileSync(backup, "BACKUP-BYTES");
  fs.writeFileSync(target, "LIVE-BYTES");
  return { dir, backup, target };
}

describe("CR-13: restore-over-live refusal", () => {
  it("refuses with a typed error when a -wal sidecar is present, target untouched", () => {
    const { backup, target } = sandbox();
    fs.writeFileSync(`${target}-wal`, "wal");
    try {
      restoreDatabase(backup, target);
      expect.unreachable("expected RestoreRefusedError");
    } catch (e) {
      expect(e).toBeInstanceOf(RestoreRefusedError);
      expect((e as Error).name).toBe("RestoreRefusedError");
      expect((e as Error).message).toContain("--force");
      expect((e as RestoreRefusedError).dbFile).toBe(path.resolve(target));
    }
    expect(fs.readFileSync(target, "utf8")).toBe("LIVE-BYTES");
    expect(fs.existsSync(`${target}-wal`)).toBe(true);
  });

  it("refuses when a -shm sidecar is present", () => {
    const { backup, target } = sandbox();
    fs.writeFileSync(`${target}-shm`, "shm");
    expect(() => restoreDatabase(backup, target)).toThrowError(RestoreRefusedError);
    expect(fs.readFileSync(target, "utf8")).toBe("LIVE-BYTES");
  });

  it("proceeds when no sidecars are present (quiet dataset)", () => {
    const { backup, target } = sandbox();
    restoreDatabase(backup, target);
    expect(fs.readFileSync(target, "utf8")).toBe("BACKUP-BYTES");
  });

  it("force:true proceeds despite sidecars and clears them", () => {
    const { backup, target } = sandbox();
    fs.writeFileSync(`${target}-wal`, "wal");
    fs.writeFileSync(`${target}-shm`, "shm");
    restoreDatabase(backup, target, { force: true });
    expect(fs.readFileSync(target, "utf8")).toBe("BACKUP-BYTES");
    expect(fs.existsSync(`${target}-wal`)).toBe(false);
    expect(fs.existsSync(`${target}-shm`)).toBe(false);
  });
});
