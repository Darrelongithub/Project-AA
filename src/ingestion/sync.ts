/**
 * Gmail sync settings (round 11) — the fetch window and credential checks,
 * split out of serve.ts so the web layer and the CLI share ONE definition.
 *
 * Production feedback: "I can't see all my mail". The every-minute poll was
 * real — but it only ever looked back a 2-day window (env-only, invisible
 * to the operator), so anything older was never ingested and "All Mail"
 * could never actually be ALL mail. The window is now a Settings value
 * (shown on the connections card) with a one-off backfill for deeper
 * history.
 */

export const DEFAULT_LOOKBACK_DAYS = 14;
export const MAX_LOOKBACK_DAYS = 365;
/** The one-off backfill offers these windows (deeper history, paid for in API calls). */
export const BACKFILL_WINDOWS = [30, 90, 365];

export type SettingsReader = { getSetting(key: string, dflt: string): string };

/** Settings value > env value > default — clamped to 1..365. */
export function resolveLookbackDays(repo: SettingsReader, envDays?: number): number {
  const raw = repo.getSetting("gmail_lookback_days", "").trim();
  const v = raw !== "" ? Number(raw) : (envDays ?? DEFAULT_LOOKBACK_DAYS);
  if (!Number.isFinite(v)) return DEFAULT_LOOKBACK_DAYS;
  return Math.min(MAX_LOOKBACK_DAYS, Math.max(1, Math.round(v)));
}

export const GMAIL_CREDENTIALS: ReadonlyArray<[key: string, label: string]> = [
  ["gmail_address", "mailbox address"],
  ["gmail_client_id", "client id"],
  ["gmail_client_secret", "client secret"],
  ["gmail_refresh_token", "refresh token"],
];

/** Which pieces of the connection are missing (plain names for the UI). */
export function missingGmailCredentials(repo: SettingsReader): string[] {
  return GMAIL_CREDENTIALS.filter(([key]) => !repo.getSetting(key, "").trim()).map(([, label]) => label);
}
