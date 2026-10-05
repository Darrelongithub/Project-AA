/**
 * The ONE place the Gmail OAuth redirect URI is computed. The connect route
 * (authorize) and the callback route (token exchange) MUST hand Google the
 * byte-identical URI, and it must never be a bare bind address:
 *
 * Visiting the console via the address the server *binds* (0.0.0.0 / [::])
 * used to produce `http://0.0.0.0:PORT/settings/gmail/callback`, which Google
 * rejects with `Error 400: invalid_request` (OAuth 2.0 policy — 0.0.0.0 is
 * not a routable loopback name). Rewriting the bind host to `localhost` is
 * what keeps authorize and callback consistent: Google sends the browser to
 * exactly this URI, so the callback request's own Host computes back to the
 * same string.
 *
 * Deployments behind a reverse proxy / HTTPS pin the origin explicitly via
 * the `gmail_public_base_url` setting (Settings → Connections, advanced).
 */
import type { Repo } from "../db/repo";

/** The address this installation is reachable at, for anything a human has to
 *  copy out of the browser (OAuth redirect URIs, the public webhook URL). One
 *  function, because both must agree about what "the outside address" is. */
export function publicOrigin(repo: Repo, protocol: string, host: string): string {
  const configured = repo.getSetting("gmail_public_base_url", "").trim().replace(/\/+$/, "");
  if (configured) return configured;
  const fixed = host
    .replace(/^0\.0\.0\.0(?=[:/]|$)/, "localhost")
    .replace(/^\[::\](?=[:/]|$)/, "localhost");
  return `${protocol}://${fixed}`;
}

export function gmailRedirectUri(repo: Repo, protocol: string, host: string): string {
  return `${publicOrigin(repo, protocol, host)}/settings/gmail/callback`;
}
