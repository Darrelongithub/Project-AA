/**
 * /logs — every decision and what it was based on.
 *
 * DecisionLog rows go to the database (queryable, scoreable). Optionally a
 * JSON Lines mirror is appended for offline diffing. The simulation harness
 * scores the system by reading these records against an answer key — no
 * manual review needed.
 */
import * as fs from "fs";
import * as path from "path";
import type { Repo } from "../db/repo";
import type { DecisionLogEntry } from "../types";

export function writeDecisionLog(
  repo: Repo,
  entry: Omit<DecisionLogEntry, "id" | "timestamp">,
  opts: { jsonlPath?: string } = {}
): void {
  repo.insertDecisionLog(entry);
  if (opts.jsonlPath) {
    try {
      fs.mkdirSync(path.dirname(path.resolve(opts.jsonlPath)), { recursive: true });
      const row = { ...entry, timestamp: new Date().toISOString() };
      fs.appendFileSync(opts.jsonlPath, JSON.stringify(row) + "\n");
    } catch {
      /* the DB copy is authoritative; don't crash on file issues */
    }
  }
}
