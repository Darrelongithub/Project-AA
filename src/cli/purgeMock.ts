/**
 * `npm run purge-mock` — OR-1 one-time cleanup of demo/simulation rows that
 * older versions wrote into the LIVE database. Backs the database up first,
 * removes ONLY rows flagged as demo (never real Gmail/staff rows), prints
 * exactly what went, and is safe to run repeatedly.
 */
import { loadConfig } from "../config";
import { openDb } from "../db/db";
import { Repo } from "../db/repo";
import { purgeMockData } from "../db/purge";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const repo = new Repo(openDb(cfg.dbPath));
  console.log(`purge-mock: scanning ${cfg.dbPath} …`);
  const result = purgeMockData(repo);
  if (result.applicants === 0 && result.staff === 0) {
    console.log("purge-mock: clean — no demo/simulation rows found. Nothing was changed.");
  } else {
    console.log(
      `purge-mock: removed ${result.applicants} mock applicant(s) and ${result.staff} demo account(s).` +
        (result.backupPath ? ` Backup saved to ${result.backupPath}.` : "")
    );
    console.log("purge-mock: real applicants, staff accounts and settings were not touched.");
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
