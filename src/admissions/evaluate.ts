/**
 * /admissions/evaluate — orchestration: documents → values → rule trees →
 * routing.
 *
 * The three automated outcomes (and NOTHING else):
 *
 *   QUALIFIED              → AUTO-ADMIT          (audit: admission_auto_qualified)
 *   NOT CLEARLY QUALIFIED  → HUMAN REVIEW        (never an automatic rejection)
 *   INCOMPLETE             → WAITING FOR DOCUMENTS (missing ≠ failed)
 *
 * Eligibility (requirement result), routing and the admission DECISION are
 * separate concepts — see applicants.req_result / routing / admission_decision.
 */
import type { Repo } from "../db/repo";
import type {
  AdmissionRouting,
  AdmissionRuleSet,
  AdmissionSystem,
  ApplicantRow,
  DerivedFlag,
  DocumentRecord,
  EvaluationReport,
  ExtractedFields,
  RequirementResult,
} from "../types";
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
  const required = requirements.filter((r) => r.required);
  const missing = required.filter((r) => !docs.some((d) => d.document_type === r.document_type));
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

  // ── Step 2 — which qualification system(s) did the applicant present? ─────
  const academic = docs.filter((d) => d.document_type === "academic_cert");
  const identified: Array<{ doc: DocumentRecord; systems: AdmissionSystem[] }> = [];
  for (const doc of academic) {
    const fields = (doc.extracted_fields ?? {}) as ExtractedFields;
    const sys = fields.examSystem ? SYSTEM_ROUTE_MAP[String(fields.examSystem)] : undefined;
    if (sys && sys.length > 0) identified.push({ doc, systems: sys });
    else if (academic.length === 1) {
      // The certificate is there but the system could not be identified —
      // reliability problem → a human decides the route.
      derivedFlags.push({ type: "low_confidence", detail: "academic document: qualification system could not be identified — human must verify which entry route applies" });
      return persist("needs_verification", "human_review", "The qualification system on the certificate could not be identified. Academic result requires verification.", "system_unidentified", null);
    }
  }

  // ── Step 3 — the frozen requirement sets (goalposts never move). ──────────
  const frozen = repo.freezeAdmissionSets(repo.getApplicant(applicantId)!);
  base.frozenAt = frozen.length ? null : null; // freeze timestamp lives on the applicant row
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
      "passed", "auto_admit",
      tree.rulesTotal === 0
        ? `${SYSTEM_LABELS[set.system]} route recognised — this route has no automated minimum, so nothing further is required.`
        : `All configured admission requirements satisfied (${tree.rulesSatisfied}/${tree.rulesTotal} rules) and no blocking flags detected.`,
      "qualified", set
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

/** passed > failed > undetermined — pick the best route when several apply. */
function rankTree(t: TreeResult): number {
  return t.result === "passed" ? 2 : t.result === "failed" ? 1 : 0;
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
