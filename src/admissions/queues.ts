/**
 * /admissions/queues — the five operational queues.
 *
 * Top level answers "what needs attention right now?"; the subcategory
 * answers "why is it here?". Placement is DERIVED from the separated
 * concepts (lifecycle, requirement result, routing, admission decision,
 * communication state) — never one giant status field.
 */
import type { ApplicantRow } from "../types";

export type QueueKey = "completed" | "waiting_documents" | "human_review" | "decision" | "enquiries";

export interface QueuePlacement {
  queue: QueueKey;
  sub: string;
}

export interface QueueInfo {
  key: QueueKey;
  label: string;
  caption: string;
  tone: string;
  subs: Array<{ key: string; label: string }>;
}

export const QUEUES: QueueInfo[] = [
  {
    key: "completed", label: "Completed / Verification", tone: "green",
    caption: "Applicants who have reached the completion stage",
    subs: [
      { key: "completed", label: "Completed" },
      { key: "awaiting_verification", label: "Awaiting verification" },
      { key: "verification_in_progress", label: "Verification in progress" },
    ],
  },
  {
    key: "waiting_documents", label: "Waiting for Documents", tone: "blue",
    caption: "The next step depends on missing or incomplete information",
    subs: [
      { key: "missing_documents", label: "Missing documents" },
      { key: "partial_submission", label: "Partial submission" },
      { key: "document_clarification", label: "Document clarification" },
      { key: "awaiting_applicant_response", label: "Awaiting applicant response" },
    ],
  },
  {
    key: "human_review", label: "Human Review Required", tone: "orange",
    caption: "Cannot safely proceed through the automated path",
    subs: [
      { key: "requirement_not_satisfied", label: "Entry requirements not met — decide manually" },
      { key: "requirement_conflict", label: "Requirement conflict" },
      { key: "late_submission", label: "Late submission" },
      { key: "low_confidence_extraction", label: "Low-confidence extraction" },
      { key: "special_consideration", label: "Special consideration" },
      { key: "exception", label: "Exception" },
      { key: "escalated", label: "Escalated — overdue, needs attention now" },
      { key: "manual_decision_required", label: "Documents in — needs a manual decision" },
    ],
  },
  {
    key: "decision", label: "Admissions / Decision", tone: "purple",
    caption: "Actively progressing through admission decisions",
    subs: [
      { key: "ready_for_decision", label: "Ready for decision" },
      { key: "auto_admitted", label: "Auto-admitted" },
      { key: "admitted_after_review", label: "Admitted after human review" },
      { key: "not_admitted", label: "Not admitted" },
      { key: "decision_pending", label: "Decision pending" },
    ],
  },
  {
    key: "enquiries", label: "Enquiries & Communication", tone: "gray",
    caption: "General communication, not an application-processing issue",
    subs: [
      { key: "new_enquiry", label: "New enquiry" },
      { key: "awaiting_response", label: "Awaiting response" },
      { key: "responded", label: "Responded" },
      { key: "follow_up_required", label: "Follow-up required" },
    ],
  },
];

export const SUB_LABELS: Record<string, string> = Object.fromEntries(
  QUEUES.flatMap((q) => q.subs.map((s) => [s.key, s.label]))
);

export interface QueueContext {
  /** Direction of the applicant's most recent email, if any. */
  lastDirection?: "in" | "out" | null;
  /** True when the applicant has sent at least one document. */
  hasDocuments?: boolean;
}

/** Deterministic queue placement for one applicant. */
export function queueOf(a: ApplicantRow, ctx: QueueContext = {}): QueuePlacement {
  // 1 — COMPLETED / VERIFICATION
  if (a.lifecycle === "verification") return { queue: "completed", sub: "verification_in_progress" };
  if (a.lifecycle === "completed") {
    return { queue: "completed", sub: a.admission_decision === "undecided" ? "awaiting_verification" : "completed" };
  }

  // 2 — WAITING FOR DOCUMENTS (missing information is never failure)
  if (a.routing === "waiting_documents") {
    let sub = a.routing_reason === "partial_submission" ? "partial_submission" : "missing_documents";
    if (a.routing_reason === "document_clarification") sub = "document_clarification";
    if (a.followup_next_at) sub = "awaiting_applicant_response";
    return { queue: "waiting_documents", sub };
  }

  // 3 — HUMAN REVIEW REQUIRED
  if (a.routing === "human_review" || (a.escalated === 1 && a.routing !== "auto_admit")) {
    if (a.escalated === 1) return { queue: "human_review", sub: "escalated" };
    const reason = a.routing_reason ?? "";
    const known = new Set([
      "requirement_not_satisfied", "requirement_conflict", "late_submission",
      "low_confidence_extraction", "special_consideration", "exception",
      "manual_decision_required",
    ]);
    return { queue: "human_review", sub: known.has(reason) ? reason : "manual_decision_required" };
  }

  // 4 — ADMISSIONS / DECISION
  if (a.admission_decision !== "undecided") {
    return { queue: "decision", sub: a.admission_decision };
  }
  if (a.routing === "auto_admit") {
    return { queue: "decision", sub: "ready_for_decision" };
  }

  // 5 — DOCUMENTS IN, NO ROUTING YET: this belongs to a reviewer, not the
  // enquiries inbox. (An earlier version fell through to "new enquiry"
  // here, which showed submitted-but-unreviewed applicants as if they had
  // merely asked a question.)
  if (ctx.hasDocuments) {
    return { queue: "human_review", sub: "manual_decision_required" };
  }

  // 6 — ENQUIRIES & COMMUNICATION
  if (a.followup_next_at) return { queue: "enquiries", sub: "follow_up_required" };
  if (!ctx.hasDocuments && a.lifecycle === "application_received") return { queue: "enquiries", sub: "new_enquiry" };
  if (ctx.lastDirection === "in") return { queue: "enquiries", sub: "awaiting_response" };
  return { queue: "enquiries", sub: ctx.lastDirection === "out" ? "responded" : "new_enquiry" };
}
