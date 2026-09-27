/** Organization-owned identity helpers. Generic runtime code never supplies an institution identity. */
import type { Repo } from "./db/repo";
import type { OrganizationTheme } from "./types";

export const DEFAULT_ORGANIZATION_NAME = "Organization";

export function organizationName(repo: Pick<Repo, "getOrganization" | "getSetting">, organizationId = 1): string {
  const organization = repo.getOrganization(organizationId);
  if (organization?.name?.trim()) {
    // Organization #1 may still be edited by an older Settings client that
    // writes the mirrored legacy key. New organizations never consult it.
    if (organizationId === 1) {
      const mirrored = repo.getSetting("institution_name", "").trim();
      if (mirrored && mirrored !== DEFAULT_ORGANIZATION_NAME) return mirrored;
    }
    return organization.name.trim();
  }
  // Compatibility for databases created before the organization table. This is
  // a migration bridge, not a product identity; new organizations always have a row.
  return repo.getSetting("institution_name", DEFAULT_ORGANIZATION_NAME).trim() || DEFAULT_ORGANIZATION_NAME;
}

/** Kept as a source-compatible alias for integrations written before WLR. */
export const institutionName = organizationName;

export function organizationTheme(repo: Repo, organizationId = 1): OrganizationTheme {
  return repo.getOrganization(organizationId)?.theme ?? { primary: "#334155", accent: "#0f766e" };
}

export function organizationLogo(repo: Repo, organizationId = 1): string | null {
  return repo.getOrganization(organizationId)?.logo ?? null;
}

/** Resolve an organization logo into the email-banner shape when possible. */
export function emailBanner(repo: Repo, organizationId = 1): { mime: string; base64: string } | null {
  const configured = organizationId === 1 ? repo.getSetting("email_banner", "") : "";
  if (configured) return { mime: repo.getSetting("email_banner_mime", "image/jpeg"), base64: configured };
  const logo = organizationLogo(repo, organizationId);
  const match = logo?.match(/^data:([^;]+);base64,(.+)$/);
  return match ? { mime: match[1], base64: match[2] } : null;
}
