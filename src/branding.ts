/**
 * Branding defaults to Riara for the shipped admissions configuration, but a
 * deployment can rename its workspace without changing code. This keeps the
 * engine useful for another school, employer or organisation while preserving
 * the school's customised admissions workflow.
 */
export const INSTITUTION = "Riara University";

import type { Repo } from "./db/repo";

export function institutionName(repo: Pick<Repo, "getSetting">): string {
  return repo.getSetting("institution_name", INSTITUTION).trim() || INSTITUTION;
}
import { defaultEmailBanner } from "./pack";

/** The changeable email banner: staff-uploaded override, else the bundled default. */
export function emailBanner(repo: Repo): { mime: string; base64: string } | null {
  const b64 = repo.getSetting("email_banner", "");
  if (!b64) return defaultEmailBanner();
  return { mime: repo.getSetting("email_banner_mime", "image/jpeg"), base64: b64 };
}
