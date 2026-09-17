/**
 * Auth: DB-backed sessions, scrypt password verification, CSRF tokens,
 * role guards (feature 31, 32). No external auth services — portable.
 *
 * Roles:
 *   admin   — everything incl. staff management, settings, backup
 *   manager — case actions + requirements/templates/programmes config, export
 *   officer — view + case actions (no configuration)
 */
import type { NextFunction, Request, Response } from "express";
import type { Repo } from "../db/repo";
import type { StaffUser } from "../types";
import { verifyPassword } from "../util/password";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      staff?: StaffUser;
      csrfToken?: string;
      sessionId?: string;
      theme?: "light" | "dark";
    }
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) continue;
    // decodeURIComponent THROWS on malformed percent-escapes ("sid=%zz").
    // This runs in middleware on every request — an unguarded throw there
    // turns one poisoned cookie into a 500 on every page.
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export function sessionCookie(token: string, maxAgeSec: number): string {
  return `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

export function clearSessionCookie(): string {
  return "sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
}

export function authMiddleware(repo: Repo) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const cookies = parseCookies(req.headers.cookie);
    req.theme = cookies["theme"] === "dark" ? "dark" : "light";
    const sid = cookies["sid"];
    if (sid) {
      const session = repo.getSession(sid);
      if (session) {
        req.staff = session.staff;
        req.csrfToken = session.csrf;
        req.sessionId = sid;
      }
    }
    next();
  };
}

export function requireLogin(req: Request, res: Response, next: NextFunction): void {
  if (!req.staff) {
    res.redirect("/login");
    return;
  }
  next();
}

export function requireRole(...roles: Array<StaffUser["role"]>) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.staff) {
      res.redirect("/login");
      return;
    }
    if (!roles.includes(req.staff.role)) {
      res.status(403).send("403 — your role does not permit this action.");
      return;
    }
    next();
  };
}

/** CSRF check for all state-changing POSTs from authenticated staff. */
export function csrfCheck(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== "POST") return next();
  const provided = (req.body && req.body._csrf) || req.headers["x-csrf-token"];
  if (!req.staff || !req.csrfToken || provided !== req.csrfToken) {
    res.status(403).send("403 — CSRF validation failed.");
    return;
  }
  next();
}

export function loginAttempt(repo: Repo, username: string, password: string): StaffUser | null {
  const row = repo.getStaffByUsername(username.trim());
  if (!row || row.active !== 1) return null;
  if (!verifyPassword(password, row.password_hash)) return null;
  return { id: row.id, username: row.username, display_name: row.display_name, role: row.role as StaffUser["role"], active: row.active, demo: row.demo };
}
