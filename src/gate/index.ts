/**
 * /gate — decides auto-send vs human queue. Pure function, no exceptions:
 *
 *   - Orange → human queue, always.
 *   - Red    → human queue, always.
 *   - Green  → auto-send ONLY if the watcher ran and found nothing off.
 */
import type { Classification } from "../types";

export interface GateDecision {
  action: "auto_send" | "human_queue";
  reason: string;
}

export interface CaseTypeGateInput {
  matrixComplete: boolean;
  ruleTreePassed: boolean;
  watcher: { ran: boolean; flagged: boolean };
  confidenceFloorMet: boolean;
}

export interface CaseTypeGateDecision {
  action: "auto_approve" | "human_review";
  outcome: "auto_approved" | "undecided";
  reason: string;
}

/**
 * The only code path permitted to produce a generic auto-approval. Every
 * prerequisite is explicit: a complete case-type matrix, deterministic rule
 * pass, clean watcher, and the configured confidence floor. Gemini facts and
 * category labels cannot satisfy any prerequisite themselves.
 */
export function caseTypeGate(input: CaseTypeGateInput): CaseTypeGateDecision {
  if (input.matrixComplete && input.ruleTreePassed && input.watcher.ran && !input.watcher.flagged && input.confidenceFloorMet) {
    return { action: "auto_approve", outcome: "auto_approved", reason: "complete matrix, code rule tree, confidence floor and clean watcher" };
  }
  const reasons = [
    !input.matrixComplete && "document matrix is incomplete",
    !input.ruleTreePassed && "code rule tree did not pass",
    !input.watcher.ran && "watcher did not run",
    input.watcher.flagged && "watcher flagged the case",
    !input.confidenceFloorMet && "confidence is below the configured floor",
  ].filter(Boolean).join("; ");
  return { action: "human_review", outcome: "undecided", reason: reasons || "human review required" };
}

export function gate(
  finalStatus: Classification,
  watcher: { ran: boolean; flagged: boolean }
): GateDecision {
  if (finalStatus === "Green") {
    if (watcher.ran && !watcher.flagged) {
      return { action: "auto_send", reason: "Green verdict confirmed by watcher" };
    }
    if (!watcher.ran) {
      return { action: "human_queue", reason: "Green verdict but watcher did not run — refusing to auto-send" };
    }
    return { action: "human_queue", reason: "Watcher flagged the record after a Green verdict" };
  }
  if (finalStatus === "Orange") {
    return { action: "human_queue", reason: "Orange: present but ambiguous/flagged — human review required" };
  }
  return { action: "human_queue", reason: "Red: missing documents or watcher downgrade — human review required" };
}
