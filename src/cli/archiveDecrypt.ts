/**
 * Decrypt one retention archive to a new, explicitly chosen private file.
 * Usage: npm run archive:decrypt -- <archive.json.enc> <output.json>.
 */
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { decryptArchive, parseArchiveEncryptionKey } from "../util/archiveCrypto";

dotenv.config();

function main(): void {
  const [sourceArg, destinationArg] = process.argv.slice(2);
  if (!sourceArg || !destinationArg) {
    console.error("usage: npm run archive:decrypt -- <archive.json.enc> <output.json>");
    process.exitCode = 2;
    return;
  }

  let key: Buffer;
  try {
    key = parseArchiveEncryptionKey(process.env.ARCHIVE_ENCRYPTION_KEY);
  } catch (error) {
    console.error(`archive:decrypt: ${error instanceof Error ? error.message : "invalid archive key"}`);
    process.exitCode = 1;
    return;
  }

  const source = path.resolve(sourceArg);
  const destination = path.resolve(destinationArg);
  if (source === destination) {
    console.error("archive:decrypt: input and output paths must differ");
    process.exitCode = 1;
    return;
  }

  try {
    const plaintext = decryptArchive(fs.readFileSync(source, "utf8"), key);
    JSON.parse(plaintext); // validate before creating a plaintext copy
    const fd = fs.openSync(destination, "wx", 0o600);
    try {
      fs.writeFileSync(fd, plaintext, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    console.log(`archive:decrypt: wrote a private plaintext copy to ${destination}; handle it as sensitive data`);
  } catch (error) {
    console.error(`archive:decrypt: ${error instanceof Error ? error.message : "failed"}`);
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error(`archive:decrypt: aborted: ${error instanceof Error ? error.message : "unknown failure"}`);
  process.exitCode = 1;
}
