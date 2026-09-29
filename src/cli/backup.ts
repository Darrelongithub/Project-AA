/**
 * `npm run backup` — safe point-in-time copy of the database (feature 40).
 * Checkpoints WAL first so the copy is complete and consistent.
 */
import * as fs from "fs";
import * as path from "path";
import { loadConfig } from "../config";
import { openDb } from "../db/db";

const cfg = loadConfig();
const dbFile = path.resolve(cfg.dbPath);
if (!fs.existsSync(dbFile)) {
  console.error(`backup: nothing to back up — ${dbFile} does not exist.`);
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.resolve(process.env.BACKUP_DIR || "./backups");
// A backup is a full PII copy: same 0700/0600 rule as the retention
// archive (mkdir mode applies at creation only, so enforce every run).
fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
fs.chmodSync(outDir, 0o700);
const outFile = path.join(outDir, `email-sorter-${stamp}.sqlite`);

// SQLite's online backup API — an atomic, consistent copy even while the
// web server keeps writing. (The old checkpoint-then-copyFileSync could lose
// or tear writes landing between the two steps.)
async function main(): Promise<void> {
  const db = openDb(cfg.dbPath);
  try {
    await db.backup(outFile);
    fs.chmodSync(outFile, 0o600);
  } finally {
    db.close();
  }
  console.log(`backup: wrote ${outFile} (${(fs.statSync(outFile).size / 1024).toFixed(0)} KB)`);
}

main().catch((e) => {
  console.error(`backup failed: ${(e as Error).message}`);
  process.exit(1);
});
