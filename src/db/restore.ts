import * as fs from "node:fs";
import * as path from "node:path";
import { acquireDatabaseRestoreLease } from "./activity";

export class RestoreBackupNotFoundError extends Error {
  readonly code = "RESTORE_BACKUP_NOT_FOUND" as const;

  constructor(readonly backupFile: string) {
    super(`Restore backup does not exist: ${backupFile}`);
    this.name = "RestoreBackupNotFoundError";
  }
}

export class RestoreSourceIsTargetError extends Error {
  readonly code = "RESTORE_SOURCE_IS_TARGET" as const;

  constructor(readonly databaseFile: string) {
    super(`Restore source and destination are the same file: ${databaseFile}`);
    this.name = "RestoreSourceIsTargetError";
  }
}

export interface RestoreDatabaseOptions {
  /** Deliberately replace a database while one or more processes have it open. */
  forceActiveDatabase?: boolean;
}

/** Restore a backup only after obtaining an exclusive, active-database-aware lease. */
export function restoreDatabaseFromBackup(
  backupFile: string,
  databaseFile: string,
  options: RestoreDatabaseOptions = {}
): { backupFile: string; databaseFile: string } {
  const source = path.resolve(backupFile);
  const target = path.resolve(databaseFile);
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new RestoreBackupNotFoundError(source);
  if (source === target) throw new RestoreSourceIsTargetError(target);

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const releaseLease = acquireDatabaseRestoreLease(target, options.forceActiveDatabase === true);
  try {
    // Remove WAL/SHM sidecars so the restored file is authoritative.
    for (const suffix of ["-wal", "-shm"]) {
      try { fs.unlinkSync(target + suffix); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    fs.copyFileSync(source, target);
  } finally {
    releaseLease();
  }
  return { backupFile: source, databaseFile: target };
}
