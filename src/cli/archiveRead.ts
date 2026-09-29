/**
 * `npm run archive:read -- <ref-or-path>` — CR-08 audit reader (Phase 10).
 *
 * Decrypts one retention archive and prints the original JSON to stdout
 * (redirect it — decrypted PII must never linger on disk). Accepts a case
 * ref (`RU-2026-000001`), a bare file name, or a direct path. Refuses
 * without ARCHIVE_KEY (exit 2); a wrong key fails on the GCM auth tag.
 */
import * as fs from "fs";
import * as path from "path";
import { loadConfig } from "../config";
import {
  ARCHIVE_ENC_SUFFIX,
  ArchiveDecryptError,
  ArchiveKeyError,
  decryptArchive,
  loadArchiveKey,
} from "../archive/crypto";

function fail(msg: string): never {
  console.error(`archive:read: ${msg}`);
  process.exit(2);
}

const arg = process.argv.slice(2).find((a) => !a.startsWith("-"));
if (!arg) fail("usage: npm run archive:read -- <case-ref | file-name | path>");

let archiveKey: Buffer;
try {
  archiveKey = loadArchiveKey();
} catch (e) {
  if (e instanceof ArchiveKeyError) fail(e.message);
  throw e;
}

const cfg = loadConfig();
const archiveDir = path.resolve(path.dirname(path.resolve(cfg.dbPath)), "archive");

const candidates = [path.resolve(arg as string)];
if (!path.isAbsolute(arg as string) && !(arg as string).includes(path.sep)) {
  const base = (arg as string).endsWith(ARCHIVE_ENC_SUFFIX)
    ? (arg as string)
    : (arg as string).endsWith(".json")
      ? `${(arg as string).slice(0, -".json".length)}${ARCHIVE_ENC_SUFFIX}`
      : `${arg}${ARCHIVE_ENC_SUFFIX}`;
  candidates.push(path.join(archiveDir, base));
}
const file = candidates.find((c) => fs.existsSync(c));
if (!file) fail(`no such archive: ${arg} (looked in ${archiveDir} for *${ARCHIVE_ENC_SUFFIX})`);

let envelope: string;
try {
  envelope = fs.readFileSync(file as string, "utf8");
} catch (e) {
  fail(`cannot read ${file}: ${(e as Error).message}`);
}
try {
  process.stdout.write(decryptArchive(envelope as string, archiveKey));
  process.stdout.write("\n");
} catch (e) {
  if (e instanceof ArchiveDecryptError) fail(e.message);
  throw e;
}
