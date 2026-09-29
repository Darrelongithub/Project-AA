/**
 * /db/repo — settings and secrets. Extracted verbatim from the Repo god class;
 * every function takes the Repo as its first argument and the Repo
 * facade in ../repo.ts delegates to it (same API, same behaviour).
 */
import type { Repo } from "../repo";
import { SECRET_KEYS } from "./shared";

// ── Settings ─────────────────────────────────────────────────────────────
export function getSetting(repo: Repo, key: string, fallback: string): string {
  const row = repo.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? row.value : fallback;
}


export function setSetting(repo: Repo, key: string, value: string): void {
  repo.db
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, value);
}


/** PPR P0-1: credentials never flow through ordinary settings. */
export function getSecret(repo: Repo, key: string, organizationId = 1): string {
  const row = repo.db.prepare("SELECT value FROM secrets WHERE organization_id = ? AND key = ?").get(organizationId, key) as { value: string } | undefined;
  return row?.value ?? "";
}


export function setSecret(repo: Repo, key: string, value: string, organizationId = 1): void {
  if (!SECRET_KEYS.includes(key)) throw new Error(`Unknown secret key: ${key}`);
  repo.db
    .prepare("INSERT INTO secrets (organization_id, key, value, updated_at) VALUES (?,?,?,datetime('now')) ON CONFLICT(organization_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')")
    .run(organizationId, key, value);
}


export function deleteSecret(repo: Repo, key: string, organizationId = 1): void {
  repo.db.prepare("DELETE FROM secrets WHERE organization_id = ? AND key = ?").run(organizationId, key);
}


export function hasSecret(repo: Repo, key: string, organizationId = 1): boolean {
  return repo.db.prepare("SELECT 1 FROM secrets WHERE organization_id = ? AND key = ? AND value <> ''").get(organizationId, key) !== undefined;
}


export function allSettings(repo: Repo): Record<string, string> {
  const rows = repo.db.prepare("SELECT key, value FROM settings").all() as Array<{ key: string; value: string }>;
  // Defense in depth: even if a secret key somehow reappears in settings,
  // a generic settings read must never return it (PPR P0-1).
  return Object.fromEntries(rows.filter((r) => !SECRET_KEYS.includes(r.key)).map((r) => [r.key, r.value]));
}
