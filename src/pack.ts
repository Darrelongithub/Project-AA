/**
 * Organization-owned document packs.
 *
 * The bundled files are migration data for Organization #1 only. Generic
 * organizations receive empty slots and must upload their own documents.
 */
import * as fs from "fs";
import * as path from "path";
import { log } from "./util/log";
import type { Repo } from "./db/repo";
import { admissionsPreset, bundledDataDir } from "./presets/loader";

export interface PackFile { filename: string; mimeType: string; content: Buffer; }
export interface PackSlot {
  key: string;
  file: string;
  pretty: string;
  pack: "application" | "admission" | "transfer";
  purpose: string;
}

/** Slot catalogue — admissions-preset data (same slots as shipped). */
export const PACK_SLOTS: PackSlot[] = admissionsPreset().packSlots;

/**
 * Where the BUNDLED data lives (migration JSON + pack PDFs).
 *
 * C-1: resolved from the module's own location via the shared helper — never
 * from the process CWD and never from DB_PATH. A deployment may keep its
 * database anywhere; that must not change where the code looks for its own
 * bundled files. A deployment that genuinely needs to relocate the bundled
 * directory sets BUNDLED_DATA_DIR.
 */
export const DATA_DIR = bundledDataDir();
export const PACK_DIR = path.join(DATA_DIR, "pack");
type MigratedSlot = { key?: string; file: string; filename?: string; mime: string };
type MigratedPack = { name: string; from_name: string; tagline?: string; pack: Record<string, MigratedSlot[]> };

/** Migration data for one organization (`organization-{id}.json`, if shipped). */
function migratedData(organizationId = 1): MigratedPack | null {
  const file = path.join(DATA_DIR, "migrated", `organization-${organizationId}.json`);
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as MigratedPack; }
  catch { return null; }
}

/**
 * The ONE display-name mapping for migration slots: the JSON's own filename
 * wins (it is the migrated record); a slot without one falls back to the
 * catalogue's display name by key, then to the bare file name.
 */
function resolveSlot(slot: MigratedSlot): { file: string; filename: string } {
  const pretty = slot.key ? PACK_SLOTS.find((s) => s.key === slot.key)?.pretty : undefined;
  return { file: slot.file, filename: slot.filename ?? pretty ?? slot.file };
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
  return build(issues, (data.pack[kind] ?? []).map((slot) => {
    const resolved = resolveSlot(slot);
    return read(resolved.file, resolved.filename, issues);
  }));
}
export function applicationPack(): PackBuild { return migratedPack("application"); }
export function admissionPack(): PackBuild { return migratedPack("admission"); }

/**
 * PPR P0-5: the migrated education profile's own files, grouped — used ONCE
 * at setup to seed its attachment sets. After seeding, sends read the sets;
 * nothing but this function ever looks at the bundled migration data.
 */
export function migratedAttachmentSets(): Array<{ name: string; files: PackFile[]; issues: string[] }> {
  const data = migratedData();
  if (!data) return [];
  const out: Array<{ name: string; files: PackFile[]; issues: string[] }> = [];
  for (const name of ["application", "admission", "transfer"] as const) {
    const issues: string[] = [];
    const slots = data.pack[name] ?? [];
    const files = build(issues, slots.map((slot) => {
      const resolved = resolveSlot(slot);
      return read(resolved.file, resolved.filename, issues);
    })).files;
    out.push({ name, files, issues });
  }
  return out;
}

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
