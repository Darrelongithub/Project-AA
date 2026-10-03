import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const ACTIVITY_DIR = path.join(os.tmpdir(), "project-aa-db-activity");

export class ActiveDatabaseRestoreRefusedError extends Error {
  readonly code = "RESTORE_REFUSED_ACTIVE_DATABASE" as const;

  constructor(readonly databasePath: string, readonly activePids: number[]) {
    super(
      `Refusing to restore over active database ${databasePath}; active process ID(s): ${activePids.join(", ")}. ` +
      "Stop those processes first, or deliberately override with --force-active-database."
    );
    this.name = "ActiveDatabaseRestoreRefusedError";
  }
}

export class DatabaseRestoreInProgressError extends Error {
  readonly code = "DATABASE_RESTORE_IN_PROGRESS" as const;

  constructor(readonly databasePath: string) {
    super(`A restore is already in progress for ${databasePath}; refusing to open it.`);
    this.name = "DatabaseRestoreInProgressError";
  }
}

export class ConcurrentDatabaseRestoreError extends Error {
  readonly code = "CONCURRENT_DATABASE_RESTORE" as const;

  constructor(readonly databasePath: string) {
    super(`Another restore already holds the restore lock for ${databasePath}.`);
    this.name = "ConcurrentDatabaseRestoreError";
  }
}

function canonicalDatabasePath(file: string): string {
  const absolute = path.resolve(file);
  try { return fs.realpathSync.native(absolute); }
  catch {
    // Canonicalize the parent too, so a first open through a symlinked
    // directory produces the same marker key as a later restore.
    try {
      const parent = fs.realpathSync.native(path.dirname(absolute));
      return path.join(parent, path.basename(absolute));
    } catch { return absolute; }
  }
}

function activityPaths(databasePath: string): { prefix: string; restoreLock: string } {
  const key = createHash("sha256").update(databasePath).digest("hex");
  return {
    prefix: `${key}.active.`,
    restoreLock: path.join(ACTIVITY_DIR, `${key}.restore.lock`),
  };
}

function ensureActivityDirectory(): void {
  fs.mkdirSync(ACTIVITY_DIR, { recursive: true, mode: 0o700 });
}

function unlinkQuietly(file: string): void {
  try { fs.unlinkSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

const ownedMarkers = new Set<string>();
let exitCleanupRegistered = false;

function registerExitCleanup(): void {
  if (exitCleanupRegistered) return;
  exitCleanupRegistered = true;
  process.once("exit", () => {
    for (const marker of ownedMarkers) {
      try { fs.unlinkSync(marker); } catch { /* stale markers are reaped by PID on the next restore */ }
    }
    ownedMarkers.clear();
  });
}

/**
 * Register a process marker before opening a file-backed SQLite database.
 * Restore uses these PID markers to distinguish a live dataset from an idle one.
 */
export function markDatabaseActive(file: string): () => void {
  if (file === ":memory:") return () => undefined;

  const databasePath = canonicalDatabasePath(file);
  ensureActivityDirectory();
  const paths = activityPaths(databasePath);
  if (fs.existsSync(paths.restoreLock)) throw new DatabaseRestoreInProgressError(databasePath);

  const marker = path.join(ACTIVITY_DIR, `${paths.prefix}${process.pid}.${randomUUID()}.json`);
  const contents = JSON.stringify({ pid: process.pid, databasePath, startedAt: new Date().toISOString() });
  fs.writeFileSync(marker, contents, { flag: "wx", mode: 0o600 });
  ownedMarkers.add(marker);
  registerExitCleanup();

  // Close the race where restore acquired its lock after the first check but
  // before the marker was created. The restore-side scan will otherwise see
  // this marker and refuse before copying any files.
  if (fs.existsSync(paths.restoreLock)) {
    ownedMarkers.delete(marker);
    unlinkQuietly(marker);
    throw new DatabaseRestoreInProgressError(databasePath);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    ownedMarkers.delete(marker);
    unlinkQuietly(marker);
  };
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function activeDatabasePids(databasePath: string): number[] {
  const { prefix } = activityPaths(databasePath);
  let entries: string[];
  try { entries = fs.readdirSync(ACTIVITY_DIR); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const pids = new Set<number>();
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith(".json")) continue;
    const marker = path.join(ACTIVITY_DIR, entry);
    try {
      const value = JSON.parse(fs.readFileSync(marker, "utf8")) as { pid?: unknown; databasePath?: unknown };
      const pid = Number(value.pid);
      if (value.databasePath !== databasePath || !Number.isSafeInteger(pid) || pid <= 0) {
        unlinkQuietly(marker);
      } else if (isProcessAlive(pid)) {
        pids.add(pid);
      } else {
        unlinkQuietly(marker);
      }
    } catch {
      // An incomplete or corrupt marker cannot prove that the dataset is live.
      unlinkQuietly(marker);
    }
  }
  return [...pids].sort((a, b) => a - b);
}

function acquireExclusiveRestoreFile(databasePath: string): { release: () => void } {
  ensureActivityDirectory();
  const { restoreLock } = activityPaths(databasePath);
  const writeLock = (): void => {
    const fd = fs.openSync(restoreLock, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, databasePath, startedAt: new Date().toISOString() }));
    } finally {
      fs.closeSync(fd);
    }
  };

  try {
    writeLock();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let stale = false;
    try {
      const lock = JSON.parse(fs.readFileSync(restoreLock, "utf8")) as { pid?: unknown };
      stale = !isProcessAlive(Number(lock.pid));
    } catch {
      stale = true;
    }
    if (!stale) throw new ConcurrentDatabaseRestoreError(databasePath);
    unlinkQuietly(restoreLock);
    writeLock();
  }

  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      unlinkQuietly(restoreLock);
    },
  };
}

/**
 * Block new openDb() calls, then refuse a restore if any process still has the
 * target database open. `forceActiveDatabase` is reserved for an explicit,
 * operator-requested overwrite of a live dataset.
 */
export function acquireDatabaseRestoreLease(
  file: string,
  forceActiveDatabase = false
): () => void {
  const databasePath = canonicalDatabasePath(file);
  const lock = acquireExclusiveRestoreFile(databasePath);
  try {
    if (!forceActiveDatabase) {
      const pids = activeDatabasePids(databasePath);
      if (pids.length) throw new ActiveDatabaseRestoreRefusedError(databasePath, pids);
    }
    return lock.release;
  } catch (error) {
    lock.release();
    throw error;
  }
}
