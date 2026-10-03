/** Re-evaluation records evidence only. It never sends a message or changes a case outcome. */
import type { Repo } from "../db/repo";
import type { EvaluationReport } from "../types";
import { extractGenericFacts } from "../extraction/fields";
import { evaluateCaseTypeRules } from "./caseType";
import { decide } from "./index";

export function evaluateStoredCase(repo: Repo, id: number): EvaluationReport {
  const current = repo.getCase(id);
  if (!current) throw new Error("Unknown case");
  repo.freezeCaseConfig(current);
  const row = repo.getCase(id)!;
  repo.freezeRequirementsSnapshot(row);
  const frozen = repo.caseConfigFrozen(row);
  const type = repo.caseTypeForCase(id);
  const docs = repo.listDocuments(id, { activeOnly: true });
  const last = repo.emailsForApplicant(id).filter((email) => email.direction === "in").at(-1);
  const facts: Record<string, unknown> = { subject: last?.subject ?? "", body: last?.body ?? "", has_attachments: docs.length > 0 };
  for (const doc of docs) if ((doc.confidence_score ?? (doc.confidence === "high" ? 100 : 0)) >= 75 && doc.extraction_method !== "none") {
    for (const [key, value] of Object.entries(doc.extracted_fields)) if (!["__proto__", "prototype", "constructor"].includes(key)) facts[key] = value;
  }
  for (const [key, value] of Object.entries(extractGenericFacts(last?.body ?? ""))) if (!Object.hasOwn(facts, key)) facts[key] = value;
  const tree = type ? evaluateCaseTypeRules(repo, type, frozen?.rules ?? repo.caseTypeRules(type), facts) : undefined;
  const persistent = repo.activeFlags(id).filter((flag) => ["identity_check", "late_submission", "anomaly", "watcher_flag"].includes(flag.type));
  const triage = decide({ requirements: repo.effectiveRequirements(repo.getCase(id)!), docs, flags: persistent });
  const result = triage.missing.length ? "missing_data" : tree?.result === "failed" ? "failed" : tree?.result !== "passed" || triage.status !== "Green" ? "needs_verification" : "passed";
  const report: EvaluationReport = { result, routing: triage.missing.length ? "waiting_documents" : "human_review", reason: `${triage.reasoning}\nCaseType rule tree: ${tree?.result ?? "unconfigured"}. A person confirms the outcome.`, reasonCode: triage.missing.length ? "missing_documents" : result === "passed" ? "ready_for_review" : "verification_required", leaves: tree?.leaves ?? [], groups: tree?.groups ?? [], rulesSatisfied: tree?.passed ?? 0, rulesTotal: tree?.total ?? 0, missingDocuments: triage.missing, blockingFlags: [...persistent, ...triage.derivedFlags].map((flag) => flag.type), evaluatedAt: new Date().toISOString(), frozenAt: frozen?.frozen_at ?? null, configVersion: frozen?.config_version ?? null };
  repo.db.transaction(() => {
    repo.insertEvaluation({ applicant_id: id, set_id: null, case_type_code: type?.code ?? null, system: null, set_version: report.configVersion, result, routing: report.routing, reason: report.reason, reason_code: report.reasonCode, detail: JSON.stringify(report), rule_snapshot: JSON.stringify(frozen?.rules ?? []) });
    repo.updateApplicant(id, { req_result: result, routing: report.routing, routing_reason: report.reasonCode, triage: result === "passed" ? "Green" : triage.missing.length ? "Red" : "Orange" });
    repo.audit(id, "system", "case_evaluated", `result=${result}; configuration=${report.configVersion ?? "unconfigured"}; outcome unchanged`);
  })();
  return report;
}
