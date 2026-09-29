/**
 * `npm run restore -- <backup-file> [--force]` — restore a database backup.
 * Refuses to run unless you pass the backup path explicitly, and refuses to
 * overwrite a dataset whose WAL sidecars suggest a live server (CR-13) —
 * unless --force states explicitly that none is running.
 */
import * as fs from "fs";
import * as path from "path";
import { loadConfig } from "../config";
import { restoreDatabase, RestoreRefusedError } from "../db/restore";

const args = process.argv.slice(2).filter((a) => a !== "--force");
const force = process.argv.includes("--force");
const file = args[0];
if (!file || !fs.existsSync(file)) {
  console.error("Usage: npm run restore -- ./backups/email-sorter-<stamp>.sqlite [--force]");
  const dir = path.resolve("./backups");
  if (fs.existsSync(dir)) {
    console.error("Available backups:\n  " + fs.readdirSync(dir).join("\n  "));
  }
  process.exit(1);
}

const cfg = loadConfig();
const dbFile = path.resolve(cfg.dbPath);
try {
  restoreDatabase(path.resolve(file), dbFile, { force });
} catch (e) {
  if (e instanceof RestoreRefusedError) {
    console.error(e.message);
    process.exit(2);
  }
  throw e;
}
console.log(`restore: ${file} → ${dbFile}. Restart the server to pick it up.`);
