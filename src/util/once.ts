/**
 * Concurrency guard for interval-driven jobs: while one run is in flight,
 * overlapping invocations are SKIPPED instead of stacking.
 *
 * A slow Gmail pass (OCR, vision latency) used to let the next 60 s tick
 * start a second pass — both would see the same unprocessed message ids.
 *
 * The result distinguishes "the pass ran" from "the pass was skipped":
 * `{ ran: true, result }` is the wrapped function's own return (whose null
 * may well mean success), while `{ ran: false, result: null }` means this
 * invocation never executed because another one holds the slot. Callers that
 * report to a human (Settings → "Sync now") MUST check `ran` first — a bare
 * null used to render "Inbox synced" for a pass that never happened.
 */
export interface OnceResult<R> {
  ran: boolean;
  result: R | null;
}

export function onceAtATime<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>
): (...args: A) => Promise<OnceResult<R>> {
  let running = false;
  return async (...args: A): Promise<OnceResult<R>> => {
    if (running) return { ran: false, result: null };
    running = true;
    try {
      return { ran: true, result: await fn(...args) };
    } finally {
      running = false;
    }
  };
}
