/**
 * CR-08 (Phase 10): retention-archive encryption pins.
 *
 * Unit: key validation, round-trip byte equality, ciphertext opacity,
 * wrong-key/tamper/malformed-envelope rejection. Integration (subprocess,
 * scratch dirs only — never the real ./data): retain refuses without a
 * key, retain writes encrypted archives with a key, archive:encrypt
 * migrates verify-then-delete, archive:read round-trips.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "node:child_process";
import { Repo } from "../src/db/repo";
import { openDb } from "../src/db/db";
import { seedDefaults } from "../src/db/seed";
import { DEFAULT_REQUIREMENTS } from "../src/config";
import {
  ARCHIVE_ENC_SUFFIX,
  ArchiveDecryptError,
  ArchiveKeyError,
  decryptArchive,
  encryptArchive,
  loadArchiveKey,
} from "../src/archive/crypto";

/** Clearly-fake vector — NEVER use for real data (see ARCHIVE_ENCRYPTION.md). */
const TEST_KEY_HEX = "0123456789abcdef".repeat(4);
const TEST_KEY = Buffer.from(TEST_KEY_HEX, "hex");
const WRONG_KEY = Buffer.from("ff".repeat(32), "hex");
const PII = '{"name":"Zawadi Mwangi","id":"KE-661234","body":"my secret body <b>x</b>"}';

const REPO = path.resolve(__dirname, "..");
function runCli(script: string, args: string[], env: Record<string, string | undefined>) {
  return spawnSync("./node_modules/.bin/tsx", [script, ...args], {
    cwd: REPO,
    env: { ...process.env, ...env },
    timeout: 60_000,
    encoding: "utf8",
  });
}
/** Env with ARCHIVE_KEY guaranteed absent (dotenv reads .env, which has none). */
function noKeyEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, ...extra };
  delete env.ARCHIVE_KEY;
  return env;
}

describe("archive key loading", () => {
  it("accepts a 64-hex-char key", () => {
    expect(loadArchiveKey({ ARCHIVE_KEY: TEST_KEY_HEX })).toEqual(TEST_KEY);
  });
  it("refuses a missing key loudly", () => {
    expect(() => loadArchiveKey({})).toThrowError(ArchiveKeyError);
    expect(() => loadArchiveKey({})).toThrowError(/not set/);
  });
  it("refuses malformed keys (short / non-hex / wrong length)", () => {
    for (const bad of ["abc", "zz".repeat(32), "00".repeat(31), "00".repeat(33), "  "]) {
      expect(() => loadArchiveKey({ ARCHIVE_KEY: bad }), bad).toThrowError(ArchiveKeyError);
    }
  });
});

describe("envelope round-trip", () => {
  it("decrypt(encrypt(x)) === x byte-for-byte, string and Buffer", () => {
    expect(decryptArchive(encryptArchive(PII, TEST_KEY), TEST_KEY)).toBe(PII);
    const buf = Buffer.from(PII + " — ünïcodé ✓", "utf8");
    expect(Buffer.from(decryptArchive(encryptArchive(buf, TEST_KEY), TEST_KEY), "utf8").compare(buf)).toBe(0);
  });
  it("ciphertext reveals nothing: valid JSON envelope, no PII substrings, random IV", () => {
    const a = encryptArchive(PII, TEST_KEY);
    const b = encryptArchive(PII, TEST_KEY);
    const env = JSON.parse(a) as Record<string, unknown>;
    expect(env.v).toBe(1);
    expect(env.algo).toBe("aes-256-gcm");
    for (const marker of ["Zawadi", "KE-661234", "secret body", "<b>"]) {
      expect(a).not.toContain(marker);
    }
    expect(a).not.toBe(b); // fresh IV per file
  });
  it("wrong key fails on the auth tag — never wrong plaintext", () => {
    expect(() => decryptArchive(encryptArchive(PII, TEST_KEY), WRONG_KEY)).toThrowError(ArchiveDecryptError);
  });
  it("tampered tag / data / non-JSON / bad version all fail", () => {
    const env = JSON.parse(encryptArchive(PII, TEST_KEY)) as Record<string, string>;
    expect(() => decryptArchive(JSON.stringify({ ...env, tag: "00".repeat(16) }), TEST_KEY)).toThrowError(
      ArchiveDecryptError
    );
    const data = Buffer.from(env.data, "base64");
    data[0] ^= 0xff;
    expect(() => decryptArchive(JSON.stringify({ ...env, data: data.toString("base64") }), TEST_KEY)).toThrowError(
      ArchiveDecryptError
    );
    expect(() => decryptArchive("not json", TEST_KEY)).toThrowError(ArchiveDecryptError);
    expect(() => decryptArchive(JSON.stringify({ ...env, v: 999 }), TEST_KEY)).toThrowError(ArchiveDecryptError);
  });
});

describe("retain with encryption (subprocess, scratch DB)", () => {
  function scratchDbWithOldCase(): { dir: string; dbPath: string; ref: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr08-retain-"));
    const dbPath = path.join(dir, "t.sqlite");
    const r = new Repo(openDb(dbPath));
    seedDefaults(r);
    r.seedBaseRequirements(DEFAULT_REQUIREMENTS);
    const a = r.getOrCreateApplicant("old@example.ke", "t1");
    const old = new Date(Date.now() - 1000 * 24 * 3600_000).toISOString();
    (r as unknown as { db: { prepare: (q: string) => { run: (...x: unknown[]) => unknown } } }).db
      .prepare("UPDATE applicants SET lifecycle='completed', demo=0, updated_at=? WHERE id=?")
      .run(old, a.id);
    const full = r.getApplicant(a.id)!;
    return { dir, dbPath, ref: full.ref_number };
  }

  it("REFUSES without ARCHIVE_KEY: exit 2, loud message, zero side effects", () => {
    const { dir, dbPath } = scratchDbWithOldCase();
    const run = runCli("src/cli/retain.ts", [], noKeyEnv({ DB_PATH: dbPath, DISABLE_OCR: "1" }));
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/ARCHIVE_KEY/);
    expect(fs.existsSync(path.join(dir, "archive"))).toBe(false); // gate precedes mkdir
    const r2 = new Repo(openDb(dbPath));
    expect(r2.allApplicants(0).length).toBe(1); // nothing swept
  });

  it("writes an encrypted archive that decrypts to the full record", () => {
    const { dir, dbPath, ref } = scratchDbWithOldCase();
    const run = runCli("src/cli/retain.ts", [], { ARCHIVE_KEY: TEST_KEY_HEX, DB_PATH: dbPath, DISABLE_OCR: "1" });
    expect(run.status).toBe(0);
    const r2 = new Repo(openDb(dbPath));
    expect(r2.allApplicants(0).length).toBe(0);
    const files = fs.readdirSync(path.join(dir, "archive"));
    expect(files).toEqual([`${ref}${ARCHIVE_ENC_SUFFIX}`]);
    const encPath = path.join(dir, "archive", files[0]);
    expect(fs.statSync(encPath).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(encPath, "utf8")).not.toContain("old@example.ke");
    const record = JSON.parse(decryptArchive(fs.readFileSync(encPath, "utf8"), TEST_KEY)) as {
      applicant: { ref_number: string; email_address: string };
    };
    expect(record.applicant.ref_number).toBe(ref);
    expect(record.applicant.email_address).toBe("old@example.ke");
  });
});

describe("archive:encrypt migration + archive:read (subprocess, scratch dir)", () => {
  function scratchArchive(): { dir: string; originals: Map<string, Buffer> } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr08-mig-"));
    fs.mkdirSync(path.join(dir, "archive"), { recursive: true });
    const originals = new Map<string, Buffer>();
    for (const ref of ["RU-2026-000001", "RU-2026-000002"]) {
      const body = Buffer.from(JSON.stringify({ applicant: { ref_number: ref }, note: "PII siri-ya-kafara" }), "utf8");
      fs.writeFileSync(path.join(dir, "archive", `${ref}.json`), body);
      originals.set(ref, body);
    }
    return { dir, originals };
  }
  const dbEnv = (dir: string) => ({ DB_PATH: path.join(dir, "x.sqlite"), DISABLE_OCR: "1" });

  it("refuses without ARCHIVE_KEY and changes nothing", () => {
    const { dir } = scratchArchive();
    const run = runCli("src/cli/archiveEncrypt.ts", [], noKeyEnv(dbEnv(dir)));
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/ARCHIVE_KEY/);
    expect(fs.readdirSync(path.join(dir, "archive")).sort()).toEqual(["RU-2026-000001.json", "RU-2026-000002.json"]);
  });

  it("--dry-run lists actions and changes nothing", () => {
    const { dir } = scratchArchive();
    const run = runCli("src/cli/archiveEncrypt.ts", ["--dry-run"], { ARCHIVE_KEY: TEST_KEY_HEX, ...dbEnv(dir) });
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/would encrypt RU-2026-000001\.json/);
    expect(fs.readdirSync(path.join(dir, "archive")).sort()).toEqual(["RU-2026-000001.json", "RU-2026-000002.json"]);
  });

  it("encrypts verify-then-deletes; re-run is a no-op; reader round-trips", () => {
    const { dir, originals } = scratchArchive();
    const env = { ARCHIVE_KEY: TEST_KEY_HEX, ...dbEnv(dir) };
    const run = runCli("src/cli/archiveEncrypt.ts", [], env);
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/2 archive\(s\) encrypted and verified/);
    const after = fs.readdirSync(path.join(dir, "archive")).sort();
    expect(after).toEqual(["RU-2026-000001.json.enc", "RU-2026-000002.json.enc"]);
    for (const [ref, body] of originals) {
      const pt = Buffer.from(decryptArchive(fs.readFileSync(path.join(dir, "archive", `${ref}.json.enc`), "utf8"), TEST_KEY), "utf8");
      expect(pt.compare(body)).toBe(0);
      expect(fs.statSync(path.join(dir, "archive", `${ref}.json.enc`)).mode & 0o777).toBe(0o600);
    }
    // Re-run: nothing left to do.
    const rerun = runCli("src/cli/archiveEncrypt.ts", [], env);
    expect(rerun.status).toBe(0);
    expect(rerun.stdout).toMatch(/nothing to do/);
    // Reader: ref → original JSON on stdout.
    const read = runCli("src/cli/archiveRead.ts", ["RU-2026-000001"], env);
    expect(read.status).toBe(0);
    expect(read.stdout).toContain("RU-2026-000001");
    expect(read.stdout).toContain("PII siri-ya-kafara");
    // Reader with the wrong key fails; unknown ref fails.
    expect(runCli("src/cli/archiveRead.ts", ["RU-2026-000001"], { ...env, ARCHIVE_KEY: "ff".repeat(32) }).status).toBe(2);
    expect(runCli("src/cli/archiveRead.ts", ["RU-2099-000009"], env).status).toBe(2);
  });

  it("aborts before any write when a target envelope already exists", () => {
    const { dir, originals } = scratchArchive();
    fs.writeFileSync(path.join(dir, "archive", "RU-2026-000001.json.enc"), "stale-envelope");
    const run = runCli("src/cli/archiveEncrypt.ts", [], { ARCHIVE_KEY: TEST_KEY_HEX, ...dbEnv(dir) });
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/already exists/);
    // Nothing touched: both plaintexts intact, no second envelope.
    expect(fs.readFileSync(path.join(dir, "archive", "RU-2026-000001.json")).compare(originals.get("RU-2026-000001")!)).toBe(0);
    expect(fs.existsSync(path.join(dir, "archive", "RU-2026-000002.json.enc"))).toBe(false);
    expect(fs.readFileSync(path.join(dir, "archive", "RU-2026-000001.json.enc"), "utf8")).toBe("stale-envelope");
  });
});
