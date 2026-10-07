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

/**
 * Read a branding setting for one organization.
 *
 * Settings are installation-global in this schema, so the per-organization key
 * (`<key>_<organizationId>`) is read first and the bare legacy key is honoured
 * **only for organization 1** — the original single tenant whose uploads are
 * stored under the un-suffixed name. Reading the bare key for every tenant
 * handed organization 1's banner to every other organization (BUG-10).
 */
export function orgSetting(
  repo: Pick<Repo, "getSetting">,
  key: string,
  organizationId: number,
  fallback = ""
): string {
  const scoped = repo.getSetting(`${key}_${organizationId}`, "").trim();
  if (scoped) return scoped;
  if (organizationId === 1) return repo.getSetting(key, "").trim();
  return fallback;
}

/**
 * Write a branding setting for one organization — the write-side counterpart of
 * `orgSetting`. Organization 1 also keeps the legacy bare key in sync, so
 * anything still reading the un-suffixed name sees the same value.
 */
export function setOrgSetting(
  repo: Pick<Repo, "setSetting">,
  key: string,
  organizationId: number,
  value: string
): void {
  repo.setSetting(`${key}_${organizationId}`, value);
  if (organizationId === 1) repo.setSetting(key, value);
}

/** Resolve an organization logo into the email-banner shape when possible. */
export function emailBanner(repo: Repo, organizationId = 1): { mime: string; base64: string } | null {
  // Prefer this organization's own uploaded banner, then its logo, then the
  // built-in default mark.
  const configured = orgSetting(repo, "email_banner", organizationId);
  if (configured) {
    return {
      mime: orgSetting(repo, "email_banner_mime", organizationId, "image/jpeg") || "image/jpeg",
      base64: configured,
    };
  }
  const logo = organizationLogo(repo, organizationId);
  const match = logo?.match(/^data:([^;]+);base64,(.+)$/);
  return match ? { mime: match[1], base64: match[2] } : { mime: "image/svg+xml", base64: EMAIL_BANNER_BASE64 };
}


/** Optional email signature block (name, title, phone, extra line). */
export function organizationSignature(
  repo: Pick<Repo, "getSetting" | "getOrganization">,
  organizationId = 1
): { name: string; title: string; phone: string; line: string } {
  // Scoped per organization: one tenant's signature must never ride on another
  // tenant's mail (BUG-10).
  const g = (k: string) => orgSetting(repo, k, organizationId);
  return {
    name: g("signature_name"),
    title: g("signature_title"),
    phone: g("signature_phone"),
    line: g("signature_line"),
  };
}

export function formatSignatureHtml(sig: { name: string; title: string; phone: string; line: string }, institution: string): string {
  const parts: string[] = [];
  if (sig.name) parts.push(`<strong style="color:#1f1729">${sig.name.replace(/</g, "")}</strong>`);
  if (sig.title) parts.push(`<span style="color:#6b6179">${sig.title.replace(/</g, "")}</span>`);
  if (sig.phone) parts.push(`<span style="color:#6b6179">${sig.phone.replace(/</g, "")}</span>`);
  if (sig.line) parts.push(`<span style="color:#6b6179">${sig.line.replace(/</g, "")}</span>`);
  if (!parts.length && institution) parts.push(`<strong style="color:#1f1729">${institution.replace(/</g, "")}</strong>`);
  if (!parts.length) return "";
  return `<div style="margin-top:24px;padding-top:16px;border-top:1px solid #e4dceb;font-size:13px;line-height:1.5">${parts.join("<br>")}</div>`;
}

/**
 * True when the body already ends in a signature block, so appending ours would
 * double it.
 *
 * Both MIME paths used to decide this differently — and the web one also
 * treated "the body happens to mention the signer's name" as signed, so a
 * quoted reply lost its signature entirely (BUG-16). One helper, one answer.
 */
export function bodyAlreadySigned(body: string, signatureText: string): boolean {
  if (!signatureText) return false;
  if (body.trimEnd().endsWith(signatureText.trim())) return true;
  // Our own "--" block, and the "-- " convention most mail clients insert.
  return /\n--[ \t]*\r?\n/.test(body) || /\n--[ \t]*$/.test(body);
}

export function formatSignatureText(sig: { name: string; title: string; phone: string; line: string }, institution: string): string {
  const parts = [sig.name, sig.title, sig.phone, sig.line].filter(Boolean);
  if (!parts.length && institution) parts.push(institution);
  if (!parts.length) return "";
  return "\n\n--\n" + parts.join("\n");
}
