/**
 * `npm run archive:encrypt [-- --dry-run]` — CR-08 migration (Phase 10).
 *
 * Encrypts pre-Phase-10 plaintext retention archives (`<ref>.json`) to
 * `<ref>.json.enc` (AES-256-GCM, see src/archive/crypto.ts). Per file:
 *   1. read the plaintext bytes,
 *   2. write `<ref>.json.enc` (0600),
 *   3. read the envelope back, decrypt, and byte-compare with the original,
 *   4. only then delete the plaintext original.
 *
 * Safety: refuses to run without ARCHIVE_KEY (exit 2); aborts BEFORE any
 * write when a target `.json.enc` already exists; aborts ON THE SPOT (exit
 * 2, plaintext kept) when a round-trip verification fails. `--dry-run`
 * lists what would happen and changes nothing.
 *
 * Never run against real archived data without explicit operator go-ahead.
 */
import * as fs from "fs";
import * as path from "path";
import { loadConfig } from "../config";
import {
  ARCHIVE_ENC_SUFFIX,
  ArchiveKeyError,
  decryptArchive,
  encryptArchive,
  loadArchiveKey,
} from "../archive/crypto";

function fail(msg: string): never {
  console.error(`archive:encrypt: ${msg}`);
  process.exit(2);
}

let archiveKey: Buffer;
try {
  archiveKey = loadArchiveKey();
} catch (e) {
  if (e instanceof ArchiveKeyError) fail(e.message);
  throw e;
}

const dryRun = process.argv.includes("--dry-run");
const cfg = loadConfig();
const archiveDir = path.resolve(path.dirname(path.resolve(cfg.dbPath)), "archive");
if (!fs.existsSync(archiveDir)) fail(`archive directory does not exist: ${archiveDir}`);

// Plaintext candidates: *.json except already-encrypted *.json.enc.
const plaintext = fs
  .readdirSync(archiveDir)
  .filter((f) => f.endsWith(".json") && !f.endsWith(ARCHIVE_ENC_SUFFIX))
  .sort();
if (plaintext.length === 0) {
  console.log("archive:encrypt: no plaintext archives found — nothing to do.");
  process.exit(0);
}

// Pre-flight: never overwrite an existing envelope — abort before writing.
for (const f of plaintext) {
  const target = path.join(archiveDir, `${f.slice(0, -".json".length)}${ARCHIVE_ENC_SUFFIX}`);
  if (fs.existsSync(target)) fail(`target already exists, aborting before any write: ${target}`);
}

if (dryRun) {
  for (const f of plaintext) console.log(`archive:encrypt: would encrypt ${f} → ${f.slice(0, -5)}.json.enc`);
  console.log(`archive:encrypt: dry run — ${plaintext.length} file(s), nothing changed.`);
  process.exit(0);
}

let done = 0;
for (const f of plaintext) {
  const src = path.join(archiveDir, f);
  const dst = path.join(archiveDir, `${f.slice(0, -".json".length)}${ARCHIVE_ENC_SUFFIX}`);
  const original = fs.readFileSync(src); // bytes, not text — the record must survive verbatim
  fs.writeFileSync(dst, encryptArchive(original, archiveKey), { mode: 0o600 });
  // Verify by reading back from disk (not from memory) before deleting.
  const roundTripped = decryptArchive(fs.readFileSync(dst, "utf8"), archiveKey);
  if (Buffer.from(roundTripped, "utf8").compare(original) !== 0) {
    fail(`round-trip mismatch for ${dst} — plaintext KEPT at ${src}, aborting.`);
  }
  fs.unlinkSync(src);
  done++;
  console.log(`archive:encrypt: encrypted + removed plaintext ${f} → ${path.basename(dst)}`);
}
console.log(`archive:encrypt: ${done} archive(s) encrypted and verified.`);
