/**
 * Restore a database backup over the live database file — with an explicit
 * refusal when the target looks live (CR-13).
 *
 * Detection: a running server holds the database open, which in WAL mode
 * leaves `-wal`/`-shm` sidecars beside the file. Overwriting the main file
 * (or deleting the sidecars) while a server writes through them corrupts
 * both. So a restore that sees sidecars refuses loudly instead of
 * overwriting; the operator stops the server first, or passes `force: true`
 * to state explicitly that no server is running (e.g. after an unclean
 * shutdown left stale sidecars behind).
 *
 * Residual edge: a server that has performed zero writes yet has no `-wal`
 * file, so this check cannot see it. The CLI prints "restart the server"
 * guidance on every restore for exactly that reason.
 */
import * as fs from "fs";
import * as path from "path";

/** Typed error: restore refused because the target dataset looks live. */
export class RestoreRefusedError extends Error {
  readonly dbFile: string;
  readonly sidecars: string[];
  constructor(dbFile: string, sidecars: string[]) {
    super(
      `restore refused: ${sidecars.join(", ")} beside ${dbFile} ` +
        `— a server may be running against this dataset. Stop the server first, ` +
        `or re-run with --force if you are certain none is.`
    );
    this.name = "RestoreRefusedError";
    this.dbFile = dbFile;
    this.sidecars = sidecars;
  }
}

export interface RestoreOptions {
  /** Proceed even when live sidecars are present (operator asserts no server runs). */
  force?: boolean;
}

/**
 * Copy `backupFile` over `dbFile`, removing WAL sidecars so the restored
 * file is authoritative. Throws RestoreRefusedError when sidecars are
 * present and `force` is not set; the target is left untouched then.
 */
export function restoreDatabase(backupFile: string, dbFile: string, opts: RestoreOptions = {}): void {
  const target = path.resolve(dbFile);
  if (!opts.force) {
    const live = ["-wal", "-shm"]
      .map((suffix) => `${target}${suffix}`)
      .filter((sidecar) => fs.existsSync(sidecar));
    if (live.length > 0) throw new RestoreRefusedError(target, live);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Remove WAL/SHM sidecars so the restored file is authoritative.
  for (const suffix of ["-wal", "-shm"]) {
    try { fs.unlinkSync(target + suffix); } catch { /* ignore */ }
  }
  fs.copyFileSync(path.resolve(backupFile), target);
}
