/**
 * Concurrency guard for interval-driven jobs: while one run is in flight,
 * overlapping invocations return null immediately instead of stacking.
 * A slow Gmail pass (OCR, vision latency) used to let the next 60 s tick
 * start a second pass — both would see the same unprocessed message ids.
 */
export function onceAtATime<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>
): (...args: A) => Promise<R | null> {
  let running = false;
  return async (...args: A): Promise<R | null> => {
    if (running) return null;
    running = true;
    try {
      return await fn(...args);
    } finally {
      running = false;
    }
  };
}
