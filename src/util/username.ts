/**
 * M-2: ONE username rule, shared by every write path.
 *
 * `/setup`, `/staff/add` and `/account/username` used to disagree (one
 * lowercased, one accepted mixed case, one only checked a length), while
 * `getStaffByUsername` matched case-sensitively — so "Admin" and "admin"
 * could both exist and only the exact spelling could sign in.
 *
 * The single rule: trim, lowercase, and match /^[a-z0-9_.-]{2,32}$/.
 * Storage and lookups are both canonical (lookups use COLLATE NOCASE so
 * rows written before this rule still resolve), and the migration in
 * `src/db/db.ts` folds any existing mixed-case usernames to lowercase once.
 */
export const USERNAME_RE = /^[a-z0-9_.-]{2,32}$/;

/** The canonical form of a username: trimmed + lowercase. */
export function normalizeUsername(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase();
}

/** True when the raw value satisfies the one shared rule. */
export function isValidUsername(raw: unknown): boolean {
  return USERNAME_RE.test(normalizeUsername(raw));
}
