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
import type {
  Classification,
  DerivedFlag,
  EmailCategory,
  IncomingEmail,
  LifecycleStage,
  ProcessResult,
  WatcherInput,
} from "../types";
import { recordDocuments } from "../matching";
import { resolveIdentity } from "../matching/identity";
import { extractAttachment, MIN_AUTO_PASS_SCORE } from "../extraction/extract";
import { consistencyCheck } from "../extraction/crosscheck";
import { readBackText, documentIssuesText, internalNote } from "../extraction/feedback";
import { decide, docLabel, normalizeName } from "../rules";
import { evaluateAdmission, evaluateCaseTypeRules, downgradeRoutingForWatcher } from "../admissions/evaluate";
import { caseTypeGate, gate } from "../gate";
import { fillSlots } from "../documents/matrix";
import { categorizeEmail, classifyWithConfiguredCategories, priorityForCategory } from "../categorize";
import { emailTargetsKnownApplicant } from "../matching";
import { classifyIntakeEmail, DEFAULT_INTAKE_HOTWORDS, intakeHotwordList } from "../intake";
import { firstMatchingRule, rulesForCaseScope, replyStateOf, describeRule, type RuleAction, type RuleMatchInput, type WorkflowRule } from "../rules/workflow";
import { extractPhone, inferIntake, inferProgramme, inferTransfer } from "../enrich";
import { checklistText, pickQueuedDraft, renderTemplate, type Draft, type DraftContext } from "../drafting";
import { writeDecisionLog } from "../logs";
import { emailBanner, organizationName, organizationSender } from "../branding";
import type { SendExtras } from "./adapters";
import { LIFECYCLE_LABELS } from "../types";
import { log } from "../util/log";
import type { PipelineContext } from "./adapters";

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
  const { repo, adapters } = ctx;
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
    return {
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
  }

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
  const preFlags: DerivedFlag[] = [];
  if (identity.concern) {
    preFlags.push({ type: "identity_check", detail: identity.concern });
    repo.audit(applicant.id, "system", "identity_concern", identity.concern);
    log(`pipeline: ${applicant.ref_number} matched via ${identity.matchedBy} WITH concern — human must verify`, "warn");
  }
  if (!identity.isNew && identity.matchedBy !== "created") {
    repo.audit(applicant.id, "system", "identity_matched", `email attached to existing case via ${identity.matchedBy} signal`);
  }

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
  const freshApplicant = repo.getApplicant(applicant.id)!;
  if (!freshApplicant.phone) {
    const phone = extractPhone(email.body);
    if (phone) {
      repo.updateApplicant(applicant.id, { phone });
      repo.audit(applicant.id, "system", "phone_captured", phone);
    }
  }

  // ── Extraction with duplicate detection (features 5, 6, 22) ─────────────
  const extractions = [];
  const duplicateFlags: DerivedFlag[] = [];
  for (const att of email.attachments) {
    const res = await extractAttachment(att, { vision: adapters.vision, ocr: adapters.ocr });
    // Generic document slots are organization-owned. A configured key or
    // label in the supplied filename/text is a routing hint only; extraction
    // fields and the human gate still decide whether the evidence is usable.
    if (genericCaseType && !educationCase) {
      const haystack = `${att.filename} ${res.text}`.toLowerCase();
      const configured = repo.listDocumentDefinitions(genericCaseType.id).find((d) => {
        const words = `${d.key} ${d.label}`.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
        return words.some((word) => haystack.includes(word));
      });
      if (configured) res.document_type = configured.key as typeof res.document_type;
    }
    const dup = repo.findDuplicate(applicant.id, res.sha256);
    if (dup) {
      repo.insertDocument({
        applicant_id: applicant.id,
        document_type: res.document_type === "unknown" ? dup.document_type : res.document_type,
        source_email_id: email.id,
        extraction_method: res.method,
        extracted_text: res.text,
        extracted_fields: res.fields,
        confidence: res.confidence,
        confidence_score: res.confidence_score,
        received_at: email.receivedAt,
        sha256: res.sha256,
        is_duplicate: true,
        duplicate_of: dup.id,
        extraction_note: res.failure_reason ?? "",
      });
      repo.audit(
        applicant.id,
        "system",
        "duplicate_detected",
        `${att.filename} is identical to document #${dup.id} (${dup.document_type}) already on file`
      );
      duplicateFlags.push({
        type: "duplicate_submission",
        detail: `${att.filename} is a byte-identical resubmission of an existing ${dup.document_type} — deduplicated`,
      });
      log(`pipeline: ${att.filename} recognised as duplicate of doc #${dup.id}`);
      continue;
    }
    extractions.push(res);
  }

  // ── Persist docs + supersede corrections (features 4, 9) ────────────────
  recordDocuments(repo, applicant.id, email, extractions);
  let activeDocs = repo.listDocuments(applicant.id, { activeOnly: true });

  // ── Cross-document consistency (confidence v2) ───────────────────────────
  // Real files agree with themselves: names match across documents (allowing
  // initials/order/case) and a DOB printed twice is the same date. Where they
  // disagree, the contradicting document loses its auto-pass trust and a
  // human is told exactly what conflicts.
  const cons = consistencyCheck(
    activeDocs.map((d) => ({
      id: d.id,
      document_type: d.document_type,
      confidence_score: d.confidence_score ?? 0,
      name: (d.extracted_fields?.name as string | undefined) ?? null,
      dateOfBirth: (d.extracted_fields?.dateOfBirth as string | undefined) ?? null,
    }))
  );
  if (!cons.nameConsistent || !cons.dobConsistent) {
    // Name contradictions are ALSO detected by the rules layer, whose
    // human-worded flag (incl. the "possible typo" phrasing) stays the
    // one staff see; here we add the DATE-OF-BIRTH check it doesn't do.
    if (!cons.dobConsistent) {
      const dobDetail = `date of birth differs between documents: ${cons.issues.join("; ")}`;
      const existing = preFlags.find((f) => f.type === "identity_check");
      if (existing) existing.detail = `${existing.detail}; ${dobDetail}`;
      else preFlags.push({ type: "identity_check", detail: dobDetail });
    }
    repo.audit(applicant.id, "system", "cross_doc_inconsistency", cons.issues.join("; "));
    for (const outlierId of [...new Set([...cons.nameOutliers, ...cons.dobOutliers])]) {
      const doc = activeDocs.find((d) => d.id === outlierId);
      if (!doc) continue;
      const capped = Math.min(doc.confidence_score ?? 0, 55);
      repo.updateDocumentConfidence(outlierId, {
        confidence_score: capped,
        confidence: capped >= MIN_AUTO_PASS_SCORE ? "high" : "medium",
        extraction_note: internalNote(`contradicts other documents on file: ${cons.issues[0]}`),
      });
    }
    activeDocs = repo.listDocuments(applicant.id, { activeOnly: true });
  }

  // ── Enrich programme/intake from email + document text (feature 2) ──────
  {
    const current = repo.getApplicant(applicant.id)!;
    const patch: { programme?: string; intake?: string; full_name?: string; transfer?: number } = {};

    // Prefer the name printed on official documents over the email From name.
    const docName = activeDocs
      .map((d) => normalizeName(d.extracted_fields?.name as string | undefined))
      .sort((a, b) => b.length - a.length)[0];
    if (docName && docName.length >= 5 && (!current.full_name || docName.length >= (current.full_name || "").length)) {
      patch.full_name = docName
        .toLowerCase()
        .split(" ")
        .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
        .join(" ");
    }


    if (!current.programme || !current.intake) {
      const corpus = [email.subject, email.body, ...activeDocs.map((d) => d.extracted_text.slice(0, 800))].join("\n");
      const programmes = repo.listProgrammes();
      const intakes = repo.listIntakes();
      if (!current.programme) {
        const p = inferProgramme(corpus, programmes);
        if (p) patch.programme = p;
      }
      if (!current.intake) {
        const i = inferIntake(corpus, intakes);
        if (i) patch.intake = i;
      }
      // Transfer applicants (credit from another institution) must also
      // submit the credit transfer form — detected from their own words.
      if (!current.transfer && inferTransfer(corpus)) patch.transfer = 1;
    }
    // Course routing: once the programme is known, the case lands with that
    // course's assigned officer — automatically, and only when the case is
    // unassigned (a human hand-over is never overwritten).
    const prog = patch.programme ?? current.programme;
    if (prog && !current.assigned_to) {
      const ownerId = repo.ownerOfProgramme(prog);
      if (ownerId) {
        (patch as { assigned_to?: number }).assigned_to = ownerId;
        const owner = repo.getStaff(ownerId);
        repo.notify(
          "assignment",
          `New ${prog} case routed to you: ${applicant.ref_number}`,
          applicant.id,
          ownerId
        );
        repo.audit(applicant.id, "system", "case_routed", `assigned to ${owner?.display_name ?? ownerId} (owner of ${prog})`);
      }
    }
    if (Object.keys(patch).length) {
      repo.updateApplicant(applicant.id, patch);
      repo.audit(
        applicant.id,
        "system",
        "case_enriched",
        Object.entries(patch).map(([k, v]) => `${k}=${v}`).join(", ")
      );
    }
  }

  // ── Requirements for THIS applicant (features 8, 36, 37, v3-19) ──────────
  // First triage freezes a snapshot of the requirement set; later rule
  // changes never retroactively move an applicant's goalposts. PPR P0-3
  // adds the exact profile configuration version to that freeze.
  const applicantNow = repo.getApplicant(applicant.id)!;
  repo.freezeRequirementsSnapshot(applicantNow);
  repo.freezeCaseConfig(applicantNow);
  if (educationCase) repo.freezeStructuredSnapshot(applicantNow);
  const requirements = repo.effectiveRequirements(repo.getApplicant(applicant.id)!);

  // ── Intake deadline (v3 features 20, 21): late arrival → flag, never an
  //    automatic rejection. ─────────────────────────────────────────────────
  const deadline = repo.intakeDeadline(applicantNow.intake);
  if (deadline && new Date(email.receivedAt).getTime() > new Date(deadline).getTime()) {
    preFlags.push({
      type: "late_submission",
      detail: `received ${email.receivedAt.slice(0, 10)} after the ${applicantNow.intake} intake deadline of ${deadline} — human decides whether to accept`,
    });
    repo.audit(applicant.id, "system", "late_submission", `after ${applicantNow.intake} deadline ${deadline}`);
  }

  // ── Configured CaseType engine ───────────────────────────────────────────
  // A non-academic tenant uses only its organization-owned matrix and rule
  // tree. The generic evaluator returns evidence and human_review; it never
  // writes an approval/rejection decision and never inherits academic fields.
  let genericRuleResult: ReturnType<typeof evaluateCaseTypeRules> | null = null;
  if (genericCaseType && !educationCase) {
    const facts: Record<string, unknown> = {
      subject: email.subject,
      body: email.body,
      has_attachments: email.attachments.length > 0,
    };
    for (const doc of activeDocs) Object.assign(facts, doc.extracted_fields ?? {});
    genericRuleResult = evaluateCaseTypeRules(repo, genericCaseType, repo.caseTypeRules(genericCaseType), facts);
    const matrix = fillSlots(requirements, activeDocs.map((d) => d.document_type));
    const matrixComplete = matrix.missing.length === 0;
    const configuredGate = caseTypeGate({
      matrixComplete,
      ruleTreePassed: genericRuleResult.result === "passed",
      watcher: { ran: false, flagged: false },
      confidenceFloorMet: activeDocs.every((d) => (d.confidence_score ?? 0) >= MIN_AUTO_PASS_SCORE),
    });
    repo.audit(applicant.id, "system", "case_type_gate", `${genericCaseType.code}: matrix=${matrixComplete}; rules=${genericRuleResult.result}; action=${configuredGate.action}; outcome remains undecided`);
    if (genericRuleResult.result !== "passed") {
      preFlags.push({ type: "low_confidence", detail: `Configured ${genericCaseType.name} rule tree is ${genericRuleResult.result}; human review required` });
    }
  }
  // PPR P0-2 (audit F1): the academic engine runs ONLY for education-module
  // cases. A non-academic profile never loads grades, routing or auto-admit.
  const admission = genericRuleResult || !educationCase
    ? { derivedFlags: [] as DerivedFlag[] }
    : evaluateAdmission(repo, applicant.id, preFlags);
  preFlags.push(...admission.derivedFlags);

  // ── Rules: pure deterministic decision (feature 10) ─────────────────────
  const rulesOut = genericRuleResult || !educationCase
    ? (() => {
      const missing = fillSlots(requirements, activeDocs.map((d) => d.document_type)).missing.map((x) => x.document_type);
      const treeResult = genericRuleResult?.result ?? "undetermined";
      const status: Classification = missing.length > 0 || treeResult !== "passed" ? "Orange" : "Green";
      return {
        status,
        reasoning: `CaseType matrix ${missing.length ? `missing ${missing.join(", ")}` : "complete"}; rule tree ${treeResult}; routing human review; outcome undecided`,
        derivedFlags: [] as DerivedFlag[],
        missing,
      };
    })()
    : decide({ requirements, docs: activeDocs, flags: preFlags });

  // ── Watcher: Green only, can only downgrade (feature: watcher) ──────────
  let finalStatus: Classification = rulesOut.status;
  let watcherFlagged = false;
  let reasoning = rulesOut.reasoning;
  const watcherFlags: DerivedFlag[] = [];

  if (rulesOut.status === "Green") {
    const watcherInput: WatcherInput = {
      applicantEmail: applicantNow.email_address,
      subject: email.subject,
      docs: activeDocs.map((d) => ({
        document_type: d.document_type,
        extraction_method: d.extraction_method,
        confidence: d.confidence,
        name: (d.extracted_fields?.name as string | undefined) ?? null,
        gradePoints: (d.extracted_fields?.gradePoints as number | undefined) ?? null,
        textExcerpt: d.extracted_text.slice(0, 600),
      })),
    };
    const watch = await adapters.watcher(watcherInput);
    if (watch.flagged) {
      watcherFlagged = true;
      finalStatus = "Red";
      reasoning += `\nWatcher (${watch.source}) FLAGGED the Green verdict — downgrading to Red:\n${watch.concerns
        .map((c) => `  - ${c}`)
        .join("\n")}`;
      for (const c of watch.concerns) watcherFlags.push({ type: "watcher_flag", detail: c });
      repo.audit(applicant.id, "system", "watcher_downgrade", watch.concerns.join("; "));
      log(`pipeline: watcher downgraded ${applicantNow.ref_number} Green → Red`, "warn");
    } else {
      reasoning += `\nWatcher (${watch.source}) found nothing off. Green stands.`;
    }
  }

  if (humanTriageOnly) {
    reasoning += `\nRouting: ${enquiryOnly ? "admission enquiry" : category.replace(/_/g, " ")} — the message is sent to human triage; attachments are evidence, not a document-pack submission.`;
  }

  // Persist flags (blocking + informational duplicates).
  const blockingFlags = [...preFlags, ...rulesOut.derivedFlags, ...watcherFlags];
  repo.syncFlags(applicant.id, [...blockingFlags, ...duplicateFlags]);
  repo.audit(applicant.id, "system", "requirements_checked", `verdict=${finalStatus}; missing=${rulesOut.missing.join(",") || "none"}`);

  // A watcher downgrade after a passing evaluation still forces human review.
  if (watcherFlagged) downgradeRoutingForWatcher(repo, applicant.id);

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

  let autoKind: ProcessResult["autoKind"] = null;
  let draft: Draft | null = null;
  let queueForHuman = false;
  /** PPR P0-4: the template a response rule resolved (may be any profile key). */
  let ruleTemplateKey: string | null = null;
  /** PPR P1-3: the queued draft needs "Approve automation" to release. */
  let draftNeedsApproval = false;

  const gateDecision = gate(finalStatus, { ran: rulesOut.status === "Green", flagged: watcherFlagged });

  const refOnlyOwnCase =
    email.attachments.length === 0 &&
    /^[A-Z]{1,6}-\d{4}-\d{1,8}$/i.test(email.body.trim()) &&
    email.body.trim().toUpperCase() === applicantNow.ref_number.toUpperCase() &&
    email.from.trim().toLowerCase() === applicantNow.email_address;

  // ── Reply selection (PPR P0-4): stored response rules decide what the
  //    case replies and how it routes. Profiles without response rules keep
  //    the original chain below, unchanged. Templates, send/draft/hold,
  //    follow-up ladder and audit codes are all rule data — the qualification
  //    gate still holds every non-fully-qualified reply for staff when the
  //    profile has one (the migrated education profile keeps it). ──────────
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

  // ── Draft-first mode (v3 feature 17): a global or per-category setting can
  //    hold ANY automated reply for human approval. The reply is still
  //    drafted normally — it just gets queued instead of sent. A workflow
  //    profile can declare its own default (new profiles default to draft —
  //    automation is opt-in per profile; the migrated education profile keeps
  //    its preserved "auto" setting). ──────────────────────────────────────
  const profileReplyMode = genericCaseType?.default_reply_action;
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

  // ── Admission safety gate ────────────────────────────────────────────────
  // A passing rules evaluation is evidence for a reviewer, never an admission
  // decision. The evaluator may record a provisional route for legacy reports,
  // but this intake path never sets admission_decision or sends a letter.

  // ── Drafting (features 14, 35) ──────────────────────────────────────────
  const institution = organizationName(repo, applicantNow.organization_id ?? applicant.organization_id ?? 1);
  const requiredReqs = requirements.filter((r) => r.required);
  const presentTypes = activeDocs.map((d) => d.document_type);
  const missingLabels = rulesOut.missing.map((m) => docLabel(m));
  const knownName =
    activeDocs
      .map((d) => normalizeName(d.extracted_fields?.name as string | undefined))
      .find((n) => n.length >= 3) || freshApplicant.full_name || email.fromName;
  let lifecycleAfter: LifecycleStage = humanTriageOnly
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

  // Admission letters are only available through a human decision; the intake
  // pipeline drafts factual acknowledgements and review notes only. (A
  // response rule may name any profile template key — that wins here.)
  const templateKey = ruleTemplateKey ?? (autoKind === "ack"
    ? "ack_received"
    : autoKind === "docs_request"
        ? "docs_request"
        : autoKind === "missing_docs"
          ? "missing_documents"
          : autoKind === "status_answer"
            ? "status_answer"
            : null);

  const organizationId = applicantNow.organization_id ?? applicant.organization_id ?? 1;
  const caseTypeId = genericCaseType?.id;
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

  // ── Send or queue ────────────────────────────────────────────────────────
  // Send failures are never fatal: the reply becomes a queued draft and a
  // human handles it (v3 reliability requirement).
  let autoSent = false;
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

  if (queueForHuman) {
    // SLA clock starts (feature 28); staff action stops it. A response rule
    // may declare its own target hours.
    const slaHours = replyAction?.sla_hours ?? Number(repo.getSetting("sla_target_hours", "4"));
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

  // ── Lifecycle transition + status history (features 15, 16) ─────────────
  const lifecycleNow = repo.getApplicant(applicant.id)!.lifecycle;
  if (lifecycleNow !== lifecycleAfter) {
    const why = autoKind === "ack"
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


