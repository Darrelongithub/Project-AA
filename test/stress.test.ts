/**
 * Stress harness smoke test (OR gate). The full 1,000-case run is
 * `npm run stress`; here a reduced slice runs under vitest so the CI loop
 * catches regressions in the volume invariants: no crashes, no auto-admit
 * with missing docs or below-floor grades, exact matrix-missing math,
 * KCPE never demanded, refs always valid, duplicates always skipped.
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("stress harness (OR gate)", () => {
  it("runs the sampled stress suite clean", () => {
    const out = execFileSync(
      resolve(__dirname, "../node_modules/.bin/tsx"),
      [resolve(__dirname, "../src/cli/stress.ts")],
      {
        env: { ...process.env, STRESS_N: "120", DISABLE_OCR: "1" },
        encoding: "utf8",
        timeout: 120_000,
      }
    );
    expect(out).toContain("RESULT:");
    expect(out).toMatch(/120\/120 cases clean — ALL GREEN/);
    expect(out).not.toContain("FAILED CASES");
    expect(out).not.toContain("DETERMINISM FAILURE");
  }, 150_000);
});
