/**
 * `npm run retain` — data retention for sensitive case data.
 *
 * Completed cases older than the configured `retention_days` setting are
 * archived as authenticated AES-256-GCM ciphertext and then removed from the
 * live database. Cases that are not completed are never touched. The raw key
 * must be supplied out-of-band as ARCHIVE_ENCRYPTION_KEY; it is never stored
 * beside the database or an archive.
 */
import * as fs from "fs";
import { envInt } from "../util/envnum";
import * as path from "path";
import { loadConfig } from "../config";
import { openDb } from "../db/db";
import { Repo } from "../db/repo";
import { seedDefaults } from "../db/seed";
import { retentionDue } from "../db/retention";
import { decryptArchive, parseArchiveEncryptionKey, writeEncryptedArchive } from "../util/archiveCrypto";

function main(): void {
  const cfg = loadConfig();
  let archiveKey: Buffer;
  try {
    // Validate the external key before opening the database or creating any
    // archive files. Missing/invalid keys must never degrade to plaintext.
    archiveKey = parseArchiveEncryptionKey(process.env.ARCHIVE_ENCRYPTION_KEY);
  } catch (error) {
    console.error(`retain: ${error instanceof Error ? error.message : "invalid archive key"}`);
    process.exitCode = 1;
    return;
  }

  const repo = new Repo(openDb(cfg.dbPath));
  seedDefaults(repo, { live: cfg.mode === "live" });

  // A corrupt setting must not crash the run with an opaque RangeError from
  // Invalid Date — fall back to the documented 730-day default.
  const retentionDays = envInt(repo.getSetting("retention_days", "730"), 730);
  const cutoff = new Date(Date.now() - retentionDays * 24 * 3600_000).toISOString();
  const archiveDir = path.resolve(path.dirname(path.resolve(cfg.dbPath)), "archive");
  fs.mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
  const archiveDirStat = fs.lstatSync(archiveDir);
  if (!archiveDirStat.isDirectory() || archiveDirStat.isSymbolicLink()) {
    throw new Error(`retain: archive path is not a real directory: ${archiveDir}`);
  }
  // mkdir's mode only applies when it creates the directory. Tighten an
  // existing directory too, so old world-traversable archive directories do
  // not retain their previous permissions.
  fs.chmodSync(archiveDir, 0o700);

  // Realm: retention defaults to the LIVE realm (demo=0). Seeded demo data is
  // mock — sweeping it silently would destroy the demo environment. Pass
  // --all-realms (or RETAIN_ALL_REALMS=1) to include the demo realm too.
  const allRealms = process.argv.includes("--all-realms") || process.env.RETAIN_ALL_REALMS === "1";
  const realm: number | undefined = allRealms ? undefined : 0;

  // retentionDue normalises the two date formats before comparing — a raw
  // string compare archives cases up to 24 h early on the boundary day.
  const candidates = repo.allApplicants(realm).filter(
    (a) => a.lifecycle === "completed" && retentionDue(a.updated_at, cutoff)
  );

  let archived = 0;
  let failed = 0;
  let noLongerDue = 0;
  for (const candidate of candidates) {
    let archivePath = "";
    try {
      const reference = repo.archiveAndDeleteDueApplicant(
        candidate.id,
        cutoff,
        retentionDays,
        (record) => {
          // Reference numbers come from persisted rows. Refuse path separators
          // or unexpected characters rather than letting a row choose a path.
          const ref = record.applicant.ref_number;
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(ref)) {
            throw new Error("case has an invalid archive reference; no data was removed");
          }
          archivePath = path.join(archiveDir, `${ref}.json.enc`);
          const serialized = JSON.stringify(record, null, 2);

          if (fs.existsSync(archivePath)) {
            const existingStat = fs.lstatSync(archivePath);
            if (!existingStat.isFile() || existingStat.isSymbolicLink()) {
              throw new Error("existing archive path is not a regular file; no data was removed");
            }
            // Recover safely if the process stopped after the encrypted archive
            // was committed but before the database delete. Only delete when the
            // authenticated archive exactly matches this transaction's snapshot.
            const oldPlaintext = decryptArchive(fs.readFileSync(archivePath, "utf8"), archiveKey);
            const oldRecord = JSON.parse(oldPlaintext) as { archived_at?: unknown };
            const retryRecord = { ...record, archived_at: oldRecord.archived_at };
            if (JSON.stringify(oldRecord) !== JSON.stringify(retryRecord)) {
              throw new Error("existing archive does not match the current case; no data was removed");
            }
          } else {
            writeEncryptedArchive(archivePath, serialized, archiveKey);
            const verified = decryptArchive(fs.readFileSync(archivePath, "utf8"), archiveKey);
            if (verified !== serialized) {
              throw new Error("archive round-trip verification failed; no data was removed");
            }
          }
        }
      );
      if (!reference) {
        noLongerDue++;
        console.log(`retain: skipped ${candidate.ref_number}; it is no longer completed or past cutoff`);
        continue;
      }
      archived++;
      console.log(`retain: encrypted archive + removal ${reference} → ${archivePath}`);
    } catch (error) {
      failed++;
      const message = error instanceof Error ? error.message : "unknown failure";
      console.error(`retain: failed ${candidate.ref_number}; case remains in the live DB: ${message}`);
    }
  }

  console.log(
    `retain: ${archived} completed case(s) archived and removed; ${noLongerDue} no longer eligible; ` +
    `${failed} failed; ${candidates.length} initial candidate(s) (retention ${retentionDays} days; ` +
    `realm: ${allRealms ? "live + demo" : "live only"}).`
  );
  if (failed > 0) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(`retain: aborted before completing the sweep: ${error instanceof Error ? error.message : "unknown failure"}`);
  process.exitCode = 1;
}
