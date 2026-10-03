/**
 * Encrypt existing plaintext retention archives without deleting or replacing
 * their source files. Usage: npm run archive:migrate -- /path/to/archive.
 */
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { decryptArchive, parseArchiveEncryptionKey, writeEncryptedArchive } from "../util/archiveCrypto";

dotenv.config();

function main(): void {
  const directoryArg = process.argv[2];
  if (!directoryArg) {
    console.error("usage: npm run archive:migrate -- <archive-directory>");
    process.exitCode = 2;
    return;
  }

  let key: Buffer;
  try {
    key = parseArchiveEncryptionKey(process.env.ARCHIVE_ENCRYPTION_KEY);
  } catch (error) {
    console.error(`archive:migrate: ${error instanceof Error ? error.message : "invalid archive key"}`);
    process.exitCode = 1;
    return;
  }

  const directory = path.resolve(directoryArg);
  if (!fs.statSync(directory).isDirectory()) {
    console.error("archive:migrate: path is not a directory");
    process.exitCode = 1;
    return;
  }

  let created = 0;
  let alreadyMigrated = 0;
  let failed = 0;
  const plainFiles = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();

  for (const name of plainFiles) {
    const source = path.join(directory, name);
    const destination = `${source}.enc`;
    try {
      const plaintext = fs.readFileSync(source, "utf8");
      JSON.parse(plaintext); // refuse to label malformed data as a migrated archive

      if (fs.existsSync(destination)) {
        const destinationStat = fs.lstatSync(destination);
        if (!destinationStat.isFile() || destinationStat.isSymbolicLink()) {
          throw new Error("encrypted sibling is not a regular file");
        }
        const current = decryptArchive(fs.readFileSync(destination, "utf8"), key);
        if (current !== plaintext) {
          throw new Error("encrypted sibling exists but does not match the plaintext source");
        }
        alreadyMigrated++;
        continue;
      }

      writeEncryptedArchive(destination, plaintext, key);
      const verified = decryptArchive(fs.readFileSync(destination, "utf8"), key);
      if (verified !== plaintext) throw new Error("encrypted copy failed round-trip verification");
      created++;
    } catch (error) {
      failed++;
      console.error(`archive:migrate: ${name}: ${error instanceof Error ? error.message : "failed"}`);
    }
  }

  console.log(
    `archive:migrate: ${created} encrypted and verified, ${alreadyMigrated} already verified, ` +
    `${failed} failed; plaintext source files were preserved.`
  );
  if (failed > 0) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(`archive:migrate: aborted: ${error instanceof Error ? error.message : "unknown failure"}`);
  process.exitCode = 1;
}
