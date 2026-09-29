/**
 * UTC calendar-day bucket, `YYYY-MM-DD` (Phase 11 dedupe — was the same
 * inline slice in 4 places). UTC on purpose: budgets and metric buckets
 * need a boundary that never shifts with the operator's timezone (unlike
 * the dashboard "today", which is local by design — see BH-13).
 */
export function utcDay(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}
