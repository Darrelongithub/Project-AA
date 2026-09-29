/**
 * Page renderers — login / setup / password pages. Extracted verbatim from pages.ts;
 * pages.ts re-exports the page API unchanged.
 */
import { Theme, crest, layout } from "../views";
import { flash, html, raw } from "../tpl";

/** Stable school grouping for course lists. */
// ── Login ──────────────────────────────────────────────────────────────────
export function loginPage(error?: string, theme?: Theme, institution = "Organization", loginCsrf?: string, okMsg?: string): string {
  return layout({
    title: `Sign in — ${institution}`,
    institution,
    publicPage: true,
    theme,
    content: html`
<div class="loginbox card">
  ${raw(crest(58))}
  <div class="brand-lockup"><span>PROJECT</span><b>a<sup>2</sup></b></div>
  <h1 class="center">Sign in</h1>
  <p class="sub center">${institution} · Automated admissions</p>
  ${raw(okMsg ? flash("ok", okMsg, "position:static;margin-bottom:14px") : "")}
  ${raw(error ? flash("err", error, "position:static;margin-bottom:14px") : "")}
  <form method="post" action="/login">
    ${raw(loginCsrf ? html`<input type="hidden" name="_lcsrf" value="${loginCsrf}">` : "")}
    <label>Username</label>
    <input type="text" name="username" autofocus autocomplete="username" placeholder="your.username">
    <label>Password</label>
    <input type="password" name="password" autocomplete="current-password" placeholder="••••••••">
    <p style="margin-top:18px"><button class="btn" style="width:100%">Sign in to the console</button></p>
  </form>
  <p class="small center" style="margin-top:14px"><a href="/reset-password">Forgot your password? Ask your admin for a reset code.</a></p>
  <p class="small muted center">Accounts are provisioned by your administrator.</p>
</div>`,
  });
}


/** Forgot-password: redeem an admin-issued one-time reset code. Anonymous. */
export function resetPasswordPage(error?: string, theme?: Theme, institution = "Organization", loginCsrf?: string): string {
  return layout({
    title: `Reset password — ${institution}`,
    institution,
    publicPage: true,
    theme,
    content: html`
<div class="loginbox card">
  ${raw(crest(58))}
  <div class="brand-lockup"><span>PROJECT</span><b>a<sup>2</sup></b></div>
  <h1 class="center">Reset password</h1>
  <p class="sub center">Enter your username and the one-time reset code your administrator issued for you. It works once and expires after 30 minutes.</p>
  ${raw(error ? flash("err", error, "position:static;margin-bottom:14px") : "")}
  <form method="post" action="/reset-password">
    ${raw(loginCsrf ? html`<input type="hidden" name="_lcsrf" value="${loginCsrf}">` : "")}
    <label>Username</label>
    <input type="text" name="username" autofocus autocomplete="username" placeholder="your.username">
    <label>Reset code (from your admin)</label>
    <input type="text" name="code" autocomplete="one-time-code" placeholder="e.g. 7KMQ3NP9XW" class="mono" style="text-transform:uppercase">
    <label>New password</label>
    <input type="password" name="password" autocomplete="new-password" placeholder="at least 8 characters">
    <label>Confirm new password</label>
    <input type="password" name="confirm" autocomplete="new-password" placeholder="repeat it">
    <p style="margin-top:18px"><button class="btn" style="width:100%">Set new password</button></p>
  </form>
  <p class="small muted center"><a href="/login">← Back to sign in</a></p>
</div>`,
  });
}


/** OR-1: one-time first-run screen — the owner creates their own admin account. */
export function setupPage(token: string, error?: string, theme?: Theme, institution = "Organization"): string {
  return layout({
    title: `First-run setup — ${institution}`,
    institution,
    publicPage: true,
    theme,
    content: html`
<div class="loginbox card">
  ${raw(crest(58))}
  <div class="brand-lockup"><span>PROJECT</span><b>a<sup>2</sup></b></div>
  <h1 class="center">Welcome to ${institution}</h1>
  <p class="sub center">This is a fresh installation. Create the administrator account — you will not see this screen again.</p>
  ${raw(error ? flash("err", error, "position:static;margin-bottom:14px") : "")}
  <form method="post" action="/setup">
    <input type="hidden" name="_setup" value="${token}">
    <label>Your name</label>
    <input type="text" name="display_name" autofocus autocomplete="name" placeholder="e.g. Darrel">
    <label>Username</label>
    <input type="text" name="username" autocomplete="username" placeholder="your.username">
    <label>Password (at least 8 characters)</label>
    <input type="password" name="password" autocomplete="new-password" placeholder="••••••••">
    <label>Confirm password</label>
    <input type="password" name="confirm" autocomplete="new-password" placeholder="••••••••">
    <p style="margin-top:18px"><button class="btn" style="width:100%">Create administrator account</button></p>
  </form>
</div>`,
  });
}
