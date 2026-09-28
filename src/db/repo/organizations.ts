/**
 * /db/repo — organizations. Extracted verbatim from the Repo god class;
 * every function takes the Repo as its first argument and the Repo
 * facade in ../repo.ts delegates to it (same API, same behaviour).
 */
import { Organization, OrganizationTheme } from "../../types";
import type { Repo } from "../repo";

// ── Organizations and generic case configuration ───────────────────────
export function getOrganization(repo: Repo, id: number): Organization | undefined {
  const row = repo.db.prepare("SELECT id, name, logo, ref_prefix, theme, from_name, reply_to, locale, timezone FROM organizations WHERE id = ?").get(id) as
    | { id: number; name: string; logo: string | null; ref_prefix: string; theme: string; from_name: string | null; reply_to: string | null; locale: string | null; timezone: string | null }
    | undefined;
  if (!row) return undefined;
  let theme: OrganizationTheme = { primary: "#650019", accent: "#c89a4a" };
  try { theme = { ...theme, ...(JSON.parse(row.theme || "{}") as Partial<OrganizationTheme>) }; } catch { /* use safe defaults */ }
  return {
    id: row.id, name: row.name, logo: row.logo, ref_prefix: row.ref_prefix || (id === 1 ? "RU" : "ORG"), theme,
    from_name: row.from_name, reply_to: row.reply_to, locale: row.locale, timezone: row.timezone,
  };
}


/** Create a tenant with no inherited admissions content. */
export function createOrganization(repo: Repo, input: { name: string; logo?: string | null; refPrefix?: string; theme?: Partial<OrganizationTheme> }): Organization {
  const name = input.name.trim();
  if (!name) throw new Error("Organization name is required");
  const theme = {
    primary: input.theme?.primary ?? "#650019",
    accent: input.theme?.accent ?? "#c89a4a",
  };
  const prefix = (input.refPrefix ?? "ORG").trim().toUpperCase();
  if (!/^[A-Z]{1,8}$/.test(prefix)) throw new Error("Reference prefix must be 1–8 letters");
  const result = repo.db.prepare("INSERT INTO organizations (name, logo, ref_prefix, theme) VALUES (?,?,?,?)")
    .run(name, input.logo ?? null, prefix, JSON.stringify(theme));
  return repo.getOrganization(Number(result.lastInsertRowid))!;
}


export function listOrganizations(repo: Repo): Organization[] {
  return (repo.db.prepare("SELECT id FROM organizations ORDER BY id").all() as Array<{ id: number }>)
    .map((r) => repo.getOrganization(r.id)!).filter(Boolean);
}


export function organizationRefPrefix(repo: Repo, organizationId = 1): string {
  return repo.getOrganization(organizationId)?.ref_prefix || (organizationId === 1 ? "RU" : "ORG");
}


export function updateOrganization(repo: Repo, id: number, patch: { name?: string; logo?: string | Buffer | null; refPrefix?: string; theme?: Partial<OrganizationTheme>; fromName?: string | null; replyTo?: string | null; locale?: string | null; timezone?: string | null }): void {
  const current = repo.getOrganization(id);
  if (!current) return;
  const theme = { ...current.theme, ...(patch.theme ?? {}) };
  const logo = patch.logo === undefined ? current.logo : Buffer.isBuffer(patch.logo) ? `data:application/octet-stream;base64,${patch.logo.toString("base64")}` : patch.logo;
  const name = patch.name?.trim() || current.name;
  const refPrefix = patch.refPrefix === undefined ? current.ref_prefix : patch.refPrefix.trim().toUpperCase();
  if (!/^[A-Z]{1,8}$/.test(refPrefix)) throw new Error("Reference prefix must be 1–8 letters");
  const text = (v: string | null | undefined, prev: string | null | undefined): string | null =>
    v === undefined ? (prev ?? null) : v === null || v.trim() === "" ? null : v.trim().replace(/[\r\n]+/g, " ");
  repo.db.prepare("UPDATE organizations SET name = ?, logo = ?, ref_prefix = ?, theme = ?, from_name = ?, reply_to = ?, locale = ?, timezone = ? WHERE id = ?")
    .run(name, logo, refPrefix, JSON.stringify(theme),
      text(patch.fromName, current.from_name), text(patch.replyTo, current.reply_to),
      text(patch.locale, current.locale), text(patch.timezone, current.timezone), id);
  if (id === 1 && patch.name !== undefined) {
    repo.db.prepare("INSERT INTO settings (key, value) VALUES ('institution_name', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(name);
  }
}
