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
 * Reminders are never auto-sent unless a rule says so and the case type's
 * evidence gate is off: outstanding information always produces a SUGGESTED
 * reply held for staff by default. Returns the number of rungs processed.
 */
import type { Repo } from "../db/repo";
import type { PipelineContext, SendExtras } from "../pipeline/adapters";
import { checklistText, renderTemplate } from "../drafting";
import { fillSlots } from "../documents/matrix";
import { docLabel } from "../rules";
import { LIFECYCLE_LABELS } from "../types";
import { log } from "../util/log";
import { organizationName, organizationSender, emailBanner } from "../branding";

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
      // Claim the rung BEFORE anything visible happens (draft, notify, audit):
      // a second sweeper holding the same stale due-list loses this update by
      // definition of changes>0 and skips — no duplicate reminder, no rung jump.
      const nextAt = new Date(baseMs + ladder[rung] * 24 * 3600_000).toISOString();
      if (!repo.claimFollowupRung(a.id, a.followup_rung, rung, nextAt)) {
        log(`followups: ${a.ref_number} rung ${rung} already claimed by another sweep — skipped`, "warn");
        continue;
      }
      const organizationId = a.organization_id ?? 1;
      // PPR P1-3: the RULE that armed the ladder decides how each rung responds
      // (send / draft / approve / hold / none). Default "hold" keeps every rung
      // with a person; "send" is additionally subject to the case type's
      // evidence gate — gate-on types keep holding.
      const rungAction = (a as { followup_action?: string }).followup_action ?? "hold";
      const caseType = repo.caseTypeForCase(a.id);
      const gateOn = (caseType?.evidence_gate ?? 1) !== 0;
      // The global draft-first switch governs EVERY outgoing reply, including
      // reminder rungs: a rule that says "send" cannot outvote it.
      const globalAuto = repo.automationAllowedGlobally();
      // P1-9: the rung wording comes from the case's own templates — a case
      // type never inherits another type's vocabulary.
      const tpl = repo.getTemplate("missing_documents", organizationId, caseType?.id);
      if (rungAction === "none") {
        repo.audit(a.id, "system", "followup_action_none", `rung ${rung}/${ladder.length - 1} skipped (rule follow-up action = do nothing)`);
        processed++;
        continue;
      }
      if (tpl) {
        const rendered = renderTemplate(tpl.subject, tpl.body, {
          ref: a.ref_number,
          institution: organizationName(repo, organizationId),
          name: a.full_name ?? undefined,
          missingLabels: missing.map((m) => docLabel(m.document_type)),
          checklist: checklistText({ requirements, presentTypes: present }),
          statusLabel: LIFECYCLE_LABELS[a.lifecycle],
        });
        const subject = rung === ladder.length - 1 ? `[FINAL REMINDER] ${rendered.subject}` : `[REMINDER] ${rendered.subject}`;
        if (rungAction === "send" && !gateOn && globalAuto) {
          // Explicit rule action + un-gated case type + the global switch
          // released: the reminder goes out.
          const extras: SendExtras = { banner: emailBanner(repo, organizationId), attachments: [], ...organizationSender(repo, organizationId) };
          try {
            await ctx.adapters.sender.send(a.email_address, subject, rendered.body, "", extras);
            repo.addOutbox({ applicant_id: a.id, to_address: a.email_address, subject, body: rendered.body, mode: "auto", template_key: "missing_documents" });
            repo.audit(a.id, "system", "followup_sent", `rung ${rung}/${ladder.length - 1} reminder sent (${subject})`);
            if (ctx.adapters.sender.delivers === false) {
              repo.audit(a.id, "system", "email_not_delivered", `recorded only — no mail connection is configured, so "${subject}" was NOT delivered to ${a.email_address}`);
            }
            log(`followups: ${a.ref_number} rung ${rung} reminder sent`);
          } catch (e) {
            repo.addOutbox({ applicant_id: a.id, to_address: a.email_address, subject, body: rendered.body, mode: "queued", template_key: "missing_documents" });
            repo.audit(a.id, "system", "followup_send_failed", `rung ${rung} send failed, held as draft (${e instanceof Error ? e.message : String(e)})`);
            log(`followups: ${a.ref_number} rung ${rung} send failed — held`, "warn");
          }
        } else if (rungAction === "draft") {
          repo.addOutbox({ applicant_id: a.id, to_address: a.email_address, subject, body: rendered.body, mode: "queued", template_key: "missing_documents" });
          repo.notify("review_needed", `${a.ref_number}: follow-up reminder (rung ${rung}/${ladder.length - 1}) drafted — review and send`, a.id);
          repo.audit(a.id, "system", "followup_drafted", `rung ${rung}/${ladder.length - 1} drafted for staff (${subject})`);
          log(`followups: ${a.ref_number} rung ${rung} reminder drafted`);
        } else if (rungAction === "approve") {
          repo.addOutbox({ applicant_id: a.id, to_address: a.email_address, subject, body: rendered.body, mode: "queued", template_key: "missing_documents", needs_approval: 1 });
          repo.notify("review_needed", `${a.ref_number}: follow-up reminder (rung ${rung}/${ladder.length - 1}) awaiting automation approval`, a.id);
          repo.audit(a.id, "system", "followup_awaiting_approval", `rung ${rung}/${ladder.length - 1} queued for approval (${subject})`);
          log(`followups: ${a.ref_number} rung ${rung} reminder awaiting approval`);
        } else {
          // "hold" (generic default) or "send" on a gate-on profile: anyone
          // on the reminder ladder still has documents outstanding — by
          // definition NOT fully qualified. Held as a staff suggestion.
          repo.addOutbox({ applicant_id: a.id, to_address: a.email_address, subject, body: rendered.body, mode: "queued", template_key: "missing_documents" });
          repo.notify("review_needed", `${a.ref_number}: follow-up reminder (rung ${rung}/${ladder.length - 1}) drafted — review and send`, a.id);
          repo.audit(a.id, "system", "followup_held_qualification", `rung ${rung}/${ladder.length - 1} held as a suggested reply (${subject})`);
          log(`followups: ${a.ref_number} rung ${rung} reminder held for staff`);
        }
      }
      processed++;
    } else {
      // Ladder exhausted → human. Same optimistic claim: only one sweeper may
      // escalate this case, even if both read the same stale due-list.
      if (!repo.claimFollowupRung(a.id, a.followup_rung, rung, null)) {
        log(`followups: ${a.ref_number} ladder-exhaustion already claimed by another sweep — skipped`, "warn");
        continue;
      }
      repo.setLifecycle(a.id, "awaiting_review", "system", "follow-up ladder exhausted — documents still outstanding");
      repo.notify("review_needed", `${a.ref_number}: no response to ${ladder.length - 1} reminders — staff follow-up needed`, a.id);
      repo.audit(a.id, "system", "followup_exhausted", "escalated to staff after full reminder ladder");
      log(`followups: ${a.ref_number} ladder exhausted → human review`, "warn");
    }
  }
  return processed;
}
