#!/usr/bin/env tsx
/**
 * npm run test:troubleshoot
 *
 * Runs the suite, then explains every failure: what it means and what to do
 * next. The classification itself lives in `test/troubleshooter.ts` so it can
 * be unit-tested and shared with the Vitest reporter that runs after `npm test`.
 *
 * Usage
 *   npm run test:troubleshoot                 # run the suite, then diagnose
 *   npm run test:troubleshoot -- --file X     # run one file, then diagnose
 *   npm run test:troubleshoot -- --from x.json# diagnose an existing JSON report
 *   npm run test:troubleshoot -- --json       # machine-readable output
 *   npm run test:troubleshoot -- --no-run     # environment checks only
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  diagnose, failuresFromReport, formatReport,
  type FailureInput, type JsonReport, type SuiteSummary,
} from "../test/troubleshooter";

/** Cheap pre-flight checks for the environment gaps that cause whole-suite failures. */
function environmentChecks(): string[] {
  const notes: string[] = [];
  const node = process.versions.node;
  const major = Number(node.split(".")[0]);
  const minor = Number(node.split(".")[1]);
  if (major < 22 || (major === 22 && minor < 13)) {
    notes.push(`Node ${node} is below the declared minimum (>=22.13.0) — pdf.js 6 will not run.`);
  }
  // .mts is ESM, so the check needs a CJS require of its own rather than the
  // bare global (which would report every module as missing).
  const require = createRequire(import.meta.url);
  for (const mod of ["better-sqlite3", "canvas", "sharp"] as const) {
    try {
      require(mod);
    } catch (e) {
      const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
      notes.push(`Native module '${mod}' is not loadable: ${msg}`);
    }
  }
  return notes;
}

function main(): void {
  const argv = process.argv.slice(2);
  const wantJson = argv.includes("--json");
  const noRun = argv.includes("--no-run");
  const fromIdx = argv.indexOf("--from");
  const fileIdx = argv.indexOf("--file");
  // .mts runs as ESM under tsx, so __dirname is not defined here.
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

  const notes = environmentChecks();
  if (notes.length) {
    console.error("Environment checks:");
    for (const n of notes) console.error(`  ! ${n}`);
    console.error("");
  }

  let report: JsonReport;
  if (fromIdx >= 0 && argv[fromIdx + 1]) {
    report = JSON.parse(readFileSync(argv[fromIdx + 1], "utf8")) as JsonReport;
  } else if (noRun) {
    process.exit(notes.length ? 1 : 0);
  } else {
    const dir = mkdtempSync(join(tmpdir(), "aa-troubleshoot-"));
    const outFile = join(dir, "report.json");
    try {
      const args = ["run", "--reporter=json", `--outputFile=${outFile}`];
      if (fileIdx >= 0 && argv[fileIdx + 1]) args.push(argv[fileIdx + 1]);
      execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", ["vitest", ...args], {
        cwd: repoRoot,
        stdio: ["ignore", "ignore", "inherit"],
      });
    } catch {
      // vitest exits non-zero when tests fail — that is exactly the case we
      // are here to explain, so fall through and read the report.
    }
    try {
      report = JSON.parse(readFileSync(outFile, "utf8")) as JsonReport;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const { failures, summary } = failuresFromReport(report);

  if (wantJson) {
    console.log(
      JSON.stringify(
        {
          summary,
          environment: notes,
          failures: failures.map((f) => ({ ...f, diagnosis: diagnose(f) })),
        },
        null,
        2
      )
    );
  } else {
    console.log(formatReport(failures, summary));
  }

  process.exit(failures.length ? 1 : 0);
}

main();
