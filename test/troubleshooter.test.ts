/**
 * The troubleshooter is infrastructure for the suite, so it is tested like
 * anything else: a classifier that mis-files a failure is worse than no
 * classifier, because it sends the next person to the wrong place.
 */
import { describe, expect, it } from "vitest";
import { diagnose, failuresFromReport, formatReport, type FailureInput } from "./troubleshooter";

describe("test-failure troubleshooter", () => {
  it("identifies a missing better-sqlite3 native binding", () => {
    const d = diagnose({
      name: "boots",
      message:
        "Cannot find module '../build/Release/better_sqlite3.node'\n" +
        "Require stack:\n- /app/node_modules/better-sqlite3/lib/database.js",
    });
    expect(d.id).toBe("native-better-sqlite3");
    expect(d.fix.join(" ")).toMatch(/rebuild better-sqlite3/);
  });

  it("identifies a Node ABI mismatch as the same native problem", () => {
    const d = diagnose({
      name: "boots",
      message: "Error: The module was compiled against a different Node.js version using NODE_MODULE_VERSION 115",
    });
    expect(d.id).toBe("native-better-sqlite3");
  });

  it("identifies a missing Cairo/Pango toolchain as canvas, not a generic module error", () => {
    const d = diagnose({ name: "rasterizes", message: "error while loading shared libraries: libcairo.so.2" });
    expect(d.id).toBe("native-canvas");
    expect(d.docs).toMatch(/ENV-2/);
  });

  it("identifies a port clash", () => {
    expect(diagnose({ name: "serves", message: "listen EADDRINUSE: address already in use :::33907" }).id).toBe("port-in-use");
  });

  it("identifies a locked database", () => {
    expect(diagnose({ name: "writes", message: "SqliteError: database is locked" }).id).toBe("database-locked");
  });

  it("identifies a timeout", () => {
    expect(diagnose({ name: "syncs", message: "Test timed out in 180000ms." }).id).toBe("timeout");
  });

  it("identifies a missing Playwright browser", () => {
    const d = diagnose({
      name: "renders at 360px",
      message: "browserType.launch: Executable doesn't exist at /root/.cache/ms-playwright/chromium-1148",
    });
    expect(d.id).toBe("playwright-missing");
  });

  it("identifies a snapshot mismatch and says to read the diff first", () => {
    const d = diagnose({ name: "renders", message: "Snapshot mismatch: expected \"a\" to match snapshot" });
    expect(d.id).toBe("snapshot");
    expect(d.fix[0]).toMatch(/read the diff/i);
  });

  it("identifies a TypeScript error and points at the typecheck gate", () => {
    const d = diagnose({
      name: "compiles",
      message: "src/web/server.ts(32,72): error TS6133: 'PROCESS_TEMPLATES' is declared but its value is never read.",
    });
    expect(d.id).toBe("typescript");
    expect(d.fix.join(" ")).toMatch(/npm run typecheck/);
  });

  it("identifies an accidental call to a real API", () => {
    expect(diagnose({ name: "classifies", message: "GEMINI_API_KEY is not set" }).id).toBe("external-credentials");
    expect(diagnose({ name: "syncs", message: "request failed: ENOTFOUND oauth2.googleapis.com" }).id).toBe("external-credentials");
  });

  it("identifies a missing fixture / wrong working directory", () => {
    expect(diagnose({ name: "reads", message: "ENOENT: no such file or directory, open 'data/pack.pdf'" }).id).toBe("missing-file");
  });

  it("identifies an ordinary assertion failure", () => {
    const d = diagnose({ name: "counts", message: "AssertionError: expected 3 to be 4" });
    expect(d.id).toBe("assertion");
  });

  it("falls back to a diagnosis with next steps instead of giving up", () => {
    const d = diagnose({ name: "obscure", message: "something utterly unrecognisable happened" });
    expect(d.id).toBe("unknown");
    expect(d.fix.length).toBeGreaterThan(0);
    expect(d.docs).toBeTruthy();
  });

  it("every rule produces a title, a reason, at least one step and a stable id", () => {
    const samples: FailureInput[] = [
      { message: "Cannot find module 'better_sqlite3.node'" },
      { message: "libcairo.so.2: cannot open shared object file" },
      { message: "libvips-cpp.so.42: cannot open shared object file" },
      { message: "Cannot find module 'vitest'" },
      { message: "EADDRINUSE :::3000" },
      { message: "SQLITE_BUSY: database is locked" },
      { message: "Test timed out in 180000ms." },
      { message: "browserType.launch: Executable doesn't exist" },
      { message: "Snapshot mismatch" },
      { message: "error TS6133" },
      { message: "GEMINI_API_KEY missing" },
      { message: "ENOENT: no such file or directory" },
      { message: "EACCES: permission denied" },
      { message: "Unhandled Rejection" },
      { message: "AssertionError: expected true to be false" },
      { message: "totally unknown" },
    ];
    const ids = new Set<string>();
    for (const s of samples) {
      const d = diagnose(s);
      expect(d.title.length).toBeGreaterThan(0);
      expect(d.why.length).toBeGreaterThan(0);
      expect(d.fix.length).toBeGreaterThan(0);
      expect(d.id).toMatch(/^[a-z0-9-]+$/);
      ids.add(d.id);
    }
    // No two samples collapsed onto the same id by accident.
    expect(ids.size).toBe(samples.length);
  });

  it("searches the stack and the captured output, not just the message", () => {
    // The useful clue is often only in the stack (native loads) or in a
    // console warning (Playwright) rather than in the assertion message.
    expect(diagnose({ message: "boom", stack: "at Object.<anonymous> (/app/node_modules/better-sqlite3/lib/database.js)" }).id)
      .toBe("native-better-sqlite3");
    expect(diagnose({ message: "failed", stdout: ["browserType.launch: Executable doesn't exist"] }).id)
      .toBe("playwright-missing");
  });
});

describe("troubleshooter report parsing", () => {
  it("picks up per-assertion failures", () => {
    const { failures, summary } = failuresFromReport({
      numTotalTestSuites: 1,
      numPassedTests: 1,
      numFailedTests: 1,
      numPendingTests: 0,
      testResults: [
        {
          name: "/app/test/a.test.ts",
          status: "failed",
          assertionResults: [
            { fullName: "a > passes", status: "passed", failureMessages: [] },
            { fullName: "a > fails", status: "failed", failureMessages: ["AssertionError: expected 1 to be 2"] },
          ],
        },
      ],
    });
    expect(failures).toHaveLength(1);
    expect(failures[0].name).toBe("a > fails");
    expect(failures[0].file).toBe("/app/test/a.test.ts");
    expect(summary).toEqual({ files: 1, passed: 1, failed: 1, skipped: 0 });
  });

  it("picks up a file that never ran, so it is not mistaken for a pass", () => {
    const { failures } = failuresFromReport({
      testResults: [
        {
          name: "/app/test/b.test.ts",
          status: "failed",
          message: "Cannot find module '../build/Release/better_sqlite3.node'",
          assertionResults: [],
        },
      ],
    });
    expect(failures).toHaveLength(1);
    expect(diagnose(failures[0]).id).toBe("native-better-sqlite3");
  });

  it("reports a clean run with no failures", () => {
    const { failures } = failuresFromReport({ testResults: [{ name: "/app/test/c.test.ts", status: "passed", assertionResults: [] }] });
    expect(failures).toEqual([]);
    expect(formatReport(failures)).toMatch(/Nothing to diagnose/);
  });

  it("renders a report that names every failure and its category", () => {
    const report = formatReport(
      [
        { file: "test/a.test.ts", name: "a > fails", message: "AssertionError: expected 1 to be 2" },
        { file: "test/b.test.ts", name: "b > dies", message: "SQLITE_BUSY: database is locked" },
      ],
      { files: 2, passed: 5, failed: 2, skipped: 1 }
    );
    expect(report).toMatch(/5 passed · 2 failed · 1 skipped/);
    expect(report).toMatch(/\[assertion\]/);
    expect(report).toMatch(/\[database-locked\]/);
    expect(report).toMatch(/TROUBLESHOOTING\.md/);
  });
});
