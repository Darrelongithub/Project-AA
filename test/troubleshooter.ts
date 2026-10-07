/**
 * Test-failure troubleshooter — the classifier.
 *
 * `npm test` tells you WHICH test failed. This module answers the question the
 * suite never answers: *why*, and *what do I do next*.
 *
 * It is deliberately dependency-free and pure, so it can be
 *   - called from the standalone CLI (`npm run test:troubleshoot`),
 *   - called from the Vitest reporter that runs after every `npm test`, and
 *   - unit-tested itself (see `test/troubleshooter.test.ts`).
 *
 * Every rule below was written against a failure this repository has actually
 * produced; the `docs` field points at the standing record in BUGS.md or
 * TROUBLESHOOTING.md where one exists.
 */

/** One failed test, as much as the runner told us about it. */
export interface FailureInput {
  /** Full test name (`describe > it`). */
  name?: string;
  /** File the failure came from, when the runner knows. */
  file?: string;
  /** Error message, or the file-level failure message. */
  message?: string;
  /** Stack trace, when there is one. */
  stack?: string;
  /** Console output captured during the test. */
  stdout?: string[];
}

export interface Diagnosis {
  /** Stable machine-readable category id. */
  id: string;
  /** One-line human title. */
  title: string;
  /** What the failure actually means. */
  why: string;
  /** Ordered things to try. */
  fix: string[];
  /** Where the standing record lives, if anywhere. */
  docs?: string;
}

interface Rule {
  id: string;
  title: string;
  why: string;
  fix: string[];
  docs?: string;
  /** Matched against message + stack + stdout, lowercased. */
  test: RegExp;
}

/**
 * Ordered most-specific first — the first match wins, so a native-module load
 * failure is never reported as a generic "cannot find module".
 */
const RULES: Rule[] = [
  {
    id: "native-better-sqlite3",
    title: "better-sqlite3 native binding is missing or was built for another Node",
    why:
      "better-sqlite3 is a native addon. Its prebuilt binary is downloaded at install time and is tied to " +
      "one Node ABI, so it breaks whenever Node is upgraded, when the download is blocked, or when the " +
      "fallback source build cannot fetch Node headers.",
    fix: [
      "npm rebuild better-sqlite3 --build-from-source",
      "If the build cannot download Node headers (offline/CI without nodejs.org), point it at the ones Node ships:",
      "  npm_config_nodedir=\"$(dirname \"$(dirname \"$(which node)\")\")\" npm rebuild better-sqlite3 --build-from-source",
      "Confirm: node -e \"new (require('better-sqlite3'))(':memory:')\"",
    ],
    docs: "TROUBLESHOOTING.md#native-modules",
    test: /better[-_]?sqlite3|better_sqlite3\.node|node_module_version|was compiled against a different node/i,
  },
  {
    id: "native-canvas",
    title: "canvas native library is unavailable",
    why:
      "The `canvas` package needs Cairo/Pango at build time. Without it the raster tier of PDF extraction " +
      "cannot run, and any test that insists on real rasterization fails. The product is designed to fall " +
      "back to a human queue rather than guess, so this is a capability gap, not a wrong answer.",
    fix: [
      "sudo apt-get install -y build-essential libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev",
      "npm rebuild canvas --build-from-source",
      "Confirm: node -e \"require('canvas')\"",
      "Or accept the documented gap and re-run; raster-only paths are expected to fall back (BUGS.md ENV-2).",
    ],
    docs: "BUGS.md (ENV-2)",
    test: /cannot find module 'canvas'|libcairo|cairo\.so|libpango|pango\.so|libgl\.so|node-canvas/i,
  },
  {
    id: "sharp",
    title: "sharp native library is unavailable",
    why: "sharp ships platform-specific binaries; a mismatch makes image preprocessing fail.",
    fix: ["npm rebuild sharp --build-from-source", "Confirm: node -e \"require('sharp')\""],
    docs: "TROUBLESHOOTING.md#native-modules",
    test: /cannot find module 'sharp'|libvips|vips\.so/i,
  },
  {
    id: "missing-module",
    title: "A module could not be resolved",
    why:
      "`node_modules` is out of sync with `package-lock.json` — usually after switching branches or after a " +
      "partial install (for example `npm install --ignore-scripts`).",
    fix: ["npm ci --no-audit --no-fund", "Then re-run: npm test"],
    docs: "TROUBLESHOOTING.md#installation",
    test: /cannot find module '[^']+'|failed to resolve import|err_module_not_found/i,
  },
  {
    id: "port-in-use",
    title: "The test server could not bind its port",
    why: "Another process (often a previous run that did not exit) already holds the port the web suite binds.",
    fix: [
      "Find it: lsof -i :<port>   (or: ss -ltnp | grep <port>)",
      "Stop the stale run, then re-run: npm test",
      "As a last resort: pkill -f vitest",
    ],
    docs: "TROUBLESHOOTING.md#ports",
    test: /eaddrinuse|address already in use|listen eaddrinuse/i,
  },
  {
    id: "database-locked",
    title: "SQLite reported the database as locked or busy",
    why:
      "Two writers touched the same file at once. This suite is designed to be serialisable, so a busy " +
      "database almost always means a leftover process from an earlier run, or a test that forgot to close " +
      "its database.",
    fix: [
      "pkill -f vitest ; pkill -f \"tsx src/cli\"",
      "Remove stray temp databases: git status --porcelain | grep sqlite",
      "Re-run: npm test",
    ],
    docs: "TROUBLESHOOTING.md#database",
    test: /sqlite_busy|database is locked|database table is locked|sqlITE_BUSY/i,
  },
  {
    id: "timeout",
    title: "The test exceeded its time limit",
    why:
      "Either the test is genuinely slow (OCR, PDF rasterization, a simulated Gmail round trip) or it is " +
      "waiting on something that will never arrive — a network call, or a promise that never settles. The " +
      "suite sets testTimeout and hookTimeout to 180s, so a breach is a real signal.",
    fix: [
      "Re-run just this file — a timeout under parallel load often passes alone:",
      "  npx vitest run <file>",
      "If it is waiting on the network, confirm nothing in the test calls an external host (this suite must run offline).",
      "If it is genuinely slow, raise the timeout on that test only; do not raise the global one.",
    ],
    docs: "TROUBLESHOOTING.md#timeouts",
    test: /test timed out in \d+|exceeded timeout of \d+|hook timed out|expected .* to complete within/i,
  },
  {
    id: "playwright-missing",
    title: "Playwright Chromium is not installed",
    why:
      "`test/responsive.test.ts` renders the UI in a real browser. It deliberately SKIPS when the browser " +
      "binary is absent, so a failure here means the browser was found but could not start (or the skip was " +
      "removed and the box has no browser).",
    fix: [
      "npx playwright install chromium",
      "Then re-run: npx vitest run test/responsive.test.ts",
      "If no browser can be installed, record the skip — do not delete the assertions (BUGS.md ENV-1).",
    ],
    docs: "BUGS.md (ENV-1)",
    test: /playwright|executable doesn't exist|browsertype\.launch|looks like you installed playwright|chromium revision/i,
  },
  {
    id: "snapshot",
    title: "A snapshot no longer matches",
    why:
      "A stored snapshot disagrees with the current output. That is either an intended change that needs " +
      "recording, or an unintended one that needs fixing — the diff tells you which.",
    fix: [
      "Read the diff first: is the new output correct?",
      "If it is intended:  npx vitest run -u",
      "If it is not: fix the source, not the snapshot.",
    ],
    docs: "TROUBLESHOOTING.md#snapshots",
    test: /snapshot .*(mismatch|does not match|not found|obsolete)|toMatchSnapshot|toMatchInlineSnapshot/i,
  },
  {
    id: "typescript",
    title: "A TypeScript error surfaced through the test run",
    why:
      "Vitest transpiles without type-checking, so type errors normally only appear in `npm run typecheck`. " +
      "Seeing one here means the failure came from a build/transform diagnostic rather than from an assertion.",
    fix: [
      "npm run typecheck",
      "Fix the reported error — `noUnusedLocals` is on, so an unused import is a hard error, not a warning.",
      "Then re-run: npm test",
    ],
    docs: "BUGS.md (PROD-12)",
    test: /\bts\d{4,5}\b|error TS\d+|is declared but its value is never read|object is possibly 'undefined'/i,
  },
  {
    id: "external-credentials",
    title: "The test reached for real credentials or an external API",
    why:
      "The suite must run with no network and no secrets. A Gemini/Gmail failure means a test is not using " +
      "the mock adapters, or an .env file is pulling a live configuration into the test process.",
    fix: [
      "Check for a stray .env in the repo root — tests should not depend on it.",
      "Confirm the test builds its own adapters (see test/helpers.ts) instead of importing the live ones.",
      "Never paste a real key into a test; use the mock/sandbox adapters.",
    ],
    docs: "BUGS.md (OP-5)",
    test: /gemini_api_key|api key not valid|googleapis|gmail.*(401|403|quota)|fetch failed|ENOTFOUND|ECONNREFUSED/i,
  },
  {
    id: "missing-file",
    title: "A file the test needed was not there",
    why:
      "Either a fixture is missing, or the test is running from the wrong working directory. Several tests " +
      "assert the app behaves correctly when it is started OUTSIDE the repository, so they change cwd " +
      "deliberately and must restore it.",
    fix: [
      "Run from the repository root: cd \"$(git rev-parse --show-toplevel)\" && npm test",
      "Check the path in the error against test/ and src/web/ — fixtures are committed, generated files are not.",
    ],
    docs: "TROUBLESHOOTING.md#working-directory",
    test: /enoent|no such file or directory|eisdir|not a directory/i,
  },
  {
    id: "permission",
    title: "The test lacked permission to read or write a file",
    why: "A fixture, temp database or archive path is not writable by the current user.",
    fix: ["Check ownership of the path in the error", "Re-run from a writable directory (not /root-owned paths)"],
    docs: "TROUBLESHOOTING.md#working-directory",
    test: /eacces|permission denied|eperm|operation not permitted/i,
  },
  {
    id: "unhandled",
    title: "The test threw an unhandled error",
    why:
      "An exception escaped the test — often an async rejection after the test finished, or an error thrown " +
      "in a hook (beforeAll/afterAll). The stack is the only real clue, so it is printed below.",
    fix: [
      "Read the stack: the first frame inside src/ is usually the real culprit.",
      "If it names a hook, the failure is setup/teardown, not the test body.",
      "Re-run the file alone to remove cross-test interference: npx vitest run <file>",
    ],
    docs: "TROUBLESHOOTING.md#unhandled",
    test: /unhandled rejection|unhandled error|uncaught exception|errors occurred while running tests/i,
  },
  {
    id: "assertion",
    title: "An assertion failed",
    why:
      "The code produced something other than what the test expects. This is the ordinary case — the diff " +
      "between expected and received is the whole diagnosis.",
    fix: [
      "Read the expected/received pair below and decide which side is wrong.",
      "If the expectation is stale (the behaviour changed on purpose), update the test and say so in the commit.",
      "If the behaviour is wrong, fix src/ — the test was doing its job.",
    ],
    docs: "TROUBLESHOOTING.md#assertions",
    test: /expected .*(to be|to equal|to contain|to match)|assertionerror|expect\(/i,
  },
];

/** Everything a rule is matched against, flattened into one searchable string. */
export function failureHaystack(f: FailureInput): string {
  return [f.name, f.file, f.message, f.stack, ...(f.stdout ?? [])]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join("\n");
}

/**
 * Classify one failure. Always returns a diagnosis — the last rule is a
 * catch-all, so a failing test can never be reported without next steps.
 */
export function diagnose(f: FailureInput): Diagnosis {
  const hay = failureHaystack(f);
  const match = RULES.find((r) => r.test.test(hay));
  if (!match) {
    return {
      id: "unknown",
      title: "Unclassified failure",
      why:
        "None of the known patterns matched. That is useful information in itself: this is either a new " +
        "failure mode or an environment gap this troubleshooter has not seen before.",
      fix: [
        "Read the message and stack below — they are printed verbatim.",
        "Re-run the file alone: npx vitest run " + (f.file ?? "<file>"),
        "If this is a repeatable environment gap, add a rule to test/troubleshooter.ts and pin it with a test.",
      ],
      docs: "TROUBLESHOOTING.md#unclassified",
    };
  }
  return { id: match.id, title: match.title, why: match.why, fix: match.fix, docs: match.docs };
}

/* ── Reading a Vitest JSON report ─────────────────────────────────────────── */

export interface JsonAssertion {
  fullName?: string;
  title?: string;
  status?: string;
  failureMessages?: string[];
}

export interface JsonFileResult {
  name?: string;
  status?: string;
  message?: string;
  assertionResults?: JsonAssertion[];
}

export interface JsonReport {
  numTotalTestSuites?: number;
  numPassedTests?: number;
  numFailedTests?: number;
  numPendingTests?: number;
  testResults?: JsonFileResult[];
}

export interface SuiteSummary {
  files: number;
  passed: number;
  failed: number;
  skipped: number;
}

/**
 * Flatten a Vitest JSON report into failures the classifier can read.
 * A file that never ran (import error, missing native module, syntax error)
 * reports one file-level message and no assertions — that is handled first so it
 * is never mistaken for a passing file with no tests.
 */
export function failuresFromReport(report: JsonReport): { failures: FailureInput[]; summary: SuiteSummary } {
  const failures: FailureInput[] = [];
  for (const file of report.testResults ?? []) {
    if (file.status === "failed" && file.message && !(file.assertionResults ?? []).length) {
      failures.push({ file: file.name, name: "(file failed to run)", message: file.message, stack: file.message });
      continue;
    }
    for (const a of file.assertionResults ?? []) {
      if (a.status !== "failed") continue;
      const message = (a.failureMessages ?? []).join("\n");
      failures.push({ file: file.name, name: a.fullName ?? a.title, message, stack: message });
    }
  }
  return {
    failures,
    summary: {
      files: report.numTotalTestSuites ?? (report.testResults ?? []).length,
      passed: report.numPassedTests ?? 0,
      failed: report.numFailedTests ?? failures.length,
      skipped: report.numPendingTests ?? 0,
    },
  };
}

/**
 * Wrap text to `width`. The first line is prefixed with `indent`, every
 * continuation line with `hang` — repeating the bullet on each line made
 * numbered steps read as "3. … 3. …".
 */
export function wrap(text: string, width = 92, indent = "", hang = indent): string {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (!paragraph.trim()) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (!line) {
        line = indent + word;
      } else if ((line + " " + word).length > width) {
        out.push(line);
        line = hang + word;
      } else {
        line += " " + word;
      }
    }
    if (line) out.push(line);
  }
  return out.join("\n");
}

/** Render one diagnosis block as plain text. */
export function formatDiagnosis(f: FailureInput, d: Diagnosis, index: number, total: number): string {
  const lines: string[] = [];
  lines.push(`── ${index}/${total}  ${f.name ?? "(unnamed test)"}${f.file ? `  —  ${f.file}` : ""}`);
  lines.push(`   ${d.title}   [${d.id}]`);
  lines.push("");
  lines.push(wrap(d.why, 92, "   WHY   ", "         "));
  lines.push("");
  lines.push("   NEXT");
  d.fix.forEach((step, i) => {
    const sub = step.startsWith("  ");
    const bullet = sub ? "        " : `   ${i + 1}. `;
    lines.push(wrap(step.trim(), 92, bullet, " ".repeat(bullet.length)));
  });
  if (d.docs) lines.push(`\n   SEE   ${d.docs}`);
  if (f.message) {
    lines.push("");
    lines.push("   MESSAGE");
    lines.push(wrap(f.message.split("\n").slice(0, 12).join("\n"), 92, "     "));
  }
  return lines.join("\n");
}

/** Render the whole report. */
export function formatReport(failures: FailureInput[], summary?: SuiteSummary): string {
  const head: string[] = [];
  head.push("");
  head.push("═══ TEST TROUBLESHOOTER ═══════════════════════════════════════════════════════════════");
  if (summary) {
    head.push(
      `  ${summary.passed} passed · ${summary.failed} failed · ${summary.skipped} skipped · ${summary.files} file(s)`
    );
  }
  if (!failures.length) {
    head.push("");
    head.push("  Nothing to diagnose — no failures were reported.");
    head.push("");
    return head.join("\n");
  }
  head.push("");
  head.push(`  ${failures.length} failure(s). Each one below is classified with what to do about it.`);
  head.push("");
  const body = failures.map((f, i) => formatDiagnosis(f, diagnose(f), i + 1, failures.length));
  const tail = [
    "",
    "────────────────────────────────────────────────────────────────────────────────────────",
    "  Full runbook and decision flowchart: TROUBLESHOOTING.md",
    "  Re-run with the same analysis:       npm run test:troubleshoot",
    "",
  ];
  return [...head, body.join("\n\n"), ...tail].join("\n");
}
