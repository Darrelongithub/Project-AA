/**
 * /db/repo — automation posture, intake deadlines and follow-ups. Extracted verbatim from the Repo god class;
 * every function takes the Repo as its first argument and the Repo
 * facade in ../repo.ts delegates to it (same API, same behaviour).
 */
import { ApplicantRow } from "../../types";
import type { Repo } from "../repo";
import { nowIso } from "./shared";

// ── Automation config (features 17, 18) ──────────────────────────────────
export function automationMode(repo: Repo, category: string): "auto" | "draft" {
  const globalDraft = repo.getSetting("automation_mode", "auto") === "draft";
  if (globalDraft) return "draft";
  const row = repo.db.prepare("SELECT mode FROM automation_config WHERE category = ?").get(category) as { mode: string } | undefined;
  return row?.mode === "draft" ? "draft" : "auto";
}


export function setAutomationMode(repo: Repo, category: string, mode: "auto" | "draft"): void {
  repo.db
    .prepare(
      "INSERT INTO automation_config (category, mode) VALUES (?, ?) ON CONFLICT(category) DO UPDATE SET mode = excluded.mode"
    )
    .run(category, mode);
}


export function allAutomationConfig(repo: Repo): Array<{ category: string; mode: string }> {
  return repo.db.prepare("SELECT category, mode FROM automation_config ORDER BY category").all() as never[];
}


// ── Intakes with deadlines (features 20, 21) ─────────────────────────────
export function listIntakeRows(repo: Repo): Array<{ name: string; deadline: string | null }> {
  return repo.db.prepare("SELECT name, deadline FROM intakes ORDER BY rowid").all() as never[];
}


export function addIntakeWithDeadline(repo: Repo, name: string, deadline: string | null): void {
  repo.db
    .prepare("INSERT INTO intakes (name, deadline) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET deadline = excluded.deadline")
    .run(name, deadline);
}


export function setIntakeDeadline(repo: Repo, name: string, deadline: string | null): void {
  repo.db.prepare("UPDATE intakes SET deadline = ? WHERE name = ?").run(deadline, name);
}


export function intakeDeadline(repo: Repo, intake: string | null): string | null {
  if (!intake) return null;
  const row = repo.db.prepare("SELECT deadline FROM intakes WHERE name = ?").get(intake) as { deadline: string | null } | undefined;
  return row?.deadline ?? null;
}


// ── Automatic follow-ups (feature 13) ────────────────────────────────────
/**
 * @param baseAt when set, (re)arms the ladder base date — rung N fires at
 * base + ladder[N] days, so "3,7,10" means Day 3 / Day 7 / Day 10 from the
 * first notice, not stacked intervals.
 */
export function setFollowup(repo: Repo, applicantId: number, rung: number, nextAt: string | null, baseAt?: string | null, action?: string): void {
  if (action !== undefined) {
    repo.db
      .prepare("UPDATE applicants SET followup_rung = ?, followup_next_at = ?, followup_base_at = ?, followup_action = ?, updated_at = ? WHERE id = ?")
      .run(rung, nextAt, baseAt ?? null, action, nowIso(), applicantId);
  } else if (baseAt !== undefined) {
    repo.db
      .prepare("UPDATE applicants SET followup_rung = ?, followup_next_at = ?, followup_base_at = ?, updated_at = ? WHERE id = ?")
      .run(rung, nextAt, baseAt, nowIso(), applicantId);
  } else {
    repo.db
      .prepare("UPDATE applicants SET followup_rung = ?, followup_next_at = ?, updated_at = ? WHERE id = ?")
      .run(rung, nextAt, nowIso(), applicantId);
  }
}


/**
 * Optimistic rung claim for the follow-up ladder: advance rung + next_at in
 * ONE update guarded on the rung the sweeper READ. Two sweepers holding the
 * same stale due-list — one holds the row, one drafts a duplicate — used to
 * both write; with the claim, exactly one wins by definition of changes>0.
 */
export function claimFollowupRung(repo: Repo, applicantId: number, expectedRung: number, nextRung: number, nextAt: string | null): boolean {
  const res = repo.db
    .prepare(
      `UPDATE applicants SET followup_rung = ?, followup_next_at = ?
       WHERE id = ? AND followup_rung = ?
         AND lifecycle IN ('application_received','documents_received')`
    )
    .run(nextRung, nextAt, applicantId, expectedRung);
  return res.changes > 0;
}


export function dueFollowUps(repo: Repo, now: string): ApplicantRow[] {
  return repo.db
    .prepare(
      `SELECT * FROM applicants
       WHERE followup_next_at IS NOT NULL AND followup_next_at <= ?
         AND lifecycle IN ('application_received','documents_received')`
    )
    .all(now) as ApplicantRow[];
}
