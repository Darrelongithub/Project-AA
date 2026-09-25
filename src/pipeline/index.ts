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
import { evaluateAdmission, downgradeRoutingForWatcher } from "../admissions/evaluate";
import { SYSTEM_LABELS } from "../admissions/systems";
import { gate } from "../gate";
import { categorizeEmail, priorityForCategory } from "../categorize";
import { emailTargetsKnownApplicant } from "../matching";
import { DEFAULT_INTAKE_HOTWORDS, matchesIntakeHotwords } from "../intake";
import { extractPhone, inferIntake, inferProgramme, inferTransfer } from "../enrich";
import { checklistText, pickQueuedDraft, renderTemplate, type Draft, type DraftContext } from "../drafting";
import { writeDecisionLog } from "../logs";
import { INSTITUTION, emailBanner } from "../branding";
import { admissionPack, applicationPack } from "../pack";
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

  // ── Intake gate (round 9) ────────────────────────────────────────────────
  // Only admissions intake becomes a case: the mail carries an intake
  // hotword, or it targets an applicant we already know (quoted reference
  // number or known sender — conversation continuity). Everything else is
  // parked in the Mail window WITHOUT an applicant: kept, visible,
  // labelable — but no case number, no queue entry, no auto-reply.
  const intakeText = `${email.subject}\n${email.body}`;
  const hotwords = repo.getSetting("intake_hotwords", DEFAULT_INTAKE_HOTWORDS);
  if (!matchesIntakeHotwords(intakeText, hotwords) && !emailTargetsKnownApplicant(repo, email)) {
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
    repo.audit(
      null,
      "system",
      "email_parked_non_intake",
      `"${email.subject}" from ${email.from} — no intake hotword; kept in Mail, no case created`
    );
    log(`pipeline: "${email.subject}" parked — no intake hotword, sender not a known applicant`);
    return {
      skipped: true,
      applicantId: null,
      finalStatus: "Red",
      lifecycle: "application_received",
      autoSent: false,
      autoKind: null,
      category: "other",
      reasoning: "parked: no intake hotword matched and sender is not a known applicant",
      flags: [],
      missing: [],
    };
  }

  // ── Categorize (feature 26) ──────────────────────────────────────────────
  const category: EmailCategory = categorizeEmail(email.subject, email.body, email.attachments.length > 0);

  // ── Resolve/create applicant with reference number (features 1, 2) ──────
  // v3 identity matching: quoted reference number → known sender (any thread)
  // → new applicant. Low-confidence matches get an identity_check flag.
  const refPrefix = repo.getSetting("ref_prefix", "RU");
  const identity = resolveIdentity(repo, email, { refPrefix });
  const applicant = identity.applicant;
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
    email.attachments.length > 0 ||
    ["application", "document_submission", "complaint", "missing_document"].includes(category);
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
  // changes never retroactively move an applicant's goalposts.
  const applicantNow = repo.getApplicant(applicant.id)!;
  repo.freezeRequirementsSnapshot(applicantNow);
  repo.freezeStructuredSnapshot(applicantNow);
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

  // ── Admissions rules engine (round 18) ───────────────────────────────────
  // Structured evaluation of the applicant's academic data against the
  // frozen requirement trees, then routing: QUALIFIED → auto-admit path,
  // NOT CLEARLY QUALIFIED → human review (never rejection), INCOMPLETE →
  // waiting for documents. The engine's own flags feed the classic verdict.
  const admission = evaluateAdmission(repo, applicant.id, preFlags);
  preFlags.push(...admission.derivedFlags);

  // ── Rules: pure deterministic decision (feature 10) ─────────────────────
  const rulesOut = decide({ requirements, docs: activeDocs, flags: preFlags });

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

  // Persist flags (blocking + informational duplicates).
  const blockingFlags = [...preFlags, ...rulesOut.derivedFlags, ...watcherFlags];
  repo.syncFlags(applicant.id, [...blockingFlags, ...duplicateFlags]);
  repo.audit(applicant.id, "system", "requirements_checked", `verdict=${finalStatus}; missing=${rulesOut.missing.join(",") || "none"}`);

  // A watcher downgrade after a passing evaluation withholds the auto-admit.
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
    finalStatus === "Red" &&
    rulesOut.missing.length > 0 &&
    activeBlockingFlags.length === 0 &&
    allDocsHigh &&
    !watcherFlagged;

  let autoKind: ProcessResult["autoKind"] = null;
  let draft: Draft | null = null;
  let queueForHuman = false;

  const gateDecision = gate(finalStatus, { ran: rulesOut.status === "Green", flagged: watcherFlagged });

  const refOnlyOwnCase =
    email.attachments.length === 0 &&
    /^[A-Z]{1,6}-\d{4}-\d{1,8}$/i.test(email.body.trim()) &&
    email.body.trim().toUpperCase() === applicantNow.ref_number.toUpperCase() &&
    email.from.trim().toLowerCase() === applicantNow.email_address;

  // The applicant emailed just their reference number ("RU-2026-000003") —
  // answer with the factual status of their own case. Only when the sender IS
  // the case owner; a stranger quoting someone's ref goes to a human.
  if (opts.autoStatusAnswers && refOnlyOwnCase) {
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
  //    drafted normally — it just gets queued instead of sent. ─────────────
  const heldForApproval = autoKind !== null && repo.automationMode(category) === "draft";
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
  const fullyQualified =
    finalStatus === "Green" && activeBlockingFlags.length === 0 && !watcherFlagged;
  const heldForQualification = autoKind !== null && !fullyQualified;
  if (heldForQualification) {
    repo.audit(
      applicant.id,
      "system",
      "automation_held_qualification",
      `verdict=${finalStatus} — not fully qualified, so the suggested reply is held for staff (special acceptance may apply)`
    );
    queueForHuman = true;
  }

  // ── Auto-admission (round 18) ────────────────────────────────────────────
  // QUALIFIED with no blocking issues → the system progresses the file itself
  // and sends the official admission letter. Draft-first mode holds even this
  // for a human; the evaluation stays intact and is re-applied on next mail.
  const admissionRow = repo.getApplicant(applicant.id)!;
  const willAutoAdmit =
    admission.report.routing === "auto_admit" &&
    admissionRow.admission_decision === "undecided" &&
    fullyQualified &&
    !heldForApproval &&
    activeDocs.length > 0;
  if (willAutoAdmit) {
    const rep = admission.report;
    repo.updateApplicant(applicant.id, {
      admission_decision: "auto_admitted",
      admission_route: "automated",
      decision_by: "system",
      decision_reason: "All configured requirements satisfied",
      decision_at: new Date().toISOString(),
    });
    const values = rep.leaves.map((l) => `${l.label}=${l.applicantValue ?? "?"}`).join(", ");
    repo.audit(applicant.id, "system", "auto_admission_triggered",
      `set v${rep.setVersion ?? "?"} (${rep.system ?? "?"}): ${values} · evaluated ${rep.evaluatedAt} · route: automated`);
    repo.audit(applicant.id, "system", "admission_auto_qualified",
      `Admission method: Automated · Reason: All configured requirements satisfied (${rep.rulesSatisfied}/${rep.rulesTotal} rules)`);
    repo.notify("auto_admission",
      `${admissionRow.ref_number} auto-admitted — ${rep.system ? SYSTEM_LABELS[rep.system] : rep.system} route, all requirements satisfied`,
      applicant.id);
    log(`pipeline: ${admissionRow.ref_number} AUTO-ADMITTED (${rep.system ?? "?"} route)`);
  }

  // ── Drafting (features 14, 35) ──────────────────────────────────────────
  const institution = INSTITUTION;
  const requiredReqs = requirements.filter((r) => r.required);
  const presentTypes = activeDocs.map((d) => d.document_type);
  const missingLabels = rulesOut.missing.map((m) => docLabel(m));
  const knownName =
    activeDocs
      .map((d) => normalizeName(d.extracted_fields?.name as string | undefined))
      .find((n) => n.length >= 3) || freshApplicant.full_name || email.fromName;
  const lifecycleAfter: LifecycleStage = willAutoAdmit
    ? "completed"
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

  // Auto-admitted applicants get the official admission letter (with the full
  // admission pack attached) instead of the plain acknowledgement.
  const templateKey = willAutoAdmit
    ? "admission_letter"
    : autoKind === "ack"
      ? "ack_received"
      : autoKind === "docs_request"
        ? "docs_request"
        : autoKind === "missing_docs"
          ? "missing_documents"
          : autoKind === "status_answer"
            ? "status_answer"
            : null;

  if (templateKey) {
    const tpl = repo.getTemplate(templateKey);
    if (tpl) {
      const rendered = renderTemplate(tpl.subject, tpl.body, draftCtx);
      draft = { subject: rendered.subject, body: rendered.body, audience: "auto", templateKey };
    }
  }
  // Held replies keep their rendered content but are queued for a person.
  if ((heldForApproval || heldForQualification) && draft) draft.audience = "human";

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
  const wantsAutoSend = autoKind !== null && draft?.audience === "auto";
  if (wantsAutoSend && draft) {
    try {
      // OR-7: which pack (if any) rides along is a property of the TEMPLATE,
      // edited in the Templates section — the pipeline no longer hardcodes
      // it, so what staff configure is exactly what applicants receive.
      // Defaults keep the historical behaviour (enquiry → application pack,
      // auto-admit → full admission pack).
      const tplRow = templateKey ? repo.getTemplate(templateKey) : undefined;
      const packFlag = tplRow?.attach_pack
        ?? (willAutoAdmit ? "admission" : autoKind === "docs_request" ? "application" : "none");
      const pack = packFlag === "admission" ? admissionPack() : packFlag === "application" ? applicationPack() : null;
      const extras: SendExtras = {
        banner: tplRow?.include_banner === 0 ? null : emailBanner(repo),
        attachments: pack ? pack.files : [],
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
      repo.audit(applicant.id, "system", "email_sent_auto", `${autoKind}: "${draft.subject}"`);
      log(`pipeline: auto-sent [${autoKind}] to ${applicantNow.email_address}`);
      autoSent = true;
    } catch (e) {
      repo.audit(applicant.id, "system", "send_failed", `auto-send [${autoKind}] failed: ${(e as Error).message}`);
      repo.addOutbox({
        applicant_id: applicant.id,
        to_address: applicantNow.email_address,
        subject: draft.subject,
        body: draft.body,
        mode: "queued",
        template_key: draft.templateKey ?? "",
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
    (autoSent || heldForQualification || heldForApproval) &&
    (autoKind === "missing_docs" || autoKind === "docs_request") &&
    ladder.length > 0
  ) {
    // Base date anchors the ladder: rung N fires at base + ladder[N] days.
    const baseAt = new Date().toISOString();
    const nextAt = new Date(Date.now() + ladder[0] * 24 * 3600_000).toISOString();
    repo.setFollowup(applicant.id, 0, nextAt, baseAt);
    repo.audit(applicant.id, "system", "followup_scheduled", `reminder ladder armed (${ladderDaysStr})`);
  }

  if (queueForHuman) {
    // SLA clock starts (feature 28); staff action stops it.
    const slaHours = Number(repo.getSetting("sla_target_hours", "4"));
    const due = new Date(Date.now() + slaHours * 3600_000).toISOString();
    const cur = repo.getApplicant(applicant.id)!;
    if (!cur.sla_handled_at) repo.updateApplicant(applicant.id, { sla_due_at: due });
    const reason = heldForQualification && !heldForApproval
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
    const why = willAutoAdmit
      ? "auto-admitted: all configured requirements satisfied"
      : autoKind === "ack"
        ? "all required documents verified automatically"
        : lifecycleAfter === "awaiting_review"
          ? "queued for human review"
          : lifecycleAfter === "documents_received"
            ? "documents received; file not yet complete"
            : lifecycleAfter === "completed"
              ? "completed"
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


