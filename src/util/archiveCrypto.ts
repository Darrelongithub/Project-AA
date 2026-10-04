import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";

const FORMAT = "project-aa-retention-archive";
const VERSION = 1;
const ALGORITHM = "aes-256-gcm" as const;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const AAD = Buffer.from(`${FORMAT}:v${VERSION}`, "utf8");

interface ArchiveEnvelope {
  format: typeof FORMAT;
  version: typeof VERSION;
  algorithm: typeof ALGORITHM;
  nonce: string;
  tag: string;
  ciphertext: string;
}

/**
 * Read a raw 32-byte archive key from an external secret store/environment.
 * Accept canonical base64 (recommended: `openssl rand -base64 32`) or 64 hex
 * characters. The key is deliberately never stored beside the archive or DB.
 */
export function parseArchiveEncryptionKey(value: string | undefined): Buffer {
  const input = value?.trim();
  if (!input) {
    throw new Error("ARCHIVE_ENCRYPTION_KEY is required; refusing plaintext retention archives.");
  }

  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(input)) {
    key = Buffer.from(input, "hex");
  } else {
    key = Buffer.from(input, "base64");
    if (key.toString("base64") !== input) {
      throw new Error("ARCHIVE_ENCRYPTION_KEY must be canonical base64 for exactly 32 bytes, or 64 hex characters.");
    }
  }

  if (key.length !== KEY_BYTES) {
    throw new Error("ARCHIVE_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  }
  return key;
}

function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new Error("Archive encryption requires a 32-byte key.");
  }
}

function decodeCanonicalBase64(value: unknown, label: string, exactLength?: number): Buffer {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Encrypted archive has an invalid ${label}.`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value || (exactLength !== undefined && decoded.length !== exactLength)) {
    throw new Error(`Encrypted archive has an invalid ${label}.`);
  }
  return decoded;
}

/** Encrypt JSON text in a versioned, authenticated AES-256-GCM envelope. */
export function encryptArchive(plaintext: string, key: Buffer): string {
  assertKey(key);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const envelope: ArchiveEnvelope = {
    format: FORMAT,
    version: VERSION,
    algorithm: ALGORITHM,
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  return `${JSON.stringify(envelope)}\n`;
}

/** Authenticate and decrypt a versioned archive envelope back to its JSON text. */
export function decryptArchive(serializedEnvelope: string, key: Buffer): string {
  assertKey(key);
  let envelope: unknown;
  try {
    envelope = JSON.parse(serializedEnvelope);
  } catch {
    throw new Error("Encrypted archive is not a valid envelope.");
  }
  if (!envelope || typeof envelope !== "object") {
    throw new Error("Encrypted archive is not a valid envelope.");
  }
  const value = envelope as Partial<ArchiveEnvelope>;
  if (value.format !== FORMAT || value.version !== VERSION || value.algorithm !== ALGORITHM) {
    throw new Error("Encrypted archive format or version is unsupported.");
  }

  const nonce = decodeCanonicalBase64(value.nonce, "nonce", NONCE_BYTES);
  const tag = decodeCanonicalBase64(value.tag, "authentication tag", TAG_BYTES);
  const ciphertext = decodeCanonicalBase64(value.ciphertext, "ciphertext");
  try {
    const decipher = createDecipheriv(ALGORITHM, key, nonce);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Encrypted archive authentication failed (wrong key or damaged file).");
  }
}

/**
 * Write an encrypted archive atomically without replacing an existing archive.
 * The temporary file and final hard link are in the same directory, so a
 * completed destination is never a partial write. A failed write leaves the
 * live database record untouched for the caller to retry.
 */
export function writeEncryptedArchive(filePath: string, plaintext: string, key: Buffer): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  );
  const envelope = encryptArchive(plaintext, key);
  let temporaryCreated = false;
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    temporaryCreated = true;
    try {
      fs.writeFileSync(fd, envelope, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // link() is atomic and fails with EEXIST rather than overwriting a prior
    // archive if two retain sweeps race or a previous run stopped mid-flight.
    fs.linkSync(temporary, filePath);
  } finally {
    if (temporaryCreated && fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
