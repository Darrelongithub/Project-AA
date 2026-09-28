/**
 * Pipeline stages 6-14: evaluation — extraction, persistence, consistency,
 * enrichment, requirements, deadline watch, case-type rules, rules decision,
 * and watcher.
 *
 * Stage bodies are the verbatim code of the original `processEmailInner`;
 * each wrapper takes one typed input and returns one typed result.
 */
import { extractAttachment, MIN_AUTO_PASS_SCORE } from "../../extraction/extract";
import { recordDocuments } from "../../matching";
import { consistencyCheck } from "../../extraction/crosscheck";
import { internalNote } from "../../extraction/feedback";
import { decide, normalizeName } from "../../rules";
import { inferIntake, inferProgramme, inferTransfer } from "../../enrich";
import { downgradeRoutingForWatcher, evaluateAdmission, evaluateCaseTypeRules } from "../../admissions/evaluate";
import { caseTypeGate } from "../../gate";
import { fillSlots } from "../../documents/matrix";
import { log } from "../../util/log";
import type { Classification, DerivedFlag, WatcherInput } from "../../types";
import type {
  ExtractStageInput,
  ExtractStageResult,
  PersistStageInput,
  PersistStageResult,
  ConsistencyStageInput,
  ConsistencyStageResult,
  EnrichStageInput,
  RequirementsStageInput,
  RequirementsStageResult,
  DeadlineStageInput,
  DeadlineStageResult,
  CaseTypeStageInput,
  CaseTypeStageResult,
  RulesStageInput,
  RulesStageResult,
  WatcherStageInput,
  WatcherStageResult,
} from "./types";

/** Stage 6 — extract attachments. */
export async function runExtractStage(input: ExtractStageInput): Promise<ExtractStageResult> {
  const { ctx, email, applicant, genericCaseType, educationCase } = input;
  const { repo, adapters } = ctx;
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
      // Exact key/label wins; otherwise the slot sharing the MOST words (not
      // merely the first slot sharing any word — "agreement" must not route
      // an NDA into the services-agreement slot).
      const definitions = repo.listDocumentDefinitions(genericCaseType.id);
      const exact = definitions.find((d) => haystack.includes(d.key.toLowerCase()) || haystack.includes(d.label.toLowerCase()));
      let configured = exact;
      if (!configured) {
        let best = 0;
        for (const d of definitions) {
          const words = [...new Set(`${d.key} ${d.label}`.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2))];
          const hits = words.filter((word) => haystack.includes(word)).length;
          if (hits > best) { best = hits; configured = d; }
        }
      }
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
  return {
    extractions,
    duplicateFlags,
  };
}

/** Stage 7 — persist the accepted documents. */
export function runPersistStage(input: PersistStageInput): PersistStageResult {
  const { ctx, email, applicant, extractions } = input;
  const { repo } = ctx;
  // ── Persist docs + supersede corrections (features 4, 9) ────────────────
  recordDocuments(repo, applicant.id, email, extractions);
  let activeDocs = repo.listDocuments(applicant.id, { activeOnly: true });
  return {
    activeDocs,
  };
}

/** Stage 8 — cross-document consistency. */
export function runConsistencyStage(input: ConsistencyStageInput): ConsistencyStageResult {
  const { ctx, applicant, preFlags } = input;
  let activeDocs = input.activeDocs;
  const { repo } = ctx;
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
  return {
    activeDocs,
    preFlags,
  };
}

/** Stage 9 — enrichment. */
export function runEnrichStage(input: EnrichStageInput): void {
  const { ctx, email, applicant, activeDocs } = input;
  const { repo } = ctx;
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
}

/** Stage 10 — requirements snapshot. */
export function runRequirementsStage(input: RequirementsStageInput): RequirementsStageResult {
  const { ctx, applicant, educationCase } = input;
  const { repo } = ctx;
  // ── Requirements for THIS applicant (features 8, 36, 37, v3-19) ──────────
  // First triage freezes a snapshot of the requirement set; later rule
  // changes never retroactively move an applicant's goalposts. PPR P0-3
  // adds the exact profile configuration version to that freeze.
  const applicantNow = repo.getApplicant(applicant.id)!;
  repo.freezeRequirementsSnapshot(applicantNow);
  repo.freezeCaseConfig(applicantNow);
  if (educationCase) repo.freezeStructuredSnapshot(applicantNow);
  const requirements = repo.effectiveRequirements(repo.getApplicant(applicant.id)!);
  return {
    applicantNow,
    requirements,
  };
}

/** Stage 11 — deadline / staleness watch. */
export function runDeadlineStage(input: DeadlineStageInput): DeadlineStageResult {
  const { ctx, email, applicant, applicantNow, preFlags } = input;
  const { repo } = ctx;
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
  return {
    preFlags,
  };
}

/** Stage 12 — case-type rule engine. */
export function runCaseTypeStage(input: CaseTypeStageInput): CaseTypeStageResult {
  const { ctx, email, applicant, genericCaseType, educationCase, activeDocs, requirements, preFlags, autoAdmitEligible } = input;
  const { repo } = ctx;
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
    // Organization-defined facts: "Label: value" lines in the documents and
    // the message body become snake_case facts (lower-cased values) for the
    // CaseType rule tree. Extracted fields win; nothing academic is read.
    for (const text of [...activeDocs.map((d) => d.extracted_text ?? ""), email.body]) {
      for (const m of text.matchAll(/^[ \t]*([A-Za-z][A-Za-z0-9 _/-]{1,40}?)[ \t]*:[ \t]*(.+?)[ \t]*$/gm)) {
        const key = m[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
        const value = m[2].trim().toLowerCase().replace(/[,](?=\d{3}\b)/g, "");
        if (key && !(key in facts)) facts[key] = value;
      }
    }
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
  // M-3: a profile with the legacy auto-admit opt-in lets the evaluator record
  // the PROVISIONAL auto_admit route; the decision + letter below still wait
  // for the watcher, the blocking flags, the qualification gate and draft mode.
  const admission = genericRuleResult || !educationCase
    ? { derivedFlags: [] as DerivedFlag[] }
    : evaluateAdmission(repo, applicant.id, preFlags, { autoAdmit: autoAdmitEligible });
  preFlags.push(...admission.derivedFlags);
  return {
    genericRuleResult,
    preFlags,
  };
}

/** Stage 13 — rules decision. */
export function runRulesStage(input: RulesStageInput): RulesStageResult {
  const { genericRuleResult, educationCase, requirements, activeDocs, preFlags } = input;
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
  return {
    rulesOut,
  };
}

/** Stage 14 — watcher. */
export async function runWatcherStage(input: WatcherStageInput): Promise<WatcherStageResult> {
  const { ctx, email, applicant, applicantNow, category, enquiryOnly, humanTriageOnly, rulesOut, activeDocs, preFlags, duplicateFlags } = input;
  const { repo, adapters } = ctx;
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
  return {
    finalStatus,
    reasoning,
    watcherFlagged,
  };
}
