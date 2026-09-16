/**
 * Password hashing with Node's built-in scrypt — no extra dependencies,
 * constant-time comparison on verify.
 */
import * as crypto from "crypto";

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, salt, hash] = stored.split(":");
    if (scheme !== "scrypt" || !salt || !hash) return false;
    const check = crypto.scryptSync(password, salt, 64);
    const expected = Buffer.from(hash, "hex");
    return check.length === expected.length && crypto.timingSafeEqual(check, expected);
  } catch {
    return false;
  }
}
