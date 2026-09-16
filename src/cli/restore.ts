/**
 * `npm run restore -- <backup-file>` — restore a database backup.
 * Refuses to run unless you pass the backup path explicitly.
 */
import * as fs from "fs";
import * as path from "path";
import { loadConfig } from "../config";

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error("Usage: npm run restore -- ./backups/email-sorter-<stamp>.sqlite");
  const dir = path.resolve("./backups");
  if (fs.existsSync(dir)) {
    console.error("Available backups:\n  " + fs.readdirSync(dir).join("\n  "));
  }
  process.exit(1);
}

const cfg = loadConfig();
const dbFile = path.resolve(cfg.dbPath);
fs.mkdirSync(path.dirname(dbFile), { recursive: true });
// Remove WAL/SHM sidecars so the restored file is authoritative.
for (const suffix of ["-wal", "-shm"]) {
  try { fs.unlinkSync(dbFile + suffix); } catch { /* ignore */ }
}
fs.copyFileSync(file, dbFile);
console.log(`restore: ${file} → ${dbFile}. Restart the server to pick it up.`);
