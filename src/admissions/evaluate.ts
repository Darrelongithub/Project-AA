/**
 * /admissions/evaluate — orchestration: documents → values → rule trees →
 * routing.
 *
 * The automated evaluation outcomes are evidence and routing guidance only:
 *
 *   QUALIFIED              → HUMAN REVIEW        (never a final admission)
 *   NOT CLEARLY QUALIFIED  → HUMAN REVIEW        (never an automatic rejection)
 *   INCOMPLETE             → WAITING FOR DOCUMENTS (missing ≠ failed)
 *
 * Eligibility (requirement result), routing and the admission DECISION are
 * separate concepts — see applicants.req_result / routing / admission_decision.
 * A human must confirm every final admission outcome.
 */
import type { Repo } from "../db/repo";
import type {
  AdmissionRouting,
  AdmissionRuleSet,
  AdmissionSystem,
  DerivedFlag,
  DocumentRecord,
  EvaluationReport,
  ExtractedFields,
  RequirementResult,
} from "../types";
import { fillSlots } from "../documents/matrix";
import { docLabel } from "../rules";
import { MIN_AUTO_PASS_SCORE } from "../extraction/extract";
import { evaluateTree, readerFromFields, describeRuleTree } from "./engine";
import { SYSTEM_LABELS } from "./systems";
import type { TreeResult } from "./engine";

/** Extraction detected on a document → the admission systems it may satisfy. */
const SYSTEM_ROUTE_MAP: Record<string, AdmissionSystem[]> = {
  KCSE: ["KCSE"],
  IGCSE: ["IGCSE"],
  IB: ["IB"],
  ALEVEL: ["ALEVEL", "KACE"],
  DIPLOMA: ["DIPLOMA"],
  DEGREE: ["DEGREE"],
};

export interface AdmissionEvaluation {
  report: EvaluationReport;
  /** Flags derived from the evaluation itself (feed syncFlags). */
  derivedFlags: DerivedFlag[];
}

const nowIso = () => new Date().toISOString();

/** OR-5: concrete academic checklist types + the generic fallback family.
 * Grades ride on whichever of these carries extracted fields. */
const ACADEMIC_FAMILY = new Set([
  "academic_cert",
  "exam_result_slip",
  "leaving_certificate",
  "undergraduate_transcript",
  "undergraduate_degree_certificate",
  "masters_transcript",
  "masters_degree_certificate",
  "kcpe_cert",
]);

function docReliable(d: DocumentRecord): boolean {
  const score = d.confidence_score || (d.confidence === "high" ? 100 : 0);
  return score >= MIN_AUTO_PASS_SCORE;
}

function flattenNodes(set: AdmissionRuleSet): { nodes: AdmissionRuleSet["nodes"] & object; } {
  return { nodes: set.nodes ?? [] };
}

/**
 * Evaluate one applicant against their frozen requirement sets.
 *
 * @param extraFlags flags already raised on this pass (late submission,
 *        identity concerns, watcher…) — they block auto-admission even when
 *        every academic rule passes.
 */
export function evaluateAdmission(
  repo: Repo,
  applicantId: number,
  extraFlags: Array<{ type: string; detail: string }> = []
): AdmissionEvaluation {
  const a = repo.getApplicant(applicantId)!;
  const docs = repo.listDocuments(applicantId, { activeOnly: true });
  const derivedFlags: DerivedFlag[] = [];

  const base = {
    evaluatedAt: nowIso(),
    frozenAt: null as string | null,
    system: null as AdmissionSystem | null,
    setId: null as number | null,
    setVersion: null as number | null,
    leaves: [] as EvaluationReport["leaves"],
    groups: [] as EvaluationReport["groups"],
    rulesSatisfied: 0,
    rulesTotal: 0,
    missingDocuments: [] as string[],
    blockingFlags: [] as string[],
  };

  const persist = (result: RequirementResult, routing: AdmissionRouting, reason: string, reasonCode: string, usedSet: AdmissionRuleSet | null, extra: Partial<EvaluationReport> = {}): AdmissionEvaluation => {
    const report: EvaluationReport = {
      result, routing, reason, reasonCode,
      system: usedSet?.system ?? base.system,
      setId: usedSet?.id ?? base.setId,
      setVersion: usedSet?.version ?? base.setVersion,
      leaves: extra.leaves ?? base.leaves,
      groups: extra.groups ?? base.groups,
      rulesSatisfied: extra.rulesSatisfied ?? base.rulesSatisfied,
      rulesTotal: extra.rulesTotal ?? base.rulesTotal,
      missingDocuments: extra.missingDocuments ?? base.missingDocuments,
      blockingFlags: extra.blockingFlags ?? base.blockingFlags,
      evaluatedAt: base.evaluatedAt,
      frozenAt: base.frozenAt,
    };
    repo.insertEvaluation({
      applicant_id: applicantId,
      set_id: usedSet?.id ?? null,
      programme: a.programme,
      system: usedSet?.system ?? base.system,
      set_version: usedSet?.version ?? null,
      result, routing, reason, reason_code: reasonCode,
      detail: JSON.stringify(report),
      rule_snapshot: JSON.stringify(usedSet ? flattenNodes(usedSet) : []),
    });
    repo.updateApplicant(applicantId, { req_result: result, routing, routing_reason: reasonCode });
    const event = result === "passed" ? "requirements_passed" : result === "failed" ? "requirements_failed" : "requirements_evaluated";
    repo.audit(applicantId, "system", event, `result=${result} routing=${routing}${reasonCode ? ` (${reasonCode})` : ""} — ${reason.slice(0, 200)}`);
    if (routing === "human_review") {
      repo.audit(applicantId, "system", "human_review_triggered", reason.slice(0, 200));
    }
    return { report, derivedFlags };
  };

  // ── Step 1 — DOCUMENT CHECK. Missing data is never interpreted as failure. ─
  const requirements = repo.effectiveRequirements(a);
  // OR-5 slot semantics: one document fills exactly one slot.
  const { missing } = fillSlots(requirements, docs.map((d) => d.document_type));
  if (missing.length > 0) {
    const missingLabels = missing.map((m) => docLabel(m.document_type));
    const code = docs.length > 0 ? "partial_submission" : "missing_documents";
    return persist(
      "missing_data",
      "waiting_documents",
      `Waiting for documents: ${missingLabels.join(", ")}. Missing information is never treated as failure.`,
      code,
      null,
      { missingDocuments: missingLabels }
    );
  }

  // ── Step 1b — the course must be known. E3: the degree-level defaults are
  // NOT a fallback — an unknown or never-inferred programme is judged against
  // NO ladder, and the (wrong) degree goalposts are never frozen as the
  // applicant's. A human sets the course, then the engine re-runs.
  const programmeKnown = a.programme ? repo.programmeByCode(a.programme) : undefined;
  if (!programmeKnown) {
    derivedFlags.push({
      type: "low_confidence",
      detail: "applicant's programme is not identified — no course- or level-specific requirements may be applied; a human must set the course first",
    });
    return persist(
      "needs_verification", "human_review",
      "The applicant's programme has not been identified, so no course-specific (or level-specific) requirements can be applied. Set the course, then re-evaluate.",
      "programme_unidentified", null
    );
  }

  // ── Step 2 — which qualification system(s) did the applicant present? ─────
  // OR-5: academic paperwork now arrives under concrete checklist types
  // (result slip, leaving certificate, transcripts…) as well as the generic
  // academic_cert fallback. Grades ride on whichever of them carries fields.
  // E5: only the GENERIC academic_cert is "could be anything" — an
  // unidentified generic certificate is a potential conflicting route, so it
  // withholds auto-admission. Specifically-typed companions (the KCPE
  // certificate, a degree certificate, a transcript…) are checklist items,
  // not entry routes, and their unreadability surfaces through the
  // document-level confidence machinery instead.
  const academic = docs.filter((d) => ACADEMIC_FAMILY.has(d.document_type));
  const identified: Array<{ doc: DocumentRecord; systems: AdmissionSystem[] }> = [];
  const unidentifiedGeneric: DocumentRecord[] = [];
  for (const doc of academic) {
    const fields = (doc.extracted_fields ?? {}) as ExtractedFields;
    const sys = fields.examSystem ? SYSTEM_ROUTE_MAP[String(fields.examSystem)] : undefined;
    if (sys && sys.length > 0) identified.push({ doc, systems: sys });
    else if (doc.document_type === "academic_cert") unidentifiedGeneric.push(doc);
    else if (academic.length === 1) {
      // The certificate is there but the system could not be identified —
      // reliability problem → a human decides the route.
      derivedFlags.push({ type: "low_confidence", detail: "academic document: qualification system could not be identified — human must verify which entry route applies" });
      return persist("needs_verification", "human_review", "The qualification system on the certificate could not be identified. Academic result requires verification.", "system_unidentified", null);
    }
  }
  // E5 (mixed case): a route IS identified, but a generic certificate with no
  // identifiable system is also in the file. It may be the applicant's real
  // qualification (extraction failed) or a conflicting second certificate —
  // either way auto-admission is withheld for a human to check.
  let withholdAuto: { reason: string; code: string } | null = null;
  if (unidentifiedGeneric.length > 0 && identified.length > 0) {
    const labels = [...new Set(unidentifiedGeneric.map((d) => docLabel(d.document_type)))].join(", ");
    derivedFlags.push({
      type: "low_confidence",
      detail: `certificate(s) with no identifiable qualification system (${labels}) — the identified route may not be the applicant's; a human should verify before admission`,
    });
    withholdAuto = {
      reason: `One or more certificates carry no identifiable qualification system (${labels}). The identified route may not be the applicant's — verify before admission.`,
      code: "system_unidentified_partial",
    };
  }

  // ── Step 3 — the frozen requirement sets (goalposts never move). ──────────
  const frozen = repo.freezeAdmissionSets(repo.getApplicant(applicantId)!);
  // E1: the real freeze time, recorded on the applicant row at first freeze
  // (COALESCE keeps the FIRST freeze if the snapshot is ever re-written).
  base.frozenAt = repo.getApplicant(applicantId)!.admission_rules_frozen_at ?? null;
  const candidateSets: AdmissionRuleSet[] = [];
  for (const { systems } of identified) {
    for (const s of systems) {
      const set = frozen.find((f) => f.system === s);
      if (set && !candidateSets.some((c) => c.id === set.id)) candidateSets.push(set);
    }
  }
  if (candidateSets.length === 0) {
    const presented = [...new Set(identified.flatMap((i) => i.systems))];
    const noAcademic = academic.length === 0;
    if (noAcademic || presented.length === 0) {
      derivedFlags.push({ type: "low_confidence", detail: "academic document: qualification system could not be identified — human must verify which entry route applies" });
      return persist("needs_verification", "human_review", "The qualification system could not be identified. Academic result requires verification.", "system_unidentified", null);
    }
    const label = presented.map((s) => SYSTEM_LABELS[s]).join(" / ");
    derivedFlags.push({ type: "alternative_qualification", detail: `${label} presented, but no such route is configured for this course — human must assess this entry route` });
    return persist("needs_verification", "human_review", `${label} presented, but no matching requirement route is configured for this course. Human review required.`, "no_route", null);
  }

  // ── Step 4 — DATA CONFIDENCE + RULE EVALUATION per route. ─────────────────
  let best: { set: AdmissionRuleSet; tree: TreeResult; reliable: boolean } | null = null;
  for (const set of candidateSets) {
    const doc = identified.find((i) => i.systems.includes(set.system))!.doc;
    const fields = (doc.extracted_fields ?? {}) as ExtractedFields;
    const reliable = docReliable(doc);
    const tree = evaluateTree(set.nodes ?? [], set.system, readerFromFields(fields, reliable));
    if (!best || rankTree(tree) > rankTree(best.tree)) best = { set, tree, reliable };
  }
  const { set, tree, reliable } = best!;
  base.system = set.system;
  base.setId = set.id;
  base.setVersion = set.version;
  base.leaves = tree.leaves;
  base.groups = tree.groups;
  base.rulesSatisfied = tree.rulesSatisfied;
  base.rulesTotal = tree.rulesTotal;

  // Flags derived from leaf outcomes (feed the existing flag machinery) — but
  // ONLY for leaves that actually decided the outcome. An unchecked OR
  // alternative (tree already passed through another subject) or a failed
  // child inside a satisfied NOT group raises nothing.
  const sysLabel = SYSTEM_LABELS[set.system];
  if (tree.result === "failed") {
    for (const leaf of tree.leaves.filter((l) => l.status === "failed")) {
      derivedFlags.push({
        type: "grade_below_requirement",
        detail: `${sysLabel}: ${leaf.label} ${leaf.applicantValue ?? ""} is below the required ${leaf.required} — human must review`,
      });
    }
  } else if (tree.result === "undetermined") {
    for (const leaf of tree.leaves.filter((l) => l.status === "undetermined")) {
      derivedFlags.push({
        type: "low_confidence",
        detail: leaf.cause === "low_confidence"
          ? `${sysLabel}: ${leaf.label} could not be read with sufficient confidence (rule expects ${leaf.required}) — academic result requires verification`
          : `${sysLabel}: ${leaf.label} could not be read from the document (rule expects ${leaf.required}) — human must verify`,
      });
    }
  }

  // ── Step 5 — ROUTING. Blocking flags are evaluated independently of
  //    academic eligibility: qualified + late submission = human review. ────
  const blocking = extraFlags.filter((f) => f.type !== "duplicate_submission");
  const blockingTypes = [...new Set(blocking.map((f) => f.type))];
  base.blockingFlags = blockingTypes;

  if (tree.result === "passed" && !reliable) {
    return persist(
      "needs_verification", "human_review",
      "Academic result requires verification — extraction confidence is below the auto-pass threshold.",
      "low_confidence_extraction", set
    );
  }

  if (tree.result === "passed") {
    // E2: a tree with ZERO conditions "passes" vacuously — that is not
    // qualification. An empty route (a misconfigured seed, or a staff edit
    // that deleted every condition) must never auto-admit: a human confirms
    // the route, and restores the rule set if it was emptied by mistake.
    if (tree.rulesTotal === 0) {
      derivedFlags.push({
        type: "low_confidence",
        detail: `the ${sysLabel} route's rule set contains no conditions — zero academic checks were performed; auto-admission withheld until a human confirms the route`,
      });
      return persist(
        "needs_verification", "human_review",
        `The ${sysLabel} route has no configured conditions, so nothing was checked. Auto-admission is withheld: a human must confirm the route — and restore the rule set if it was emptied by mistake.`,
        "empty_rule_set", set
      );
    }
    // E5: an unidentified generic certificate in the file withholds
    // auto-admission even though the identified route passed every rule.
    if (withholdAuto) {
      return persist("passed", "human_review", `${withholdAuto.reason} Auto-admission withheld.`, withholdAuto.code, set);
    }
    if (blocking.length > 0) {
      const label = blockingTypes.map((t) => t.replace(/_/g, " ")).join(", ");
      return persist(
        "passed", "human_review",
        `Applicant satisfies all academic requirements (${tree.rulesSatisfied}/${tree.rulesTotal} rules) but has a blocking flag requiring human decision: ${label}.`,
        blockingTypes.includes("late_submission") ? "late_submission" : "manual_decision_required",
        set
      );
    }
    return persist(
      "passed", "human_review",
      `All configured admission requirements satisfied (${tree.rulesSatisfied}/${tree.rulesTotal} rules). Human confirmation is still required; the system never makes the final admission decision.`,
      "qualified_human_review", set
    );
  }

  if (tree.result === "failed") {
    const failed = tree.leaves.filter((l) => l.status === "failed");
    const lines = failed.map((l) => `${l.label}: ${l.applicantValue ?? "—"} — required ${l.required}`).join("; ");
    return persist(
      "failed", "human_review",
      `Applicant does not meet the standard published requirements (${lines}). Human review required — special consideration or an alternative route may apply.`,
      "requirement_not_satisfied", set
    );
  }

  // Undetermined — data gap. Missing extraction with a readable document is a
  // verification problem; low confidence is flagged above.
  const cause = tree.causes.includes("low_confidence") ? "low_confidence_extraction" : "missing_result";
  return persist(
    "needs_verification", "human_review",
    cause === "low_confidence_extraction"
      ? "Academic result requires verification — extraction confidence is below the auto-pass threshold."
      : "A required academic value could not be read from the documents. Human review required.",
    cause, set
  );
}

/** passed > undetermined > failed — pick the best route when several apply.
 *  E4: an UNREAD route outranks a confirmed failure on another route. The
 *  undetermined route may be the applicant's real qualification system that
 *  simply could not be read — the honest label is "needs verification", not
 *  "does not meet requirements". */
function rankTree(t: TreeResult): number {
  return t.result === "passed" ? 3 : t.result === "undetermined" ? 2 : 1;
}

/**
 * Downgrade a provisional auto-admit when the watcher later flags the record
 * (watcher runs after evaluation). Idempotent.
 */
export function downgradeRoutingForWatcher(repo: Repo, applicantId: number): void {
  const a = repo.getApplicant(applicantId);
  if (!a || a.routing !== "auto_admit") return;
  repo.updateApplicant(applicantId, { routing: "human_review", routing_reason: "manual_decision_required" });
  repo.audit(applicantId, "system", "human_review_triggered", "watcher flagged the record after the requirements engine passed it — auto-admission withheld");
}

/** Human-readable one-liner for a stored set (configuration preview). */
export function describeSet(set: AdmissionRuleSet): string {
  return describeRuleTree(set.nodes ?? []);
}
