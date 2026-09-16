/** Tiny leveled console logger. */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const threshold: number = LEVELS[(process.env.LOG_LEVEL as Level) || "info"] ?? 20;

export function log(msg: string, level: Level = "info"): void {
  if (LEVELS[level] < threshold) return;
  const ts = new Date().toISOString();
  const line = `[${ts}] ${level.toUpperCase().padEnd(5)} ${msg}`;
  if (level === "error") console.error(line);
  else console.log(line);
}
