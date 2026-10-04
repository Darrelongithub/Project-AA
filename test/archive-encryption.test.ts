import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "node:child_process";
import {
  decryptArchive,
  encryptArchive,
  parseArchiveEncryptionKey,
  writeEncryptedArchive,
} from "../src/util/archiveCrypto";

const keyHex = "5a".repeat(32);
const key = parseArchiveEncryptionKey(keyHex);
const temporaryDirectories: string[] = [];

function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "project-aa-archive-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("retention archive encryption", () => {
  it("accepts only a 32-byte external key (canonical base64 or 64 hex characters)", () => {
    const bytes = Buffer.from("archive-key-material-32-bytes!!!").subarray(0, 32);
    expect(parseArchiveEncryptionKey(bytes.toString("base64"))).toEqual(bytes);
    expect(parseArchiveEncryptionKey(bytes.toString("hex"))).toEqual(bytes);
    expect(() => parseArchiveEncryptionKey(undefined)).toThrow(/required/);
    expect(() => parseArchiveEncryptionKey("too-short")).toThrow(/32 bytes/);
    expect(() => parseArchiveEncryptionKey("!".repeat(64))).toThrow(/canonical base64/);
  });

  it("round-trips authenticated ciphertext without exposing archive contents", () => {
    const plaintext = JSON.stringify({ applicant: { email: "person@example.test" }, body: "sensitive" });
    const envelope = encryptArchive(plaintext, key);
    expect(envelope).not.toContain("person@example.test");
    expect(envelope).not.toContain("sensitive");
    expect(decryptArchive(envelope, key)).toBe(plaintext);
    expect(encryptArchive(plaintext, key)).not.toBe(envelope); // fresh random nonce
  });

  it("rejects wrong keys, tampering, malformed envelopes and unsupported versions", () => {
    const envelope = JSON.parse(encryptArchive('{"private":true}', key)) as Record<string, unknown>;
    expect(() => decryptArchive(JSON.stringify(envelope), Buffer.alloc(32, 0x33))).toThrow(/authentication failed/);

    const tampered = { ...envelope, ciphertext: Buffer.from("altered ciphertext").toString("base64") };
    expect(() => decryptArchive(JSON.stringify(tampered), key)).toThrow(/authentication failed/);
    expect(() => decryptArchive("not json", key)).toThrow(/valid envelope/);
    expect(() => decryptArchive(JSON.stringify({ ...envelope, version: 99 }), key)).toThrow(/unsupported/);
  });

  it("writes private ciphertext atomically and refuses to overwrite an archive", () => {
    const directory = tempDir();
    const destination = path.join(directory, "CASE-1.json.enc");
    const plaintext = '{"case":"sensitive"}';
    writeEncryptedArchive(destination, plaintext, key);

    const envelope = fs.readFileSync(destination, "utf8");
    expect(envelope).not.toContain("sensitive");
    expect(decryptArchive(envelope, key)).toBe(plaintext);
    if (process.platform !== "win32") expect(fs.statSync(destination).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(directory)).toEqual(["CASE-1.json.enc"]);
    expect(() => writeEncryptedArchive(destination, "replacement", key)).toThrow();
    expect(decryptArchive(fs.readFileSync(destination, "utf8"), key)).toBe(plaintext);
  });

  it("migrates plaintext archives to verified siblings and preserves every source", () => {
    const directory = tempDir();
    const source = path.join(directory, "CASE-2.json");
    const destination = `${source}.enc`;
    const plaintext = '{\n  "case": "keep-original-until-reviewed"\n}\n';
    fs.writeFileSync(source, plaintext, { mode: 0o600 });

    const first = spawnSync("./node_modules/.bin/tsx", ["src/cli/archiveMigrate.ts", directory], {
      cwd: path.resolve(__dirname, ".."),
      env: { ...process.env, ARCHIVE_ENCRYPTION_KEY: keyHex },
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain("1 encrypted and verified");
    expect(first.stdout).toContain("plaintext source files were preserved");
    expect(fs.readFileSync(source, "utf8")).toBe(plaintext);
    expect(decryptArchive(fs.readFileSync(destination, "utf8"), key)).toBe(plaintext);
    if (process.platform !== "win32") expect(fs.statSync(destination).mode & 0o777).toBe(0o600);

    const second = spawnSync("./node_modules/.bin/tsx", ["src/cli/archiveMigrate.ts", directory], {
      cwd: path.resolve(__dirname, ".."),
      env: { ...process.env, ARCHIVE_ENCRYPTION_KEY: keyHex },
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain("1 already verified");
    expect(fs.readFileSync(source, "utf8")).toBe(plaintext);
  });

  it("decrypts only to an explicit new private path, without overwriting or logging PII", () => {
    const directory = tempDir();
    const source = path.join(directory, "CASE-3.json.enc");
    const destination = path.join(directory, "review-copy.json");
    const plaintext = '{"email":"private@example.test"}';
    writeEncryptedArchive(source, plaintext, key);

    const result = spawnSync("./node_modules/.bin/tsx", ["src/cli/archiveDecrypt.ts", source, destination], {
      cwd: path.resolve(__dirname, ".."),
      env: { ...process.env, ARCHIVE_ENCRYPTION_KEY: keyHex },
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(destination, "utf8")).toBe(plaintext);
    expect(result.stdout).not.toContain("private@example.test");
    if (process.platform !== "win32") expect(fs.statSync(destination).mode & 0o777).toBe(0o600);

    const repeated = spawnSync("./node_modules/.bin/tsx", ["src/cli/archiveDecrypt.ts", source, destination], {
      cwd: path.resolve(__dirname, ".."),
      env: { ...process.env, ARCHIVE_ENCRYPTION_KEY: keyHex },
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(repeated.status).not.toBe(0);
    expect(fs.readFileSync(destination, "utf8")).toBe(plaintext);
  });
});
