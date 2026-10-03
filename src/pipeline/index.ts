/**
 * The v2 pipeline per incoming email:
 *
 *   1. ingestion delivers the email (caller)
 *   2. categorize (Gemini first when configured; deterministic regex fallback)
 *      before intake routing, then resolve/create applicant + ref number
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
import { envInt } from "../util/envnum";
import { resolveIdentity } from "../matching/identity";
import { computeConfidence, extractAttachment, MIN_AUTO_PASS_SCORE } from "../extraction/extract";
import { consistencyCheck } from "../extraction/crosscheck";
import { readBackText, documentIssuesText, internalNote } from "../extraction/feedback";
import { decide, docLabel, normalizeName } from "../rules";
import { evaluateCaseTypeRules } from "../rules/caseType";
import { caseTypeGate, gate } from "../gate";
import { fillSlots } from "../documents/matrix";
import { categorizeEmail, classifyWithConfiguredCategories, priorityForCategory, CLASSIFIER_MIN_CONFIDENCE, type CategoryClassificationTrace } from "../categorize";
import { emailTargetsKnownApplicant } from "../matching";
import { classifyIntakeEmail, DEFAULT_INTAKE_HOTWORDS, intakeHotwordList } from "../intake";
import { firstMatchingRule, rulesForCaseScope, replyStateOf, describeRule, type RuleAction, type RuleMatchInput, type WorkflowRule } from "../rules/workflow";
import { extractPhone, inferIntake } from "../enrich";
import { extractGenericFacts } from "../extraction/fields";
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
  // Which tenant this message belongs to: declared by the connector/portal,
  // else resolved from the address it was delivered to, else the head office.
  const intakeOrganizationId = email.organizationId
    ?? repo.organizationForInboundAddress(email.to)?.organizationId
    ?? 1;

  // Classify FIRST: a configured Gemini categorizer must get its chance before
  // either the intake scorer can park mail or an intake rule can ignore it.
  // The trace rows are inserted now (before routing) and attached to a case
  // later without changing their ids, preserving the real order in its audit.
  const configuredKeys = repo.listEmailCategories(intakeOrganizationId).map((x) => x.key);
  const classifierAuditIds: number[] = [];
  const traceValue = (value: unknown, max = 180) =>
    String(value ?? "").replace(/[\r\n;=]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  const recordClassifierAttempt = (attempt: CategoryClassificationTrace) => {
    const event = attempt.classifier === "gemini" ? "email_classifier_gemini" : "email_classifier_fallback";
    const details = [
      `message_id=${traceValue(email.id, 120)}`,
      `outcome=${attempt.outcome}`,
      ...(attempt.label !== undefined ? [`label=${traceValue(attempt.label, 80)}`] : []),
      ...(attempt.confidence !== undefined ? [`confidence=${attempt.confidence}`] : []),
      ...(attempt.reason ? [`reason=${traceValue(attempt.reason)}`] : []),
    ];
    classifierAuditIds.push(repo.audit(null, "system", event, details.join("; ")));
  };

  let category: EmailCategory;
  let categoryLabelDetail: string;
  let classifierHold: string | null = null;
  if (configuredKeys.length > 0) {
    const label = await classifyWithConfiguredCategories(
      {
        subject: email.subject,
        body: email.body,
        hasAttachments: email.attachments.length > 0,
      },
      configuredKeys,
      adapters.categorizer,
      undefined,
      recordClassifierAttempt
    );
    const normalized = label.label.toLowerCase();
    const mapped: Record<string, EmailCategory> = {
      general_enquiry: "general_enquiry",
      application: "application", document_submission: "document_submission",
      missing_document: "missing_document", fee_enquiry: "fee_enquiry",
      follow_up: "follow_up", complaint: "complaint", other: "other", normal: "other",
    };
    category = mapped[normalized] ?? "other";
    categoryLabelDetail = `label=${label.label} confidence=${label.confidence} source=${label.source ?? "fallback"}; routed as '${category}'; routing metadata only, never a decision${mapped[normalized] ? "" : " — not one of the eight workflow categories"}`;
    if ((label.source ?? "fallback") !== "gemini") {
      classifierHold = `the label '${label.label}' came from the deterministic fallback, not the model`;
    } else if (!(label.confidence >= CLASSIFIER_MIN_CONFIDENCE)) {
      classifierHold = `classifier confidence ${label.confidence} is below the ${CLASSIFIER_MIN_CONFIDENCE} floor (label '${label.label}')`;
    }
  } else {
    recordClassifierAttempt({ classifier: "gemini", outcome: "not_run", reason: "no tenant message categories configured" });
    category = categorizeEmail(email.subject, email.body, email.attachments.length > 0);
    recordClassifierAttempt({ classifier: "deterministic_regex", outcome: "returned", label: category, confidence: 1, reason: "no tenant message categories configured" });
    categoryLabelDetail = `label=${category} confidence=1 source=deterministic_regex; routed as '${category}'; routing metadata only, never a decision`;
  }

  // ── Intake gate (round 9; PPR P0-4: stored rules decide, with the
  //    configured scorer as the signal source and as the fallback for
  //    tenants without intake rules) ───────────────────────────────────────
  // Only intake mail becomes a case: the mail carries an intake signal, or
  // it targets a contact we already know (conversation continuity).
  // Everything else is parked in the Mail window WITHOUT a case: kept,
  // visible, labelable — but no case number, no queue entry, no reply.
  const hotwords = repo.getSetting("intake_hotwords", DEFAULT_INTAKE_HOTWORDS);
  const verdict = classifyIntakeEmail({
    subject: email.subject,
    body: email.body,
    attachmentFilenames: (email.attachments ?? []).map((a) => a.filename),
    // Both the editable display name and the stable code of every case type the
    // tenant configured are intake signals: contacts write the short code as
    // often as the full name, and a code is less ambiguous than a generic word.
    caseTypeNames: repo.listCaseTypes(intakeOrganizationId).flatMap((t) => [t.name, t.code]),
    customHotwords: intakeHotwordList(hotwords),
    knownContact: emailTargetsKnownApplicant(repo, email),
  });
  const senderState: "known" | "unknown" = emailTargetsKnownApplicant(repo, email) ? "known" : "unknown";
  // Which profile this mail targets (declared on the connector/portal, or
  // the migrated legacy scope). Rule scope follows it exactly.
  // Which case type this message belongs to, in precedence order:
  //   1. declared by the connector or portal (it knows better than we can guess);
  //   2. an inbound ADDRESS ALIAS this tenant configured (Phase D3) — the sender
  //      chose the route by picking an address;
  //   3. the tenant's own type when it has exactly ONE (unambiguous);
  //   4. nothing. With several configured types and no signal, nothing is
  //      guessed: the case is flagged unconfigured and a person picks the right
  //      checklist, because a wrong checklist silently demands the wrong
  //      documents. Two aliases on one message pointing at DIFFERENT types are
  //      ambiguous and are treated the same way — never a coin toss.
  const tenantCaseTypes = repo.listCaseTypes(intakeOrganizationId);
  const aliasResolution = email.caseTypeCode ? { status: "none" as const } : repo.resolveInboundAlias(intakeOrganizationId, email.to);
  const aliasMatch = aliasResolution.status === "match" ? aliasResolution : null;
  const aliasAmbiguous = aliasResolution.status === "ambiguous" ? aliasResolution : null;
  const effectiveCaseTypeCode = email.caseTypeCode
    ?? (aliasMatch ? aliasMatch.caseTypeCode : undefined)
    ?? (aliasAmbiguous ? undefined : tenantCaseTypes.length === 1 ? tenantCaseTypes[0].code : undefined);
  const scopeType = effectiveCaseTypeCode ? repo.getCaseType(effectiveCaseTypeCode, intakeOrganizationId) : undefined;
  const scopedIntakeRules = rulesForCaseScope(
    repo.listWorkflowRules(intakeOrganizationId, { kind: "intake" }), scopeType?.id ?? null
  );
  const scopedResponseRules = rulesForCaseScope(
    repo.listWorkflowRules(intakeOrganizationId, { kind: "response" }), scopeType?.id ?? null
  );
  const bodyIsRefShape = /^[A-Z]{1,6}-\d{4}-\d{1,8}$/i.test(email.body.trim());
  const intakeInput: RuleMatchInput = {
    senderState,
    subject: email.subject,
    body: email.body,
    hasAttachments: email.attachments.length > 0,
    category,
    bodyIsRef: bodyIsRefShape,
    intakeSignals: verdict.category === "parked" ? "parked" : "open",
    docsState: "dirty", // document posture is a reply-time fact; intake rules match on message facts
    docsOnFile: 0,
  };
  let intakeRule: WorkflowRule | null = null;
  let intakeDecision: "create" | "attach" | "ignore" | "review" | null = null;
  if (scopedIntakeRules.length > 0) {
    intakeRule = firstMatchingRule(scopedIntakeRules, intakeInput);
    // Rules are present: an unmatched message still reaches the case flow
    // (human review) — mail is never silently dropped because a rule set
    // has a gap.
    intakeDecision = intakeRule?.action.decision ?? "create";
  } else {
    // Fallback for tenants without intake rules: the configured scorer.
    intakeDecision = verdict.category === "parked" ? "ignore" : "create";
  }
  if (intakeDecision === "ignore") {
    repo.insertEmail({
      applicant_id: null,
      organization_id: intakeOrganizationId,
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

  // An eligibility/requirements question may carry a screenshot as evidence.
  // Keep it in the enquiry workflow: OCR can still preserve the evidence, but
  // the attachment must not turn a question into a documents-received or
  // awaiting-documents case. PPR P0-4: which mail needs a human is a stored
  // response rule (`decision: review`); profiles without rules keep the
  // original category policy.
  const enquiryOnly = category === "general_enquiry";
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
    caseTypeCode: effectiveCaseTypeCode,
  });
  const applicant = identity.applicant;
  // Preserve the classifier's original pre-routing audit order on the case.
  repo.attachAuditRowsToApplicant(classifierAuditIds, applicant.id);
  // The intake rule's audit code records which rule opened/continued the case.
  if (intakeRule?.action.audit_code) {
    repo.audit(applicant.id, "system", intakeRule.action.audit_code, `rule “${intakeRule.name}” matched — ${describeRule(intakeRule)}`);
  }
  const genericCaseType = repo.caseTypeForCase(applicant.id);
  if (!email.caseTypeCode && genericCaseType) {
    if (aliasMatch) {
      repo.audit(applicant.id, "system", "case_type_by_alias",
        `${genericCaseType.code} — the message was delivered to ${aliasMatch.alias}, which this organization routes to that case type`);
    } else {
      repo.audit(applicant.id, "system", "case_type_inferred",
        `${genericCaseType.code} — this organization has exactly one case type, so the message was filed under it`);
    }
  }
  repo.freezeCaseConfig(applicant);
  const frozenConfig = repo.caseConfigFrozen(repo.getCase(applicant.id)!);
  const intakeCarriesReply = Boolean(intakeRule?.action.reply_action && intakeRule.action.reply_action !== "none");
  if (scopedResponseRules.length === 0 && !intakeCarriesReply) humanTriageOnly = true;
  const profileReplyMode = genericCaseType?.default_reply_action;
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
    organization_id: intakeOrganizationId,
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
  if (categoryLabelDetail) repo.audit(applicant.id, "system", "email_labelled", categoryLabelDetail);

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
    if (genericCaseType) {
      const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const haystack = ` ${normalize(`${att.filename} ${res.text}`)} `;
      const definitions = frozenConfig?.documents ?? repo.listDocumentDefinitions(genericCaseType.id);
      const exact = definitions.filter((definition) => haystack.includes(` ${normalize(definition.key)} `) || haystack.includes(` ${normalize(definition.label)} `));
      let configured = exact.length === 1 ? exact[0] : undefined;
      if (!configured && exact.length === 0) {
        const scores = definitions.map((definition) => {
          const words = [...new Set(normalize(`${definition.key} ${definition.label}`).split(" ").filter((word) => word.length > 2))];
          return { definition, hits: words.filter((word) => haystack.includes(` ${word} `)).length };
        }).sort((left, right) => right.hits - left.hits);
        if (scores[0]?.hits >= 2 && scores[0].hits > (scores[1]?.hits ?? 0)) configured = scores[0].definition;
      }
      if (configured) {
        res.document_type = configured.key;
        // A routing hint cannot turn unreadable bytes or vision guesses into reliable evidence.
        if (res.method !== "none") {
          const confidence = computeConfidence({ text: res.text, fields: res.fields, docType: res.document_type, method: res.method,
            tier: res.method === "pdf_text" ? "high" : res.method === "gemini_vision" ? res.confidence : "medium" });
          // A routing hint may rename the document; it must not UPGRADE a file
          // we only partly read (page cap, render budget). That cap survives.
          const score = res.partial_read ? Math.min(confidence.score, res.confidence_score ?? confidence.score) : confidence.score;
          res.confidence_score = score;
          res.confidence = score >= MIN_AUTO_PASS_SCORE ? "high" : score >= 45 ? "medium" : "low";
        }
      }
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

  // Prefer document names over mail display names; preserve tenant-owned case routing.
  const current = repo.getCase(applicant.id)!;
  const documentName = activeDocs.map((doc) => normalizeName(typeof doc.extracted_fields.name === "string" ? doc.extracted_fields.name : null)).sort((left, right) => right.length - left.length)[0];
  if (documentName && documentName.length >= 5 && (!current.full_name || documentName.length >= current.full_name.length)) {
    repo.updateApplicant(applicant.id, { full_name: documentName.toLowerCase().split(" ").map((part) => part ? part[0].toUpperCase() + part.slice(1) : part).join(" ") });
  }

  // ── Requirements for THIS applicant (features 8, 36, 37, v3-19) ──────────
  // First triage freezes a snapshot of the requirement set; later rule
  // changes never retroactively move an applicant's goalposts. PPR P0-3
  // adds the exact profile configuration version to that freeze.
  const applicantNow = repo.getApplicant(applicant.id)!;
  repo.freezeRequirementsSnapshot(applicantNow);
  repo.freezeCaseConfig(applicantNow);
  const requirements = repo.effectiveRequirements(repo.getApplicant(applicant.id)!);

  // ── Submission windows (v3 features 20, 21) ─────────────────────────────
  // A tenant may configure windows (a service round, a funding cycle) with a
  // deadline. The case names its own window; when it does not, a window named
  // in the message is attached to it. A late arrival only ever RAISES A FLAG —
  // a human decides, the machine never rejects on a calendar alone.
  const configuredWindows = repo.listIntakes(intakeOrganizationId);
  if (!applicantNow.intake && configuredWindows.length > 0) {
    const named = inferIntake(`${email.subject}\n${email.body}`, configuredWindows);
    if (named) {
      repo.updateApplicant(applicant.id, { intake: named });
      repo.audit(applicant.id, "system", "window_inferred", `window “${named}” is named in the message`);
    }
  }
  const windowName = repo.getApplicant(applicant.id)?.intake ?? null;
  const deadline = repo.intakeDeadline(windowName, intakeOrganizationId);
  if (deadline && new Date(email.receivedAt).getTime() > new Date(deadline).getTime()) {
    preFlags.push({
      type: "late_submission",
      detail: `received ${email.receivedAt.slice(0, 10)} after the ${windowName} window closed on ${deadline} — human decides whether to accept`,
    });
    repo.audit(applicant.id, "system", "late_submission", `after the ${windowName} deadline ${deadline}`);
  }

  // ── Configured CaseType engine ───────────────────────────────────────────
  // A non-academic tenant uses only its organization-owned matrix and rule
  // tree. The generic evaluator returns evidence and human_review; it never
  // writes an approval/rejection decision and never inherits academic fields.
  let genericRuleResult: ReturnType<typeof evaluateCaseTypeRules> | null = null;
  if (genericCaseType) {
    const facts: Record<string, unknown> = { subject: email.subject, body: email.body, has_attachments: email.attachments.length > 0 };
    for (const doc of activeDocs) {
      if ((doc.confidence_score ?? (doc.confidence === "high" ? 100 : 0)) < MIN_AUTO_PASS_SCORE || doc.extraction_method === "none") continue;
      for (const [key, value] of Object.entries(doc.extracted_fields ?? {})) if (!["__proto__", "prototype", "constructor"].includes(key)) facts[key] = value;
    }
    for (const [key, value] of Object.entries(extractGenericFacts(email.body))) if (!Object.hasOwn(facts, key)) facts[key] = value;
    genericRuleResult = evaluateCaseTypeRules(repo, genericCaseType, frozenConfig?.rules ?? repo.caseTypeRules(genericCaseType), facts);
    const matrix = fillSlots(requirements, activeDocs.map((d) => d.document_type));
    const matrixComplete = matrix.missing.length === 0;
    const configuredGate = caseTypeGate({
      matrixComplete,
      ruleTreePassed: genericRuleResult.result === "passed",
      watcher: { ran: false, flagged: false },
      confidenceFloorMet: activeDocs.every((d) => (d.confidence_score ?? 0) >= MIN_AUTO_PASS_SCORE),
    });
    repo.audit(applicant.id, "system", "case_type_gate", `${genericCaseType.code}: matrix=${matrixComplete}; rules=${genericRuleResult.total > 0 ? genericRuleResult.result : "none configured"}; action=${configuredGate.action}; outcome remains undecided`);
    // An EMPTY rule tree is not an undetermined one: a case type that declares
    // no rule constraints is gated by its document matrix alone. Filing a
    // blocking flag for "undetermined" here made automation impossible for
    // such a case type even after its administrator turned the evidence gate
    // off and opted into sending — the switch documented below had no effect.
    if (genericRuleResult.total > 0 && (genericRuleResult.result === "failed" || (genericRuleResult.result !== "passed" && matrixComplete))) {
      preFlags.push({ type: "low_confidence", detail: `Configured ${genericCaseType.name} rule tree is ${genericRuleResult.result}; human review required` });
    }
  }
  if (!genericCaseType) {
    // One flag, with the precise reason: "we could not tell" is not the same
    // message to a person as "two of your own addresses disagree".
    preFlags.push(aliasAmbiguous
      ? {
          type: "unconfigured_case",
          detail: `delivered to ${aliasAmbiguous.aliases.map((x) => x.alias).join(" and ")}, which this organization routes to different case types (${aliasAmbiguous.aliases.map((x) => x.caseTypeCode ?? "?").join(", ")}) — a person must choose on the case page`,
        }
      : { type: "unconfigured_case", detail: "No case type is configured — human review required" });
  }
  if (aliasAmbiguous) {
    // Deliberately unrouted: a person picks the case type on the case page
    // (the re-type control), which is exactly what the safety valve is for.
    repo.audit(applicant.id, "system", "case_type_alias_ambiguous",
      `${aliasAmbiguous.aliases.map((x) => `${x.alias} → ${x.caseTypeCode ?? "?"}`).join("; ")} — left unconfigured for a person to choose`);
    repo.notify("review_needed",
      `${applicantNow.ref_number}: two configured addresses on this message point at different case types — choose one on the case page`, applicant.id);
  }
  const rulesOut = decide({ requirements, docs: activeDocs, flags: preFlags });
  if (genericRuleResult && genericRuleResult.total > 0 && genericRuleResult.result !== "passed" && rulesOut.status === "Green") rulesOut.status = "Orange";
  rulesOut.reasoning += `\nCaseType rule tree: ${genericRuleResult ? (genericRuleResult.total > 0 ? genericRuleResult.result : "none configured") : "unconfigured"}; outcome remains undecided.`;

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
    reasoning += `\nRouting: ${enquiryOnly ? "general enquiry" : category.replace(/_/g, " ")} — the message is sent to human triage; attachments are evidence, not a document-pack submission.`;
  }

  // Persist flags (blocking + informational duplicates).
  const blockingFlags = [...preFlags, ...rulesOut.derivedFlags, ...watcherFlags];
  repo.syncFlags(applicant.id, [...blockingFlags, ...duplicateFlags]);
  repo.audit(applicant.id, "system", "requirements_checked", `verdict=${finalStatus}; missing=${rulesOut.missing.join(",") || "none"}`);

  // A watcher downgrade after a passing evaluation still forces human review.
  const requirementResult = rulesOut.missing.length ? "missing_data" : genericRuleResult?.result === "failed" ? "failed" : finalStatus !== "Green" ? "needs_verification" : "passed";
  const report: import("../types").EvaluationReport = {
    result: requirementResult, routing: rulesOut.missing.length ? "waiting_documents" : "human_review",
    reason: reasoning, reasonCode: rulesOut.missing.length ? "missing_documents" : finalStatus === "Green" ? "ready_for_review" : "verification_required",
    leaves: genericRuleResult?.leaves ?? [], groups: genericRuleResult?.groups ?? [], rulesSatisfied: genericRuleResult?.passed ?? 0,
    rulesTotal: genericRuleResult?.total ?? 0, missingDocuments: rulesOut.missing, blockingFlags: blockingFlags.map((flag) => flag.type),
    evaluatedAt: new Date().toISOString(), frozenAt: frozenConfig?.frozen_at ?? null, configVersion: frozenConfig?.config_version ?? null,
  };
  repo.insertEvaluation({ applicant_id: applicant.id, set_id: null, case_type_code: genericCaseType?.code ?? null, system: null,
    set_version: report.configVersion, result: report.result, routing: report.routing, reason: report.reason, reason_code: report.reasonCode,
    detail: JSON.stringify(report), rule_snapshot: JSON.stringify(frozenConfig?.rules ?? []) });
  repo.updateApplicant(applicant.id, { req_result: report.result, routing: report.routing, routing_reason: report.reasonCode });

  // ── Gate v2 (features 11, 13, 21) ────────────────────────────────────────
  const activeBlockingFlags = repo
    .activeFlags(applicant.id)
    .filter((f) => f.type !== "duplicate_submission");
  // Numeric readability gate: every document must reach the auto-pass score.
  // (Legacy DBs without the score fall back to the tier — high ⇒ pass.)
  const allDocsHigh = activeDocs.every(
    (d) => (d.confidence_score ?? (d.confidence === "high" ? 100 : 0)) >= MIN_AUTO_PASS_SCORE
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
  if (classifierHold) {
    // Uncertain classification is never automated: a person decides the route
    // (a fallback label, or a model label below the confidence floor).
    queueForHuman = true;
    repo.audit(applicant.id, "system", "held_for_classification", `${classifierHold} — held for a person`);
    repo.notify("review_needed", `${applicantNow.ref_number}: classification was uncertain (${classifierHold})`, applicant.id);
  }
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
  //    follow-up ladder and audit codes are all rule data — the evidence
  //    gate still holds every reply that is not fully evidenced for staff
  //    whenever the case type has one (it is on by default). ────────────
  const fullyQualified =
    finalStatus === "Green" && activeBlockingFlags.length === 0 && allDocsHigh && !watcherFlagged;
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
        intakeSignals: verdict.category === "parked" ? "parked" : "open",
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
      // Intended to go out; the draft-first and evidence gates below
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
      const assignee = repo.getStaff(replyAction.assign);
      if (assignee) {
        repo.notify("assignment", `${applicantNow.ref_number} was assigned to you by rule “${replyRule.name}”`, applicant.id, assignee.id);
        repo.audit(applicant.id, "system", "case_assigned", `rule “${replyRule.name}” → ${assignee.display_name}`);
      }
    }
  } else if (scopedResponseRules.length > 0 || intakeRule !== null) {
    // Rule-driven profile with a gap in its reply rules: never guess, never
    // drop — a human reviews (invariant: failed/incomplete rule tree always
    // routes to human review).
    queueForHuman = true;
  } else if (humanTriageOnly) {
    // A screenshot attached to an eligibility question, complaint or fee
    // enquiry is evidence for the human reply, not a submission of the
    // intake document pack.
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
  //    drafted normally — it just gets queued instead of sent. A case type
  //    declares its own default (new case types default to draft — automation
  //    is opt-in per case type). ────────────────────────────────────────────
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

  // ── Evidence gate: automated mail only for a fully evidenced case ───────
  // Fully evidenced = Green verdict, no blocking flags, watcher clean. Every
  // other file — including a "clean" missing-document case — gets the reply
  // HELD as a staff suggestion instead: a contact who is short of a document
  // today may still be accepted tomorrow on an exception, so the machine never
  // speaks for the office on their behalf. A case type may switch this gate off
  // (its workflow rules then own the send decision); it is on by default.
  const typeGate = genericCaseType?.evidence_gate ?? 1;
  const evidenceGateOn = typeGate !== 0;
  const heldForQualification = replyAttempted && ((!fullyQualified && evidenceGateOn) || activeBlockingFlags.length > 0 || !allDocsHigh || watcherFlagged);
  if (heldForQualification) {
    repo.audit(
      applicant.id,
      "system",
      "automation_held_evidence",
      `verdict=${finalStatus} — the case is not fully evidenced, so the suggested reply is held for staff (an exception may still apply)`
    );
    queueForHuman = true;
  }

  const organizationId = applicantNow.organization_id ?? applicant.organization_id ?? 1;
  const caseTypeId = genericCaseType?.id;

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
    statusLabel: genericCaseType?.stages?.find((stage) => stage.id === lifecycleAfter)?.label ?? LIFECYCLE_LABELS[lifecycleAfter] ?? lifecycleAfter,
    readBack: readBackText(activeDocs),
    documentIssues: documentIssuesText(activeDocs),
  };

  const templateKey = ruleTemplateKey ?? (autoKind === "ack"
    ? "ack_received"
    : autoKind === "docs_request"
        ? "docs_request"
        : autoKind === "missing_docs"
          ? "missing_documents"
          : autoKind === "status_answer"
            ? "status_answer"
            : null);

  let missingTemplateKey: string | null = null;
  if (templateKey) {
    const tpl = repo.getTemplate(templateKey, organizationId, caseTypeId);
    if (tpl) {
      const rendered = renderTemplate(tpl.subject, tpl.body, draftCtx);
      draft = { subject: rendered.subject, body: rendered.body, audience: "auto", templateKey };
    } else {
      // A reply was chosen — by a rule or by the case's own state — but this
      // organization has no wording for it. That must never become silence and
      // never become a guess: the case goes to a human, the audit names the
      // missing key, and the queued draft explains what to do.
      missingTemplateKey = templateKey;
      queueForHuman = true;
      repo.audit(applicant.id, "system", "template_missing",
        `reply template '${templateKey}' does not exist for this organization — nothing was rendered; add it under Templates`);
      repo.notify("review_needed",
        `${applicantNow.ref_number}: reply template '${templateKey}' is missing — the reply could not be written`, applicant.id);
    }
  }
  // Uncertain classification is a hold in its own right: a person decides the
  // route before anything is sent on the strength of a guessed label.
  const heldForClassification = replyAttempted && classifierHold !== null;

  // Held replies keep their rendered content but are queued for a person.
  if ((heldForApproval || heldForQualification || heldForClassification) && draft) draft.audience = "human";

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
    const picked = pickQueuedDraft({
      finalStatus,
      watcherFlagged,
      flags: activeBlockingFlags.map((f) => ({ type: f.type, detail: f.detail })),
      applicantName: knownName ?? undefined,
      ref: applicantNow.ref_number,
    });
    draft = missingTemplateKey
      ? {
          ...picked,
          body: `INTERNAL — DO NOT AUTO-SEND.\nThe reply template '${missingTemplateKey}' does not exist for this organization, so nothing could be rendered. Create it under Templates, then write this reply by hand.\n\n${picked.body}`,
        }
      : picked;
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
        ?? "none";
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
      // An install with no mail connection records sends it cannot make. The
      // audit trail must not claim a delivery that never happened.
      if (adapters.sender.delivers === false) {
        repo.audit(applicant.id, "system", "email_not_delivered",
          `recorded only — no mail connection is configured, so "${draft.subject}" was NOT delivered to ${applicantNow.email_address}`);
        log(`pipeline: reply recorded but NOT delivered (no mail connection) for ${applicantNow.ref_number}`, "warn");
      }
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
    // A corrupt setting must not crash intake (NaN → Invalid Date → throw).
    const slaHours = replyAction?.sla_hours ?? envInt(repo.getSetting("sla_target_hours", "4"), 4);
    const due = new Date(Date.now() + slaHours * 3600_000).toISOString();
    const cur = repo.getApplicant(applicant.id)!;
    if (!cur.sla_handled_at) repo.updateApplicant(applicant.id, { sla_due_at: due });
    const reason = humanTriageOnly
      ? `${enquiryOnly ? "general enquiry" : category.replace(/_/g, " ")} — staff response required`
      : heldForQualification && !heldForApproval
      ? "case not fully evidenced — suggested reply held for staff (an exception may still apply)"
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
    // The kind the automation ATTEMPTED — even when the evidence gate
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


