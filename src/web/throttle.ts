/**
 * Windowed guards for the web surface: login-failure throttling, the
 * duplicate-send window, and the public webhook rate limit. Shared rule: entries
 * expire by their own clock, the map is bounded by eviction, never by a bulk
 * `clear()`.
 *
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

  /** Number of IPs currently tracked (for tests / observability). */
  get size(): number {
    return this.fails.size;
  }

  /**
   * Evict the oldest entries (by most-recent failure) until the map is back
   * under `maxEntries`. Deliberately NOT a clear(): entries whose failures
   * are still inside the window — including an IP currently being blocked —
   * survive as long as they are not among the oldest.
   */
  private evictOldest(): void {
    if (this.fails.size <= this.maxEntries) return;
    const excess = this.fails.size - this.maxEntries;
    const order = [...this.fails.entries()]
      .sort((x, y) => x[1][x[1].length - 1] - y[1][y[1].length - 1]) // oldest last-failure first
      .slice(0, excess)
      .map(([ip]) => ip);
    for (const ip of order) this.fails.delete(ip);
  }
}

/**
 * Short-window "did this exact action just happen?" guard, used to fold a rapid
 * double-click on a send button into one action.
 *
 * It follows the same rule as LoginThrottle above: entries are dropped when
 * their own window expires, never by clearing the whole map. A size cap plus
 * `clear()` (what this used to be, at 2 000 entries) discards every guard that
 * is INSIDE its window at that moment — precisely the busy-office case the
 * protection exists for — and the duplicate mail it lets through cannot be
 * recalled.
 */
export class SendGuard {
  private readonly seen = new Map<string, number>();

  constructor(private readonly windowMs = 5_000) {}

  /** True when `key` may proceed; a repeat inside the window is refused. */
  allow(key: string, now: number = Date.now()): boolean {
    for (const [seenKey, at] of this.seen) if (now - at >= this.windowMs) this.seen.delete(seenKey);
    const last = this.seen.get(key);
    if (last !== undefined && now - last < this.windowMs) return false;
    this.seen.set(key, now);
    return true;
  }

  /** Keys currently inside their window (for tests / observability). */
  get size(): number {
    return this.seen.size;
  }
}

/**
 * Fixed-window hit counter for the public webhook ingest: `limit` accepted calls
 * per `windowMs`, per key.
 *
 * It follows the rule this file exists to state. The natural way to write this
 * is a map of counters plus a periodic sweep, or a size cap with `clear()` — and
 * both are wrong in the same direction: wiping the map forgets which callers had
 * already spent their budget, so a flood that trips the cap is rewarded with a
 * fresh allowance. Here a window rolls over on its own clock, an idle key is
 * dropped when it is next touched, and the number of tracked keys is bounded by
 * evicting the least recently seen one, which only ever shortens a stranger's
 * pause, never an attacker's.
 */
export class RateWindow {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  private readonly windowMs: number;
  private readonly maxEntries: number;

  constructor(options: { windowMs?: number; maxEntries?: number } = {}) {
    this.windowMs = options.windowMs ?? 60_000;
    this.maxEntries = options.maxEntries ?? 10_000;
  }

  /**
   * Count one hit against `key` and report whether it is inside `limit`.
   * `limit` is a parameter, not constructor state, because the threshold is a
   * Settings value: changing it must take effect on the next request, not on the
   * next process start.
   */
  hit(key: string, limit: number, now: number = Date.now()): { ok: boolean; retryAfterSeconds: number; remaining: number } {
    const seen = this.hits.get(key);
    const open = seen && seen.resetAt > now ? seen : { count: 0, resetAt: now + this.windowMs };
    open.count += 1;
    this.hits.delete(key);
    this.hits.set(key, open);
    if (this.hits.size > this.maxEntries) {
      const oldest = this.hits.keys().next();
      if (!oldest.done) this.hits.delete(oldest.value);
    }
    if (open.count > limit) {
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((open.resetAt - now) / 1000)), remaining: 0 };
    }
    return { ok: true, retryAfterSeconds: 0, remaining: Math.max(0, limit - open.count) };
  }

  /** Keys with an open window (for tests and for an operator's status view). */
  get size(): number {
    return this.hits.size;
  }

  forget(key: string): void {
    this.hits.delete(key);
  }
}
