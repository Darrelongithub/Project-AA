/**
 * Branding is FIXED to the institution — there is deliberately no settings
 * field for it (removed at the user's request). Every applicant-facing and
 * UI string takes the name from here.
 */
export const INSTITUTION = "Riara University";

import type { Repo } from "./db/repo";
import { defaultEmailBanner } from "./pack";

/** The changeable email banner: staff-uploaded override, else the bundled default. */
export function emailBanner(repo: Repo): { mime: string; base64: string } | null {
  const b64 = repo.getSetting("email_banner", "");
  if (!b64) return defaultEmailBanner();
  return { mime: repo.getSetting("email_banner_mime", "image/jpeg"), base64: b64 };
}
