/**
 * Organization-owned document packs.
 *
 * The bundled files are migration data for Organization #1 only. Generic
 * organizations receive empty slots and must upload their own documents.
 */
import * as fs from "fs";
import * as path from "path";
import { loadConfig } from "./config";
import { log } from "./util/log";
import type { Repo } from "./db/repo";

export interface PackFile { filename: string; mimeType: string; content: Buffer; }
export interface PackSlot {
  key: string;
  file: string;
  pretty: string;
  pack: "application" | "admission" | "transfer";
  purpose: string;
}

/** Generic slot catalogue. Names and files are organization data, not defaults. */
export const PACK_SLOTS: PackSlot[] = [
  { key: "application-form", file: "application-form.pdf", pretty: "Application form.pdf", pack: "application", purpose: "Application form sent to enquirers" },
  { key: "brochure-2026", file: "brochure-2026.pdf", pretty: "Brochure.pdf", pack: "application", purpose: "Prospectus sent to enquirers" },
  { key: "student-medical-form", file: "student-medical-form.pdf", pretty: "Student medical form.pdf", pack: "admission", purpose: "Admission pack — medical form" },
  { key: "data-protection-form", file: "data-protection-form.pdf", pretty: "Data protection form.pdf", pack: "admission", purpose: "Admission pack — data protection" },
  { key: "next-of-kin-form", file: "next-of-kin-form.pdf", pretty: "Next of kin form.pdf", pack: "admission", purpose: "Admission pack — next of kin" },
  { key: "hostels-list", file: "hostels-list.pdf", pretty: "Accommodation list.pdf", pack: "admission", purpose: "Admission pack — accommodation" },
  { key: "fee-structure-2026", file: "fee-structure-2026.pdf", pretty: "Fee structure.pdf", pack: "admission", purpose: "Admission pack — fee structure" },
  { key: "sponsorship-form", file: "sponsorship-form.pdf", pretty: "Sponsorship form.pdf", pack: "admission", purpose: "Admission pack — sponsorship" },
  { key: "orientation-programme-2026", file: "orientation-programme-2026.pdf", pretty: "Orientation programme.pdf", pack: "admission", purpose: "Admission pack — orientation" },
  { key: "credit-transfer-form", file: "credit-transfer-form.pdf", pretty: "Credit transfer form.pdf", pack: "transfer", purpose: "For applicants transferring credit from another institution" },
];

export const DATA_DIR = path.dirname(path.resolve(loadConfig().dbPath));
export const PACK_DIR = path.join(DATA_DIR, "pack");
const MIGRATED_ORG_ONE = path.join(DATA_DIR, "migrated", "organization-1.json");
type MigratedPack = { name: string; from_name: string; tagline?: string; pack: Record<string, Array<{ file: string; filename: string; mime: string }>> };

function migratedData(): MigratedPack | null {
  try { return JSON.parse(fs.readFileSync(MIGRATED_ORG_ONE, "utf8")) as MigratedPack; }
  catch { return null; }
}
export function migratedOrganizationOne(): { name: string; fromName: string; tagline?: string } | null {
  const data = migratedData();
  return data ? { name: data.name, fromName: data.from_name, tagline: data.tagline } : null;
}

function read(file: string, filename: string, issues: string[]): PackFile | null {
  try { return { filename, mimeType: "application/pdf", content: fs.readFileSync(path.join(PACK_DIR, file)) }; }
  catch {
    const issue = `Missing organization pack file: ${file}`;
    issues.push(issue);
    log(issue, "warn");
    return null;
  }
}
function build(issues: string[], files: Array<PackFile | null>): PackBuild {
  return { files: files.filter((f): f is PackFile => f !== null), issues };
}
export interface PackBuild { files: PackFile[]; issues: string[]; }

export function packManifest(repo?: Repo, organizationId = 1): Array<PackSlot & { exists: boolean; bytes: number }> {
  if (repo) {
    const owned = new Map(repo.listOrganizationPackSlots(organizationId).map((slot) => [slot.key, slot]));
    return PACK_SLOTS.map((slot) => {
      const row = owned.get(slot.key);
      if (row?.content) return { ...slot, exists: true, bytes: row.content.length };
      if (organizationId !== 1) return { ...slot, exists: false, bytes: 0 };
      try { return { ...slot, exists: true, bytes: fs.statSync(path.join(PACK_DIR, slot.file)).size }; }
      catch { return { ...slot, exists: false, bytes: 0 }; }
    });
  }
  return PACK_SLOTS.map((slot) => {
    try { return { ...slot, exists: true, bytes: fs.statSync(path.join(PACK_DIR, slot.file)).size }; }
    catch { return { ...slot, exists: false, bytes: 0 }; }
  });
}

/** Migration compatibility helper. It reads only Organization #1 data. */
function migratedPack(kind: "application" | "admission"): PackBuild {
  const issues: string[] = [];
  const data = migratedData();
  if (!data) return { files: [], issues: ["Organization #1 migration data is unavailable"] };
  return build(issues, (data.pack[kind] ?? []).map((slot) => read(slot.file, slot.filename, issues)));
}
export function applicationPack(): PackBuild { return migratedPack("application"); }
export function admissionPack(): PackBuild { return migratedPack("admission"); }

/** Build the pack owned by one organization. Empty slots are intentional. */
export function organizationPack(repo: Repo, organizationId = 1, groups?: string[]): PackBuild {
  const wanted = new Set(groups ?? ["application", "admission", "transfer"]);
  const issues: string[] = [];
  const slots = repo.listOrganizationPackSlots(organizationId);
  const files = slots
    .filter((slot) => {
      const catalogue = PACK_SLOTS.find((candidate) => candidate.key === slot.key);
      return catalogue && wanted.has(catalogue.pack) && slot.content && slot.filename;
    })
    .map((slot) => ({ filename: slot.filename!, mimeType: slot.mime || "application/pdf", content: slot.content! }));

  // Existing Organization #1 installations may not yet have copied their
  // legacy files into the tenant table. That migration data is the only
  // permitted compatibility path; all newly-created organizations stay empty.
  if (organizationId === 1 && files.length === 0 && slots.every((slot) => !slot.content)) {
    if (wanted.has("admission")) return migratedPack("admission");
    if (wanted.has("application")) return migratedPack("application");
  }
  for (const group of wanted) {
    const keys = new Set(PACK_SLOTS.filter((slot) => slot.pack === group).map((slot) => slot.key));
    if (!slots.some((slot) => keys.has(slot.key) && slot.content)) issues.push(`Organization pack '${group}' is empty`);
  }
  return { files, issues };
}

/** No generic bundled banner exists. A caller may use its organization logo. */
export function defaultEmailBanner(): null { return null; }
