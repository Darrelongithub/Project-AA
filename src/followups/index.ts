/**
 * Automatic follow-up ladder (feature 13):
 *
 *   Day 0 → missing-document notification (sent by the pipeline)
 *   Day 3 → reminder
 *   Day 7 → final reminder
 *   Day 10 → case handed to staff
 *
 * The ladder is configurable (`followup_ladder_days` setting, e.g. "3,7,10").
 * Every reminder is factual (the checklist is recomputed from reality at send
 * time) — if the file became complete meanwhile, the ladder quietly stops.
 */
import type { Repo } from "../db/repo";
import type { PipelineContext } from "../pipeline/adapters";
import { checklistText, renderTemplate } from "../drafting";
import { docLabel } from "../rules";
import { LIFECYCLE_LABELS } from "../types";
import { log } from "../util/log";

const nowIso = () => new Date().toISOString();

export function ladderDays(repo: Repo): number[] {
  return repo
    .getSetting("followup_ladder_days", "3,7,10")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

export async function runFollowUpSweep(repo: Repo, ctx: PipelineContext): Promise<number> {
  const ladder = ladderDays(repo);
  if (ladder.length === 0) return 0;
  const due = repo.dueFollowUps(nowIso());
  let sent = 0;

  for (const a of due) {
    // Recompute from reality: maybe the documents arrived since scheduling.
    const requirements = repo.effectiveRequirements(a).filter((r) => r.required);
    const activeDocs = repo.listDocuments(a.id, { activeOnly: true });
    const present = activeDocs.map((d) => d.document_type);
    const missing = requirements.filter((r) => !present.includes(r.document_type));

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
          institution: repo.getSetting("institution_name", "Admissions"),
          name: a.full_name ?? undefined,
          missingLabels: missing.map((m) => docLabel(m.document_type)),
          checklist: checklistText({ requirements, presentTypes: present }),
          statusLabel: LIFECYCLE_LABELS[a.lifecycle],
        });
        const subject = rung === ladder.length - 1 ? `[FINAL REMINDER] ${rendered.subject}` : `[REMINDER] ${rendered.subject}`;
        try {
          await ctx.adapters.sender.send(a.email_address, subject, rendered.body, a.thread_id);
          repo.insertEmail({
            applicant_id: a.id, message_id: `followup-${a.id}-${rung}-${Date.now()}`, thread_id: a.thread_id,
            direction: "out", from_addr: "", to_addr: a.email_address, subject, body: rendered.body,
            category: null, auto: 1, at: nowIso(),
          });
          repo.audit(a.id, "system", "followup_sent", `rung ${rung}/${ladder.length - 1} (${subject})`);
          log(`followups: ${a.ref_number} rung ${rung} reminder sent`);
        } catch (e) {
          repo.audit(a.id, "system", "send_failed", `followup rung ${rung}: ${(e as Error).message}`);
        }
      }
      const nextAt = new Date(baseMs + ladder[rung] * 24 * 3600_000).toISOString();
      repo.setFollowup(a.id, rung, nextAt);
      sent++;
    } else {
      // Ladder exhausted → human.
      repo.setFollowup(a.id, rung, null);
      repo.setLifecycle(a.id, "awaiting_review", "system", "follow-up ladder exhausted — documents still outstanding");
      repo.notify("review_needed", `${a.ref_number}: applicant did not respond to ${ladder.length - 1} reminders — staff follow-up needed`, a.id);
      repo.audit(a.id, "system", "followup_exhausted", "escalated to staff after full reminder ladder");
      log(`followups: ${a.ref_number} ladder exhausted → human review`, "warn");
    }
  }
  return sent;
}
