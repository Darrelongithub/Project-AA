/** A deadline expired while awaiting an asynchronous operation. */
export class TimeoutError extends Error {
  readonly code = "TIMEOUT" as const;

  constructor(readonly label: string, readonly timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
  }
}

/**
 * Resolve/reject with `operation`, or reject with a typed TimeoutError after
 * `timeoutMs`. The underlying work is not cancelled; callers should use an
 * abortable API when cancellation is required. Its timer is unref'd so this
 * guard alone does not keep a short-lived process alive.
 */
export function withTimeout<T>(operation: PromiseLike<T>, timeoutMs: number, label: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    return Promise.reject(new RangeError(`timeoutMs must be a finite non-negative number; received ${timeoutMs}`));
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, timeoutMs)), timeoutMs);
    if (typeof timer === "object" && timer) (timer as { unref?: () => void }).unref?.();
  });

  return Promise.race([Promise.resolve(operation), expiry]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
