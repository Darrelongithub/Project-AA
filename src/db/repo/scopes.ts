/**
 * /db/repo — visibility scopes, catalogues and schools. Extracted verbatim from the Repo god class;
 * every function takes the Repo as its first argument and the Repo
 * facade in ../repo.ts delegates to it (same API, same behaviour).
 */
import { ApplicantRow } from "../../types";
import type { Repo } from "../repo";

// ═══ Admissions rules engine (round 18) ══════════════════════════════════
// ── OR-8: visibility scoping — the ONLY place scope is decided ─────────
/** The schools a staff member may see.
 *
 * null = deliberately unscoped/full visibility (the default), a non-empty
 * array = assigned schools, and [] = deliberately no access. Keeping the
 * last state in staff_users makes an empty scope real instead of silently
 * turning it into unrestricted access.
 */
export function visibleSchoolsFor(repo: Repo, staff: { id: number; role: string }): string[] | null {
  if (staff.role === "admin") return null;
  const rows = repo.scopesFor(staff.id);
  if (rows.length) return rows;
  const mode = (repo.db.prepare("SELECT scope_mode FROM staff_users WHERE id = ?").get(staff.id) as { scope_mode?: string } | undefined)?.scope_mode;
  return mode === "none" ? [] : null;
}


/** DEMO: the case-list scope for a staff member — their school scope
 *  (visibleSchoolsFor) PLUS their ACTIVE organization, so queues,
 *  dashboards, mail and search never mix tenants. Pass it anywhere a
 *  `schools` scope is accepted. */
export function caseScopeFor(repo: Repo, staff: { id: number; role: string; organization_id?: number | null }): string[] {
  const schools = repo.visibleSchoolsFor(staff);
  return Object.assign(schools ? [...schools] : [], { organizationId: staff.organization_id ?? 1, allSchools: schools === null });
}


/** Would this staff member see this applicant anywhere in the console?
 * Scoped staff only see cases whose programme belongs to one of their
 * schools; a case with no programme is never shared with scoped staff. */
export function applicantVisibleTo(repo: Repo, staff: { id: number; role: string; organization_id?: number | null }, a: ApplicantRow): boolean {
  // DEMO: a case is only visible inside its own organization.
  if ((a.organization_id ?? 1) !== (staff.organization_id ?? 1)) return false;
  const scope = repo.visibleSchoolsFor(staff);
  if (!scope) return true;
  if (!a.programme) return false;
  const school = repo.programmeByCode(a.programme)?.school;
  return Boolean(school) && scope.includes(school as string);
}


// ── Subject catalogue (centrally managed, never duplicated per course) ──
export function listSubjectCatalogue(repo: Repo, system?: string): Array<{ id: number; system: string; name: string; active: number }> {
  const rows = system === undefined
    ? repo.db.prepare("SELECT * FROM subject_catalogue ORDER BY system, name").all()
    : repo.db.prepare("SELECT * FROM subject_catalogue WHERE system = ? ORDER BY name").all(system);
  return rows as never[];
}


/** OR-6: returns false when the subject already exists — callers must
 * refuse loudly; nothing is ever swallowed silently. */
export function addCatalogueSubject(repo: Repo, system: string, name: string): boolean {
  const res = repo.db
    .prepare("INSERT OR IGNORE INTO subject_catalogue (system, name) VALUES (?, ?)")
    .run(system, name.trim());
  return res.changes > 0;
}


/** OR-6: rename a catalogue subject (keeps its active status). Returns
 * false when the new name already exists in that system. */
export function renameCatalogueSubject(repo: Repo, id: number, name: string): boolean {
  const row = repo.db.prepare("SELECT system FROM subject_catalogue WHERE id = ?").get(id) as { system?: string } | undefined;
  if (!row?.system) return false;
  const clash = repo.db
    .prepare("SELECT id FROM subject_catalogue WHERE system = ? AND name = ? AND id <> ?")
    .get(row.system, name.trim(), id);
  if (clash) return false;
  repo.db.prepare("UPDATE subject_catalogue SET name = ? WHERE id = ?").run(name.trim(), id);
  return true;
}


export function setCatalogueActive(repo: Repo, id: number, active: boolean): void {
  repo.db.prepare("UPDATE subject_catalogue SET active = ? WHERE id = ?").run(active ? 1 : 0, id);
}


export function seedCatalogue(repo: Repo, entries: Array<{ system: string; name: string }>): void {
  const tx = repo.db.transaction(() => {
    for (const e of entries) repo.addCatalogueSubject(e.system, e.name);
  });
  tx();
}


// ── Staff visibility scopes (OR-8: school × staff matrix) ───────────────
export function scopesFor(repo: Repo, staffId: number): string[] {
  const rows = repo.db.prepare("SELECT school FROM staff_scopes WHERE staff_id = ? ORDER BY school").all(staffId) as Array<{ school: string }>;
  return rows.map((x) => x.school);
}


export function setCaseTypeScopes(repo: Repo, staffId: number, caseTypes: string[]): void {
  repo.db.transaction(() => {
    repo.db.prepare("DELETE FROM staff_case_type_scopes WHERE staff_id = ?").run(staffId);
    const insert = repo.db.prepare("INSERT OR IGNORE INTO staff_case_type_scopes (staff_id, case_type_code) VALUES (?,?)");
    for (const code of [...new Set(caseTypes.map((x) => x.trim().toUpperCase()).filter(Boolean))]) insert.run(staffId, code);
  })();
}


export function caseTypeScopesFor(repo: Repo, staffId: number): string[] {
  const rows = repo.db.prepare("SELECT case_type_code FROM staff_case_type_scopes WHERE staff_id = ? ORDER BY case_type_code").all(staffId) as Array<{ case_type_code: string }>;
  return rows.map((r) => r.case_type_code);
}


export function caseTypeVisibleTo(repo: Repo, staff: { id: number; role: string; organization_id?: number | null }, a: ApplicantRow): boolean {
  if (staff.role === "admin") return true;
  const scopes = repo.caseTypeScopesFor(staff.id);
  if (scopes.length === 0) return true;
  const code = a.case_type_id ? repo.caseTypeForCase(a.id)?.code : (a.programme ?? null);
  return !!code && scopes.includes(code.toUpperCase());
}


/** Replace a staff member's whole school set in ONE action.
 * An empty set is an explicit no-access scope; use clearScopes() when an
 * administrator wants to restore full visibility. */
export function setScopes(repo: Repo, staffId: number, schools: string[]): void {
  const clean = [...new Set(schools.map((x) => x.trim()).filter(Boolean))];
  const tx = repo.db.transaction(() => {
    repo.db.prepare("DELETE FROM staff_scopes WHERE staff_id = ?").run(staffId);
    repo.db.prepare("UPDATE staff_users SET scope_mode = ? WHERE id = ?").run(clean.length ? "scoped" : "none", staffId);
    const ins = repo.db.prepare("INSERT OR IGNORE INTO staff_scopes (staff_id, school) VALUES (?, ?)");
    for (const s of clean) ins.run(staffId, s);
  });
  tx();
}


/** Restore an officer's default full visibility explicitly. */
export function clearScopes(repo: Repo, staffId: number): void {
  repo.db.transaction(() => {
    repo.db.prepare("DELETE FROM staff_scopes WHERE staff_id = ?").run(staffId);
    repo.db.prepare("UPDATE staff_users SET scope_mode = 'unscoped' WHERE id = ?").run(staffId);
  })();
}


export function scopeModeFor(repo: Repo, staffId: number): "unscoped" | "scoped" | "none" {
  const row = repo.db.prepare("SELECT scope_mode FROM staff_users WHERE id = ?").get(staffId) as { scope_mode?: string } | undefined;
  if (row?.scope_mode === "none" || row?.scope_mode === "scoped") return row.scope_mode;
  return "unscoped";
}


// ── Schools (OR-6: first-class, editable, shared with courses page) ─────
/** Every school: the schools catalogue UNION the schools programmes use. */
export function listSchools(repo: Repo): string[] {
  const rows = repo.db
    .prepare("SELECT name FROM schools UNION SELECT DISTINCT school FROM programmes WHERE school <> '' ORDER BY name")
    .all() as Array<{ name: string }>;
  return rows.map((x) => x.name);
}


/** Add a school. Returns false when it already exists. */
export function addSchool(repo: Repo, name: string): boolean {
  const res = repo.db.prepare("INSERT OR IGNORE INTO schools (name) VALUES (?)").run(name.trim());
  return res.changes > 0;
}


/** Rename a school, moving every course with it. Returns the number of
 * courses moved, or -1 when the target name already exists. */
export function renameSchool(repo: Repo, from: string, to: string): number {
  const clash =
    repo.db.prepare("SELECT name FROM schools WHERE name = ?").get(to.trim()) ??
    repo.db.prepare("SELECT school FROM programmes WHERE school = ?").get(to.trim());
  if (clash) return -1;
  const moved = repo.db.prepare("UPDATE programmes SET school = ? WHERE school = ?").run(to.trim(), from).changes;
  repo.db.prepare("UPDATE schools SET name = ? WHERE name = ?").run(to.trim(), from);
  return moved;
}
