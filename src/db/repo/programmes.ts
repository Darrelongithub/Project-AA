/**
 * /db/repo — programmes and intakes. Extracted verbatim from the Repo god class;
 * every function takes the Repo as its first argument and the Repo
 * facade in ../repo.ts delegates to it (same API, same behaviour).
 */
import { CourseLevel, Programme } from "../../types";
import type { Repo } from "../repo";

// ── Programmes & intakes ─────────────────────────────────────────────────
export function listProgrammes(repo: Repo): Programme[] {
  return repo.db
    .prepare(
      `SELECT p.code, p.name, p.school, p.entry_requirements, p.owner_id, s.display_name AS owner_name, p.level
       FROM programmes p LEFT JOIN staff_users s ON s.id = p.owner_id
       ORDER BY p.school, p.code`
    )
    .all() as never[];
}


export function programmeByCode(repo: Repo, code: string): Programme | undefined {
  return repo.db
    .prepare(
      `SELECT p.code, p.name, p.school, p.entry_requirements, p.owner_id, s.display_name AS owner_name, p.level
       FROM programmes p LEFT JOIN staff_users s ON s.id = p.owner_id
       WHERE p.code = ? COLLATE NOCASE`
    )
    .get(code) as Programme | undefined;
}


/** Editable catalogue fields (name/school/entry requirements) — Configuration. */
export function updateProgramme(repo: Repo, code: string, fields: { name?: string; school?: string; entry_requirements?: string }): void {
  const cur = repo.db.prepare("SELECT name, school, entry_requirements FROM programmes WHERE code = ?").get(code) as
    | { name: string; school: string; entry_requirements: string }
    | undefined;
  if (!cur) return;
  repo.db
    .prepare("UPDATE programmes SET name = ?, school = ?, entry_requirements = ? WHERE code = ?")
    .run(
      fields.name?.trim() || cur.name,
      fields.school !== undefined ? fields.school.trim() || cur.school : cur.school,
      fields.entry_requirements !== undefined ? fields.entry_requirements.trim() : cur.entry_requirements,
      code
    );
}


/** Courses are worked by people: a new case lands with its course's owner. */
export function ownerOfProgramme(repo: Repo, code: string | null): number | null {
  if (!code) return null;
  // The join on active staff matters: a deactivated officer must never
  // receive freshly routed cases (or the notifications that come with them).
  const row = repo.db
    .prepare(
      `SELECT p.owner_id FROM programmes p
       JOIN staff_users s ON s.id = p.owner_id AND s.active = 1
       WHERE p.code = ? COLLATE NOCASE`
    )
    .get(code) as { owner_id: number | null } | undefined;
  return row?.owner_id ?? null;
}


export function addProgramme(repo: Repo, code: string, name: string, school = "", entry = "", level: CourseLevel = "degree"): void {
  repo.db
    .prepare(
      `INSERT INTO programmes (code, name, school, entry_requirements, level) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET name = excluded.name,
         school = CASE WHEN programmes.school = '' THEN excluded.school ELSE programmes.school END,
         entry_requirements = CASE WHEN programmes.entry_requirements = '' THEN excluded.entry_requirements ELSE programmes.entry_requirements END,
         level = excluded.level`
    )
    .run(code.toUpperCase(), name, school, entry, level);
}


/** Assign (or unassign, with null) the staff member who handles a course. */
export function assignProgrammeOwner(repo: Repo, code: string, staffId: number | null): void {
  repo.db.prepare("UPDATE programmes SET owner_id = ? WHERE code = ?").run(staffId, code);
}


export function listIntakes(repo: Repo): string[] {
  return (repo.db.prepare("SELECT name FROM intakes ORDER BY rowid").all() as Array<{ name: string }>).map((r) => r.name);
}


export function addIntake(repo: Repo, name: string): void {
  repo.db.prepare("INSERT OR IGNORE INTO intakes (name) VALUES (?)").run(name);
}
