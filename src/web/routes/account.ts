/**
 * account routes. Extracted verbatim from server.ts createApp;
 * shared closure state arrives via RouteCtx — behavior unchanged.
 */
import type { Express } from "express";
import { accountPage } from "../pages";
import { csrfCheck, requireLogin } from "../auth";
import { hashPassword, verifyPassword } from "../../util/password";
import { USERNAME_RE, normalizeUsername } from "../../util/username";
import type { RouteCtx } from "./ctx";

export function registerAccount(app: Express, rt: RouteCtx): void {
  // ── Team performance (staff listener) ────────────────────────────────────

  app.get("/team", requireLogin, (_req, res) => res.redirect("/staff"));

  // ── Notifications ────────────────────────────────────────────────────────

  app.get("/notifications", requireLogin, (req, res) => {
    // Alerts now live on the Overview page; opening the old link still clears them.
    rt.repo.markNotificationsRead(req.staff!.id);
    res.redirect("/#alerts");
  });

  app.post("/notifications/read-all", requireLogin, csrfCheck, (req, res) => {
    rt.repo.markNotificationsRead(req.staff!.id);
    res.redirect("/#alerts");
  });

  // ── Account (self-service, every signed-in user) ─────────────────────────

  app.get("/account", requireLogin, (req, res) =>
    res.send(accountPage(rt.c(req), req.query.msg ? String(req.query.msg) : undefined))
  );

  const accountMsg = (m: string) => `/account?msg=${encodeURIComponent(m)}`;

  // M-2: the same normalization + pattern as /setup and /staff/add. (This
  // route previously accepted ANY string of 3+ characters — spaces, upper
  // case, symbols — so the account it produced could not be re-typed
  // consistently anywhere else.)
  app.post("/account/username", requireLogin, csrfCheck, (req, res) => {
    const next = normalizeUsername(req.body.username);
    if (!USERNAME_RE.test(next)) {
      return res.redirect(accountMsg("Usernames: 2-32 characters — letters, digits, dots, dashes."));
    }
    const clash = rt.repo.getStaffByUsername(next);
    if (clash && clash.id !== req.staff!.id) return res.redirect(accountMsg(`“${next}” is already taken by another account.`));
    rt.repo.setStaffUsername(req.staff!.id, next);
    rt.repo.audit(null, next, "account_username_changed", `was “${req.staff!.username}”`);
    res.redirect(accountMsg("Username updated."));
  });

  app.post("/account/password", requireLogin, csrfCheck, (req, res) => {
    const me = rt.repo.getStaffByUsername(req.staff!.username);
    if (!me) return res.redirect(accountMsg("Account not found."));
    const current = String(req.body.current ?? "");
    const next = String(req.body.next ?? "");
    const confirm = String(req.body.confirm ?? "");
    if (!verifyPassword(current, me.password_hash)) return res.redirect(accountMsg("Your current password was incorrect."));
    if (next.length < 8) return res.redirect(accountMsg("New password must be at least 8 characters."));
    if (next !== confirm) return res.redirect(accountMsg("New passwords did not match."));
    rt.repo.setStaffPassword(me.id, hashPassword(next));
    rt.repo.audit(null, me.username, "account_password_changed", "self-service password change");
    res.redirect(accountMsg("Password changed."));
  });

  app.post("/account/theme", requireLogin, csrfCheck, (req, res) => {
    const t = req.body.theme === "dark" ? "dark" : "light";
    res.setHeader("Set-Cookie", `theme=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${365 * 86400}`);
    res.redirect(accountMsg(`Theme set to ${t} mode.`));
  });
}
