/**
 * Vitest reporter that explains failures as soon as the run ends.
 *
 * `npm test` prints which tests failed. This adds the part the runner leaves
 * out — what the failure means and what to do about it — using the same
 * classifier as `npm run test:troubleshoot` (test/troubleshooter.ts).
 *
 * It is defensive on purpose: a reporter that throws would mask the very
 * failures it exists to explain, so every path is wrapped and silent on error.
 */
import { diagnose, formatDiagnosis, type FailureInput } from "./troubleshooter";

interface ErrorLite {
  message?: string;
  stack?: string;
}

interface TaskLite {
  name?: string;
  type?: string;
  /** Present on a file-level task that never managed to run. */
  message?: string;
  result?: { state?: string; errors?: ErrorLite[] };
  tasks?: TaskLite[];
}

interface FileLite extends TaskLite {
  filepath?: string;
}

/**
 * Walk one task tree and record failures. Returns how many were recorded so a
 * parent can tell "I failed" from "one of my children failed" — without this,
 * a single failing test is reported four times (file, describe, test, hook).
 */
function walk(task: TaskLite, file: string, out: FailureInput[], path: string[]): number {
  const trail = [...path, task.name].filter((s): s is string => typeof s === "string" && s.length > 0);
  const children = task.tasks ?? [];
  let recorded = 0;
  for (const child of children) recorded += walk(child, file, out, trail);
  if (task.result?.state !== "fail") return recorded;
  // A suite is only "the" failure when nothing underneath it was: otherwise the
  // child's own message is far more useful than the parent's.
  if (children.length && recorded > 0) return recorded;
  const errors = task.result.errors ?? [];
  const message = errors.map((e) => e?.message ?? "").filter(Boolean).join("\n") || task.message || "";
  const stack = errors.map((e) => e?.stack ?? "").filter(Boolean).join("\n");
  out.push({
    file,
    name: trail.join(" > ") || "(file failed to run)",
    message,
    stack: stack || message,
  });
  return recorded + 1;
}

export default class TroubleshootReporter {
  onFinished(files: FileLite[] = []): void {
    try {
      const failures: FailureInput[] = [];
      for (const file of files ?? []) {
        walk(file, file.filepath ?? file.name ?? "", failures, []);
      }
      if (!failures.length) return;

      const lines: string[] = [];
      lines.push("");
      lines.push("═══ TEST TROUBLESHOOTER ═══════════════════════════════════════════════════════════════");
      lines.push(`  ${failures.length} failure(s), classified:`);
      lines.push("");
      for (let i = 0; i < failures.length; i++) {
        const f = failures[i];
        const d = diagnose(f);
        lines.push(formatDiagnosis(f, d, i + 1, failures.length));
        lines.push("");
      }
      lines.push("  Full runbook and decision flowchart: TROUBLESHOOTING.md");
      lines.push("  Deeper, re-runnable analysis:        npm run test:troubleshoot");
      lines.push("");
      // eslint-disable-next-line no-console
      console.log(lines.join("\n"));
    } catch {
      /* never mask the real failure */
    }
  }
}
