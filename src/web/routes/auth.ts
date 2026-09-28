/**
 * auth routes. Extracted verbatim from server.ts createApp;
 * shared closure state arrives via RouteCtx — behavior unchanged.
 */
import * as crypto from "crypto";
import type { Express, Response } from "express";
import { loginPage, resetPasswordPage, setupPage } from "../pages";
import { clearSessionCookie, csrfCheck, loginAttempt, parseCookies, sessionCookie } from "../auth";
import { hashPassword } from "../../util/password";
import { USERNAME_RE, normalizeUsername } from "../../util/username";
import { LoginThrottle } from "../throttle";
import type { RouteCtx } from "./ctx";

export function registerAuth(app: Express, rt: RouteCtx): void {
  // OR-1: on a fresh install the whole console reduces to one screen — the
  // first-run setup where the owner creates their own admin account.
  const setupTokens = new Map<string, number>(); // one-time token -> expiry (epoch ms)
  const newSetupToken = (): string => {
    const t = crypto.randomBytes(16).toString("hex");
    setupTokens.set(t, Date.now() + 10 * 60_000);
    for (const [k, exp] of setupTokens) if (exp < Date.now()) setupTokens.delete(k);
    return t;
  };

  app.use((req, res, next) => {
    if (rt.repo.staffCount() === 0 && req.path !== "/setup" && req.path !== "/healthz" && req.path !== "/theme") {
      res.redirect("/setup");
      return;
    }
    next();
  });

  app.get("/setup", (req, res) => {
    if (rt.repo.staffCount() > 0) {
      res.status(404).send("Not found");
      return;
    }
    res.send(setupPage(newSetupToken(), undefined, req.theme, rt.authName()));
  });

  app.post("/setup", (req, res) => {
    if (rt.repo.staffCount() > 0) {
      res.status(404).send("Not found");
      return;
    }
    const fail = (msg: string) => res.status(200).send(setupPage(newSetupToken(), msg, req.theme, rt.authName()));
    const token = String(req.body._setup ?? "");
    const exp = setupTokens.get(token);
    setupTokens.delete(token);
    if (!exp || exp < Date.now()) return fail("That setup link expired — reload the page and try again.");
    // M-2: one shared rule — normalizeUsername() + USERNAME_RE — used by
    // /setup, /staff/add and /account/username alike.
    const username = normalizeUsername(req.body.username);
    const displayName = String(req.body.display_name ?? "").trim();
    const password = String(req.body.password ?? "");
    const confirm = String(req.body.confirm ?? "");
    if (!displayName) return fail("Please enter your name.");
    if (!USERNAME_RE.test(username)) return fail("Username: 2-32 characters — letters, digits, dots, dashes.");
    if (password.length < 8) return fail("Password must be at least 8 characters.");
    if (password !== confirm) return fail("The passwords do not match.");
    if (rt.repo.getStaffByUsername(username)) return fail("That username is already taken.");
    rt.repo.createStaff(username, displayName, hashPassword(password), "admin");
    const created = rt.repo.getStaffByUsername(username);
    if (!created) return fail("Could not create the account — please try again.");
    const session = rt.repo.createSession(created.id);
    rt.repo.audit(null, username, "first_run_setup", "Administrator account created on first run");
    res.setHeader("Set-Cookie", sessionCookie(session.token, 8 * 3600, secureCookies));
    res.redirect("/");
  });

  // Login-CSRF defence (double-submit): the sign-in form echoes a token the
  // server also sets as a cookie. A cross-site forged login POST cannot read
  // that cookie, so it cannot supply the matching field. Set `COOKIE_SECURE=1`
  // behind TLS so the session cookie is never sent over plain HTTP.
  const secureCookies = process.env.COOKIE_SECURE === "1";
  const newLoginCsrf = (res: Response): string => {
    const t = crypto.randomBytes(16).toString("hex");
    res.setHeader("Set-Cookie", `lcsrf=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`);
    return t;
  };

  app.get("/login", (req, res) => {
    if (rt.repo.staffCount() === 0) {
      res.redirect("/setup");
      return;
    }
    // ?msg= carries the one success notice (password just reset via code).
    res.send(loginPage(undefined, req.theme, rt.authName(), newLoginCsrf(res), req.query.msg ? String(req.query.msg) : undefined));
  });

  /** Theme toggle — persisted in a cookie so it survives sessions & works on public pages. */
  app.post("/theme", (req, res) => {
    const next = req.theme === "dark" ? "light" : "dark";
    res.setHeader("Set-Cookie", `theme=${next}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${365 * 86400}`);
    // Redirect back to where the toggle was pressed — but ONLY to a relative
    // path on this host. The raw Referer was an open redirect: any external
    // URL a visitor came from would be sent straight back to the client.
    const back = req.get("referer") ?? "";
    let target = "/";
    try {
      const url = new URL(back);
      if (url.origin === `${req.protocol}://${req.get("host")}` && url.pathname.startsWith("/") && !url.pathname.startsWith("//")) {
        target = url.pathname;
      }
    } catch {
      /* not a URL → stay on "/" */
    }
    res.redirect(target);
  });

  // Failed-logins-only limiter: 10 failures per IP per minute blocks further
  // attempts. Only FAILURES count, so legitimate users are never locked out
  // by normal use. Time-based expiry + oldest-first eviction above the entry
  // cap — never a bulk clear (see src/web/throttle.ts).
  const loginFails = new LoginThrottle();
  const loginBlocked = (ip: string): boolean => !loginFails.allowed(ip);
  const loginRecordFail = (ip: string): void => {
    loginFails.recordFail(ip);
  };

  app.post("/login", (req, res) => {
    const ip = req.ip ?? "?";
    if (loginBlocked(ip)) {
      res.status(429).send(loginPage("Too many failed sign-ins from this address — please wait a minute.", req.theme, rt.authName(), newLoginCsrf(res)));
      return;
    }
    // Login-CSRF: the token the page rendered must come back in the body AND
    // match the cookie. A mismatch means the form was forged or stale.
    const provided = String(req.body._lcsrf ?? "");
    const cookieToken = parseCookies(req.headers.cookie)["lcsrf"] ?? "";
    if (!provided || provided !== cookieToken) {
      res.status(403).send(loginPage("That sign-in page expired — please try again.", req.theme, rt.authName(), newLoginCsrf(res)));
      return;
    }
    const staff = loginAttempt(rt.repo, String(req.body.username ?? ""), String(req.body.password ?? ""));
    if (!staff) {
      loginRecordFail(ip);
      res.status(401).send(loginPage("Invalid username or password.", req.theme, rt.authName(), newLoginCsrf(res)));
      return;
    }
    const session = rt.repo.createSession(staff.id);
    rt.repo.audit(null, staff.username, "staff_login", "");
    res.setHeader("Set-Cookie", sessionCookie(session.token, 8 * 3600, secureCookies));
    res.redirect("/");
  });

  // Logout mutates auth state, so it needs CSRF like every other mutation —
  // otherwise a cross-site 1-pixel form could sign staff out mid-crisis.
  app.post("/logout", csrfCheck, (req, res) => {
    if (req.sessionId) rt.repo.deleteSession(req.sessionId);
    res.setHeader("Set-Cookie", clearSessionCookie());
    res.redirect("/login");
  });

  // ── Forgot password — one-time code issued by an admin ─────────────────
  // Per the owner's direction there is no email in the loop: the admin
  // issues a code on the staff page (shown once, in the response body —
  // never a URL, so it can't leak into history or a Referer) and hands it
  // to the member out-of-band; the member redeems it here. Codes are
  // single-use, expire in 30 minutes, are revoked by a newer issue, and
  // every failure returns the SAME generic refusal (no account
  // enumeration). The public endpoint is rate-limited per IP.
  const resetThrottle = new LoginThrottle({ windowMs: 10 * 60_000, maxFails: 5 });

  app.get("/reset-password", (req, res) => {
    res.send(resetPasswordPage(undefined, req.theme, rt.authName(), newLoginCsrf(res)));
  });

  app.post("/reset-password", (req, res) => {
    const ip = req.ip ?? "?";
    if (!resetThrottle.allowed(ip)) {
      return res.status(429).send(resetPasswordPage("Too many reset attempts from this address — please wait a few minutes.", req.theme, rt.authName(), newLoginCsrf(res)));
    }
    // Same anonymous double-submit CSRF as /login.
    const provided = String(req.body._lcsrf ?? "");
    const cookieToken = parseCookies(req.headers.cookie)["lcsrf"] ?? "";
    if (!provided || provided !== cookieToken) {
      return res.status(403).send(resetPasswordPage("That page expired — please try again.", req.theme, rt.authName(), newLoginCsrf(res)));
    }
    const refuse = (m: string) => res.send(resetPasswordPage(m, req.theme, rt.authName(), newLoginCsrf(res)));
    const GENERIC = "We couldn't verify that username and code. Check both, or ask your admin for a fresh code.";
    const username = String(req.body.username ?? "").trim();
    const code = String(req.body.code ?? "").trim();
    const password = String(req.body.password ?? "");
    const confirm = String(req.body.confirm ?? "");
    const member = username ? rt.repo.getStaffByUsername(username) : undefined;
    if (!member || member.active !== 1) {
      resetThrottle.recordFail(ip); // credential guess — count it
      return refuse(GENERIC);
    }
    // Validate the password BEFORE consuming the code — a typo must not
    // burn the one-time code.
    if (password.length < 8) return refuse("The new password must be at least 8 characters.");
    if (password !== confirm) return refuse("The two new passwords do not match — nothing was changed.");
    // Atomic claim: racing redemptions can't both win.
    const ownerId = rt.repo.consumeResetCode(code);
    if (ownerId === null || ownerId !== member.id) {
      resetThrottle.recordFail(ip); // credential guess — count it
      return refuse(GENERIC);
    }
    rt.repo.setStaffPassword(member.id, hashPassword(password));
    const purged = rt.repo.purgeStaffSessions(member.id);
    rt.repo.audit(null, member.username, "password_reset_code_used", `admin-issued code consumed; ${purged} session(s) ended`);
    res.redirect(`/login?msg=${encodeURIComponent("Password updated — sign in with your new password.")}`);
  });
}
