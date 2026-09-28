/**
 * Pipeline stages 15-21: reply — gate v2, reply selection, draft-first and
 * qualification gates, admission safety, drafting, and send-or-queue.
 *
 * Stage bodies are the verbatim code of the original `processEmailInner`;
 * each wrapper takes one typed input and returns one typed result.
 */
import { gate } from "../../gate";
import { MIN_AUTO_PASS_SCORE } from "../../extraction/extract";
import { describeRule, firstMatchingRule, replyStateOf, type RuleAction } from "../../rules/workflow";
import { emailBanner, organizationName, organizationSender } from "../../branding";
import { docLabel, normalizeName } from "../../rules";
import { checklistText, pickQueuedDraft, renderTemplate } from "../../drafting";
import { documentIssuesText, readBackText } from "../../extraction/feedback";
import { LIFECYCLE_LABELS } from "../../types";
import { log } from "../../util/log";
import type { Draft, DraftContext } from "../../drafting";
import type { LifecycleStage, ProcessResult } from "../../types";
import type { SendExtras } from "../adapters";
import type {
  GateStageInput,
  GateStageResult,
  ReplySelectStageInput,
  ReplySelectStageResult,
  DraftFirstStageInput,
  DraftFirstStageResult,
  QualGateStageInput,
  QualGateStageResult,
  AdmitSafetyStageInput,
  AdmitSafetyStageResult,
  DraftingStageInput,
  DraftingStageResult,
  SendStageInput,
  SendStageResult,
} from "./types";

/** Stage 15 — gate v2. */
export function runGateStage(input: GateStageInput): GateStageResult {
  const { ctx, email, applicant, applicantNow, activeDocs, humanTriageOnly, finalStatus, rulesOut, watcherFlagged } = input;
  const { repo } = ctx;
  // ── Gate v2 (features 11, 13, 21) ────────────────────────────────────────
  const activeBlockingFlags = repo
    .activeFlags(applicant.id)
    .filter((f) => f.type !== "duplicate_submission");
  // Numeric readability gate: every document must reach the auto-pass score.
  // (Legacy DBs without the score fall back to the tier — high ⇒ pass.)
  const allDocsHigh = activeDocs.every(
    (d) => (d.confidence_score || (d.confidence === "high" ? 100 : 0)) >= MIN_AUTO_PASS_SCORE
  );
  const cleanMissingCase =
    !humanTriageOnly &&
    finalStatus === "Red" &&
    rulesOut.missing.length > 0 &&
    activeBlockingFlags.length === 0 &&
    allDocsHigh &&
    !watcherFlagged;
  const gateDecision = gate(finalStatus, { ran: rulesOut.status === "Green", flagged: watcherFlagged });

  const refOnlyOwnCase =
    email.attachments.length === 0 &&
    /^[A-Z]{1,6}-\d{4}-\d{1,8}$/i.test(email.body.trim()) &&
    email.body.trim().toUpperCase() === applicantNow.ref_number.toUpperCase() &&
    email.from.trim().toLowerCase() === applicantNow.email_address;
  return {
    gateDecision,
    activeBlockingFlags,
    cleanMissingCase,
    refOnlyOwnCase,
  };
}

/** Stage 16 — reply selection. */
export function runReplySelectStage(input: ReplySelectStageInput): ReplySelectStageResult {
  const { ctx, email, applicant, applicantNow, category, senderState, verdict, intakeRule, scopedResponseRules, finalStatus, watcherFlagged, cleanMissingCase, refOnlyOwnCase, gateDecision, activeBlockingFlags, activeDocs, humanTriageOnly, opts } = input;
  const { repo } = ctx;
  // ── Reply selection (PPR P0-4): stored response rules decide what the
  //    case replies and how it routes. Profiles without response rules keep
  //    the original chain below, unchanged. Templates, send/draft/hold,
  //    follow-up ladder and audit codes are all rule data — the qualification
  //    gate still holds every non-fully-qualified reply for staff when the
  //    profile has one (the migrated education profile keeps it). ──────────
  let autoKind: ProcessResult["autoKind"] = null;
  let queueForHuman = false;
  /** PPR P0-4: the template a response rule resolved (may be any profile key). */
  let ruleTemplateKey: string | null = null;
  /** PPR P1-3: the queued draft needs "Approve automation" to release. */
  let draftNeedsApproval = false;
  const fullyQualified =
    finalStatus === "Green" && activeBlockingFlags.length === 0 && !watcherFlagged;
  const ruleDocsState = replyStateOf({
    fullyQualified,
    blockingFlags: activeBlockingFlags.length > 0,
    cleanMissing: cleanMissingCase,
    docsOnFile: activeDocs.length,
  });
  const replyRule = (scopedResponseRules.length > 0
    ? firstMatchingRule(scopedResponseRules, {
        senderState,
        subject: email.subject,
        body: email.body,
        hasAttachments: email.attachments.length > 0,
        category,
        bodyIsRef: refOnlyOwnCase,
        educationSignals: verdict.category === "parked" ? "parked" : "open",
        docsState: ruleDocsState,
        docsOnFile: activeDocs.length,
      })
    : null) ?? (intakeRule && intakeRule.action.reply_action ? intakeRule : null);
  // A first-email rule may carry the reply too (create + reply in one rule).
  const replyAction: RuleAction | null = replyRule?.action ?? null;

  const resolveRuleTemplateKey = (ra: RuleAction): string | null => {
    if (ra.template_map) {
      if (ruleDocsState === "complete" && ra.template_map.green) return ra.template_map.green;
      if (ruleDocsState === "empty" && ra.template_map.empty) return ra.template_map.empty;
      if (ruleDocsState === "missing" && ra.template_map.missing) return ra.template_map.missing;
    }
    return ra.template_key ?? null;
  };
  const autoKindFor = (key: string | null): ProcessResult["autoKind"] =>
    key === "ack_received" ? "ack" : key === "docs_request" ? "docs_request"
    : key === "missing_documents" ? "missing_docs" : key === "status_answer" ? "status_answer" : null;

  if (replyRule && replyAction) {
    const key = resolveRuleTemplateKey(replyAction)
      ?? (replyAction.fallback && replyAction.fallback.startsWith("template:") ? replyAction.fallback.slice("template:".length) : null);
    // Record which rule drove the reply (the intake audit may have already
    // recorded this very rule — one clean event per rule per message).
    if (!(replyRule.id === intakeRule?.id && intakeRule?.action.audit_code)) {
      repo.audit(
        applicant.id,
        "system",
        replyAction.audit_code || "workflow_rule_fired",
        `rule “${replyRule.name}” matched — ${describeRule(replyRule)}`
      );
    }
    // A review decision or a hold always defers to a person; any template the
    // rule names becomes their SUGGESTION, never a send. So does a forced
    // human-triage case (no-eval folder, generic category policy).
    if (humanTriageOnly || replyAction.decision === "review" || replyAction.reply_action === "hold") {
      queueForHuman = true;
      if (key && !humanTriageOnly) {
        ruleTemplateKey = key;
        autoKind = autoKindFor(key);
      }
    } else if ((replyAction.reply_action === "draft" || replyAction.reply_action === "approve") && key) {
      // Rendered and queued — never sent from here. "approve" additionally
      // requires the "Approve automation" permission to release (P1-3).
      ruleTemplateKey = key;
      autoKind = autoKindFor(key);
      queueForHuman = true;
      if (replyAction.reply_action === "approve") draftNeedsApproval = true;
    } else if (replyAction.reply_action === "send" && key) {
      // Intended to go out; the draft-first and qualification gates below
      // decide send vs hold exactly as they always have.
      ruleTemplateKey = key;
      autoKind = autoKindFor(key);
    }
    // reply_action "none": the case sits with staff — deliberately silent.
    if (replyAction.decision === "review" && key && !ruleTemplateKey) {
      ruleTemplateKey = key;
      autoKind = autoKindFor(key);
    }    if (ruleDocsState === "dirty" && autoKind === "status_answer" && key === "status_answer") {
      // The factual status answer is drafted alongside the human queue —
      // make that deliberate double-track visible in the audit trail.
      repo.audit(
        applicant.id,
        "system",
        "status_answer_and_queued",
        "factual status answer drafted while the underlying case also needs human review"
      );
    }
    // Rule-declared case handling: priority, queue and assignment.
    if (replyAction.priority === "high" && repo.getApplicant(applicant.id)?.priority === "normal") {
      repo.updateApplicant(applicant.id, { priority: "high" });
      repo.audit(applicant.id, "system", "priority_raised", `rule “${replyRule.name}”`);
    }
    if (replyAction.queue) {
      repo.updateApplicant(applicant.id, { queue: replyAction.queue });
    }
    if (typeof replyAction.assign === "number" && !applicantNow.assigned_to) {
      repo.updateApplicant(applicant.id, { assigned_to: replyAction.assign });
    }
  } else if (scopedResponseRules.length > 0 || intakeRule !== null) {
    // Rule-driven profile with a gap in its reply rules: never guess, never
    // drop — a human reviews (invariant: failed/incomplete rule tree always
    // routes to human review).
    queueForHuman = true;
  } else if (humanTriageOnly) {
    // A screenshot attached to an eligibility question, complaint or fee
    // enquiry is evidence for the human reply, not a submission of the
    // admissions document pack.
    queueForHuman = true;
  } else if (opts.autoStatusAnswers && refOnlyOwnCase) {
    autoKind = "status_answer";
  } else if (gateDecision.action === "auto_send") {
    autoKind = "ack";
  } else if (
    opts.autoStatusAnswers &&
    email.attachments.length === 0 &&
    activeDocs.length > 0 &&
    (category === "missing_document" || category === "follow_up")
  ) {
    // "Have you received my documents?" → answer from reality (feature 21).
    autoKind = "status_answer";
    if (finalStatus !== "Green" && !cleanMissingCase) {
      queueForHuman = true;
      // The factual status answer is drafted alongside the human queue —
      // make that deliberate double-track visible in the audit trail.
      repo.audit(
        applicant.id,
        "system",
        "status_answer_and_queued",
        "factual status answer drafted while the underlying case also needs human review"
      );
    }
  } else if (opts.autoMissingDocsEmails && cleanMissingCase) {
    autoKind = activeDocs.length === 0 ? "docs_request" : "missing_docs";
  } else {
    queueForHuman = true;
  }
  return {
    autoKind: autoKind ?? null,
    queueForHuman,
    humanTriageOnly,
    ruleTemplateKey,
    draftNeedsApproval,
    fullyQualified,
    replyRule,
    replyAction,
  };
}

/** Stage 17 — draft-first overrides. */
export function runDraftFirstStage(input: DraftFirstStageInput): DraftFirstStageResult {
  const { ctx, applicant, category, profileReplyMode, autoKind, ruleTemplateKey } = input;
  let queueForHuman = input.queueForHuman;
  const { repo } = ctx;
  // ── Draft-first mode (v3 feature 17): a global or per-category setting can
  //    hold ANY automated reply for human approval. The reply is still
  //    drafted normally — it just gets queued instead of sent. A workflow
  //    profile can declare its own default (new profiles default to draft —
  //    automation is opt-in per profile; the migrated education profile keeps
  //    its preserved "auto" setting). ──────────────────────────────────────
  const replyMode: "auto" | "draft" = profileReplyMode === "draft" || profileReplyMode === "hold" ? "draft" : repo.automationMode(category);
  const replyAttempted = autoKind !== null || ruleTemplateKey !== null;
  const heldForApproval = replyAttempted && replyMode === "draft";
  if (heldForApproval) {
    repo.audit(
      applicant.id,
      "system",
      "automation_held",
      `category '${category}' is in draft-for-approval mode — reply held for a human`
    );
    queueForHuman = true;
  }
  return {
    queueForHuman,
    replyAttempted,
    heldForApproval,
  };
}

/** Stage 18 — qualification gate. */
export function runQualGateStage(input: QualGateStageInput): QualGateStageResult {
  const { ctx, applicant, genericCaseType, replyAttempted, fullyQualified, finalStatus } = input;
  let queueForHuman = input.queueForHuman;
  const { repo } = ctx;
  // ── Qualification gate: automated mail is for the FULLY QUALIFIED only ──
  // Fully qualified = Green verdict, no blocking flags, watcher clean. Every
  // other file — including "clean" missing-document cases — gets the reply
  // HELD as a staff suggestion instead: an applicant who is short of a
  // document or below a grade line today may still be admitted tomorrow on
  // special acceptance, so the machine never speaks for the office on them.
  // A profile may switch this gate off (its rules then own the send decision);
  // the migrated education profile keeps it on, as it always was.
  const typeGate = genericCaseType?.qualification_gate ?? 1;
  const qualificationGateOn = typeGate !== 0;
  const heldForQualification = replyAttempted && !fullyQualified && qualificationGateOn;
  if (heldForQualification) {
    repo.audit(
      applicant.id,
      "system",
      "automation_held_qualification",
      `verdict=${finalStatus} — not fully qualified, so the suggested reply is held for staff (special acceptance may apply)`
    );
    queueForHuman = true;
  }
  return {
    queueForHuman,
    heldForQualification,
  };
}

/** Stage 19 — admission safety check. */
export function runAdmitSafetyStage(input: AdmitSafetyStageInput): AdmitSafetyStageResult {
  const { ctx, applicant, applicantNow, genericCaseType, autoAdmitEligible, finalStatus, watcherFlagged, activeBlockingFlags, humanTriageOnly, heldForApproval, heldForQualification, queueForHuman } = input;
  const { repo } = ctx;
  // ── Admission safety gate ────────────────────────────────────────────────
  // A passing rules evaluation is evidence for a reviewer, never by itself an
  // admission decision. The evaluator records the PROVISIONAL auto_admit
  // route for profiles that opt in; the decision is written below only after
  // every gate has agreed (watcher clean, no blocking flag, fully qualified,
  // not in draft mode, nothing queued for a human) — and the admission letter
  // is the single automatic mail that goes out for such a case. Every other
  // passing evaluation stays human review, exactly as it always has.
  const organizationId = applicantNow.organization_id ?? applicant.organization_id ?? 1;
  const caseTypeId = genericCaseType?.id;
  const freshRouting = repo.getApplicant(applicant.id)!.routing;
  const admitNow = Boolean(
    autoAdmitEligible &&
      freshRouting === "auto_admit" &&
      finalStatus === "Green" &&
      !watcherFlagged &&
      activeBlockingFlags.length === 0 &&
      !humanTriageOnly &&
      !heldForApproval &&
      !heldForQualification &&
      !queueForHuman &&
      repo.getTemplate("admission_letter", organizationId, caseTypeId)
  );
  return {
    admitNow,
    organizationId,
    caseTypeId,
  };
}

/** Stage 20 — drafting. */
export function runDraftingStage(input: DraftingStageInput): DraftingStageResult {
  const { ctx, email, applicant, applicantNow, freshApplicant, requirements, activeDocs, activeBlockingFlags, rulesOut, finalStatus, watcherFlagged, admitNow, humanTriageOnly, heldForApproval, heldForQualification, autoKind, ruleTemplateKey, replyAction, replyRule, scopedResponseRules, intakeRule, genericCaseType, organizationId, caseTypeId } = input;
  let queueForHuman = input.queueForHuman;
  const { repo } = ctx;
  // ── Drafting (features 14, 35) ──────────────────────────────────────────
  let draft: Draft | null = null;
  const institution = organizationName(repo, applicantNow.organization_id ?? applicant.organization_id ?? 1);
  const requiredReqs = requirements.filter((r) => r.required);
  const presentTypes = activeDocs.map((d) => d.document_type);
  const missingLabels = rulesOut.missing.map((m) => docLabel(m));
  const knownName =
    activeDocs
      .map((d) => normalizeName(d.extracted_fields?.name as string | undefined))
      .find((n) => n.length >= 3) || freshApplicant.full_name || email.fromName;
  let lifecycleAfter: LifecycleStage = admitNow
    ? "completed"
    : humanTriageOnly
      ? "application_received"
      : heldForApproval || heldForQualification
        ? activeDocs.length > 0
          ? "documents_received"
          : "application_received"
        : autoKind === "ack"
          ? "documents_checked"
          : queueForHuman && finalStatus !== "Green"
            ? "awaiting_review"
            : activeDocs.length > 0
              ? "documents_received"
              : "application_received";
  // PPR P0-4/P1-2: a response rule may declare the stage explicitly — either
  // a built-in lifecycle id or one of this profile's configured stage ids.
  if (replyAction?.stage) {
    const stageId = replyAction.stage as LifecycleStage;
    const configured = genericCaseType?.stages?.some((s) => s.id === replyAction.stage) ?? false;
    if ((stageId in LIFECYCLE_LABELS) || configured) lifecycleAfter = stageId;
  }

  const draftCtx: DraftContext = {
    ref: applicantNow.ref_number,
    institution,
    name: knownName ?? undefined,
    missingLabels,
    checklist: checklistText({ requirements: requiredReqs, presentTypes }),
    statusLabel: LIFECYCLE_LABELS[lifecycleAfter],
    programme: applicantNow.programme
      ? (repo.programmeByCode(applicantNow.programme)?.name ?? applicantNow.programme)
      : undefined,
    regDate: repo.getSetting("reg_date", ""),
    orientationDates: repo.getSetting("orientation_dates", ""),
    readBack: readBackText(activeDocs),
    documentIssues: documentIssuesText(activeDocs),
  };

  // M-3: a case that has qualified for the provisional admission sends the
  // ADMISSION LETTER as its automatic reply — the letter IS the receipt for a
  // file that has already been decided — with the profile's admission
  // attachment set riding along (the template's attach_pack). Everything else
  // keeps the ordinary template chain: factual acknowledgements and review
  // notes only, unless a response rule names a profile template key.
  const templateKey = (admitNow ? "admission_letter" : null) ?? ruleTemplateKey ?? (autoKind === "ack"
    ? "ack_received"
    : autoKind === "docs_request"
        ? "docs_request"
        : autoKind === "missing_docs"
          ? "missing_documents"
          : autoKind === "status_answer"
            ? "status_answer"
            : null);

  if (templateKey) {
    const tpl = repo.getTemplate(templateKey, organizationId, caseTypeId);
    if (tpl) {
      const rendered = renderTemplate(tpl.subject, tpl.body, draftCtx);
      draft = { subject: rendered.subject, body: rendered.body, audience: "auto", templateKey };
    } else if (ruleTemplateKey) {
      // A rule named a template this organization does not have. Never let
      // that become silence: the case goes to a human with the standard
      // internal note (failed/incomplete rule tree → human review).
      queueForHuman = true;
    }
  }
  // Held replies keep their rendered content but are queued for a person.
  if ((heldForApproval || heldForQualification) && draft) draft.audience = "human";

  if (!draft && queueForHuman) {
    // PPR P0-6/D4: a rule-driven profile with a reply gap gets the org's
    // generic_enquiry template as the staff SUGGESTION — a real fallback,
    // queued for approval like every other human-bound draft, never sent
    // automatically.
    const ruleGap = !replyRule && (scopedResponseRules.length > 0 || intakeRule !== null);
    const gapTpl = ruleGap ? repo.getTemplate("generic_enquiry", organizationId, caseTypeId) : undefined;
    if (gapTpl) {
      const rendered = renderTemplate(gapTpl.subject, gapTpl.body, draftCtx);
      draft = { subject: rendered.subject, body: rendered.body, audience: "human", templateKey: "generic_enquiry" };
    }
  }

  if (!draft && queueForHuman) {
    draft = pickQueuedDraft({
      finalStatus,
      watcherFlagged,
      flags: activeBlockingFlags.map((f) => ({ type: f.type, detail: f.detail })),
      applicantName: knownName ?? undefined,
      ref: applicantNow.ref_number,
    });
  }
  return {
    draft,
    queueForHuman,
    lifecycleAfter,
    templateKey,
  };
}

/** Stage 21 — send or queue. */
export async function runSendStage(input: SendStageInput): Promise<SendStageResult> {
  const { ctx, email, applicant, applicantNow, draft, templateKey, organizationId, caseTypeId, draftNeedsApproval, replyAction, replyAttempted } = input;
  let queueForHuman = input.queueForHuman;
  let autoKind = input.autoKind;
  const { repo, adapters } = ctx;
  // ── Send or queue ────────────────────────────────────────────────────────
  // Send failures are never fatal: the reply becomes a queued draft and a
  // human handles it (v3 reliability requirement).
  let autoSent = false;
  /** M-3: the admission letter actually left the building this pass. */
  let admissionLetterSent = false;
  // A rule that answers with "draft", "approve" or "hold" means exactly that:
  // the pipeline never escalates it to a send, whatever the gates say. Only
  // "send" (or legacy non-rule automation) may reach the wire.
  const ruleHoldsReply = replyAction != null
    && (replyAction.reply_action === "draft" || replyAction.reply_action === "approve" || replyAction.reply_action === "hold");
  const wantsAutoSend = replyAttempted && draft?.audience === "auto" && !ruleHoldsReply;
  if (wantsAutoSend && draft) {
    try {
      // PPR P0-5: which attachment set (if any) rides along is a property of
      // the response rule first and the template second. Sets are the
      // organization's own files — there is no privileged pack vocabulary.
      // Defaults keep the historical behaviour for factual requests: a
      // document request may carry the application set.
      const tplRow = templateKey ? repo.getTemplate(templateKey, organizationId, caseTypeId) : undefined;
      const setRef = replyAction?.attachment_set
        ?? tplRow?.attach_pack
        ?? (autoKind === "docs_request" ? "application" : "none");
      const resolved = repo.attachmentSetFiles(organizationId, setRef);
      const pack = resolved.files.length || resolved.issues.length ? resolved : null;
      const extras: SendExtras = {
        banner: tplRow?.include_banner === 0 ? null : emailBanner(repo, organizationId),
        attachments: pack ? pack.files : [],
        ...organizationSender(repo, organizationId),
      };
      // A pack that went out missing files is a silent failure no more:
      // audit it and tell staff which file is gone.
      if (pack && pack.issues.length) {
        repo.audit(applicant.id, "system", "pack_incomplete", pack.issues.join("; "));
        repo.notify("review_needed", `${applicantNow.ref_number}: outgoing pack is incomplete — ${pack.issues[0]}`, applicant.id);
      }
      await adapters.sender.send(applicantNow.email_address, draft.subject, draft.body, email.threadId, extras);
      repo.insertEmail({
        applicant_id: applicant.id,
        message_id: `${email.id}:auto-reply`,
        thread_id: email.threadId,
        direction: "out",
        from_addr: "",
        to_addr: applicantNow.email_address,
        subject: draft.subject,
        body: draft.body,
        category: null,
        auto: 1,
        at: new Date().toISOString(),
        attachments: (extras.attachments ?? []).map((f) => f.filename),
      });
      repo.addOutbox({
        applicant_id: applicant.id,
        to_address: applicantNow.email_address,
        subject: draft.subject,
        body: draft.body,
        mode: "auto",
        template_key: draft.templateKey ?? "",
      });
      repo.audit(applicant.id, "system", "email_sent_auto", `${autoKind ?? templateKey}: "${draft.subject}"`);
      log(`pipeline: auto-sent [${autoKind ?? templateKey}] to ${applicantNow.email_address}`);
      autoSent = true;
      if (templateKey === "admission_letter") admissionLetterSent = true;
    } catch (e) {
      repo.audit(applicant.id, "system", "send_failed", `auto-send [${autoKind ?? templateKey}] failed: ${(e as Error).message}`);
      repo.addOutbox({
        applicant_id: applicant.id,
        to_address: applicantNow.email_address,
        subject: draft.subject,
        body: draft.body,
        mode: "queued",
        template_key: draft.templateKey ?? "",
        needs_approval: draftNeedsApproval ? 1 : 0,
      });
      repo.notify("review_needed", `${applicantNow.ref_number}: automated send failed — reply needs manual attention`, applicant.id);
      log(`pipeline: auto-send failed for ${applicantNow.ref_number} → queued for human`, "warn");
      queueForHuman = true;
      autoKind = null;
    }
  } else if (draft) {
    repo.addOutbox({
      applicant_id: applicant.id,
      to_address: applicantNow.email_address,
      subject: draft.subject,
      body: draft.body,
      mode: "queued",
      template_key: draft.templateKey ?? "",
      needs_approval: draftNeedsApproval ? 1 : 0,
    });
  }
  return {
    autoSent,
    admissionLetterSent,
    autoKind: autoKind ?? null,
    queueForHuman,
  };
}
