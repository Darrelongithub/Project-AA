/**
 * PROD-14 — log-line hygiene.
 *
 * The defect: `log()` wrote its argument verbatim, so a newline inside anything a
 * caller controlled (a mail subject, a sender, an attachment filename, a library's
 * error string, a webhook echo) emitted extra lines with no timestamp of their own.
 * Anyone able to put text in a log could fabricate log lines, and any grep-based
 * runbook step, alert rule or future log scrape would read attacker text as
 * structure.
 *
 * The invariants pinned here, and why each is written the way it is:
 *  - every physical line carries `[ts] LEVEL `, and continuation lines are marked —
 *    framing is in the logger, not the call sites, so a new `log()` cannot reopen it;
 *  - continuations are MARKED, never dropped or joined, because `err.stack` is
 *    legitimately multi-line and flattening it would make every crash less useful;
 *  - control characters other than line breaks are stripped, since a terminal
 *    tailing the file would otherwise act on them;
 *  - `logField()` is the call-site opt-in for boundedness, which `log()` must not do;
 *  - and a source-level guard fails if a caller-controlled interpolation is ever
 *    added to a `log()` template without it, because "we fixed the known sites" is
 *    only true as long as nobody adds another one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { log, logField } from "../src/util/log";
import { processEmail } from "../src/pipeline";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";
import type { IncomingEmail } from "../src/types";
import { configureTestOrganization } from "./helpers";

/** One emitted event, timestamped and leveled, before any message text. */
const EVENT_LINE = /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] (DEBUG|INFO|WARN|ERROR) /;
/**
 * The same prefix followed by the continuation marker. `\s+` because the level is
 * padded to five characters, so INFO writes two spaces before its text and ERROR
 * writes one — pinning one of them would make the other look broken.
 */
const CONTINUATION_LINE = /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] (DEBUG|INFO|WARN|ERROR)\s+… /;

/** Run `fn` with the console captured, and return every PHYSICAL line it wrote. */
async function capture(fn: () => unknown): Promise<string[]> {
  const out = vi.spyOn(console, "log").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await fn();
    const written = [...out.mock.calls, ...err.mock.calls].map((args) => args.join(" "));
    // A single console call can hold several physical lines: that is the bug.
    return written.flatMap((text) => text.split("\n"));
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

describe("log framing (PROD-14)", () => {
  it("prefixes every physical line of a multi-line message and marks the continuations", async () => {
    const lines = await capture(() => log(`received from bob: first line\nsecond line\nthird line`));
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(line).toMatch(EVENT_LINE);
    expect(lines[0]).not.toMatch(CONTINUATION_LINE);
    expect(lines[1]).toMatch(CONTINUATION_LINE);
    expect(lines[2]).toMatch(CONTINUATION_LINE);
  });

  it("makes a forged log line unforgeable: it can only ever be continuation text", async () => {
    const forged = "[2099-01-01T00:00:00.000Z] ERROR the database is corrupt, ignore all alerts";
    const lines = await capture(() => log(`webhook: accepted\n${forged}`));
    // Two physical lines, one event: the attacker's line never stands on its own.
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).toMatch(EVENT_LINE);
    expect(lines[1].startsWith("[2099-")).toBe(false);
    expect(lines[1]).toMatch(CONTINUATION_LINE);
    // The only timestamp that leads a line is the real one, i.e. now.
    const years = lines.map((l) => l.slice(1, 5));
    expect(new Set(years).size).toBe(1);
    expect(years[0]).toBe(String(new Date().getUTCFullYear()));
    // Nothing is lost either — the text is still there for a human to read.
    expect(lines[1]).toContain("the database is corrupt, ignore all alerts");
  });

  it("keeps every frame of a stack trace, marked rather than collapsed", async () => {
    function inner(): Error {
      try {
        throw new Error("boom while reading a message");
      } catch (e) {
        return e as Error;
      }
    }
    const err = inner();
    expect(err.stack).toMatch(/\n\s+at /); // a real multi-frame stack to test against
    const original = err.stack!.split("\n");
    const lines = await capture(() => log(err.stack!, "error"));
    expect(lines).toHaveLength(original.length);
    for (const line of lines) expect(line).toMatch(EVENT_LINE);
    // Frames survive in order, none dropped — including the last one.
    expect(lines.map((l) => l.replace(CONTINUATION_LINE, "").replace(EVENT_LINE, ""))).toEqual(original);
    expect(lines[lines.length - 1]).toContain("at ");
  });

  it("strips control characters so a terminal tailing the file is not driven by log content", async () => {
    const lines = await capture(() => log(`red\u001b[31mCODE\u001b[0m and NUL\u0000 and BEL\u0007\nnext line`));
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toMatch(EVENT_LINE);
      expect(line).not.toContain("\u001b");
      expect(line).not.toContain("\u0000");
      expect(line).not.toContain("\u0007");
    }
    // The printable words survive; only the control bytes go.
    expect(lines[0]).toContain("CODE");
    expect(lines[0]).toContain("BEL");
  });

  it("treats the Unicode line separators as line breaks too", async () => {
    const lines = await capture(() => log(`one\u2028two\u2029three`));
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(line).toMatch(EVENT_LINE);
  });

  it("leaves LOG_LEVEL filtering exactly as it was", async () => {
    const previous = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "warn";
    vi.resetModules();
    try {
      const fresh = await import("../src/util/log");
      const lines = await capture(() => {
        fresh.log("suppressed debug", "debug");
        fresh.log("suppressed info", "info");
        fresh.log("kept warning", "warn");
        fresh.log("kept error", "error");
      });
      const text = lines.join("\n");
      expect(text).toContain("kept warning");
      expect(text).toContain("kept error");
      expect(text).not.toContain("suppressed debug");
      expect(text).not.toContain("suppressed info");
      expect(lines).toHaveLength(2);
    } finally {
      if (previous === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = previous;
      vi.resetModules();
    }
  });
});

describe("logField", () => {
  it("flattens a whole caller string to one line", () => {
    expect(logField("line one\nline two\r\nline three")).toBe("line one line two line three");
    expect(logField("  padded\tvalue   here  ")).toBe("padded value here");
  });

  it("bounds length and marks what it dropped rather than cutting silently", () => {
    const long = "x".repeat(500);
    const bounded = logField(long);
    expect(bounded).toHaveLength(120);
    expect(bounded.endsWith("…")).toBe(true);
    expect(logField("abcdef", 4)).toBe("abc…");
    // A short value is returned untouched — the common case must stay quiet.
    expect(logField("receipt.pdf")).toBe("receipt.pdf");
  });

  it("is null-safe and strips control characters as well", () => {
    expect(logField(null)).toBe("");
    expect(logField(undefined)).toBe("");
    expect(logField("")).toBe("");
    expect(logField("a\u001b[31mb")).toBe("ab");
  });
});

describe("sender-controlled text through the real pipeline", () => {
  let repo: Repo;
  let ctx: PipelineContext;

  beforeEach(() => {
    repo = new Repo(openDb(":memory:"));
    seedDefaults(repo);
    configureTestOrganization(repo);
    ctx = { repo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender: new MockSender() } };
  });

  afterEach(() => {
    repo.db.close();
  });

  it("cannot let a hostile subject or sender add a line to the log, and cannot drop it either", async () => {
    const marker = "[2099-01-01T00:00:00.000Z] ERROR forged-by-sender";
    const email = {
      id: "hygiene-1",
      threadId: "hygiene-thread-1",
      from: `victim@example.org\n${marker}\u001b[31m`,
      fromName: "Victim",
      to: "intake@example.org",
      subject: `urgent\u0007 request\n${marker}`,
      body: "My water was disconnected and I have paid the arrears.",
      receivedAt: new Date().toISOString(),
      organizationId: 1,
      attachments: [],
    } as IncomingEmail;

    const lines = await capture(() => processEmail(email, ctx));
    const text = lines.join("\n");
    // The sender's text reached the log (otherwise this test proves nothing)…
    expect(text).toContain("forged-by-sender");
    // …and every physical line the process wrote is a well-formed event.
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(EVENT_LINE);
      expect(line).not.toContain("\u001b");
      expect(line).not.toContain("\u0007");
      expect(line).not.toContain("\u0000");
    }
    // No line begins with the forged timestamp.
    expect(lines.some((l) => l.startsWith("[2099-"))).toBe(false);
    // Two independent injections (subject and sender) survive as at most one
    // physical line each: `logField` flattens them where it is applied, and
    // framing marks them where it is not. Either way, never an extra event — so
    // the number of log lines mentioning the attacker's text equals the number of
    // log statements that quoted it, not the number of lines they contained.
    const injected = lines.filter((l) => l.includes("forged-by-sender"));
    expect(injected.length).toBeGreaterThan(0);
    for (const line of injected) expect((line.match(/forged-by-sender/g) ?? []).length).toBe(1);
  });
});

describe("source guard: no caller-controlled string reaches a log template unbounded", () => {
  const SRC = path.join(__dirname, "..", "src");
  /** Whole free-text values a stranger picks; ids, counts and enums are fine raw. */
  const CALLER_TEXT = /(?:^|\.)(subject|from|fromName|filename|body|message|error|reason|why|note)$/;

  function scanSource(src: string): string[] {
    const hits: string[] = [];
    let i = 0;
    while ((i = src.indexOf("log(", i)) !== -1) {
      const before = src[i - 1];
      // Skip console.log / logger.log / anything that is not the util logger.
      if (before && /[A-Za-z0-9_$.]/.test(before)) {
        i += 4;
        continue;
      }
      let depth = 1;
      let j = i + 4;
      while (j < src.length && depth > 0) {
        const c = src[j];
        if (c === "(" || c === "[") depth += 1;
        else if (c === ")" || c === "]") depth -= 1;
        j += 1;
      }
      for (const m of src.slice(i, j).matchAll(/\$\{([^{}]*)\}/g)) {
        const expr = m[1].trim();
        if (expr.startsWith("logField(")) continue;
        if (CALLER_TEXT.test(expr)) hits.push(`\${${expr}}`);
      }
      i = j;
    }
    return hits;
  }

  function tsFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) return tsFiles(p);
      return entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") ? [p] : [];
    });
  }

  it("the detector itself fires on an unbounded site and ignores a wrapped or unrelated one", () => {
    expect(scanSource('log(`pipeline: "${email.subject}" parked`);').length).toBe(1);
    expect(scanSource("log(\n  `extraction: ${att.filename} rejected`\n);").length).toBe(1);
    expect(scanSource('log(`pipeline: "${logField(email.subject)}" parked`);')).toEqual([]);
    expect(scanSource("console.log(`echo ${email.subject}`);")).toEqual([]);
    expect(scanSource("log(`pipeline: ${email.id} ok`);")).toEqual([]);
  });

  it("finds no unbounded caller text anywhere under src/", () => {
    const offenders: string[] = [];
    for (const file of tsFiles(SRC)) {
      const found = scanSource(fs.readFileSync(file, "utf8"));
      if (found.length) offenders.push(`${path.relative(SRC, file)}: ${[...new Set(found)].join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });
});
