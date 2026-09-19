/**
 * Automatic follow-up ladder (feature 13):
 *
 *   Day 0 → missing-document notification (sent by the pipeline)
 *   Day 3 → reminder
 *   Day 7 → final reminder
 *   Day 10 → case handed to staff
 *
 * The ladder is configurable (`followup_ladder_days` setting, e.g. "3,7,10").
 * Every reminder is factual (the checklist is recomputed from reality at rung
 * time) — if the file became complete meanwhile, the ladder quietly stops.
 *
 * Reminders are never auto-sent: an applicant with outstanding documents is
 * not fully qualified, so each rung produces a SUGGESTED reply held for staff
 * (special acceptance may apply). Returns the number of rungs processed.
 */
import type { Repo } from "../db/repo";
import type { PipelineContext } from "../pipeline/adapters";
import { checklistText, renderTemplate } from "../drafting";
import { fillSlots } from "../documents/matrix";
import { docLabel } from "../rules";
import { LIFECYCLE_LABELS } from "../types";
import { log } from "../util/log";
import { INSTITUTION } from "../branding";

const nowIso = () => new Date().toISOString();

export function ladderDays(repo: Repo): number[] {
  return repo
    .getSetting("followup_ladder_days", "3,7,10")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

export async function runFollowUpSweep(repo: Repo, _ctx: PipelineContext): Promise<number> {
  const ladder = ladderDays(repo);
  if (ladder.length === 0) return 0;
  const due = repo.dueFollowUps(nowIso());
  let processed = 0;

  for (const a of due) {
    // Recompute from reality: maybe the documents arrived since scheduling.
    const requirements = repo.effectiveRequirements(a).filter((r) => r.required);
    const activeDocs = repo.listDocuments(a.id, { activeOnly: true });
    const present = activeDocs.map((d) => d.document_type);
    const { missing } = fillSlots(requirements, present);

    if (missing.length === 0) {
      repo.setFollowup(a.id, 0, null);
      repo.audit(a.id, "system", "followup_stopped", "file became complete; ladder cancelled");
      continue;
    }

    // Ladder dates are ABSOLUTE offsets from the day the ladder was armed
    // (followup_base_at): "3,7,10" fires on Day 3, Day 7 and Day 10 — not
    // 3 days, then 7 days AFTER that, then 10 days after THAT.
    const baseMs = a.followup_base_at ? new Date(a.followup_base_at).getTime() : Date.now();

    const rung = a.followup_rung + 1;
    if (rung < ladder.length) {
      const tpl = repo.getTemplate("missing_documents");
      if (tpl) {
        const rendered = renderTemplate(tpl.subject, tpl.body, {
          ref: a.ref_number,
          institution: INSTITUTION,
          name: a.full_name ?? undefined,
          missingLabels: missing.map((m) => docLabel(m.document_type)),
          checklist: checklistText({ requirements, presentTypes: present }),
          statusLabel: LIFECYCLE_LABELS[a.lifecycle],
        });
        const subject = rung === ladder.length - 1 ? `[FINAL REMINDER] ${rendered.subject}` : `[REMINDER] ${rendered.subject}`;
        // Qualification gate: anyone on the reminder ladder still has
        // documents outstanding — by definition NOT fully qualified. The
        // reminder is held as a staff suggestion, never auto-sent: the file
        // may still be headed for special acceptance, so the office decides
        // what (if anything) goes out.
        repo.addOutbox({ applicant_id: a.id, to_address: a.email_address, subject, body: rendered.body, mode: "queued", template_key: "missing_documents" });
        repo.notify("review_needed", `${a.ref_number}: follow-up reminder (rung ${rung}/${ladder.length - 1}) drafted — review and send`, a.id);
        repo.audit(a.id, "system", "followup_held_qualification", `rung ${rung}/${ladder.length - 1} held as a suggested reply (${subject})`);
        log(`followups: ${a.ref_number} rung ${rung} reminder held for staff`);
      }
      const nextAt = new Date(baseMs + ladder[rung] * 24 * 3600_000).toISOString();
      repo.setFollowup(a.id, rung, nextAt);
      processed++;
    } else {
      // Ladder exhausted → human.
      repo.setFollowup(a.id, rung, null);
      repo.setLifecycle(a.id, "awaiting_review", "system", "follow-up ladder exhausted — documents still outstanding");
      repo.notify("review_needed", `${a.ref_number}: applicant did not respond to ${ladder.length - 1} reminders — staff follow-up needed`, a.id);
      repo.audit(a.id, "system", "followup_exhausted", "escalated to staff after full reminder ladder");
      log(`followups: ${a.ref_number} ladder exhausted → human review`, "warn");
    }
  }
  return processed;
}
