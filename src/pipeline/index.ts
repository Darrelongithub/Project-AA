/**
 * The v2 pipeline per incoming email:
 *
 *   1. ingestion delivers the email (caller)
 *   2. categorize (deterministic) + resolve/create applicant + ref number
 *   3. store the incoming email in the case history + audit
 *   4. extraction: pdf text → Tesseract → Gemini (fixed chain), with
 *      duplicate detection by content hash
 *   5. matching: persist docs, supersede corrections
 *   6. rules: PURE Green/Orange/Red decision (no AI, ever)
 *   7. watcher: Green-only sanity check; can only downgrade
 *   8. gate v2: ack / missing-docs notice / status answer / human queue
 *   9. drafting (DB templates, ref-numbered subjects)
 *  10. lifecycle transitions + status history + SLA + notifications
 *  11. DecisionLog + audit, always
 *
 * Automation here is strictly FACTUAL: receipts, missing-doc lists, status
 * answers. Anything ambiguous queues for a human. Never a decision.
 */
import type { IncomingEmail, ProcessResult } from "../types";
import type { PipelineContext } from "./adapters";
import { log } from "../util/log";
import {
  runCategorizeStage,
  runIntakeStage,
  runReopenStage,
  runResolveStage,
  runStoreStage,
} from "./stages/intake";
import {
  runCaseTypeStage,
  runConsistencyStage,
  runDeadlineStage,
  runEnrichStage,
  runExtractStage,
  runPersistStage,
  runRequirementsStage,
  runRulesStage,
  runWatcherStage,
} from "./stages/evaluation";
import {
  runAdmitSafetyStage,
  runDraftFirstStage,
  runDraftingStage,
  runGateStage,
  runQualGateStage,
  runReplySelectStage,
  runSendStage,
} from "./stages/reply";
import {
  runLadderStage,
  runLifecycleStage,
  runLogStage,
  runProvisionalStage,
  runReviewQueueStage,
} from "./stages/closeout";

export interface PipelineOptions {
  autoMissingDocsEmails: boolean;
  autoStatusAnswers: boolean;
}

const DEFAULT_OPTS: PipelineOptions = { autoMissingDocsEmails: true, autoStatusAnswers: true };

export async function processEmail(
  email: IncomingEmail,
  ctx: PipelineContext,
  opts: PipelineOptions = DEFAULT_OPTS
): Promise<ProcessResult> {
  const { repo } = ctx;

  // Atomic claim FIRST: a concurrent run of the same email loses here and
  // skips, so one message can never be processed (and replied to) twice.
  if (!repo.claimProcessed(email.id, email.threadId)) {
    log(`pipeline: skipping ${email.id} (already processed or claimed)`);
    return {
      skipped: true,
      applicantId: null,
      finalStatus: "Red",
      lifecycle: "application_received",
      autoSent: false,
      autoKind: null,
      category: "other",
      reasoning: "skipped: email already processed",
      flags: [],
      missing: [],
    };
  }
  try {
    return await processEmailInner(email, ctx, opts);
  } catch (e) {
    // Release the claim: the ingest dead-letter machinery owns retries.
    repo.unmarkProcessed(email.id);
    throw e;
  }
}

async function processEmailInner(
  email: IncomingEmail,
  ctx: PipelineContext,
  opts: PipelineOptions
): Promise<ProcessResult> {
  const { repo } = ctx;

  // ── Stage 1 · intake gate ─────────────────────────────────────────
  const intake = runIntakeStage({ ctx, email });
  if (intake.parked) return intake.parked;

  // ── Stage 2 · categorize ──────────────────────────────────────────
  const triage = await runCategorizeStage({
    ctx,
    email,
    intakeOrganizationId: intake.intakeOrganizationId,
    fallbackCategory: intake.fallbackCategory,
    intakeInput: intake.intakeInput,
    bodyIsRefShape: intake.bodyIsRefShape,
    scopedResponseRules: intake.scopedResponseRules,
  });

  // ── Stage 3 · resolve applicant ───────────────────────────────────
  const resolved = runResolveStage({
    ctx,
    email,
    category: triage.category,
    intakeOrganizationId: intake.intakeOrganizationId,
    intakeRule: intake.intakeRule,
    scopedResponseRules: intake.scopedResponseRules,
    humanTriageOnly: triage.humanTriageOnly,
  });

  // ── Stage 4 · reopen + sender tracking ────────────────────────────
  runReopenStage({
    ctx,
    email,
    applicant: resolved.applicant,
    category: triage.category,
    humanTriageOnly: resolved.humanTriageOnly,
  });

  // ── Stage 5 · store the email ─────────────────────────────────────
  const stored = runStoreStage({
    ctx,
    email,
    applicant: resolved.applicant,
    category: triage.category,
  });

  // ── Stage 6 · extract attachments ─────────────────────────────────
  const extracted = await runExtractStage({
    ctx,
    email,
    applicant: resolved.applicant,
    genericCaseType: resolved.genericCaseType,
    educationCase: resolved.educationCase,
  });

  // ── Stage 7 · persist the accepted documents ──────────────────────
  const persisted = runPersistStage({
    ctx,
    email,
    applicant: resolved.applicant,
    extractions: extracted.extractions,
  });

  // ── Stage 8 · cross-document consistency ──────────────────────────
  const consistent = runConsistencyStage({
    ctx,
    applicant: resolved.applicant,
    activeDocs: persisted.activeDocs,
    preFlags: resolved.preFlags,
  });

  // ── Stage 9 · enrichment ──────────────────────────────────────────
  runEnrichStage({
    ctx,
    email,
    applicant: resolved.applicant,
    activeDocs: consistent.activeDocs,
  });

  // ── Stage 10 · requirements snapshot ──────────────────────────────
  const reqs = runRequirementsStage({
    ctx,
    applicant: resolved.applicant,
    educationCase: resolved.educationCase,
  });

  // ── Stage 11 · deadline / staleness watch ─────────────────────────
  const deadline = runDeadlineStage({
    ctx,
    email,
    applicant: resolved.applicant,
    applicantNow: reqs.applicantNow,
    preFlags: consistent.preFlags,
  });

  // ── Stage 12 · case-type rule engine ──────────────────────────────
  const caseType = runCaseTypeStage({
    ctx,
    email,
    applicant: resolved.applicant,
    genericCaseType: resolved.genericCaseType,
    educationCase: resolved.educationCase,
    activeDocs: consistent.activeDocs,
    requirements: reqs.requirements,
    preFlags: deadline.preFlags,
    autoAdmitEligible: resolved.autoAdmitEligible,
  });

  // ── Stage 13 · rules decision ─────────────────────────────────────
  const rules = runRulesStage({
    ctx,
    genericRuleResult: caseType.genericRuleResult,
    educationCase: resolved.educationCase,
    requirements: reqs.requirements,
    activeDocs: consistent.activeDocs,
    preFlags: caseType.preFlags,
  });

  // ── Stage 14 · watcher ────────────────────────────────────────────
  const watch = await runWatcherStage({
    ctx,
    email,
    applicant: resolved.applicant,
    applicantNow: reqs.applicantNow,
    category: triage.category,
    enquiryOnly: triage.enquiryOnly,
    humanTriageOnly: resolved.humanTriageOnly,
    rulesOut: rules.rulesOut,
    activeDocs: consistent.activeDocs,
    preFlags: caseType.preFlags,
    duplicateFlags: extracted.duplicateFlags,
  });

  // ── Stage 15 · gate v2 ────────────────────────────────────────────
  const gated = runGateStage({
    ctx,
    email,
    applicant: resolved.applicant,
    applicantNow: reqs.applicantNow,
    activeDocs: consistent.activeDocs,
    humanTriageOnly: resolved.humanTriageOnly,
    finalStatus: watch.finalStatus,
    rulesOut: rules.rulesOut,
    watcherFlagged: watch.watcherFlagged,
  });

  // ── Stage 16 · reply selection ────────────────────────────────────
  const reply = runReplySelectStage({
    ctx,
    email,
    applicant: resolved.applicant,
    applicantNow: reqs.applicantNow,
    category: triage.category,
    senderState: intake.senderState,
    verdict: intake.verdict,
    intakeRule: intake.intakeRule,
    scopedResponseRules: intake.scopedResponseRules,
    finalStatus: watch.finalStatus,
    watcherFlagged: watch.watcherFlagged,
    cleanMissingCase: gated.cleanMissingCase,
    refOnlyOwnCase: gated.refOnlyOwnCase,
    gateDecision: gated.gateDecision,
    activeBlockingFlags: gated.activeBlockingFlags,
    activeDocs: consistent.activeDocs,
    humanTriageOnly: resolved.humanTriageOnly,
    opts,
  });

  // ── Stage 17 · draft-first overrides ──────────────────────────────
  const draftFirst = runDraftFirstStage({
    ctx,
    applicant: resolved.applicant,
    category: triage.category,
    profileReplyMode: resolved.profileReplyMode,
    autoKind: reply.autoKind,
    ruleTemplateKey: reply.ruleTemplateKey,
    queueForHuman: reply.queueForHuman,
  });

  // ── Stage 18 · qualification gate ─────────────────────────────────
  const qualGate = runQualGateStage({
    ctx,
    applicant: resolved.applicant,
    genericCaseType: resolved.genericCaseType,
    replyAttempted: draftFirst.replyAttempted,
    fullyQualified: reply.fullyQualified,
    finalStatus: watch.finalStatus,
    queueForHuman: draftFirst.queueForHuman,
  });

  // ── Stage 19 · admission safety check ─────────────────────────────
  const admitSafety = runAdmitSafetyStage({
    ctx,
    applicant: resolved.applicant,
    applicantNow: reqs.applicantNow,
    genericCaseType: resolved.genericCaseType,
    autoAdmitEligible: resolved.autoAdmitEligible,
    finalStatus: watch.finalStatus,
    watcherFlagged: watch.watcherFlagged,
    activeBlockingFlags: gated.activeBlockingFlags,
    humanTriageOnly: reply.humanTriageOnly,
    heldForApproval: draftFirst.heldForApproval,
    heldForQualification: qualGate.heldForQualification,
    queueForHuman: qualGate.queueForHuman,
  });

  // ── Stage 20 · drafting ───────────────────────────────────────────
  const drafted = runDraftingStage({
    ctx,
    email,
    applicant: resolved.applicant,
    applicantNow: reqs.applicantNow,
    freshApplicant: stored.freshApplicant,
    requirements: reqs.requirements,
    activeDocs: consistent.activeDocs,
    activeBlockingFlags: gated.activeBlockingFlags,
    rulesOut: rules.rulesOut,
    finalStatus: watch.finalStatus,
    watcherFlagged: watch.watcherFlagged,
    admitNow: admitSafety.admitNow,
    humanTriageOnly: reply.humanTriageOnly,
    heldForApproval: draftFirst.heldForApproval,
    heldForQualification: qualGate.heldForQualification,
    autoKind: reply.autoKind,
    ruleTemplateKey: reply.ruleTemplateKey,
    queueForHuman: qualGate.queueForHuman,
    replyAction: reply.replyAction,
    replyRule: reply.replyRule,
    scopedResponseRules: intake.scopedResponseRules,
    intakeRule: intake.intakeRule,
    genericCaseType: resolved.genericCaseType,
    organizationId: admitSafety.organizationId,
    caseTypeId: admitSafety.caseTypeId,
  });

  // ── Stage 21 · send or queue ──────────────────────────────────────
  const send = await runSendStage({
    ctx,
    email,
    applicant: resolved.applicant,
    applicantNow: reqs.applicantNow,
    autoKind: reply.autoKind,
    draft: drafted.draft,
    templateKey: drafted.templateKey,
    organizationId: admitSafety.organizationId,
    caseTypeId: admitSafety.caseTypeId,
    draftNeedsApproval: reply.draftNeedsApproval,
    replyAction: reply.replyAction,
    replyAttempted: draftFirst.replyAttempted,
    queueForHuman: drafted.queueForHuman,
  });

  // ── Stage 22 · provisional admit ──────────────────────────────────
  const provisional = runProvisionalStage({
    ctx,
    applicant: resolved.applicant,
    applicantNow: reqs.applicantNow,
    genericCaseType: resolved.genericCaseType,
    admissionLetterSent: send.admissionLetterSent,
  });

  // ── Stage 23 · follow-up ladder ───────────────────────────────────
  runLadderStage({
    ctx,
    applicant: resolved.applicant,
    finalStatus: watch.finalStatus,
    autoSent: send.autoSent,
    heldForQualification: qualGate.heldForQualification,
    heldForApproval: draftFirst.heldForApproval,
    replyRule: reply.replyRule,
    autoKind: send.autoKind,
    replyAction: reply.replyAction,
  });

  // ── Stage 24 · SLA + queue-for-human ──────────────────────────────
  runReviewQueueStage({
    ctx,
    applicant: resolved.applicant,
    applicantNow: reqs.applicantNow,
    category: triage.category,
    enquiryOnly: triage.enquiryOnly,
    humanTriageOnly: reply.humanTriageOnly,
    heldForQualification: qualGate.heldForQualification,
    heldForApproval: draftFirst.heldForApproval,
    finalStatus: watch.finalStatus,
    watcherFlagged: watch.watcherFlagged,
    rulesOut: rules.rulesOut,
    replyAction: reply.replyAction,
    queueForHuman: send.queueForHuman,
  });

  // ── Stage 25 · lifecycle transitions ──────────────────────────────
  runLifecycleStage({
    ctx,
    applicant: resolved.applicant,
    admitNow: admitSafety.admitNow,
    autoAdmitted: provisional.autoAdmitted,
    lifecycleAfter: drafted.lifecycleAfter,
    autoKind: send.autoKind,
    finalStatus: watch.finalStatus,
  });

  // ── Stage 26 · decision log ───────────────────────────────────────
  runLogStage({
    ctx,
    email,
    applicant: resolved.applicant,
    finalStatus: watch.finalStatus,
    reasoning: watch.reasoning,
    autoSent: send.autoSent,
  });

  // ── Result assembly (verbatim tail of the original stage 26) ──────
  const applicant = resolved.applicant;
  const applicantNow = reqs.applicantNow;
  const finalStatus = watch.finalStatus;
  const autoSent = send.autoSent;
  const autoKind = send.autoKind;
  const category = triage.category;
  const reasoning = watch.reasoning;
  const rulesOut = rules.rulesOut;
  const finalRow = repo.getApplicant(applicant.id)!;
  return {
    applicantId: applicant.id,
    refNumber: applicantNow.ref_number,
    finalStatus,
    lifecycle: finalRow.lifecycle,
    autoSent,
    // The kind the automation ATTEMPTED — even when the qualification gate
    // held it as a suggestion (autoSent=false); null means no reply drafted.
    autoKind,
    category,
    reasoning,
    flags: repo
      .activeFlags(applicant.id)
      .filter((f) => f.type !== "duplicate_submission")
      .map((f) => ({ type: f.type, detail: f.detail })),
    missing: rulesOut.missing,
  };
}

