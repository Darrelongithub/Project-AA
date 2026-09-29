/**
 * /db/repo — message templates. Extracted verbatim from the Repo god class;
 * every function takes the Repo as its first argument and the Repo
 * facade in ../repo.ts delegates to it (same API, same behaviour).
 */
import type { Repo } from "../repo";

// ── Templates (feature 35) ───────────────────────────────────────────────
export function getTemplate(repo: Repo, key: string, organizationId = 1, caseTypeId?: number): { key: string; name: string; subject: string; body: string; include_banner: number; attach_pack: string; case_type_id: number } | undefined {
  // PPR P0-6 precedence: the profile's own row → organization-wide row →
  // the migrated education profile's legacy store. A template key is not a
  // closed enum — any key a profile needs can exist and shadow freely.
  const rows = repo.db.prepare(
    "SELECT key, name, subject, body, include_banner, attach_pack, case_type_id FROM organization_templates WHERE organization_id = ? AND key = ?"
  ).all(organizationId, key) as never[];
  const typed = rows as Array<{ case_type_id: number }>;
  // case_type_id = 0 → organization-wide; > 0 → ONLY that profile's cases.
  // An explicit caseTypeId never picks up another profile's template.
  const scoped = caseTypeId !== undefined
    ? typed.find((r) => r.case_type_id === caseTypeId) ?? typed.find((r) => r.case_type_id === 0)
    : typed[0];
  if (scoped) return scoped as never;
  const legacy = repo.db.prepare(
    "SELECT key, name, subject, body, include_banner, attach_pack, 0 AS case_type_id FROM templates WHERE key = ? AND COALESCE(organization_id, 1) = ?"
  ).get(key, organizationId) as never;
  return legacy ?? undefined;
}


export function listTemplates(repo: Repo, organizationId = 1): Array<{ key: string; name: string; subject: string; body: string; include_banner: number; attach_pack: string; case_type_id: number }> {
  const owned = repo.db.prepare("SELECT key, name, subject, body, include_banner, attach_pack, case_type_id FROM organization_templates WHERE organization_id = ? ORDER BY key").all(organizationId) as any[];
  const legacy = repo.db.prepare("SELECT key, name, subject, body, include_banner, attach_pack, 0 AS case_type_id FROM templates WHERE COALESCE(organization_id, 1) = ? ORDER BY key").all(organizationId) as any[];
  const byKey = new Map([...legacy, ...owned].map((row: any) => [row.key, row]));
  return [...byKey.values()] as never[];
}


/** PPR P0-6: the profile's own default, captured when the template was
 *  created — "Reset to default" restores exactly this, never someone
 *  else's wording. */
export function templateDefaultSnapshot(repo: Repo, key: string, organizationId = 1): { name: string; subject: string; body: string; include_banner: number; attach_pack: string } | null {
  const row = (repo.db.prepare("SELECT default_snapshot FROM organization_templates WHERE organization_id = ? AND key = ?").get(organizationId, key)
    ?? repo.db.prepare("SELECT default_snapshot FROM templates WHERE key = ? AND COALESCE(organization_id, 1) = ?").get(key, organizationId)) as { default_snapshot: string | null } | undefined;
  if (!row?.default_snapshot) return null;
  try { return JSON.parse(row.default_snapshot); } catch { return null; }
}


/** OR-7: attachPack names one of the organization's attachment sets ("none"
 *  for no attachments). PPR P0-6: caseTypeId binds the template to one
 *  workflow profile (0 = organization-wide); the default snapshot is
 *  captured at creation and never rewritten by later edits. */
export function upsertTemplate(repo: Repo, key: string, name: string, subject: string, body: string, includeBanner?: boolean, attachPack?: string, organizationId = 1, caseTypeId = 0): void {
  // A CaseType-scoped template must name a CaseType that exists AND belongs
  // to the template's organization — a forged id otherwise cross-links two
  // tenants' catalogues (the id is route input; validated here so every
  // caller is covered). 0/undefined stays org-wide.
  if (caseTypeId > 0) {
    const ct = repo.caseTypeById(caseTypeId);
    if (!ct || ct.organization_id !== organizationId) {
      throw new Error(`Unknown CaseType #${caseTypeId} for organization ${organizationId}`);
    }
  }
  // PPR P0-5 (E3 close): a template may attach NOTHING or one of the
  // organization's OWN attachment sets — validated here at the repo level,
  // not just in one route. Unknown refs fail loudly; nothing is silently
  // coerced, and no privileged pack vocabulary exists to abuse.
  let pack: string | null = null;
  if (attachPack !== undefined) {
    pack = attachPack.trim() || "none";
    if (pack !== "none") {
      const set = pack.startsWith("set:") ? repo.getAttachmentSet(Number(pack.slice(4))) : repo.attachmentSetByName(organizationId, pack);
      if (!set || set.organization_id !== organizationId) {
        throw new Error(`Unknown attachment set '${attachPack}' for organization ${organizationId}`);
      }
      pack = set.name;
    }
  }
  const bannerVal = includeBanner === undefined ? 1 : includeBanner ? 1 : 0;
  const snapshot = JSON.stringify({ name, subject, body, include_banner: bannerVal, attach_pack: pack ?? "none" });
  if (organizationId !== 1 || caseTypeId > 0) {
    const current = repo.getTemplate(key, organizationId, caseTypeId);
    repo.db.prepare(
      `INSERT INTO organization_templates (organization_id, key, name, subject, body, include_banner, attach_pack, case_type_id, default_snapshot) VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(organization_id, key) DO UPDATE SET name=excluded.name, subject=excluded.subject, body=excluded.body,
         include_banner=COALESCE(?, organization_templates.include_banner), attach_pack=COALESCE(?, organization_templates.attach_pack),
         case_type_id=excluded.case_type_id, updated_at=datetime('now')`
    ).run(organizationId, key, name, subject, body, includeBanner === undefined ? current?.include_banner ?? 1 : bannerVal,
      pack ?? current?.attach_pack ?? "none", caseTypeId, snapshot,
      includeBanner === undefined ? null : bannerVal, pack);
    return;
  }
  repo.db.prepare(
    `INSERT INTO templates (key, organization_id, name, subject, body, include_banner, attach_pack, default_snapshot) VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET organization_id = excluded.organization_id, name = excluded.name, subject = excluded.subject, body = excluded.body,
       include_banner = COALESCE(?, templates.include_banner), attach_pack = COALESCE(?, templates.attach_pack), updated_at = datetime('now')`
  ).run(key, organizationId, name, subject, body, bannerVal, pack ?? "none", snapshot,
    includeBanner === undefined ? null : bannerVal, pack);
}


export function setTemplateBanner(repo: Repo, key: string, include: boolean): void {
  repo.db.prepare("UPDATE templates SET include_banner = ? WHERE key = ?").run(include ? 1 : 0, key);
}
