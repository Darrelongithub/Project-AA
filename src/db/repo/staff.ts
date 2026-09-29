/**
 * /db/repo — staff, permissions, sessions and reset codes. Extracted verbatim from the Repo god class;
 * every function takes the Repo as its first argument and the Repo
 * facade in ../repo.ts delegates to it (same API, same behaviour).
 */
import * as crypto from "crypto";
import { PERMISSIONS, Permission, StaffUser } from "../../types";
import type { Repo } from "../repo";

// ── Applicants ───────────────────────────────────────────────────────────
/** How many staff accounts exist (drives the first-run setup gate). */
export function staffCount(repo: Repo): number {
  return ((repo.db.prepare("SELECT COUNT(*) AS n FROM staff_users").get() as { n: number }).n);
}


// ── Staff users & sessions (features 31, 32) ─────────────────────────────
/**
 * H-2: the account belongs to a REAL tenant — never a hard-coded one.
 * `organizationId` defaults to 1 for the first-run admin (the only case
 * where no tenant exists yet), but every staff-adding route passes the
 * acting administrator's own organization.
 */
export function createStaff(repo: Repo, username: string, displayName: string, passwordHash: string, role: string, demo = false, organizationId = 1): void {
  repo.db
    .prepare(
      "INSERT INTO staff_users (username, display_name, password_hash, role, demo, organization_id) VALUES (?,?,?,?,?,?)"
    )
    .run(username, displayName, passwordHash, role, demo ? 1 : 0, organizationId);
}


export function createStaffAndReturn(repo: Repo,
  username: string,
  displayName: string,
  passwordHash: string,
  role: "admin" | "user" = "user",
  organizationId = 1
): StaffUser {
  repo.createStaff(username, displayName, passwordHash, role, false, organizationId);
  return repo.getStaffByUsername(username)!;
}


// ── PPR P1-8: fine-grained automation permissions ───────────────────────
// The four actions that used to hide behind the admin/user role split are
// distinct permissions now. Admins implicitly hold all four; other staff
// hold exactly what is granted, defaulting to the two sending-related ones
// (sending replies and approving automation were always staff work).
export function permissionsFor(repo: Repo, staffId: number): string[] {
  return (repo.db.prepare("SELECT permission FROM staff_permissions WHERE staff_id = ?").all(staffId) as Array<{ permission: string }>).map((r) => r.permission);
}


export function setPermissions(repo: Repo, staffId: number, permissions: string[]): void {
  repo.db.prepare("DELETE FROM staff_permissions WHERE staff_id = ?").run(staffId);
  const insert = repo.db.prepare("INSERT OR IGNORE INTO staff_permissions (staff_id, permission) VALUES (?, ?)");
  for (const p of permissions) {
    if (PERMISSIONS.includes(p as Permission)) insert.run(staffId, p);
  }
}


export function hasPermission(repo: Repo, staffId: number, permission: Permission): boolean {
  const staff = repo.getStaff(staffId);
  if (!staff) return false;
  if (staff.role === "admin") return true;
  const rows = repo.db.prepare("SELECT COUNT(*) AS n FROM staff_permissions WHERE staff_id = ?").get(staffId) as { n: number };
  if (rows.n > 0) {
    return (repo.db.prepare("SELECT 1 FROM staff_permissions WHERE staff_id = ? AND permission = ?").get(staffId, permission)) !== undefined;
  }
  // No explicit grants yet: the historical default — regular staff may
  // send replies and approve automation; publishing rules and recording
  // outcomes need an explicit grant.
  return permission === "send_automated" || permission === "approve_automation";
}


/** Rename an account (e.g. giving the demo admin a human name). */
export function setStaffDisplayName(repo: Repo, id: number, displayName: string): void {
  repo.db.prepare("UPDATE staff_users SET display_name = ? WHERE id = ?").run(displayName, id);
}


/**
 * M-2: usernames have one canonical case (lowercase, see util/username.ts)
 * and are matched case-insensitively, so an account created before the rule
 * still resolves whichever way it is typed.
 */
export function getStaffByUsername(repo: Repo, username: string): (StaffUser & { password_hash: string }) | undefined {
  return repo.db
    .prepare("SELECT id, username, display_name, password_hash, role, active, demo, organization_id FROM staff_users WHERE username = ? COLLATE NOCASE")
    .get(username) as never;
}


export function getStaff(repo: Repo, id: number): StaffUser | undefined {
  return repo.db
    .prepare("SELECT id, username, display_name, role, active, demo, organization_id FROM staff_users WHERE id = ?")
    .get(id) as StaffUser | undefined;
}


export function listStaff(repo: Repo, organizationId?: number): StaffUser[] {
  const sql = organizationId === undefined
    ? "SELECT id, username, display_name, role, active, demo, organization_id FROM staff_users ORDER BY id"
    : "SELECT id, username, display_name, role, active, demo, organization_id FROM staff_users WHERE COALESCE(organization_id, 1) = ? ORDER BY id";
  return (organizationId === undefined
    ? repo.db.prepare(sql).all()
    : repo.db.prepare(sql).all(organizationId)) as StaffUser[];
}


/**
 * H-3: cross-tenant guard. Resolve a staff id ONLY when the account belongs
 * to the acting administrator's organization — the single entry point every
 * /staff/* route uses before acting on a target id.
 */
export function staffInOrganization(repo: Repo, staffId: number, organizationId: number): StaffUser | undefined {
  const staff = repo.getStaff(staffId);
  if (!staff) return undefined;
  return (staff.organization_id ?? 1) === organizationId ? staff : undefined;
}


export function setStaffUsername(repo: Repo, id: number, username: string): void {
  repo.db.prepare("UPDATE staff_users SET username = ? WHERE id = ?").run(username, id);
}


export function setStaffPassword(repo: Repo, id: number, passwordHash: string): void {
  repo.db.prepare("UPDATE staff_users SET password_hash = ? WHERE id = ?").run(passwordHash, id);
}


export function setStaffActive(repo: Repo, id: number, active: boolean): void {
  repo.db.prepare("UPDATE staff_users SET active = ? WHERE id = ?").run(active ? 1 : 0, id);
}


export function createSession(repo: Repo, staffId: number): { token: string; csrf: string; expiresAt: string } {
  // Expired rows were previously only purged at boot; purge on every login so
  // the table can't grow without bound on a long-running server.
  repo.purgeExpiredSessions();
  const token = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(16).toString("hex");
  const expiresAt = new Date(Date.now() + 8 * 3600_000).toISOString();
  repo.db
    .prepare("INSERT INTO sessions (token, staff_id, csrf, expires_at) VALUES (?,?,?,?)")
    .run(token, staffId, csrf, expiresAt);
  return { token, csrf, expiresAt };
}


export function getSession(repo: Repo, token: string): { staff: StaffUser; csrf: string } | undefined {
  const row = repo.db
    .prepare(
      `SELECT s.csrf AS csrf, s.expires_at AS expires_at, u.id AS id, u.username AS username,
              u.display_name AS display_name, u.role AS role, u.active AS active, u.demo AS demo,
              u.organization_id AS organization_id, u.active_organization_id AS active_organization_id
       FROM sessions s JOIN staff_users u ON u.id = s.staff_id
       WHERE s.token = ?`
    )
    .get(token) as any;
  if (!row) return undefined;
  if (new Date(row.expires_at).getTime() < Date.now() || row.active !== 1) return undefined;
  return {
    csrf: row.csrf,
    staff: (() => {
      const home = row.organization_id ?? null;
      const canSwitch = row.role === "admin" && (home === null || home === 1);
      const active = canSwitch && row.active_organization_id && repo.getOrganization(row.active_organization_id) ? row.active_organization_id : home;
      return { id: row.id, username: row.username, display_name: row.display_name, role: row.role, active: row.active, demo: row.demo, organization_id: active, can_switch_org: canSwitch };
    })(),
  };
}


export function deleteSession(repo: Repo, token: string): void {
  repo.db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}


/**
 * One-time admin-issued password reset codes (forgot password).
 *
 * The code is shown exactly ONCE, in the issuing admin's response body
 * (never a URL — no history/referrer leakage), and travels out-of-band
 * to the member. It is valid until `expires_at`, is revoked the moment a
 * newer code is issued for the same member, and is consumed exactly once
 * by the public reset route.
 */
export function issueResetCode(repo: Repo, staffId: number, issuedBy: string, ttlMs = 30 * 60_000): string {
  // No 0/O/1/I — codes get read over the phone and typed from WhatsApp.
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let code = "";
  for (;;) {
    code = Array.from(crypto.randomBytes(10)).map((b) => alphabet[b % alphabet.length]).join("");
    if (!repo.db.prepare("SELECT 1 FROM password_reset_codes WHERE code = ?").get(code)) break;
  }
  const now = new Date().toISOString();
  repo.db
    .transaction(() => {
      repo.db
        .prepare("UPDATE password_reset_codes SET revoked_at = ? WHERE staff_id = ? AND used_at IS NULL AND revoked_at IS NULL")
        .run(now, staffId);
      repo.db
        .prepare("INSERT INTO password_reset_codes (code, staff_id, issued_by, expires_at) VALUES (?,?,?,?)")
        .run(code, staffId, issuedBy, new Date(Date.now() + ttlMs).toISOString());
    })();
  return code;
}


/**
 * Atomically consume a code. Returns the member id it belongs to, or null
 * when the code is unknown, revoked, expired, or already used. The UPDATE
 * is the single point of claim, so two racing redemptions can't both win.
 */
export function consumeResetCode(repo: Repo, code: string): number | null {
  const trimmed = code.trim().toUpperCase();
  const now = new Date().toISOString();
  const r = repo.db
    .prepare("UPDATE password_reset_codes SET used_at = ? WHERE code = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?")
    .run(now, trimmed, now);
  if (Number(r.changes) === 0) return null;
  const row = repo.db.prepare("SELECT staff_id FROM password_reset_codes WHERE code = ?").get(trimmed) as { staff_id: number };
  return row.staff_id;
}


/** End every live session of a member (always run after their password changes). */
export function purgeStaffSessions(repo: Repo, staffId: number): number {
  const r = repo.db.prepare("DELETE FROM sessions WHERE staff_id = ?").run(staffId);
  return Number(r.changes);
}


/** End every session for the staffer EXCEPT the one holding `keepToken` —
 * a self-service password change must kill a thief's sessions without
 * signing the changer out mid-flow. */
export function purgeStaffSessionsExcept(repo: Repo, staffId: number, keepToken: string): number {
  const r = repo.db.prepare("DELETE FROM sessions WHERE staff_id = ? AND token <> ?").run(staffId, keepToken);
  return Number(r.changes);
}


export function purgeExpiredSessions(repo: Repo): void {
  repo.db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(new Date().toISOString());
}


/** Switch an admin's active organization (the sidebar switcher). */
export function setActiveOrganization(repo: Repo, staffId: number, organizationId: number): void {
  if (!repo.getOrganization(organizationId)) throw new Error("Unknown organization");
  repo.db.prepare("UPDATE staff_users SET active_organization_id = ? WHERE id = ?").run(organizationId, staffId);
}
