/**
 * Pipeline stages 1-5: intake — organization scoping, intake rules,
 * categorization, applicant resolution, reopen, and email storage.
 *
 * Stage bodies are the verbatim code of the original `processEmailInner`;
 * each wrapper takes one typed input and returns one typed result.
 */
import { classifyIntakeEmail, DEFAULT_INTAKE_HOTWORDS, intakeHotwordList } from "../../intake";
import { categorizeEmail, classifyWithConfiguredCategories, priorityForCategory } from "../../categorize";
import { emailTargetsKnownApplicant } from "../../matching";
import { resolveIdentity } from "../../matching/identity";
import { describeRule, firstMatchingRule, rulesForCaseScope, type RuleMatchInput, type WorkflowRule } from "../../rules/workflow";
import { extractPhone } from "../../enrich";
import { log } from "../../util/log";
import type { DerivedFlag, EmailCategory, ProcessResult } from "../../types";
import type {
  IntakeStageInput,
  IntakeStageResult,
  CategorizeStageInput,
  CategorizeStageResult,
  ResolveStageInput,
  ResolveStageResult,
  ReopenStageInput,
  StoreStageInput,
  StoreStageResult,
} from "./types";

/** Stage 1 — intake gate. */
export function runIntakeStage(input: IntakeStageInput): IntakeStageResult {
  const { ctx, email } = input;
  const { repo } = ctx;
  const intakeOrganizationId = email.organizationId ?? 1;

  // ── Intake gate (round 9; PPR P0-4: stored rules decide, with the legacy
  //    scorer as the education preset's signal source and as the fallback
  //    for profiles without intake rules) ──────────────────────────────────
  // Only intake mail becomes a case: the mail carries an intake signal, or
  // it targets a contact we already know (conversation continuity).
  // Everything else is parked in the Mail window WITHOUT a case: kept,
  // visible, labelable — but no case number, no queue entry, no reply.
  const hotwords = repo.getSetting("intake_hotwords", DEFAULT_INTAKE_HOTWORDS);
  const verdict = classifyIntakeEmail({
    subject: email.subject,
    body: email.body,
    attachmentFilenames: (email.attachments ?? []).map((a) => a.filename),
    // Both the editable display name and the stable course code are hotwords.
    // Applicants commonly write “BBIT”/“BCS” rather than the full catalogue
    // name, and codes are less ambiguous than a generic word such as “business”.
    courseNames: [
      ...(intakeOrganizationId === 1 ? repo.listProgrammes().flatMap((p) => [p.name, p.code]) : []),
      ...repo.listCaseTypes(intakeOrganizationId).flatMap((t) => [t.name, t.code]),
    ],
    customHotwords: intakeHotwordList(hotwords),
    knownApplicant: emailTargetsKnownApplicant(repo, email),
  });
  const senderState: "known" | "unknown" = emailTargetsKnownApplicant(repo, email) ? "known" : "unknown";
  const fallbackCategory = categorizeEmail(email.subject, email.body, email.attachments.length > 0);
  // Which profile this mail targets (declared on the connector/portal, or
  // the migrated legacy scope). Rule scope follows it exactly.
  const scopeType = email.caseTypeCode ? repo.getCaseType(email.caseTypeCode, intakeOrganizationId) : undefined;
  const scopeEducation = scopeType ? scopeType.education_module === 1 : intakeOrganizationId === 1;
  const scopedIntakeRules = rulesForCaseScope(
    repo.listWorkflowRules(intakeOrganizationId, { kind: "intake" }), scopeType?.id ?? null, scopeEducation
  );
  const scopedResponseRules = rulesForCaseScope(
    repo.listWorkflowRules(intakeOrganizationId, { kind: "response" }), scopeType?.id ?? null, scopeEducation
  );
  const bodyIsRefShape = /^[A-Z]{1,6}-\d{4}-\d{1,8}$/i.test(email.body.trim());
  const intakeInput: RuleMatchInput = {
    senderState,
    subject: email.subject,
    body: email.body,
    hasAttachments: email.attachments.length > 0,
    category: fallbackCategory,
    bodyIsRef: bodyIsRefShape,
    educationSignals: verdict.category === "parked" ? "parked" : "open",
    docsState: "dirty", // document posture is a reply-time fact; intake rules match on message facts
    docsOnFile: 0,
  };
  let intakeRule: WorkflowRule | null = null;
  let intakeDecision: "create" | "attach" | "ignore" | "review" | null = null;
  if (scopedIntakeRules.length > 0) {
    intakeRule = firstMatchingRule(scopedIntakeRules, intakeInput);
    // Rules are present: an unmatched message still reaches the case flow
    // (human review) — mail is never silently dropped because a rule set
    // has a gap. The education preset always matches (catch-all parks).
    intakeDecision = intakeRule?.action.decision ?? "create";
  } else {
    // Legacy fallback (profiles without intake rules): the built-in scorer.
    intakeDecision = verdict.category === "parked" ? "ignore" : "create";
  }
  if (intakeDecision === "ignore") {
    repo.insertEmail({
      applicant_id: null,
      message_id: email.id,
      thread_id: email.threadId,
      direction: "in",
      from_addr: email.from,
      to_addr: "",
      subject: email.subject,
      body: email.body,
      category: "other",
      auto: 0,
      channel: email.channel ?? "email",
      at: email.receivedAt,
    });
    const why =
      `score ${verdict.score}` +
      (verdict.negatives.length ? ` (negatives: ${verdict.negatives.join(", ")})` : "") +
      (verdict.positives.length ? `; signals seen: ${verdict.positives.join(", ")}` : "; no intake signals");
    const parkEvent = intakeRule?.action.audit_code || "email_parked_non_intake";
    repo.audit(
      null,
      "system",
      parkEvent,
      `"${email.subject}" from ${email.from} — ${why}; kept in Mail, no case created${intakeRule ? ` (rule “${intakeRule.name}”)` : ""}`
    );
    log(`pipeline: "${email.subject}" parked — ${why}`);
    const parked: ProcessResult = {
      skipped: true,
      applicantId: null,
      finalStatus: "Red",
      lifecycle: "application_received",
      autoSent: false,
      autoKind: null,
      category: "other",
      reasoning: "parked: no intake signals reached the threshold and sender is not a known applicant",
      flags: [],
      missing: [],
    };
    return {
      parked,
      intakeOrganizationId,
      verdict,
      senderState,
      fallbackCategory,
      intakeInput,
      bodyIsRefShape,
      intakeRule,
      scopedResponseRules,
    };
  }
  return {
    parked: null,
    intakeOrganizationId,
    verdict,
    senderState,
    fallbackCategory,
    intakeInput,
    bodyIsRefShape,
    intakeRule,
    scopedResponseRules,
  };
}

/** Stage 2 — categorize. */
export async function runCategorizeStage(input: CategorizeStageInput): Promise<CategorizeStageResult> {
  const { ctx, email, intakeOrganizationId, fallbackCategory, intakeInput, bodyIsRefShape, scopedResponseRules } = input;
  const { repo } = ctx;
  // ── Categorize (feature 26) ──────────────────────────────────────────────
  // Gemini may provide only an organization-owned routing label. Code maps
  // that label to the legacy workflow enum; it never produces an outcome.
  // (The deterministic fallback category was already computed for the intake
  // rule match above — same input, same result.)
  const configuredKeys = repo.listEmailCategories(intakeOrganizationId).map((x) => x.key);
  let category: EmailCategory = fallbackCategory;
  if (process.env.GEMINI_API_KEY && configuredKeys.length > 0) {
    const label = await classifyWithConfiguredCategories(
      { subject: email.subject, body: email.body }, configuredKeys
    );
    const normalized = label.label.toLowerCase();
    const mapped: Record<string, EmailCategory> = {
      admission: "admission_enquiry", admission_enquiry: "admission_enquiry",
      application: "application", document_submission: "document_submission",
      missing_document: "missing_document", fee_enquiry: "fee_enquiry",
      follow_up: "follow_up", complaint: "complaint", other: "other", normal: "other",
    };
    category = mapped[normalized] ?? "other";
    repo.audit(null, "system", "email_labelled", `label=${label.label} confidence=${label.confidence} source=${label.source ?? "gemini"}; routing metadata only`);
  }

  // An eligibility/requirements question may carry a screenshot as evidence.
  // Keep it in the enquiry workflow: OCR can still preserve the evidence, but
  // the attachment must not turn a question into a documents-received or
  // awaiting-documents case. PPR P0-4: which mail needs a human is a stored
  // response rule (`decision: review`); profiles without rules keep the
  // original category policy.
  const enquiryOnly = category === "admission_enquiry";
  let humanTriageOnly = false;
  if (scopedResponseRules.length > 0) {
    const reviewRule = firstMatchingRule(scopedResponseRules, {
      ...intakeInput,
      category,
      bodyIsRef: bodyIsRefShape,
    });
    if (reviewRule?.action.decision === "review") humanTriageOnly = true;
  } else {
    humanTriageOnly = enquiryOnly || category === "complaint" || category === "fee_enquiry";
  }
  return {
    category,
    enquiryOnly,
    humanTriageOnly,
  };
}

/** Stage 3 — resolve applicant. */
export function runResolveStage(input: ResolveStageInput): ResolveStageResult {
  const { ctx, email, category, intakeOrganizationId, intakeRule, scopedResponseRules } = input;
  let humanTriageOnly = input.humanTriageOnly;
  const { repo } = ctx;
  // ── Resolve/create applicant with reference number (features 1, 2) ──────
  // v3 identity matching: quoted reference number → known sender (any thread)
  // → new applicant. Low-confidence matches get an identity_check flag.
  // New inbound mail enters the migrated tenant unless a known case already
  // identifies another organization; reference prefixes belong to that tenant.
  const refPrefix = repo.organizationRefPrefix(intakeOrganizationId);
  const identity = resolveIdentity(repo, email, {
    refPrefix,
    organizationId: intakeOrganizationId,
    caseTypeCode: email.caseTypeCode,
  });
  const applicant = identity.applicant;
  // The intake rule's audit code records which rule opened/continued the case.
  if (intakeRule?.action.audit_code) {
    repo.audit(applicant.id, "system", intakeRule.action.audit_code, `rule “${intakeRule.name}” matched — ${describeRule(intakeRule)}`);
  }
  const genericCaseType = repo.caseTypeForCase(applicant.id);
  // PPR P0-2: the education_module flag on the workflow profile decides
  // whether ANY academic code path may run for this case. Without it there
  // is no grade engine, no academic document matrix, no admissions routing —
  // just the generic evidence/triage flow (audit F1).
  const educationCase = repo.educationCaseFor(applicant);
  // The generic/no-eval folder has no rules of its own — automation stays
  // held there (audit B1). A profile that OWNS reply behaviour is driven by
  // it instead: response rules, OR an intake rule that carries its own reply
  // action (create + reply in one rule — P0-4).
  const intakeCarriesReply = Boolean(intakeRule?.action.reply_action && intakeRule.action.reply_action !== "none");
  if (!educationCase && scopedResponseRules.length === 0 && !intakeCarriesReply) humanTriageOnly = true;
  // M-3: the profile's deterministic auto-admit posture (explicit opt-in only).
  // The migrated education profile carries it; every profile a new
  // organization creates starts with auto-admit OFF and draft automation, so
  // a new organization can never enter this path. Draft mode always wins: a
  // profile (or the global/per-category setting) that says "draft" holds every
  // automatic reply — and therefore withholds the provisional admission too.
  const profileReplyMode = genericCaseType?.default_reply_action;
  const autoAdmitEligible = Boolean(
    educationCase &&
      genericCaseType?.auto_admit === 1 &&
      profileReplyMode !== "draft" &&
      profileReplyMode !== "hold" &&
      repo.automationMode(category) === "auto" &&
      !humanTriageOnly
  );
  const preFlags: DerivedFlag[] = [];
  if (identity.concern) {
    preFlags.push({ type: "identity_check", detail: identity.concern });
    repo.audit(applicant.id, "system", "identity_concern", identity.concern);
    log(`pipeline: ${applicant.ref_number} matched via ${identity.matchedBy} WITH concern — human must verify`, "warn");
  }
  if (!identity.isNew && identity.matchedBy !== "created") {
    repo.audit(applicant.id, "system", "identity_matched", `email attached to existing case via ${identity.matchedBy} signal`);
  }
  return {
    applicant,
    educationCase,
    genericCaseType,
    profileReplyMode,
    autoAdmitEligible,
    humanTriageOnly,
    preFlags,
  };
}

/** Stage 4 — reopen + sender tracking. */
export function runReopenStage(input: ReopenStageInput): void {
  const { ctx, email, applicant, category, humanTriageOnly } = input;
  const { repo } = ctx;
  // ── Case reopen (v3 feature 34): a completed/verification applicant emails
  //    again with substance → reopen the SAME case, never create a duplicate.
  const reopenable = applicant.lifecycle === "completed" || applicant.lifecycle === "verification";
  const actionable =
    !humanTriageOnly &&
    (email.attachments.length > 0 ||
      ["application", "document_submission", "complaint", "missing_document"].includes(category));
  if (reopenable && actionable) {
    repo.setLifecycle(applicant.id, "awaiting_review", "system", "case reopened: applicant emailed again after completion");
    repo.audit(applicant.id, "system", "case_reopened", `new ${category} email after ${applicant.lifecycle}`);
    log(`pipeline: ${applicant.ref_number} reopened (${category})`);
  }

  if (!applicant.full_name && email.fromName) {
    repo.updateApplicant(applicant.id, { full_name: email.fromName });
  }
  log(`pipeline: email ${email.id} from ${email.from} → ${applicant.ref_number} (${category})`);
}

/** Stage 5 — store the email. */
export function runStoreStage(input: StoreStageInput): StoreStageResult {
  const { ctx, email, applicant, category } = input;
  const { repo } = ctx;
  // ── Store incoming email in the case history (feature 4) ────────────────
  repo.insertEmail({
    applicant_id: applicant.id,
    message_id: email.id,
    thread_id: email.threadId,
    direction: "in",
    from_addr: email.from,
    to_addr: "",
    subject: email.subject,
    body: email.body,
    category,
    auto: 0,
    channel: email.channel ?? "email",
    at: email.receivedAt,
  });
  repo.audit(applicant.id, "system", "email_received", `"${email.subject}" [${category}] via ${email.channel ?? "email"}`);

  // Priority from category (feature 27): complaints jump to high.
  const catPriority = priorityForCategory(category);
  if (catPriority === "high" && applicant.priority === "normal") {
    repo.updateApplicant(applicant.id, { priority: "high" });
    repo.audit(applicant.id, "system", "priority_raised", "complaint received → high priority");
  }

  // Enrich phone from the email body.
  const freshApplicant = repo.requireApplicant(applicant.id);
  if (!freshApplicant.phone) {
    const phone = extractPhone(email.body);
    if (phone) {
      repo.updateApplicant(applicant.id, { phone });
      repo.audit(applicant.id, "system", "phone_captured", phone);
    }
  }
  return {
    freshApplicant,
  };
}
