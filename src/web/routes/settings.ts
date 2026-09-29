/**
 * settings routes. Extracted verbatim from server.ts createApp;
 * shared closure state arrives via RouteCtx — behavior unchanged.
 */
import * as crypto from "crypto";
import type { Express } from "express";
import { BudgetedVisionAdapter, DEFAULT_GEMINI_MODEL, GeminiVisionAdapter, MockVisionAdapter } from "../../extraction/gemini";
import type { Adapters } from "../../pipeline/adapters";
import { settingsPage } from "../pages";
import { csrfCheck, requireLogin, requireRole } from "../auth";
import { GmailClient } from "../../ingestion/gmailClient";
import { GeminiWatcher, makeHeuristicWatcher } from "../../watcher";
import { gmailRedirectUri } from "../oauth";
import { metrics } from "../../metrics";
import type { LegacyAcademicLevel } from "./ctx";
import type { RouteCtx } from "./ctx";

export function registerSettings(app: Express, rt: RouteCtx): void {
  // ── Settings (manager+) ──────────────────────────────────────────────────

  // 'it' role: cases + configuration, but not staff management.
  app.get("/settings", requireLogin, requireRole("admin"), (req, res) =>
    res.send(settingsPage(rt.c(req), req.query.msg ? String(req.query.msg) : undefined, gmailRedirectUri(rt.repo, req.protocol, req.get("host") ?? "localhost")))
  );

  // ── Gmail connect (OAuth code flow; tokens stored in Settings) ───────────

  // OR-4: connection controls have ONE home — Settings → Connections.
  const settingsBack = (msg: string) => `/settings?msg=${encodeURIComponent(msg)}#connections`;

  app.post("/settings/gmail/credentials", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    // Saving credentials is an explicit reconnect/enable action.
    rt.repo.setSetting("gmail_disabled", "");
    rt.repo.setSetting("gmail_address", String(req.body.gmail_address ?? "").trim());
    rt.repo.setSetting("gmail_client_id", String(req.body.gmail_client_id ?? "").trim());
    // The watcher reads incoming All Mail (the same region for everyone).
    // Pin the OAuth origin only for reverse-proxy / HTTPS deployments — advanced field.
    rt.repo.setSetting("gmail_public_base_url", String(req.body.gmail_public_base_url ?? "").trim());
    // Secret is write-only in the UI: kept if the field is left blank.
    // PPR P0-1: credentials live in the secrets store, never in settings.
    const secret = String(req.body.gmail_client_secret ?? "").trim();
    if (secret) rt.repo.setSecret("gmail_client_secret", secret);
    // Manual / OAuth-Playground refresh token path (advanced field).
    const manualToken = String(req.body.gmail_refresh_token_manual ?? "").trim();
    if (manualToken) rt.repo.setSecret("gmail_refresh_token", manualToken);
    rt.repo.audit(null, req.staff!.username, "gmail_credentials_saved", "stored OAuth credentials in the secret store");
    res.redirect(settingsBack("Gmail credentials saved — now press “Connect with Google”."));
  });

  app.get("/settings/gmail/connect", requireLogin, requireRole("admin"), (req, res) => {
    const clientId = rt.repo.getSetting("gmail_client_id", "");
    if (!clientId) return res.redirect(settingsBack("Save the OAuth client ID and secret first."));
    const state = crypto.randomBytes(16).toString("hex");
    rt.repo.setSetting("gmail_oauth_state", state);
    const redirectUri = gmailRedirectUri(rt.repo, req.protocol, req.get("host") ?? "localhost");
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "https://www.googleapis.com/auth/gmail.modify");
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("state", state);
    res.redirect(url.toString());
  });

  app.get("/settings/gmail/callback", requireLogin, requireRole("admin"), async (req, res) => {
    const state = String(req.query.state ?? "");
    if (!state || state !== rt.repo.getSetting("gmail_oauth_state", "")) {
      return res.redirect(settingsBack("OAuth state mismatch — try connecting again."));
    }
    rt.repo.setSetting("gmail_oauth_state", "");
    if (req.query.error) {
      // AUX-1: a bare code ("access_denied") is not actionable — surface
      // Google's description and point at the usual causes.
      const err = String(req.query.error);
      const desc = req.query.error_description ? ` — ${String(req.query.error_description)}` : "";
      const hint =
        err === "redirect_uri_mismatch"
          ? " The redirect URI must match step 4 above byte-for-byte (scheme, host, port — http vs https counts)."
          : err === "access_denied"
            ? " While the consent screen is “In testing”, only the listed test users can approve — and the client type must be “Web application”, not Desktop."
            : "";
      return res.redirect(settingsBack(`Google returned an error: ${err}${desc}${hint}`));
    }
    const code = String(req.query.code ?? "");
    const clientId = rt.repo.getSetting("gmail_client_id", "");
    const clientSecret = rt.repo.getSecret("gmail_client_secret");
    const redirectUri = gmailRedirectUri(rt.repo, req.protocol, req.get("host") ?? "localhost");
    try {
      const resp = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code, client_id: clientId, client_secret: clientSecret,
          redirect_uri: redirectUri, grant_type: "authorization_code",
        }).toString(),
      });
      const json = (await resp.json()) as { refresh_token?: string; error_description?: string };
      if (!json.refresh_token) {
        return res.redirect(settingsBack(
          `Google did not return a refresh token${json.error_description ? ` (${json.error_description})` : ""}. Press “Connect with Google” again and approve access.`
        ));
      }
      rt.repo.setSecret("gmail_refresh_token", json.refresh_token);
      rt.repo.setSetting("gmail_disabled", "");
      rt.repo.audit(null, req.staff!.username, "gmail_connected", rt.repo.getSetting("gmail_address", ""));
      res.redirect(settingsBack("Gmail connected — live sorting starts within a minute."));
    } catch (e) {
      rt.repo.audit(null, req.staff!.username, "gmail_connect_failed", (e as Error).message);
      res.redirect(settingsBack(`Token exchange failed: ${(e as Error).message}`));
    }
  });

  // OR-4: one real, lightweight call against the mailbox — success or a
  // helpful plain-words error, never silence.
  app.post("/settings/gmail/test", requireLogin, requireRole("admin"), csrfCheck, async (req, res) => {
    const cfg = {
      address: rt.repo.getSetting("gmail_address", ""),
      clientId: rt.repo.getSetting("gmail_client_id", ""),
      clientSecret: rt.repo.getSecret("gmail_client_secret"),
      refreshToken: rt.repo.getSecret("gmail_refresh_token"),
    };
    if (!cfg.address || !cfg.clientId || !cfg.clientSecret || !cfg.refreshToken) {
      if (rt.gmailTest && rt.gmailConfigured && rt.repo.getSetting("gmail_disabled", "") !== "1") {
        const envError = await rt.gmailTest();
        if (!envError) {
          rt.repo.setSetting("gmail_last_error", "");
          rt.repo.audit(null, req.staff!.username, "gmail_tested", "environment-configured Gmail connection succeeded");
          return res.redirect(settingsBack("Gmail test connection succeeded — the environment-configured mailbox is reachable."));
        }
        rt.repo.setSetting("gmail_last_error", envError.message.slice(0, 300));
        rt.repo.audit(null, req.staff!.username, "gmail_test_failed", envError.message.slice(0, 200));
        return res.redirect(settingsBack(`Gmail test connection failed: ${envError.message}`));
      }
      return res.redirect(settingsBack("Gmail is not fully configured yet — save credentials (and connect, or paste a refresh token) first."));
    }
    try {
      const client = new GmailClient(cfg);
      const ids = await client.listRecentMessageIds(1, { perPage: 1, maxPages: 1 });
      rt.repo.setSetting("gmail_last_error", "");
      rt.repo.audit(null, req.staff!.username, "gmail_tested", "test connection succeeded");
      return res.redirect(settingsBack(
        ids.length
          ? "Gmail test connection succeeded — mailbox reachable, recent mail found."
          : "Gmail test connection succeeded — mailbox reachable (no mail in the last day, which is fine)."
      ));
    } catch (e) {
      const msg = (e as Error).message;
      rt.repo.setSetting("gmail_last_error", msg.slice(0, 300));
      rt.repo.audit(null, req.staff!.username, "gmail_test_failed", msg.slice(0, 200));
      return res.redirect(settingsBack(`Gmail test connection failed: ${msg}`));
    }
  });

  app.post("/settings/gmail/disconnect", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    // Pause an environment-managed client without deleting its env secret.
    rt.repo.setSetting("gmail_disabled", "1");
    rt.repo.deleteSecret("gmail_refresh_token");
    rt.repo.audit(null, req.staff!.username, "gmail_disconnected", "");
    res.redirect(settingsBack("Gmail disconnected — live fetching stopped."));
  });

  // Manual "Sync now": pull incoming All Mail immediately instead of waiting for the
  // next 60s poll. Errors are surfaced verbatim on the config page — a broken
  // connection is never silently ignored.
  app.post("/settings/gmail/sync", requireLogin, requireRole("admin"), csrfCheck, async (req, res) => {
    if (!rt.gmailSync) {
      return res.redirect(settingsBack("No live mailbox — connect Gmail first."));
    }
    const pass = await rt.gmailSync();
    if (!pass.ran) {
      metrics.incr("gmail.sync.skipped");
      return res.redirect(settingsBack("A sync is already running — give it a few seconds, then try again."));
    }
    const err = pass.result;
    if (err) {
      metrics.incr("gmail.sync.error");
      rt.repo.setSetting("gmail_last_error", err.message.slice(0, 300));
      rt.repo.audit(null, req.staff!.username, "gmail_sync_failed", err.message.slice(0, 200));
      return res.redirect(settingsBack(`Sync failed: ${err.message}`));
    }
    metrics.incr("gmail.sync.ran");
    rt.repo.setSetting("gmail_last_sync_at", new Date().toISOString());
    rt.repo.setSetting("gmail_last_error", "");
    rt.repo.audit(null, req.staff!.username, "gmail_synced", "manual sync from Settings");
    res.redirect(settingsBack("Inbox synced — new mail has been triaged."));
  });
  // Round 11: one-off backfill — pull mail older than the normal window.
  app.post("/settings/gmail/backfill", requireLogin, requireRole("admin"), csrfCheck, async (req, res) => {
    const { BACKFILL_WINDOWS } = await import("../../ingestion/sync");
    const days = Number(req.body.days);
    if (!BACKFILL_WINDOWS.includes(days)) {
      return res.redirect(`/settings?msg=${encodeURIComponent("Backfill windows are 30, 90 or 365 days.")}#connections`);
    }
    if (!rt.gmailBackfill) {
      return res.redirect(`/settings?msg=${encodeURIComponent("Backfill is unavailable — the server was started without live Gmail sync.")}#connections`);
    }
    const pass = await rt.gmailBackfill(days);
    if (!pass.ran) {
      metrics.incr("gmail.backfill.skipped");
      return res.redirect(`/settings?msg=${encodeURIComponent("A sync or backfill is already running — wait for it to finish, then try again.")}#connections`);
    }
    if (pass.result) {
      metrics.incr("gmail.backfill.error");
      return res.redirect(`/settings?msg=${encodeURIComponent(`Backfill failed: ${pass.result.message}`)}#connections`);
    }
    metrics.incr("gmail.backfill.ran");
    rt.repo.audit(null, req.staff!.username, "gmail_backfill", `Pulled mail from the last ${days} days into the console`);
    res.redirect(`/settings?msg=${encodeURIComponent(`History pulled — mail from the last ${days} days is now in All Mail.`)}#connections`);
  });

  // ── Gemini (document-reading AI) — a first-class settings field ───────────
  // The key is stored in the secret store (PPR P0-1), used by the extraction
  // pipeline AT ONCE (no restart, no env file). "Test key" performs a real
  // round-trip and reports exactly what happened.
  const rebuildAdapters = () => {
    const key = rt.repo.getSecret("gemini_api_key").trim();
    if (!key) {
      // N1: no key means MOCK reading — say so by actually rebuilding. The
      // old early-return left stale live Gemini adapters in place after a
      // key removal: the dead-key watcher fails closed on every Green file
      // (auto-replies silently stop) while the UI/audit claim "back to
      // mock reading". Boot with no key behaves identically (mock either
      // way, so this is a no-op there).
      rt.ctx.adapters = {
        ...rt.ctx.adapters,
        vision: new MockVisionAdapter(),
        watcher: makeHeuristicWatcher(),
      };
      return;
    }
    const model = rt.repo.getSetting("gemini_model", DEFAULT_GEMINI_MODEL).trim() || DEFAULT_GEMINI_MODEL;
    try {
      const next: Adapters = {
        ...rt.ctx.adapters,
        vision: new BudgetedVisionAdapter(new GeminiVisionAdapter(key, model), rt.repo.visionCacheStore()),
        watcher: ((w) => (input) => w.watch(input))(new GeminiWatcher(key, model)),
      };
      rt.ctx.adapters = next;
      rt.repo.setSetting("gemini_last_error", "");
      return;
    } catch (e) {
      rt.repo.setSetting("gemini_last_error", (e as Error).message.slice(0, 300));
    }
  };
  // Boot with a key that was saved earlier (server restarts keep it working).
  rebuildAdapters();

  app.post("/settings/gemini", requireLogin, requireRole("admin"), csrfCheck, async (req, res) => {
    const back = (m: string) => `/settings?msg=${encodeURIComponent(m)}#connections`;
    const key = String(req.body.gemini_api_key ?? "").trim();
    const model = String(req.body.gemini_model ?? DEFAULT_GEMINI_MODEL).trim() || DEFAULT_GEMINI_MODEL;
    if (req.body.clear !== undefined) {
      rt.repo.deleteSecret("gemini_api_key");
      rt.repo.setSetting("gemini_last_error", "");
      // N1: the message below is only true if the adapters actually go
      // back to mock — rebuild before claiming it.
      rebuildAdapters();
      rt.repo.audit(null, req.staff!.username, "gemini_disabled", "API key removed — back to mock reading");
      return res.redirect(back("Gemini key removed. Document reading falls back to text/OCR only."));
    }
    if (!key && !rt.repo.hasSecret("gemini_api_key")) {
      return res.redirect(back("Paste a Gemini API key first (get one free at aistudio.google.com/apikey)."));
    }
    if (key) rt.repo.setSecret("gemini_api_key", key);
    rt.repo.setSetting("gemini_model", model);
    // Prove the key with ONE real API call before claiming it works.
    try {
      const probe = new GeminiVisionAdapter(rt.repo.getSecret("gemini_api_key"), model);
      await probe.probeKey();
      rebuildAdapters();
      rt.repo.audit(null, req.staff!.username, "gemini_enabled", `live document reading on (${model})`);
      return res.redirect(back(`Gemini is live (${model}) — unreadable scans are now read by AI, no restart needed.`));
    } catch (e) {
      const msg = (e as Error).message;
      rt.repo.setSetting("gemini_last_error", msg.slice(0, 300));
      rt.repo.audit(null, req.staff!.username, "gemini_test_failed", msg.slice(0, 200));
      return res.redirect(back(`Gemini test call failed: ${msg}`));
    }
  });

  app.post("/settings/organization", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const name = String(req.body.organization_name ?? "").trim();
    const primary = String(req.body.primary_color ?? "").trim();
    const accent = String(req.body.accent_color ?? "").trim();
    const refPrefix = String(req.body.ref_prefix ?? "").trim().toUpperCase();
    const validColor = (value: string) => /^#[0-9a-f]{6}$/i.test(value);
    if (!name) return res.redirect(`/settings?msg=${encodeURIComponent("Organization name is required.")}#letters`);
    if (!validColor(primary) || !validColor(accent)) {
      return res.redirect(`/settings?msg=${encodeURIComponent("Colours must be six-digit hexadecimal values.")}#letters`);
    }
    if (!/^[A-Z]{1,8}$/.test(refPrefix)) {
      return res.redirect(`/settings?msg=${encodeURIComponent("Reference prefix must be 1–8 letters.")}#letters`);
    }
    // PPR P1-5: sender identity + locale are organization-owned and now
    // actually applied to outgoing mail (From display name / Reply-To).
    rt.repo.updateOrganization(rt.organizationId(req), {
      name, refPrefix, theme: { primary, accent },
      fromName: String(req.body.from_name ?? ""),
      replyTo: String(req.body.reply_to ?? ""),
      locale: String(req.body.locale ?? ""),
      timezone: String(req.body.timezone ?? ""),
    });
    rt.repo.audit(null, req.staff!.username, "organization_identity_changed", `${name} (${primary}, ${accent})`);
    res.redirect(`/settings?msg=${encodeURIComponent("Organization identity saved.")}#letters`);
  });

  app.post("/settings/general", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    // Blank identity fields keep their current value (an empty ref prefix
    // would break ref generation); numbers are validated.
    const ignored: string[] = [];
    const numOk = (v: string) => /^\d+(\.\d+)?$/.test(v) && Number(v) > 0;
    const ladderOk = (v: string) => v.split(",").every((p) => /^\d+$/.test(p.trim()) && Number(p.trim()) > 0);
    for (const key of [
      "institution_name", "sla_target_hours", "escalation_hours",
      "unanswered_target_hours", "followup_ladder_days", "retention_days",
      "reg_date", "orientation_dates", "intake_hotwords",
    ]) {
      if (typeof req.body[key] !== "string") continue;
      const v = String(req.body[key]).trim();
      if (["sla_target_hours", "escalation_hours", "unanswered_target_hours", "retention_days"].includes(key) && !numOk(v)) {
        ignored.push(key.replace(/_/g, " "));
        continue;
      }
      if (key === "followup_ladder_days" && !ladderOk(v)) {
        ignored.push(key.replace(/_/g, " "));
        continue;
      }
      if (!(key === "institution_name" && rt.organizationId(req) !== 1)) rt.repo.setSetting(key, v);
      if (key === "institution_name" && rt.organizationId(req) !== 1 && v) {
        rt.repo.updateOrganization(rt.organizationId(req), { name: v });
      }
    }
    rt.repo.audit(null, req.staff!.username, "settings_changed", "general settings updated");
    res.redirect(
      `/settings?msg=${encodeURIComponent(
        ignored.length ? `Saved. Kept current value for: ${ignored.join(", ")} (blank or invalid input).` : "Settings saved."
      )}`
    );
  });

  app.post("/settings/automation/global", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const mode = String(req.body.mode ?? "auto") === "draft" ? "draft" : "auto";
    rt.repo.setSetting("automation_mode", mode);
    rt.repo.audit(null, req.staff!.username, "automation_changed", `global automation mode → ${mode}`);
    res.redirect("/settings");
  });

  app.post("/settings/automation/category", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const cat = String(req.body.category ?? "");
    const mode = String(req.body.mode ?? "auto") === "draft" ? "draft" : "auto";
    if (cat) {
      try {
        rt.repo.setAutomationMode(cat, mode);
      } catch {
        return res.redirect(`/settings?msg=${encodeURIComponent(`Unknown automation category '${cat}' — nothing changed.`)}`);
      }
      rt.repo.audit(null, req.staff!.username, "automation_changed", `category '${cat}' → ${mode}`);
    }
    res.redirect("/settings");
  });

  app.post("/settings/intake-deadline", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    // Intakes are a global (Organization 1) list — tenant admins use CaseTypes.
    if ((req.staff!.organization_id ?? 1) !== 1) return res.redirect("/config?tab=case-types&msg=Use+CaseTypes+for+this+organization");
    const name = String(req.body.name ?? "").trim();
    const deadline = String(req.body.deadline ?? "").trim();
    if (name) {
      // Garbage date strings produced Invalid Dates whose toISOString()
      // throws → 500. Validate first.
      const parsed = deadline ? new Date(`${deadline}T23:59:59Z`) : null;
      if (deadline && (parsed === null || isNaN(parsed.getTime()))) {
        return res.redirect("/config?msg=invalid-deadline#intakes");
      }
      rt.repo.setIntakeDeadline(name, parsed ? parsed.toISOString() : null);
      rt.repo.audit(null, req.staff!.username, "intake_deadline_changed", `${name} → ${deadline || "none"}`);
    }
    res.redirect("/config#intakes");
  });

  // Requirement rules now speak GRADES (mean grade + subject lines) — the way
  // the university actually publishes entry requirements. No numeric points.
  // OR-5: document requirements are generated deterministically from the
  // official application-form checklist — they are NOT staff-configurable.
  // The old add/delete endpoints are gone; a stale POST (bookmark, old
  // tab, replayed request) must get an explicit refusal, never a silent
  // success and never a hidden write.
  app.post("/settings/rules/add", requireLogin, requireRole("admin"), csrfCheck, (_req, res) => {
    res.redirect("/config?msg=" + encodeURIComponent("Document requirements are generated deterministically from the application-form checklist — they cannot be added by hand. See the Requirements tab.") + "#courses");
  });
  app.post("/settings/rules/delete", requireLogin, requireRole("admin"), csrfCheck, (_req, res) => {
    res.redirect("/config?msg=" + encodeURIComponent("Document requirements are generated deterministically from the application-form checklist — they cannot be removed by hand. See the Requirements tab.") + "#courses");
  });

  app.post("/settings/lists/add", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    // Programmes AND intakes are Organization 1's global lists (the old
    // gate covered programmes only — a tenant intake add polluted org 1).
    if ((req.staff!.organization_id ?? 1) !== 1) return res.redirect("/config?tab=case-types&msg=Use+CaseTypes+for+this+organization");
    const added: string[] = [];
    if (req.body.prog_code && req.body.prog_name) {
      const school = String(req.body.prog_school ?? "").trim();
      // OR-6: Master's and PhD are distinct levels; anything unknown
      // falls back to "degree" rather than storing junk.
      const lvlRaw = String(req.body.prog_level ?? "degree");
      const level: LegacyAcademicLevel = ["degree", "diploma", "certificate", "masters", "phd"].includes(lvlRaw)
        ? (lvlRaw as LegacyAcademicLevel)
        : "degree";
      rt.repo.addProgramme(String(req.body.prog_code), String(req.body.prog_name), school, "", level);
      added.push("programme");
    }
    if (req.body.intake) { rt.repo.addIntake(String(req.body.intake)); added.push("intake"); }
    rt.repo.audit(null, req.staff!.username, "lists_changed", "programmes/intakes updated");
    res.redirect("/config?msg=" + encodeURIComponent(added.length ? `Added ${added.join(" and ")}.` : "Nothing to add — fill in a programme code and name, or an intake.") + "#courses");
  });

  // OR-7: templates moved to their own section (/templates). A stale POST to
  // the old endpoint is refused explicitly — never a silent write to a page
  // nobody is looking at.
  app.post("/settings/template", requireLogin, requireRole("admin"), csrfCheck, (_req, res) => {
    res.redirect("/templates?msg=" + encodeURIComponent("Templates are edited in the Templates section now — this old form no longer saves anything."));
  });
}
