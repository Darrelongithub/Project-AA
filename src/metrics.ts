/**
 * Operational metrics (Phase 6): tiny in-memory counters/observations,
 * flushed to the metric_daily table. Additive-only instrumentation —
 * recording a metric never changes control flow, and a flush failure
 * must never fail the request that triggered it (callers catch).
 */
export interface MetricSample {
  n: number;
  sum: number;
}

export class Metrics {
  private readonly cur = new Map<string, MetricSample>();

  incr(name: string, n = 1): void {
    const s = this.cur.get(name) ?? { n: 0, sum: 0 };
    s.n += n;
    this.cur.set(name, s);
  }

  observe(name: string, value: number): void {
    const s = this.cur.get(name) ?? { n: 0, sum: 0 };
    s.n += 1;
    s.sum += value;
    this.cur.set(name, s);
  }

  /** Drain pending samples into `sink`, then clear (flush is idempotent). */
  drain(sink: (name: string, n: number, sum: number) => void): void {
    for (const [name, s] of this.cur) {
      if (s.n !== 0 || s.sum !== 0) sink(name, s.n, s.sum);
    }
    this.cur.clear();
  }

  get size(): number {
    return this.cur.size;
  }
}

/** Process-wide registry. Serve mode persists it every 60s. */
export const metrics = new Metrics();

/** Flush pending samples via `upsert` (UTC day bucket). Never throws. */
export function flushMetrics(upsert: (day: string, name: string, n: number, sum: number) => void): void {
  const day = new Date().toISOString().slice(0, 10);
  try {
    metrics.drain((name, n, sum) => upsert(day, name, n, sum));
  } catch {
    // Metrics must never break the app — drops the batch on DB errors.
  }
}
