/**
 * Page renderers — settings, connections and account. Extracted verbatim from pages.ts;
 * pages.ts re-exports the page API unchanged.
 */
import { organizationTheme } from "../../branding";
import { DEAD_GEMINI_MODELS, DEFAULT_GEMINI_MODEL } from "../../extraction/gemini";
import { missingGmailCredentials, resolveLookbackDays } from "../../ingestion/sync";
import { Theme, esc, fmtDate } from "../views";
import { capFirst, head } from "./shared";
import type { Ctx } from "./shared";

// ── Settings (app behaviour) & Configuration (admissions setup) ────────────
export function settingsPage(c: Ctx, flash?: string, gmailRedirectUri?: string): string {
  const { repo } = c;
  const settings = repo.allSettings();
  const organizationId = c.user.organization_id ?? 1;
  const organization = repo.getOrganization(organizationId);
  const settingInput = (key: string, label: string) =>
    `<div><label>${esc(label)}</label><input type="text" name="${esc(key)}" value="${esc(settings[key] ?? "")}"></div>`;
  const organizationInput = (key: string, label: string, value: string) =>
    `<div><label>${esc(label)}</label><input type="text" name="${esc(key)}" value="${esc(value)}"></div>`;

  return head(
    c,
    "Settings",
    "settings",
    `
<h1>Settings</h1>
<div class="sub">How the console behaves — automation, response targets, retention and workspace identity.</div>
${flash ? `<div class="flash ok" style="position:static;margin-bottom:16px">${esc(flash)}</div>` : ""}

${connectionsSection(c, gmailRedirectUri)}

<div class="card" id="intake">
  <h2>Which emails become cases</h2>
  <p class="small muted" style="margin-top:-6px">The inbox gets more than applications — service messages, promos, stray mail, job ads. The engine decides in plain terms:</p>
  <ul class="small muted" style="margin:4px 0 8px 18px">
    <li>It is a reply to an applicant you already know (quoted reference number, or a sender on file) → <b>always a case</b>.</li>
    <li>It contains one of the <b>hotwords below</b> (your words — decisive) → a case.</li>
    <li>It carries <b>two or more admissions signals</b>, or one strong one — an exact phrase like "application form", a <b>course name from your course list</b>, application/transcript/certificate words (the subject line counts double), or attachment names like "ApplicationForm.pdf" → a case.</li>
    <li>It asks an <b>admissions question</b> (tuition, scholarship, how to apply, prospectus…) → a case, so enquiries get answered.</li>
    <li>It is clearly <b>not</b> admissions (job application, vacancy, CV, refund, invoice…) → parked.</li>
  </ul>
  <p class="small muted" style="margin-top:0">Everything else is <b>parked</b>: kept in <a href="/mail?f=all">All Mail</a> so nothing is ever lost, but no case number, queue entry or auto-reply is created for it. Add a word below whenever mail you wanted as a case gets parked.</p>
  <form method="post" action="/settings/general">
    <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
    <div style="max-width:560px"><label>Intake hotwords (comma-separated — your words, always decisive)</label><input type="text" name="intake_hotwords" value="${esc(settings["intake_hotwords"] ?? "")}" style="width:100%"></div>
    <p><button class="btn">Save hotwords</button></p>
  </form>
  ${(() => {
    const parked = c.repo.recentAudit(100).filter((a) => a.event === "email_parked_non_intake").slice(0, 5);
    if (parked.length === 0) return "";
    return `<details style="margin-top:10px">
      <summary class="small"><b>Recently parked</b> <span class="muted">— the engine's score for each, so you can add a hotword when it misjudges</span></summary>
      <ul class="small muted" style="margin:8px 0 4px 18px">
        ${parked.map((a) => `<li>${esc(a.detail)}<br><span style="opacity:.7">${esc(a.at)}</span></li>`).join("")}
      </ul>
    </details>`;
  })()}
</div>

<div class="card" id="automation">
  <h2>Automation mode (draft-first)</h2>
  <p class="small muted" style="margin-top:-6px">Two rules always apply. First, automated sending is reserved for <b>fully qualified</b> applicants — a Green verdict with no flags; everyone else gets the reply as a <b>suggested draft</b> for staff to review, edit or discard, because borderline files can still be admitted on special acceptance. Second, the rollout dial: keep the global mode on <b>draft</b> (every automated reply waits for a human), then switch automation on category by category as you trust it.</p>
  <form method="post" action="/settings/automation/global" class="formrow" style="align-items:end">
    <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
    <div><label>Global mode</label><select name="mode">
      <option value="auto" ${settings["automation_mode"] !== "draft" ? "selected" : ""}>auto — safe categories send automatically</option>
      <option value="draft" ${settings["automation_mode"] === "draft" ? "selected" : ""}>draft — hold EVERY automated reply for approval</option>
    </select></div>
    <div style="flex:0"><button class="btn">Apply global mode</button></div>
  </form>
  <table style="margin-top:14px"><tr><th>Email category</th><th>Mode</th><th></th></tr>
    ${(["application", "document_submission", "missing_document", "fee_enquiry", "admission_enquiry", "follow_up", "complaint", "other"] as string[])
      .map((cat) => {
        const mode = c.repo.automationMode(cat);
        return `<tr><td>${esc(cat.replace(/_/g, " "))}</td>
        <td><span class="badge ${mode === "auto" ? "b-green" : "b-orange"}">${mode === "auto" ? "auto-send" : "draft for approval"}</span></td>
        <td><form method="post" action="/settings/automation/category" style="margin:0">
          <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
          <input type="hidden" name="category" value="${esc(cat)}">
          <button class="btn small ghost" name="mode" value="${mode === "auto" ? "draft" : "auto"}">switch to ${mode === "auto" ? "draft" : "auto"}</button>
        </form></td></tr>`;
      })
      .join("")}
  </table>
  <p class="small muted">Note: with global mode set to draft, per-category switches take effect once global returns to auto.</p>
</div>

<div class="card" id="sla">
  <h2>Response targets &amp; SLA</h2>
  <p class="small muted" style="margin-top:-6px">How fast the office promises to respond, when a slow case is escalated, and the reminder ladder for missing documents. These numbers drive the SLA clock on every queued case and the scheduled reminders.</p>
  <form method="post" action="/settings/general">
    <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
    <div class="formrow">
      ${settingInput("sla_target_hours", "SLA target (hours to first response)")}
      ${settingInput("escalation_hours", "Escalation (hours before a case is escalated)")}
      ${settingInput("unanswered_target_hours", "Unanswered target (hours)")}
    </div>
    <div class="formrow">
      ${settingInput("followup_ladder_days", "Follow-up ladder (days between reminders, e.g. 3,7,10)")}
    </div>
    <p><button class="btn">Save response targets</button></p>
    <p class="small muted" style="margin-bottom:0">Current ladder: <b>${esc(settings["followup_ladder_days"] ?? "3,7,10")}</b> days — reminders stop as soon as the case is complete. A response rule can switch the ladder off for its own path.</p>
  </form>
</div>

<div class="card" id="letters">
  <h2>Letters &amp; identity</h2>
  <p class="small muted" style="margin-top:-6px">Identity and theme belong to this organization. The same values are used by the console, outgoing messages and generated documents.</p>
  <form method="post" action="/settings/organization">
    <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
    <div class="formrow">
      ${organizationInput("organization_name", (c.user.organization_id ?? 1) === 1 ? "Organisation / school name" : "Organisation name", organization?.name ?? c.institution)}
      ${organizationInput("primary_color", "Primary colour", organization ? organizationTheme(repo, organizationId).primary : "#650019")}
      ${organizationInput("accent_color", "Accent colour", organization ? organizationTheme(repo, organizationId).accent : "#c89a4a")}
      <div><label>Reference prefix</label><input name="ref_prefix" value="${esc(organization?.ref_prefix ?? repo.organizationRefPrefix(c.user.organization_id ?? 1))}" pattern="[A-Za-z]{1,8}" maxlength="8" required></div>
    </div>
    <div class="formrow">
      ${organizationInput("from_name", "From name on outgoing mail", organization?.from_name ?? "")}
      ${organizationInput("reply_to", "Reply-to address", organization?.reply_to ?? "")}
      ${organizationInput("locale", "Locale (dates & numbers)", organization?.locale ?? "en-KE")}
      ${organizationInput("timezone", "Timezone (IANA name)", organization?.timezone ?? "")}
    </div>
    <p class="small muted">The From name and Reply-to are applied to every message the system sends. Empty From name keeps the sending mailbox's own name; empty Reply-to keeps replies on the sending mailbox.</p>
    <p><button class="btn">Save identity &amp; colours</button></p>
  </form>
  <div class="card" style="margin:14px 0 0;padding:14px;background:var(--card2)">
    <b>Logo</b><p class="small muted" style="margin:3px 0 10px">Upload a PNG, JPEG or SVG logo for this organization. It replaces the neutral mark across the workspace.</p>
    <form method="post" action="/config/organization/logo" enctype="application/octet-stream">
      <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
      <input type="file" name="logo" accept="image/png,image/jpeg,image/svg+xml" data-logo-upload>
      <button class="btn small ghost" type="button" data-logo-save>Upload logo</button>
      <span class="small muted" data-logo-message></span>
    </form>
  </div>
  <form method="post" action="/settings/general" style="margin-top:14px">
    <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
    <div class="formrow">
      ${settingInput("institution_name", "Legacy identity setting")}
      ${settingInput("reg_date", "Registration date (admission letter)")}
      ${settingInput("orientation_dates", "Orientation dates (admission letter)")}
    </div>
    <p><button class="btn ghost">Save response settings</button></p>
  </form>
</div>
<script>
(function () {
  var save = document.querySelector("[data-logo-save]");
  if (!save) return;
  save.addEventListener("click", function () {
    var input = document.querySelector("[data-logo-upload]");
    var msg = document.querySelector("[data-logo-message]");
    if (!input.files[0]) { msg.textContent = "Choose an image first."; return; }
    msg.textContent = "Uploading…";
    fetch("/config/organization/logo", { method: "POST", headers: { "x-csrf-token": "${esc(c.csrf)}", "content-type": input.files[0].type }, body: input.files[0] })
      .then(function (r) { msg.textContent = r.ok ? "Logo saved." : "Upload failed."; if (r.ok) window.location.reload(); })
      .catch(function () { msg.textContent = "Upload failed — network error."; });
  });
})();
</script>`
  );
}


// ── Account (self-service settings, available to every signed-in user) ─────
/**
 * OR-4: Gmail + Gemini connection setup — ONE home, in Settings.
 * Step-by-step Google Cloud guide (exact scope, redirect URI,
 * OAuth-Playground fallback) plus live status and test buttons.
 */
export function connectionsSection(c: Ctx, gmailRedirectUri?: string): string {
  const { repo } = c;
  const settings = repo.allSettings();
  const gAddress = settings["gmail_address"] || c.gmailAddress || "";
  const gClientId = settings["gmail_client_id"] ?? "";
  // PPR P0-1: secrets are presence-only here — a settings page can never
  // read the stored credential value back out.
  const gClientSecret = repo.hasSecret("gmail_client_secret") ? "saved" : "";
  const gRefresh = repo.hasSecret("gmail_refresh_token") ? "saved" : "";
  const geminiKeySaved = repo.hasSecret("gemini_api_key");
  const connected = Boolean(gAddress && gClientId && gClientSecret && gRefresh) || Boolean(c.gmailConfigured);
  // AUX-2: a plain-`http://` redirect URI on a NON-LOOPBACK host can never
  // be registered with a Google OAuth web client — the classic
  // behind-a-proxy trap (the app sees the plain-http hop to the proxy,
  // not the public https address). Instead of letting the admin hit
  // Google's opaque 400, name it and point at the Public base URL field.
  let proxyUriWarning = "";
  if (gmailRedirectUri) {
    try {
      const u = new URL(gmailRedirectUri);
      const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname);
      if (u.protocol === "http:" && !loopback && !(settings["gmail_public_base_url"] ?? "").trim()) {
        proxyUriWarning = `<p class="small" style="color:var(--red);margin-top:10px"><b>You're behind a proxy — set the <i>Public base URL</i> below before connecting.</b><br>The app currently hands Google <span class="mono">http://${esc(u.host)}/settings/gmail/callback</span>, and Google's OAuth console refuses plain-http (non-localhost) redirect addresses for web clients. Enter your public address (e.g. <span class="mono">https://admissions.example.ac.ke</span>), save, and step&nbsp;4 below will show the correct https URI to register.</p>`;
      }
    } catch {
      /* unparseable URI — nothing to warn about */
    }
  }
  return `
<div id="connections">
<h1 style="margin-top:34px">Connections</h1>
<div class="sub">Gmail inbox and Gemini document AI — set up once, live immediately, no restarts.</div>

<div class="card" id="gmail">
  <h2>Gmail connection ${connected
    ? `<span class="badge b-green">connected — live sorting on</span>`
    : `<span class="badge b-orange">not connected</span>`}</h2>
  <p class="small muted" style="margin-top:-6px">Connect the admissions mailbox so incoming mail is fetched, triaged and sorted automatically every minute.</p>
  ${proxyUriWarning}
  ${!connected && (gAddress || gClientId || gClientSecret || gRefresh)
    ? `<p class="small" style="color:var(--red);margin-top:10px"><b>Connection incomplete — mail is NOT being fetched until every piece is saved.</b> Missing: <b>${esc(missingGmailCredentials(repo).join(", "))}</b>. Add what's missing in the fields below (or via the OAuth connect) and save.</p>`
    : ""}
  <ol class="small" style="margin:0 0 14px 18px;line-height:1.7">
    <li>In <b>Google Cloud Console</b> (console.cloud.google.com) create or pick a project for the admissions mailbox.</li>
    <li><b>APIs &amp; Services → Library</b>: enable the <b>Gmail API</b>.</li>
    <li><b>APIs &amp; Services → Credentials → Create credentials → OAuth client ID</b>, application type <b>Web application</b>.</li>
    <li>Under <b>Authorised redirect URIs</b> add exactly this address (copy it — Google rejects placeholders such as <span class="mono">0.0.0.0</span>):<br><input class="mono" style="width:100%;margin-top:4px" readonly value="${esc(gmailRedirectUri ?? "")}" onclick="this.select()"></li>
    <li>Paste the <b>Client ID</b> and <b>Client secret</b> below, save, then press <b>Connect with Google…</b> and approve. The only scope requested is <span class="mono">https://www.googleapis.com/auth/gmail.modify</span> — read and send for this one mailbox.</li>
    <li>No OAuth client of your own? Use the <b>OAuth Playground</b> (developers.google.com/oauthplayground) with your own client ID and the <span class="mono">gmail.modify</span> scope, then paste the resulting refresh token into the advanced field.</li>
  </ol>
  <form method="post" action="/settings/gmail/credentials">
    <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
    <div class="formrow">
      <div><label>Gmail address</label><input type="email" name="gmail_address" value="${esc(gAddress)}" placeholder="admissions@institution.ac.ke"></div>
      <div><label>OAuth client ID</label><input type="text" name="gmail_client_id" value="${esc(gClientId)}" placeholder="…apps.googleusercontent.com"></div>
      <div><label>OAuth client secret</label><input type="password" name="gmail_client_secret" value="" placeholder="${gClientSecret ? "saved — enter a new value to replace" : "GOCSPX-…"}" autocomplete="new-password"></div>
    </div>
    <div class="formrow" style="margin-top:10px">
      <div style="flex:2"><label>Public base URL <span class="muted small">(advanced — only for reverse-proxy / HTTPS deployments)</span></label><input type="text" name="gmail_public_base_url" value="${esc(settings["gmail_public_base_url"] ?? "")}" placeholder="https://admissions.example.ac.ke"></div>
      <div style="flex:2"><label>Refresh token (advanced — OAuth Playground / manual) ${gRefresh ? "<span class='muted small'>(saved)</span>" : ""}</label><input type="password" name="gmail_refresh_token_manual" value="" placeholder="1//…" autocomplete="new-password"></div>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <button class="btn ghost">Save credentials</button>
      ${gClientId && (gClientSecret || gRefresh) ? `<a class="btn" href="/settings/gmail/connect">Connect with Google…</a>` : ""}
    </div>
  </form>
  ${connected ? `
  <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px">
    <form method="post" action="/settings/gmail/test" style="margin:0"><input type="hidden" name="_csrf" value="${esc(c.csrf)}"><button class="btn ghost">Test connection</button></form>
    <form method="post" action="/settings/gmail/sync" style="margin:0"><input type="hidden" name="_csrf" value="${esc(c.csrf)}"><button class="btn ghost">Sync now</button></form>
    <form method="post" action="/settings/gmail/backfill" style="margin:0"><input type="hidden" name="_csrf" value="${esc(c.csrf)}"><select name="days" class="small"><option value="30">30 days</option><option value="90" selected>90 days</option><option value="365">365 days</option></select> <button class="btn ghost">Pull older mail</button></form>
    <form method="post" action="/settings/gmail/disconnect" style="margin:0"><input type="hidden" name="_csrf" value="${esc(c.csrf)}"><button class="btn ghost danger">Disconnect</button></form>
  </div>` : ""}
  <p class="small muted" style="margin-top:10px">${connected
    ? `Signed in as <b>${esc(gAddress)}</b>. New incoming mail is fetched automatically every minute from <b>All Mail</b> (excluding sent, spam and trash), covering the last ${resolveLookbackDays(repo, undefined)} days — older mail is brought in with “Pull older mail”.${settings["gmail_last_sync_at"] ? ` Last successful sync: <b>${esc(fmtDate(settings["gmail_last_sync_at"]))}</b>.` : " First sync pending (runs every minute)."}`
    : "Mail is not being fetched yet — the console still works; process mail manually or connect when ready."}</p>
  ${settings["gmail_last_error"] ? `<p class="small" style="color:var(--red)">Last sync failed: ${esc(settings["gmail_last_error"])}<br><span class="muted">If this says <span class="mono">invalid_grant</span>, the refresh token expired — press “Connect with Google…” again (or paste a fresh refresh token). If new mail still doesn’t appear after a good sync, check that it is in <b>All Mail</b> for ${esc(gAddress || "the connected address")} and within the lookback window.</span></p>` : ""}
</div>

<div class="card" id="gemini">
  <h2>Document AI (Gemini) ${geminiKeySaved
    ? `<span class="badge b-green">key saved — AI reads what OCR can't</span>`
    : `<span class="badge b-gray">optional</span>`}</h2>
  <p class="small muted" style="margin-top:-6px">When a document beats text extraction and OCR (bad scans, photos, handwriting), Gemini reads it as a vision model. Get a free key at <b>aistudio.google.com/apikey</b> (Google account → “Get API key”). The key is tested with one real call on save and goes live <b>immediately</b>, no restart. Without a key the console still works; unreadable files simply land in the review queue.</p>
  <form method="post" action="/settings/gemini">
    <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
    <div class="formrow">
      <div style="flex:2"><label>Gemini API key ${geminiKeySaved ? "(saved — paste a new value to replace)" : ""}</label><input type="password" name="gemini_api_key" value="" placeholder="AIza…" autocomplete="new-password"></div>
      ${(() => {
    const storedModel = settings["gemini_model"] ?? "";
    const dead = DEAD_GEMINI_MODELS.has(storedModel);
    return `<div><label>Model</label><input type="text" name="gemini_model" value="${esc(storedModel || DEFAULT_GEMINI_MODEL)}" placeholder="${esc(DEFAULT_GEMINI_MODEL)}"></div>
    ${dead ? `<p class="small" style="color:var(--red)">Heads-up: <span class="mono">${esc(storedModel)}</span> no longer exists in the Gemini API — that is the 404 you are seeing. The current Flash model is <span class="mono">${esc(DEFAULT_GEMINI_MODEL)}</span> (GA 2026-09-02) — put it in the field and test again.</p>` : ""}`;
  })()}
      <div style="flex:0"><label>&nbsp;</label><button class="btn">Save &amp; test key</button></div>
    </div>
  </form>
  ${geminiKeySaved ? `<form method="post" action="/settings/gemini" style="margin-top:8px"><input type="hidden" name="_csrf" value="${esc(c.csrf)}"><button class="btn ghost danger small" name="clear" value="1">Remove key</button></form>` : ""}
  ${settings["gemini_last_error"] ? `<p class="small" style="color:var(--red)">Last test failed: ${esc(settings["gemini_last_error"])}</p>` : ""}
</div>
</div>`;
}


export function accountPage(c: Ctx, msg?: string): string {
  const u = c.user;
  const theme: Theme = c.theme === "light" ? "light" : "dark";
  return head(
    c,
    "Account",
    "account",
    `
<h1>Account settings</h1>
<div class="sub">Your sign-in and appearance. These apply only to your account.</div>
${msg ? `<div class="flash ok" style="position:static;margin-bottom:16px">${esc(msg)}</div>` : ""}

<div class="card" id="profile">
  <h2>Username</h2>
  <form method="post" action="/account/username" class="formrow" style="align-items:end">
    <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
    <div><label>Username</label><input name="username" value="${esc(u.username)}" required minlength="3" maxlength="40" autocomplete="username"></div>
    <div style="flex:0"><button class="btn">Update username</button></div>
  </form>
  <p class="small muted" style="margin-top:6px">This is the name you sign in with.</p>
</div>

<div class="card" id="password">
  <h2>Password</h2>
  <form method="post" action="/account/password">
    <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
    <div class="formrow">
      <div><label>Current password</label><input type="password" name="current" required autocomplete="current-password"></div>
      <div><label>New password</label><input type="password" name="next" required minlength="8" autocomplete="new-password"></div>
      <div><label>Confirm new password</label><input type="password" name="confirm" required minlength="8" autocomplete="new-password"></div>
    </div>
    <p><button class="btn">Change password</button></p>
  </form>
</div>

<div class="card" id="appearance">
  <h2>Appearance</h2>
  <p class="small muted" style="margin-top:-6px">Choose how the console looks. You can also flip it at any time with the sun/moon button in the top bar.</p>
  <form method="post" action="/account/theme" class="formrow" style="align-items:end">
    <input type="hidden" name="_csrf" value="${esc(c.csrf)}">
    <div><label>Theme</label><select name="theme">
      <option value="light" ${theme === "light" ? "selected" : ""}>Light</option>
      <option value="dark" ${theme === "dark" ? "selected" : ""}>Dark</option>
    </select></div>
    <div style="flex:0"><button class="btn">Apply theme</button></div>
  </form>
</div>

<div class="card" id="role">
  <h2>Your role</h2>
  <p class="small">You are signed in as <b>${esc(u.display_name)}</b> (${esc(capFirst(u.role))}). Some areas — such as Configuration, Settings and Staff management — are only available to administrators and managers.</p>
</div>`
  );
}
