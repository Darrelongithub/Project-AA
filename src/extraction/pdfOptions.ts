/**
 * Every pdf.js open in this codebase goes through here — because every PDF we
 * open arrived as an email attachment, i.e. it is UNTRUSTED input.
 *
 * The options are the security-relevant ones, not tuning:
 *   - `isEvalSupported: false`  — never evaluate embedded JavaScript or font
 *     programs (this is the mitigation for the pdfjs "arbitrary JavaScript
 *     execution on a malicious PDF" advisory);
 *   - `enableXfa: false`        — XFA forms carry their own scripting;
 *   - `disableRange/Stream/AutoFetch: true` — we hand pdf.js a complete local
 *     buffer, so it must never reach out for more bytes;
 *   - `verbosity: 0`            — a hostile file must not be able to spam logs.
 *
 * Text extraction and page rendering differ in exactly one respect: rendering
 * draws glyphs (it feeds OCR), so it keeps font faces; a text-layer read never
 * needs them, so that parser surface is switched off too.
 *
 * On top of the options there is a hard wall-clock budget: one pathological
 * file must not occupy an intake pass forever. A timeout is reported as its own
 * status so the file goes to a person instead of being guessed at.
 */
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import { envInt } from "../util/envnum";

type PdfjsModule = { getDocument: (params: Record<string, unknown>) => PdfLoadingTask };
let pdfjsPromise: Promise<PdfjsModule> | null = null;

/**
 * pdf.js 6 ships ESM only, and this project compiles to CommonJS where
 * TypeScript downlevels a bare `import()` into `require()` (which cannot load
 * an ES module). The load therefore goes through `pdfjs-esm.mjs`: a one-line
 * bridge that Node's real ESM loader executes. It is externalized in
 * `vitest.config.ts` so no bundler transforms it — inside a transformed module
 * a runtime `import()` has no import callback at all ("A dynamic import
 * callback was not specified"), which is what blocked this upgrade before.
 * CommonJS may `require()` an ES module on Node >= 20.19 / >= 22.12, and pdf.js
 * 6 itself requires Node >= 22.13 — hence the `engines` bump.
 *
 * Memoised: one load per process, and every open still goes through the
 * hardened options below.
 */
export function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const bridge = require("./pdfjs-esm.mjs") as { loadPdfjs: () => Promise<unknown> };
    pdfjsPromise = bridge.loadPdfjs().then((loaded) => {
      const mod = ((loaded as { default?: PdfjsModule }).default ?? loaded) as PdfjsModule;
      if (typeof mod?.getDocument !== "function") throw new Error("pdfjs-dist exposed no getDocument");
      return mod;
    });
  }
  return pdfjsPromise;
}

/** Options applied to EVERY open. Never overridable by a caller. */
export const HARDENED_PDF_OPTIONS = {
  isEvalSupported: false,
  enableXfa: false,
  disableRange: true,
  disableStream: true,
  disableAutoFetch: true,
  verbosity: 0,
} as const;

/** Text-layer reads: no font faces either (nothing is drawn). */
export const TEXT_PDF_OPTIONS = { ...HARDENED_PDF_OPTIONS, disableFontFace: true, useSystemFonts: true } as const;

/** Page rendering (the OCR fallback): fonts stay on, glyphs must draw. */
export const RENDER_PDF_OPTIONS = { ...HARDENED_PDF_OPTIONS, useSystemFonts: true } as const;

/** Wall-clock budget for opening + parsing one PDF. PROVISIONAL: 20 s. */
export const PDF_PARSE_TIMEOUT_MS = envInt(process.env.PDF_PARSE_TIMEOUT_MS, 20_000);

export class PdfTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`PDF parsing exceeded the ${timeoutMs} ms budget`);
    this.name = "PdfTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** Rejects after `ms`. Exported so the budget itself is testable without a
 *  pathological PDF. */
export function promiseWithTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  return Promise.race([work, guard]).finally(() => { if (timer) clearTimeout(timer); });
}

/**
 * Open a document with the hardened options and the parse budget. On timeout
 * the loading task is destroyed so pdf.js does not keep working in the
 * background, and the error is a {@link PdfTimeoutError} the caller can
 * distinguish from a corrupt or encrypted file.
 */
/** What pdf.js hands back: a promise for the document, and a way to stop work. */
export interface PdfLoadingTask {
  promise: Promise<PDFDocumentProxy>;
  destroy?: () => Promise<void>;
}
export type PdfOpener = (params: Record<string, unknown>) => Promise<PdfLoadingTask> | PdfLoadingTask;

/**
 * An opened document plus its teardown. pdf.js 4+ removed
 * `PDFDocumentProxy.destroy()` — teardown belongs to the loading task — so
 * callers close through this handle instead of reaching for a method that only
 * exists on some versions.
 */
export interface OpenedPdf {
  doc: PDFDocumentProxy;
  close: () => Promise<void>;
}

export async function openPdfDocument(
  data: Uint8Array,
  kind: "text" | "render",
  extra: Record<string, unknown> = {},
  timeoutMs: number = PDF_PARSE_TIMEOUT_MS,
  opener?: PdfOpener
): Promise<OpenedPdf> {
  const options = kind === "render" ? RENDER_PDF_OPTIONS : TEXT_PDF_OPTIONS;
  const open = opener ?? (async (params: Record<string, unknown>) => (await loadPdfjs()).getDocument(params));
  const task = await open({ ...extra, data, ...options });
  const close = async (): Promise<void> => { try { await task.destroy?.(); } catch { /* best effort */ } };
  try {
    const doc = await promiseWithTimeout(task.promise as Promise<PDFDocumentProxy>, timeoutMs, () => new PdfTimeoutError(timeoutMs));
    return { doc, close };
  } catch (e) {
    await close(); // the budget expired or the file is bad: stop pdf.js working
    throw e;
  }
}
