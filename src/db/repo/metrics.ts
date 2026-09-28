/**
 * /db/repo — operational metrics persistence (Phase 6). Daily counters in
 * metric_daily; the Repo facade in ../repo.ts delegates to it.
 */
import type { Repo } from "../repo";

export interface MetricDayRow {
  day: string;
  name: string;
  n: number;
  sum: number;
}

export function upsertMetric(repo: Repo, day: string, name: string, n: number, sum: number): void {
  repo.db
    .prepare(
      `INSERT INTO metric_daily (day, name, n, sum) VALUES (?, ?, ?, ?)
       ON CONFLICT (day, name) DO UPDATE SET n = n + excluded.n, sum = sum + excluded.sum`
    )
    .run(day, name, n, sum);
}

/** Last `days` days (UTC), oldest first — feeds the admin metrics page. */
export function metricDaily(repo: Repo, days: number): MetricDayRow[] {
  return repo.db
    .prepare(
      `SELECT day, name, n, sum FROM metric_daily
       WHERE day >= date('now', ?) ORDER BY day ASC, name ASC`
    )
    .all(`-${days - 1} days`) as MetricDayRow[];
}
