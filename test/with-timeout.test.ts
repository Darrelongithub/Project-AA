import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiVisionAdapter, VisionUnavailableError } from "../src/extraction/gemini";
import { GeminiWatcher } from "../src/watcher";
import { TimeoutError, withTimeout } from "../src/util/withTimeout";
import type { Attachment, WatcherInput } from "../src/types";

afterEach(() => vi.useRealTimers());

describe("shared withTimeout behavior", () => {
  it("returns a resolved value and clears its deadline timer", async () => {
    vi.useFakeTimers();

    await expect(withTimeout(Promise.resolve("done"), 500, "unit operation")).resolves.toBe("done");

    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves the original rejection and clears its deadline timer", async () => {
    vi.useFakeTimers();
    const failure = new Error("service unavailable");

    await expect(withTimeout(Promise.reject(failure), 500, "unit operation")).rejects.toBe(failure);

    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects with the same typed timeout at the configured deadline", async () => {
    vi.useFakeTimers();
    const pending = withTimeout(new Promise<never>(() => undefined), 75, "shared operation");
    let thrown: unknown = undefined;
    const handled = pending.catch((error: unknown) => { thrown = error; });

    await vi.advanceTimersByTimeAsync(74);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await handled;
    expect(thrown).toBeInstanceOf(TimeoutError);
    expect(thrown).toMatchObject({
      name: "TimeoutError",
      code: "TIMEOUT",
      label: "shared operation",
      timeoutMs: 75,
      message: "shared operation timed out after 75ms",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives Gemini vision and the watcher equivalent deadlines for a hung model", { timeout: 3000 }, async () => {
    const hangingModel = { generateContent: () => new Promise<never>(() => undefined) };
    const vision = new GeminiVisionAdapter("unused-test-key", "test-model", hangingModel, 25);
    const attachment: Attachment = {
      filename: "timeout.pdf",
      mimeType: "application/pdf",
      content: Buffer.from("offline timeout test"),
    };

    const visionFailure = await vision.extractDocument(attachment).then(
      () => null,
      (error: unknown) => error
    );
    expect(visionFailure).toBeInstanceOf(VisionUnavailableError);
    expect(visionFailure).toMatchObject({ kind: "timeout" });

    const watcher = new GeminiWatcher("unused-test-key", "test-model", hangingModel, 25);
    const input: WatcherInput = { applicantEmail: "timeout@example.test", subject: "Timeout", docs: [] };
    const result = await watcher.watch(input);
    expect(result.flagged).toBe(true);
    expect(result.concerns.join(" ")).toMatch(/timed out after 25ms/i);
  });
});
