/**
 * Pipeline stages 22-26: closeout — provisional admit, follow-up ladder,
 * review queue + SLA, lifecycle transitions, and the decision log.
 *
 * Stage bodies are the verbatim code of the original `processEmailInner`;
 * each wrapper takes one typed input and returns one typed result.
 */
import { Decision } from "../../decisions";
import { LIFECYCLE_ORDER } from "../../types";
import { writeDecisionLog } from "../../logs";
import { envInt } from "../../util/envnum";
import { docLabel } from "../../rules";
import { log } from "../../util/log";
import type {
  ProvisionalStageInput,
  ProvisionalStageResult,
  LadderStageInput,
  ReviewQueueStageInput,
  LifecycleStageTransitionInput,
  LogStageInput,
} from "./types";

/** Stage 22 — provisional admit. */
export function runProvisionalStage(input: ProvisionalStageInput): ProvisionalStageResult {
  const { ctx, applicant, applicantNow, genericCaseType, admissionLetterSent } = input;
  const { repo } = ctx;
  // ── Provisional admission (M-3: the legacy auto-admit path, restored) ───
  // The letter went out under the profile's explicit opt-in, so the case is
  // admitted provisionally and the decision is recorded as AUTOMATED:
  // admission_route "auto" (never "human"), decision_reason explains the
  // basis, and the audit trail carries the exact event. Nothing here decides
  // on its own — the evaluator routed auto_admit only on a complete matrix +
  // satisfied rule tree + reliable extraction, and every gate above has
  // agreed. A registrar may reverse it through the ordinary not_admitted
  // decision path on the case page.
  let autoAdmitted = false;
  if (admissionLetterSent) {
    // The trail must show the step the file actually passed through before it
    // was admitted: every required document was read and checked. Auto-admit
    // would otherwise jump straight from documents_received to completed.
    const stageNow = repo.getApplicant(applicant.id)!.lifecycle;
    if (LIFECYCLE_ORDER.indexOf(stageNow) < LIFECYCLE_ORDER.indexOf("documents_checked")) {
      repo.setLifecycle(applicant.id, "documents_checked", "system", "all required documents verified automatically");
    }
    repo.recordDecision(applicant.id, Decision.auto({
      outcome: "auto_approved",
      reasoning: "All configured admission requirements satisfied — provisional admission recorded automatically; a registrar may reverse it.",
    }));
    repo.audit(
      applicant.id,
      "system",
      "auto_admission_triggered",
      `${applicantNow.ref_number}: complete file, satisfied rules and clean watcher on auto-admit profile “${genericCaseType?.name ?? ""}” — provisional admission recorded and the admission letter sent`
    );
    repo.notify(
      "auto_admitted",
      `${applicantNow.ref_number}: provisionally admitted automatically — reversal available on the case page`,
      applicant.id
    );
    autoAdmitted = true;
  }
  return {
    autoAdmitted,
  };
}

/** Stage 23 — follow-up ladder. */
export function runLadderStage(input: LadderStageInput): void {
  const { ctx, applicant, finalStatus, autoSent, heldForQualification, heldForApproval, replyRule, autoKind, replyAction } = input;
  const { repo } = ctx;
  // ── Follow-up ladder (v3 feature 13) ─────────────────────────────────────
  // Missing-docs notices schedule the first reminder; a Green verdict cancels
  // any pending ladder for this applicant.
  const ladderDaysStr = repo.getSetting("followup_ladder_days", "3,7,10");
  const ladder = ladderDaysStr
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (finalStatus === "Green") {
    repo.setFollowup(applicant.id, 0, null, null);
  } else if (
    (autoSent || heldForQualification || heldForApproval || (replyRule !== null && autoKind !== null)) &&
    (autoKind === "missing_docs" || autoKind === "docs_request") &&
    (replyRule === null || replyAction?.followup === "ladder") &&
    replyAction?.followup_action !== "none" && // P1-3: explicit do-nothing cancels the ladder
    ladder.length > 0
  ) {
    // Base date anchors the ladder: rung N fires at base + ladder[N] days.
    // P1-3: the rung response action comes from the rule (default "hold").
    const baseAt = new Date().toISOString();
    const nextAt = new Date(Date.now() + ladder[0] * 24 * 3600_000).toISOString();
    repo.setFollowup(applicant.id, 0, nextAt, baseAt, replyAction?.followup_action ?? "hold");
    repo.audit(applicant.id, "system", "followup_scheduled", `reminder ladder armed (${ladderDaysStr}, response=${replyAction?.followup_action ?? "hold"})`);
  }
}

/** Stage 24 — SLA + queue-for-human. */
export function runReviewQueueStage(input: ReviewQueueStageInput): void {
  const { ctx, applicant, applicantNow, category, enquiryOnly, humanTriageOnly, heldForQualification, heldForApproval, finalStatus, watcherFlagged, rulesOut, replyAction, queueForHuman } = input;
  const { repo } = ctx;
  if (queueForHuman) {
    // SLA clock starts (feature 28); staff action stops it. A response rule
    // may declare its own target hours.
    // A corrupt setting must not crash intake (NaN → Invalid Date → throw).
    const slaHours = replyAction?.sla_hours ?? envInt(repo.getSetting("sla_target_hours", "4"), 4);
    const due = new Date(Date.now() + slaHours * 3600_000).toISOString();
    const cur = repo.getApplicant(applicant.id)!;
    if (!cur.sla_handled_at) repo.updateApplicant(applicant.id, { sla_due_at: due });
    const reason = humanTriageOnly
      ? `${enquiryOnly ? "admission enquiry" : category.replace(/_/g, " ")} — staff response required`
      : heldForQualification && !heldForApproval
      ? "applicant not fully qualified — suggested reply held for staff (special acceptance may apply)"
      : heldForApproval
        ? "automated reply held for approval (draft-first mode)"
      : finalStatus === "Orange"
        ? "flagged for human review"
        : watcherFlagged
          ? "watcher flagged the record"
          : `missing/unclear documents (${rulesOut.missing.map((m) => docLabel(m)).join(", ") || "review needed"})`;
    repo.notify("review_needed", `${cur.ref_number} needs review — ${reason}`, applicant.id);
    repo.audit(applicant.id, "system", "human_review_triggered", reason);
    log(`pipeline: ${applicantNow.ref_number} queued for human (${reason})`);
  }
}

/** Stage 25 — lifecycle transitions. */
export function runLifecycleStage(input: LifecycleStageTransitionInput): void {
  const { ctx, applicant, admitNow, autoAdmitted, autoKind, finalStatus } = input;
  let lifecycleAfter = input.lifecycleAfter;
  const { repo } = ctx;
  // ── Lifecycle transition + status history (features 15, 16) ─────────────
  // The provisional admission set the file to "completed" above; if that
  // admission never completed (send failed, letter template missing), the
  // file waits for a person — it is never presented as closed.
  if (admitNow && !autoAdmitted) lifecycleAfter = "awaiting_review";
  const lifecycleNow = repo.getApplicant(applicant.id)!.lifecycle;
  if (lifecycleNow !== lifecycleAfter) {
    const why = autoAdmitted
        ? "provisional admission recorded — the admission letter was sent; a registrar may reverse it"
      : autoKind === "ack"
        ? "all required documents verified automatically"
        : lifecycleAfter === "awaiting_review"
          ? "queued for human review"
          : lifecycleAfter === "documents_received"
            ? "documents received; file not yet complete"
            : "application received";
    repo.setLifecycle(applicant.id, lifecycleAfter, "system", why);
  }

  // Triage verdict snapshot.
  repo.updateApplicant(applicant.id, { triage: finalStatus });
}

/** Stage 26 — decision log. */
export function runLogStage(input: LogStageInput): void {
  const { ctx, email, applicant, finalStatus, reasoning, autoSent } = input;
  const { repo } = ctx;
  // ── DecisionLog + audit, always (feature 17) ────────────────────────────
  writeDecisionLog(
    repo,
    {
      applicant_id: applicant.id,
      triggering_email_id: email.id,
      computed_status: finalStatus,
      reasoning,
      auto_sent: autoSent,
    },
    { jsonlPath: ctx.jsonlPath }
  );
}
