/** Queue placement derives from case state, independently of human-recorded outcomes. */
import type { ApplicantRow } from "../types";
export type QueueKey = "completed" | "waiting_documents" | "human_review" | "decision" | "enquiries";
export interface QueueInfo { key: QueueKey; label: string; caption: string; tone: string; subs: Array<{ key: string; label: string }> }
export const QUEUES: QueueInfo[] = [
  { key: "completed", label: "Completed / Verification", caption: "Completed cases", tone: "green", subs: [{ key: "completed", label: "Completed" }, { key: "verification", label: "Verification" }] },
  { key: "waiting_documents", label: "Waiting for Documents", caption: "More information is needed", tone: "blue", subs: [{ key: "missing_documents", label: "Missing information" }, { key: "awaiting_contact_response", label: "Awaiting contact response" }] },
  { key: "human_review", label: "Human Review Required", caption: "A person must check the evidence", tone: "orange", subs: [{ key: "verification_required", label: "Evidence requires verification" }, { key: "ready_for_review", label: "Ready for review" }, { key: "escalated", label: "Escalated" }] },
  { key: "decision", label: "Outcomes", caption: "Human-recorded outcomes", tone: "purple", subs: [{ key: "approved_after_review", label: "Approved after review" }, { key: "not_approved", label: "Not approved" }, { key: "auto_approved", label: "Imported automated outcome" }] },
  { key: "enquiries", label: "Enquiries & Communication", caption: "Messages needing a reply", tone: "gray", subs: [{ key: "new_enquiry", label: "New enquiry" }, { key: "awaiting_response", label: "Awaiting response" }, { key: "responded", label: "Responded" }] },
];
export const SUB_LABELS: Record<string, string> = Object.fromEntries(QUEUES.flatMap((queue) => queue.subs.map((sub) => [sub.key, sub.label])));
export function queueOf(row: ApplicantRow, context: { lastDirection?: "in" | "out" | null; hasDocuments?: boolean } = {}): { queue: QueueKey; sub: string } {
  if (row.lifecycle === "completed" || row.lifecycle === "verification") return { queue: "completed", sub: row.lifecycle };
  if (row.outcome && row.outcome !== "undecided") return { queue: "decision", sub: row.outcome };
  if (row.escalated) return { queue: "human_review", sub: "escalated" };
  if (row.routing === "waiting_documents") return { queue: "waiting_documents", sub: row.followup_next_at ? "awaiting_contact_response" : "missing_documents" };
  if (row.routing === "human_review" || context.hasDocuments) return { queue: "human_review", sub: row.routing_reason ?? "verification_required" };
  return { queue: "enquiries", sub: context.lastDirection === "out" ? "responded" : context.lastDirection === "in" ? "awaiting_response" : "new_enquiry" };
}
