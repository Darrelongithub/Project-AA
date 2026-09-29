/**
 * Page renderers — operational metrics (admin only). Reads the metric_daily
 * table populated by the Phase 6 instrumentation; the route flushes pending
 * in-memory samples first so the view is current.
 */
import type { MetricDayRow } from "../../db/repo/metrics";
import { esc } from "../views";
import { head } from "./shared";
import type { Ctx } from "./shared";
import { emptyState } from "../tpl";
import { utcDay } from "../../util/day";

function metricRow(r: MetricDayRow): string {
  const avg = r.sum !== 0 ? (r.sum / r.n).toFixed(1) : "—";
  return `<tr><td class="mono">${esc(r.day)}</td><td class="mono">${esc(r.name)}</td><td class="num">${r.n}</td><td class="num muted">${avg}</td></tr>`;
}

export function metricsPage(c: Ctx): string {
  const { repo } = c;
  // Phase 12: per-org duration rows stay out of the global metrics page —
  // they belong to one org's console, not to every admin's screen.
  const rows = repo.metricDaily(14).filter((r) => !r.name.includes(".org."));
  const today = utcDay();
  const todayRows = rows.filter((r) => r.day === today);
  const pastRows = rows.filter((r) => r.day !== today).reverse();
  return head(
    c,
    "Metrics",
    "metrics",
    `<div class="card-head"><h2>Operational metrics</h2><span class="muted small">counters flush every 60s; opening this page flushes immediately</span></div>
    <section class="card"><h2>Today (UTC)</h2>
      ${todayRows.length
        ? `<table><tr><th>Day</th><th>Metric</th><th>Count</th><th>Avg</th></tr>${todayRows.map(metricRow).join("")}</table>`
        : emptyState(`<p>No samples yet today — browse the console and reload.</p>`)}
    </section>
    <section class="card"><h2>Previous 13 days</h2>
      ${pastRows.length
        ? `<table><tr><th>Day</th><th>Metric</th><th>Count</th><th>Avg</th></tr>${pastRows.map(metricRow).join("")}</table>`
        : emptyState(`<p>No history yet.</p>`)}
    </section>`
  );
}
