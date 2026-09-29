/**
 * /db/repo — organization asset catalogs (attachment sets, axes, categories, pack slots). Extracted verbatim from the Repo god class;
 * every function takes the Repo as its first argument and the Repo
 * facade in ../repo.ts delegates to it (same API, same behaviour).
 */
import { AttachmentSet } from "../../types";
import type { Repo } from "../repo";

// ── PPR P0-5: attachment sets (organization-owned groups of sendable files) ──
export function listAttachmentSets(repo: Repo, organizationId = 1): Array<AttachmentSet & { file_count: number; bytes: number }> {
  const rows = repo.db.prepare(
    `SELECT s.*, (SELECT COUNT(*) FROM attachment_set_files f WHERE f.set_id = s.id) AS file_count,
            (SELECT COALESCE(SUM(LENGTH(f.content)), 0) FROM attachment_set_files f WHERE f.set_id = s.id) AS bytes
     FROM attachment_sets s WHERE s.organization_id = ? ORDER BY s.position, s.id`
  ).all(organizationId) as never[];
  return rows as never[];
}


export function getAttachmentSet(repo: Repo, id: number): AttachmentSet | undefined {
  return repo.db.prepare("SELECT * FROM attachment_sets WHERE id = ?").get(id) as never;
}


export function attachmentSetByName(repo: Repo, organizationId: number, name: string): AttachmentSet | undefined {
  return repo.db.prepare("SELECT * FROM attachment_sets WHERE organization_id = ? AND name = ?").get(organizationId, name) as never;
}


export function createAttachmentSet(repo: Repo, organizationId: number, name: string, description = ""): AttachmentSet {
  const clean = name.trim();
  if (!clean) throw new Error("Set name is required");
  const nextPos = (repo.db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM attachment_sets WHERE organization_id = ?").get(organizationId) as { p: number }).p;
  repo.db.prepare("INSERT INTO attachment_sets (organization_id, name, description, position) VALUES (?,?,?,?)").run(organizationId, clean, description.trim(), nextPos);
  return repo.attachmentSetByName(organizationId, clean)!;
}


export function deleteAttachmentSet(repo: Repo, id: number, organizationId = 1): void {
  repo.db.prepare("DELETE FROM attachment_sets WHERE id = ? AND organization_id = ?").run(id, organizationId);
}


export function addAttachmentSetFile(repo: Repo, setId: number, file: { filename: string; mime?: string; content: Buffer; provenance?: string }): number {
  const nextPos = (repo.db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM attachment_set_files WHERE set_id = ?").get(setId) as { p: number }).p;
  repo.db.prepare("INSERT INTO attachment_set_files (set_id, filename, mime, content, provenance, position) VALUES (?,?,?,?,?,?)")
    .run(setId, file.filename, file.mime ?? "application/pdf", file.content, file.provenance ?? "uploaded", nextPos);
  repo.db.prepare("UPDATE attachment_sets SET updated_at = datetime('now') WHERE id = ?").run(setId);
  return (repo.db.prepare("SELECT id FROM attachment_set_files WHERE set_id = ? ORDER BY id DESC LIMIT 1").get(setId) as { id: number }).id;
}


export function listAttachmentSetFiles(repo: Repo, setId: number): Array<{ id: number; filename: string; mime: string; content: Buffer; provenance: string }> {
  return repo.db.prepare("SELECT id, filename, mime, content, provenance FROM attachment_set_files WHERE set_id = ? ORDER BY position, id").all(setId) as never;
}


export function deleteAttachmentSetFile(repo: Repo, id: number): void {
  repo.db.prepare("DELETE FROM attachment_set_files WHERE id = ?").run(id);
}


/**
 * PPR P0-5: resolve an attachment reference to the exact files that ride
 * along. A reference is a set name owned by the organization (or `set:<id>`).
 * Only the sending organization's own sets resolve — there is no global or
 * bundled fallback (the migrated education profile's sets were seeded from
 * its own migration data at setup time).
 */
export function attachmentSetFiles(repo: Repo, organizationId: number, ref: string | null | undefined): { label: string; files: Array<{ filename: string; mimeType: string; content: Buffer }>; issues: string[] } {
  const issues: string[] = [];
  const label = (ref ?? "").trim();
  if (!label || label === "none") return { label: "none", files: [], issues };
  let set: AttachmentSet | undefined;
  if (label.startsWith("set:")) set = repo.getAttachmentSet(Number(label.slice(4)));
  else set = repo.attachmentSetByName(organizationId, label);
  if (!set || set.organization_id !== organizationId) {
    return { label, files: [], issues: [`Attachment set '${label}' does not exist for repo organization`] };
  }
  const files = repo.listAttachmentSetFiles(set.id)
    .filter((f) => f.content && f.filename)
    .map((f) => ({ filename: f.filename, mimeType: f.mime || "application/pdf", content: f.content }));
  if (!files.length) issues.push(`Attachment set '${set.name}' is empty`);
  return { label: set.name, files, issues };
}


export function listOrganizationDocumentAxes(repo: Repo, organizationId = 1): Array<{ key: string; label: string; values: string[] }> {
  const rows = repo.db.prepare("SELECT axis_key, label, values_json FROM organization_document_axes WHERE organization_id = ? ORDER BY axis_key").all(organizationId) as Array<{ axis_key: string; label: string; values_json: string }>;
  return rows.map((r) => {
    let values: string[] = [];
    try { values = JSON.parse(r.values_json) as string[]; } catch { /* safe empty axis */ }
    return { key: r.axis_key, label: r.label, values };
  });
}


export function replaceOrganizationDocumentAxes(repo: Repo, organizationId: number, axes: Array<{ key: string; label: string; values: string[] }>): void {
  repo.db.transaction(() => {
    repo.db.prepare("DELETE FROM organization_document_axes WHERE organization_id = ?").run(organizationId);
    const insert = repo.db.prepare("INSERT INTO organization_document_axes (organization_id, axis_key, label, values_json) VALUES (?,?,?,?)");
    for (const axis of axes) insert.run(organizationId, axis.key.trim(), axis.label.trim(), JSON.stringify([...new Set(axis.values.map((v) => v.trim()).filter(Boolean))]));
  })();
}


export function replaceDocumentDefinitions(repo: Repo, caseTypeId: number, definitions: Array<{ key: string; label: string; required: boolean; blocking: boolean }>): void {
  repo.db.transaction(() => {
    repo.db.prepare("DELETE FROM document_definitions WHERE case_type_id = ?").run(caseTypeId);
    const insert = repo.db.prepare("INSERT INTO document_definitions (case_type_id, key, label, required, blocking, position) VALUES (?,?,?,?,?,?)");
    definitions.forEach((d, position) => insert.run(caseTypeId, d.key.trim(), d.label.trim(), d.required ? 1 : 0, d.blocking ? 1 : 0, position));
  })();
  repo.bumpCaseTypeConfigVersion(caseTypeId);
}


export function listEmailCategories(repo: Repo, organizationId = 1): Array<{ id: number; organization_id: number; key: string; label: string; active: number }> {
  return repo.db.prepare("SELECT id, organization_id, key, label, active FROM organization_categories WHERE organization_id = ? AND active = 1 ORDER BY id").all(organizationId) as never[];
}


export function addEmailCategory(repo: Repo, organizationId: number, input: { key: string; label: string }): void {
  repo.db.prepare("INSERT INTO organization_categories (organization_id, key, label) VALUES (?,?,?) ON CONFLICT(organization_id, key) DO UPDATE SET label=excluded.label, active=1")
    .run(organizationId, input.key.trim(), input.label.trim());
}


export function listOrganizationPackSlots(repo: Repo, organizationId = 1): Array<{ organization_id: number; key: string; filename: string | null; mime: string | null; content: Buffer | null }> {
  const keys = [
    "application-form", "brochure-2026", "student-medical-form", "data-protection-form",
    "next-of-kin-form", "hostels-list", "fee-structure-2026", "sponsorship-form",
    "orientation-programme-2026", "credit-transfer-form",
    // Compatibility aliases for pre-WLR uploads; new UI writes concrete slots.
    "application", "admission", "brochure", "transfer",
  ];
  const rows = repo.db.prepare("SELECT organization_id, key, filename, mime, content FROM organization_pack_slots WHERE organization_id = ? ORDER BY key").all(organizationId) as Array<{ organization_id: number; key: string; filename: string | null; mime: string | null; content: Buffer | null }>;
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return keys.map((key) => byKey.get(key) ?? { organization_id: organizationId, key, filename: null, mime: null, content: null });
}


export function setOrganizationPackSlot(repo: Repo, organizationId: number, key: string, file: { filename: string; mime: string; content: Buffer }): void {
  repo.db.prepare("INSERT INTO organization_pack_slots (organization_id, key, filename, mime, content, updated_at) VALUES (?,?,?,?,?,datetime('now')) ON CONFLICT(organization_id,key) DO UPDATE SET filename=excluded.filename, mime=excluded.mime, content=excluded.content, updated_at=datetime('now')")
    .run(organizationId, key, file.filename, file.mime, file.content);
}
