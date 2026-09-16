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
