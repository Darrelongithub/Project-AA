export const FORCE_ACTIVE_DATABASE_FLAG = "--force-active-database";

export interface RestoreCommandOptions {
  backupFile: string;
  forceActiveDatabase: boolean;
}

export function parseRestoreArgs(args: readonly string[]): RestoreCommandOptions {
  let backupFile: string | undefined;
  let forceActiveDatabase = false;

  for (const arg of args) {
    if (arg === FORCE_ACTIVE_DATABASE_FLAG) {
      if (forceActiveDatabase) throw new Error(`${FORCE_ACTIVE_DATABASE_FLAG} may be supplied only once`);
      forceActiveDatabase = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown restore option: ${arg}`);
    } else if (backupFile) {
      throw new Error("Restore accepts exactly one backup path");
    } else {
      backupFile = arg;
    }
  }

  if (!backupFile) throw new Error("A backup path is required");
  return { backupFile, forceActiveDatabase };
}
