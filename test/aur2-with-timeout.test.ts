/**
 * Phase 11 (AU-R2): one shared withTimeout helper (src/util/timeout.ts)
 * serves the vision tier and the watcher. Pins the unified contract both
 * migrated call sites now share: values and rejections pass through, a hung
 * promise rejects with "<label> timed out after <ms>ms".
 */
import { describe, expect, it } from "vitest";
import { withTimeout } from "../src/util/timeout";

const hang = (): Promise<string> => new Promise(() => { /* never settles */ });

describe("AU-R2: shared withTimeout", () => {
  it("passes a resolving value through", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 50, "probe")).resolves.toBe("ok");
  });

  it("passes a rejection through untouched", async () => {
    const err = new Error("boom");
    await expect(withTimeout(Promise.reject(err), 50, "probe")).rejects.toBe(err);
  });

  it("rejects a hung promise with the unified timeout message", async () => {
    await expect(withTimeout(hang(), 20, "gemini vision")).rejects.toThrow(
      "gemini vision timed out after 20ms"
    );
  });

  it("settles promptly (no dangling timer keeps the suite hanging)", async () => {
    const start = Date.now();
    await expect(withTimeout(hang(), 10, "probe")).rejects.toThrow(/timed out/);
    await expect(withTimeout(Promise.resolve(1), 10_000, "probe")).resolves.toBe(1);
    expect(Date.now() - start).toBeLessThan(5000);
  });
});
