/**
 * Numeric environment variables must never leak NaN into timeouts, budgets
 * or guards: `Number("abc")` is NaN, and `bytes > NaN` / `setTimeout(NaN)`
 * silently disable the very protection the knob configures. These helpers
 * fall back to the documented default for anything unparsable or non-positive.
 */
export function envInt(raw: string | undefined, fallback: number): number {
  const n = Number((raw || "").trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Like envInt, but keeps fractional values (e.g. RASTER_SCALE=2.2). */
export function envNum(raw: string | undefined, fallback: number): number {
  const n = Number((raw || "").trim());
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
