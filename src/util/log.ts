/**
 * Tiny leveled console logger.
 *
 * Invariant: **every physical line this writes is self-describing.** A message
 * is emitted as `[ts] LEVEL ` on its first line and `[ts] LEVEL … ` on every
 * continuation line, so a line in the log always carries its own timestamp and
 * level, and a continuation is always visibly one.
 *
 * Why that matters here: log messages routinely interpolate text a stranger
 * chose — a mail subject, a sender, an attachment filename, an ingest echo, a
 * library's error string. Without framing, one newline inside such a value
 * emits additional lines that look like independent events, so anyone who can
 * put text in a log can fabricate log lines (and any grep-based runbook step,
 * alert rule, or future log scrape is then reading an attacker's text as
 * structure). Framing removes that, and it removes it globally rather than at
 * each call site, so a newly added `log()` cannot reopen the hole.
 *
 * Framing deliberately **marks** extra lines instead of collapsing them:
 * `err.stack` is legitimately multi-line and flattening it would trade a
 * cosmetic problem for worse diagnostics on every crash. Non-newline control
 * characters (ESC/ANSI, NUL, the rest of C0) *are* removed, because they carry
 * nothing a reader needs and a terminal that `tail`s the file would otherwise
 * act on them.
 */

/** Characters that end a physical line, including the two Unicode separators. */
const LINE_BREAK = /\r\n|\n|\r|\u2028|\u2029/;
/** Control characters other than the line breaks handled above. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
/** Written after the prefix on every line that continues the event above it. */
const CONTINUATION = "… ";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const threshold: number = LEVELS[(process.env.LOG_LEVEL as Level) || "info"] ?? 20;

/** Split into physical lines and strip the characters no log line should carry. */
function frame(msg: string): string[] {
  return msg.split(LINE_BREAK).map((line) => line.replace(CONTROL_CHARS, ""));
}

export function log(msg: string, level: Level = "info"): void {
  if (LEVELS[level] < threshold) return;
  const ts = new Date().toISOString();
  const prefix = `[${ts}] ${level.toUpperCase().padEnd(5)} `;
  const lines = frame(msg);
  const out = lines.map((line, i) => prefix + (i === 0 ? "" : CONTINUATION) + line).join("\n");
  if (level === "error") console.error(out);
  else console.log(out);
}

/**
 * One bounded line for a whole caller-controlled string that is being embedded
 * in a message (subject, sender, filename, error text) — the handful of places
 * where the interpolated value is free-form rather than an id.
 *
 * Two things `log()` does not do, and should not: it cannot know that a 12 kB
 * subject is noise rather than signal, and it must not truncate anything it was
 * handed, since a stack trace is the payload it exists to preserve. Call sites
 * that embed a stranger's whole string opt into both limits here instead:
 * line breaks become single spaces, so the value can never masquerade as its own
 * event even when the message is re-read or copied elsewhere, and text past
 * `max` is replaced by a marker rather than dropped silently.
 */
export function logField(value: string | null | undefined, max = 120): string {
  const limit = Math.max(1, Math.floor(max));
  const flat = frame(value == null ? "" : String(value)).join(" ").replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, Math.max(1, limit - 1))}…`;
}
