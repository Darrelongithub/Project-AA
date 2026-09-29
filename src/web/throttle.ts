/**
 * Time-based login-failure throttling.
 *
 * The previous implementation kept `Map<ip, number[]>` and, when the map
 * grew past 5,000 entries, called `loginFails.clear()` — a blunt wipe that
 * discarded the memory of EVERY other blocked IP at exactly the moment an
 * attacker was flooding with fresh addresses.
 *
 * This throttle instead:
 *   - keeps per-IP failure timestamps and expires them by time (windowMs);
 *   - when the entry count exceeds `maxEntries`, evicts the OLDEST entries
 *     (least-recent failure first) — never a bulk clear, so an IP that is
 *     currently inside its block window keeps being blocked;
 *   - exposes `size` so the bound is testable.
 *
 * Only failed logins are recorded; legitimate users are never locked out.
 */
export interface LoginThrottleOptions {
  /** Failure window. Default 60 s. */
  windowMs?: number;
  /** Failures inside the window that trigger a block. Default 10. */
  maxFails?: number;
  /** Hard cap on tracked IPs; oldest entries are evicted above this. Default 10,000. */
  maxEntries?: number;
}

export class LoginThrottle {
  private readonly fails = new Map<string, number[]>();
  private readonly windowMs: number;
  private readonly maxFails: number;
  private readonly maxEntries: number;

  constructor(opts: LoginThrottleOptions = {}) {
    this.windowMs = opts.windowMs ?? 60_000;
    this.maxFails = opts.maxFails ?? 10;
    this.maxEntries = opts.maxEntries ?? 10_000;
  }

  /** True while the IP may attempt to log in. */
  allowed(ip: string, now: number = Date.now()): boolean {
    const list = this.fails.get(ip);
    if (!list) return true;
    const cutoff = now - this.windowMs;
    const kept = list.filter((t) => t > cutoff);
    if (kept.length) this.fails.set(ip, kept);
    else this.fails.delete(ip);
    return kept.length < this.maxFails;
  }

  /** Record a failed attempt for the IP. */
  recordFail(ip: string, now: number = Date.now()): void {
    const cutoff = now - this.windowMs;
    const kept = (this.fails.get(ip) ?? []).filter((t) => t > cutoff);
    kept.push(now);
    this.fails.set(ip, kept);
    this.evictOldest();
  }

  /**
   * Claim a dedup key once per window (double-submit guards): true on the
   * first claim, false on repeats inside the window. One call — the
   * check and the record cannot interleave.
   */
  claim(key: string, now: number = Date.now()): boolean {
    if (!this.allowed(key, now)) return false;
    this.recordFail(key, now);
    return true;
  }

  /** Number of IPs currently tracked (for tests / observability). */
  get size(): number {
    return this.fails.size;
  }

  /**
   * Evict the oldest entries (by most-recent failure) until the map is back
   * under `maxEntries`. Deliberately NOT a clear(): entries whose failures
   * are still inside the window — including an IP currently being blocked —
   * survive as long as they are not among the oldest.
   *
   * Amortized: one pass evicts down to 90% of the cap instead of a single
   * entry. Evicting exactly the excess re-sorted the whole map on EVERY
   * insert under flood (O(n log n) per failure with n = 10k) — attacker-
   * paced CPU. The batch keeps the same oldest-first semantics.
   */
  private evictOldest(): void {
    if (this.fails.size <= this.maxEntries) return;
    const target = Math.max(1, Math.floor(this.maxEntries * 0.9));
    const excess = this.fails.size - target;
    const order = [...this.fails.entries()]
      .sort((x, y) => x[1][x[1].length - 1] - y[1][y[1].length - 1]) // oldest last-failure first
      .slice(0, excess)
      .map(([ip]) => ip);
    for (const ip of order) this.fails.delete(ip);
  }
}
