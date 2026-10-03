/** Organization-owned file packs. No bundled files, fixed slots, or fallback tenant. */
import type { Repo } from "./db/repo";

export interface PackFile { filename: string; mimeType: string; content: Buffer }
export interface PackBuild { files: PackFile[]; issues: string[] }
export interface PackSlot { key: string; file: string; pretty: string; pack: string; purpose: string }

export function packManifest(repo: Repo, organizationId = 1): Array<PackSlot & { exists: boolean; bytes: number }> {
  return repo.listOrganizationPackSlots(organizationId).map((slot) => ({ key: slot.key, file: slot.filename ?? "", pretty: slot.filename ?? slot.key,
    pack: slot.key, purpose: "Organization-owned file", exists: Boolean(slot.content), bytes: slot.content?.length ?? 0 }));
}
export function organizationPack(repo: Repo, organizationId = 1, groups?: string[]): PackBuild {
  const slots = repo.listOrganizationPackSlots(organizationId).filter((slot) => !groups || groups.includes(slot.key));
  const files = slots.filter((slot) => slot.content && slot.filename).map((slot) => ({ filename: slot.filename!, mimeType: slot.mime ?? "application/pdf", content: slot.content! }));
  return { files, issues: groups?.filter((key) => !slots.some((slot) => slot.key === key && slot.content)).map((key) => `Organization file '${key}' is empty`) ?? [] };
}
export function defaultEmailBanner(): null { return null; }
