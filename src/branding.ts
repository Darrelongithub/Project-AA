/** Organization-owned branding helpers. Generic runtime code has no
 * institution-specific fallback; a seeded deployment may choose its own name. */
import type { Repo } from "./db/repo";
import { defaultEmailBanner } from "./pack";

export const DEFAULT_ORGANIZATION_NAME = "Organization";

export function institutionName(repo: Pick<Repo, "getSetting">): string {
  return repo.getSetting("institution_name", DEFAULT_ORGANIZATION_NAME).trim() || DEFAULT_ORGANIZATION_NAME;
}

export function organizationTheme(repo: Repo, organizationId = 1): { primary: string; accent: string } {
  return repo.getOrganization(organizationId)?.theme ?? { primary: "#334155", accent: "#0f766e" };
}

export function organizationLogo(repo: Repo, organizationId = 1): string | null {
  return repo.getOrganization(organizationId)?.logo ?? null;
}

/** Legacy email-banner hook. New deployments can leave it empty; the generic
 * organization logo is preferred, while existing template controls continue
 * to work for migrated datasets. */
export function emailBanner(repo: Repo): { mime: string; base64: string } | null {
  const b64 = repo.getSetting("email_banner", "");
  if (!b64) return defaultEmailBanner();
  return { mime: repo.getSetting("email_banner_mime", "image/jpeg"), base64: b64 };
}
