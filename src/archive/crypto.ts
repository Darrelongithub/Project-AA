/**
 * CR-08: retention-archive encryption (Phase 10).
 *
 * Retention archives hold full case PII (email bodies, ID numbers). Since
 * Phase 8 they are written 0600 inside a 0700 directory (BH-35); this module
 * adds the encryption layer: AES-256-GCM via node:crypto, no new deps.
 *
 * Envelope (JSON, written as `<ref>.json.enc`):
 *   { v: 1, algo: "aes-256-gcm", iv: hex12, tag: hex16, data: base64 }
 * A fresh random 96-bit IV per file; the GCM auth tag rejects wrong keys
 * and tampered files. `v` reserves room for future algorithm rotation.
 *
 * Key: ARCHIVE_KEY, 32 bytes as 64 hex chars, from the environment (see
 * ARCHIVE_ENCRYPTION.md). It deliberately lives OUTSIDE the database: the
 * settings table is plaintext, so storing the key there would add nothing.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const ARCHIVE_ENVELOPE_VERSION = 1;
export const ARCHIVE_ALGO = "aes-256-gcm";
/** On-disk suffix for encrypted archives (plaintext was `<ref>.json`). */
export const ARCHIVE_ENC_SUFFIX = ".json.enc";

export class ArchiveKeyError extends Error {}
export class ArchiveDecryptError extends Error {}

/**
 * Load and strictly validate the archive key. Throws ArchiveKeyError when
 * the key is missing or malformed — callers turn that into a loud refusal
 * (exit 2, nothing written). There is no plaintext fallback by design.
 */
export function loadArchiveKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = (env.ARCHIVE_KEY ?? "").trim();
  if (!raw) {
    throw new ArchiveKeyError(
      "ARCHIVE_KEY is not set — refusing to touch archives without encryption. " +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\" " +
        "(see ARCHIVE_ENCRYPTION.md)."
    );
  }
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new ArchiveKeyError("ARCHIVE_KEY must be exactly 64 hex characters (32 bytes).");
  }
  return Buffer.from(raw, "hex");
}

interface ArchiveEnvelope {
  v: number;
  algo: string;
  iv: string;
  tag: string;
  data: string;
}

/** Encrypt one archive payload; returns the JSON envelope string. */
export function encryptArchive(plaintext: string | Buffer, key?: Buffer): string {
  const k = key ?? loadArchiveKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ARCHIVE_ALGO, k, iv);
  const pt = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const envelope: ArchiveEnvelope = {
    v: ARCHIVE_ENVELOPE_VERSION,
    algo: ARCHIVE_ALGO,
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    data: ct.toString("base64"),
  };
  return JSON.stringify(envelope);
}

/**
 * Decrypt an envelope back to the original UTF-8 payload. Throws
 * ArchiveDecryptError on malformed envelopes, wrong keys (GCM auth-tag
 * mismatch) and tampered files — never returns wrong plaintext.
 */
export function decryptArchive(envelopeText: string, key?: Buffer): string {
  const k = key ?? loadArchiveKey();
  let env: ArchiveEnvelope;
  try {
    env = JSON.parse(envelopeText) as ArchiveEnvelope;
  } catch {
    throw new ArchiveDecryptError("not a valid archive envelope (not JSON — plaintext? see archive:encrypt).");
  }
  if (
    env?.v !== ARCHIVE_ENVELOPE_VERSION ||
    env?.algo !== ARCHIVE_ALGO ||
    typeof env?.iv !== "string" ||
    typeof env?.tag !== "string" ||
    typeof env?.data !== "string"
  ) {
    throw new ArchiveDecryptError("unsupported archive envelope (bad version/algorithm/shape).");
  }
  try {
    const decipher = createDecipheriv(ARCHIVE_ALGO, k, Buffer.from(env.iv, "hex"));
    decipher.setAuthTag(Buffer.from(env.tag, "hex"));
    const pt = Buffer.concat([decipher.update(Buffer.from(env.data, "base64")), decipher.final()]);
    return pt.toString("utf8");
  } catch (e) {
    if (e instanceof ArchiveDecryptError) throw e;
    throw new ArchiveDecryptError(`decryption failed — wrong key or corrupted file (${(e as Error).message}).`);
  }
}
