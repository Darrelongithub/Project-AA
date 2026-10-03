/**
 * `npm run restore -- <backup-file>` — restore an idle database backup.
 * A live database requires the intentionally explicit --force-active-database override.
 */
import * as fs from "fs";
import * as path from "path";
import { loadConfig } from "../config";
import { ActiveDatabaseRestoreRefusedError } from "../db/activity";
import { restoreDatabaseFromBackup } from "../db/restore";
import { FORCE_ACTIVE_DATABASE_FLAG, parseRestoreArgs } from "./restoreArgs";

function showUsage(error?: string): never {
  if (error) console.error(`restore: ${error}`);
  console.error(`Usage: npm run restore -- [${FORCE_ACTIVE_DATABASE_FLAG}] ./backups/email-sorter-<stamp>.sqlite`);
  const dir = path.resolve("./backups");
  if (fs.existsSync(dir)) {
    console.error("Available backups:\n  " + fs.readdirSync(dir).join("\n  "));
  }
  process.exit(1);
}

let options: ReturnType<typeof parseRestoreArgs>;
try { options = parseRestoreArgs(process.argv.slice(2)); }
catch (error) { showUsage(error instanceof Error ? error.message : String(error)); }

try {
  const cfg = loadConfig();
  const result = restoreDatabaseFromBackup(options.backupFile, path.resolve(cfg.dbPath), {
    forceActiveDatabase: options.forceActiveDatabase,
  });
  console.log(`restore: ${result.backupFile} → ${result.databaseFile}. Restart the server to pick it up.`);
} catch (error) {
  if (error instanceof ActiveDatabaseRestoreRefusedError) {
    console.error(`restore: ${error.message}`);
  } else {
    console.error(`restore: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exitCode = 1;
}
