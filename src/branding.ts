/** Organization-owned identity helpers. Generic runtime code never supplies an institution identity. */
import type { Repo } from "./db/repo";
import type { OrganizationTheme } from "./types";
import { EMAIL_BANNER_BASE64 } from "./web/logo";

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
  const theme = repo.getOrganization(organizationId)?.theme;
  const previousDefault = theme && (
    (theme.primary.toLowerCase() === "#334155" && theme.accent.toLowerCase() === "#0f766e") ||
    (theme.primary.toLowerCase() === "#672b3c" && theme.accent.toLowerCase() === "#c7b69e") ||
    (theme.primary.toLowerCase() === "#660033" && theme.accent.toLowerCase() === "#d5a0b1") ||
    (theme.primary.toLowerCase() === "#650019" && theme.accent.toLowerCase() === "#e18b9a") ||
    (theme.primary.toLowerCase() === "#650019" && theme.accent.toLowerCase() === "#c89a4a")
  );
  // Primary identity moved to the purple/plum system; legacy default pairs resolve to the current UI palette.
  if (!theme || previousDefault) return { primary: "#3b1d5f", accent: "#9a78c7" };
  return theme;
}

export function organizationLogo(repo: Repo, organizationId = 1): string | null {
  return repo.getOrganization(organizationId)?.logo ?? null;
}

/** PPR P1-5: sender identity applied to every outgoing message. */
export function organizationSender(
  repo: Pick<Repo, "getOrganization" | "getSetting">,
  organizationId = 1
): { fromName: string | null; fromAddress: string | null; replyTo: string | null } {
  const org = repo.getOrganization(organizationId);
  return {
    fromName: org?.from_name?.trim() || null,
    fromAddress: repo.getSetting("gmail_address", "").trim() || null,
    replyTo: org?.reply_to?.trim() || null,
  };
}

/** Resolve an organization logo into the email-banner shape when possible. */
export function emailBanner(repo: Repo, organizationId = 1): { mime: string; base64: string } | null {
  const configured = organizationId === 1 ? repo.getSetting("email_banner", "") : "";
  if (configured) return { mime: repo.getSetting("email_banner_mime", "image/jpeg"), base64: configured };
  const logo = organizationLogo(repo, organizationId);
  const match = logo?.match(/^data:([^;]+);base64,(.+)$/);
  return match ? { mime: match[1], base64: match[2] } : { mime: "image/svg+xml", base64: EMAIL_BANNER_BASE64 };
}
