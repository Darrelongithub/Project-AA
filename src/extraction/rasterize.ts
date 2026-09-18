/**
 * Full-page rasterisation (round 19).
 *
 * Scanned PDFs are images wrapped in a PDF shell. When the embedded-image
 * tier can't pull a usable XObject out (phone "Scan" apps, 16-bit scans,
 * JPX/CCITT/JBIG2 filters), we RENDER each page ourselves with pdf.js and
 * hand the rendered PNGs to Tesseract — no external tools needed.
 *
 * Rendering engine: pdfjs-dist (already a dependency) + node-canvas as the
 * canvas implementation. Sharp/libvips has no PDF loader and Ghostscript is
 * not available on this box, so this is the local, dependency-free path.
 *
 * Hard limits protect the worker from pathological files: a page cap, a
 * per-page pixel cap, and an overall time budget.
 */
import { createCanvas, type Canvas, type CanvasRenderingContext2D } from "canvas";
import { log } from "../util/log";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfjs = require("pdfjs-dist/legacy/build/pdf.js");

/** pdf.js uses DOMMatrix on some rendering paths; give Node a minimal one. */
if (typeof (globalThis as any).DOMMatrix === "undefined") {
  (globalThis as any).DOMMatrix = class DOMMatrix {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
    constructor(init?: number[] | string) {
      if (Array.isArray(init) && init.length === 6) {
        [this.a, this.b, this.c, this.d, this.e, this.f] = init;
      }
    }
    get is2D(): boolean { return true; }
    translate(x = 0, y = 0): any {
      return new (this.constructor as any)([this.a, this.b, this.c, this.d, this.e + x, this.f + y]);
    }
    scale(sx = 1, sy = sx): any {
      return new (this.constructor as any)([this.a * sx, this.b * sx, this.c * sy, this.d * sy, this.e, this.f]);
    }
    multiply(o: any): any {
      return new (this.constructor as any)([
        this.a * o.a + this.c * o.b, this.b * o.a + this.d * o.b,
        this.a * o.c + this.c * o.d, this.b * o.c + this.d * o.d,
        this.a * o.e + this.c * o.f + this.e, this.b * o.e + this.d * o.f + this.f,
      ]);
    }
    inverse(): any {
      const det = this.a * this.d - this.b * this.c;
      if (!det) return new (this.constructor as any)();
      return new (this.constructor as any)([
        this.d / det, -this.b / det, -this.c / det, this.a / det,
        (this.c * this.f - this.d * this.e) / det, (this.b * this.e - this.a * this.f) / det,
      ]);
    }
    transformPoint(p: { x: number; y: number }): { x: number; y: number; z: number; w: number } {
      return {
        x: this.a * p.x + this.c * p.y + this.e,
        y: this.b * p.x + this.d * p.y + this.f,
        z: 0,
        w: 1,
      };
    }
  };
}

export interface RasterPage {
  pageNumber: number;
  /** PNG bytes of the rendered page. */
  buffer: Buffer;
  width: number;
  height: number;
}

export interface RasterReport {
  /** Pages actually rendered and handed to the callback. */
  rendered: number;
  /** Pages dropped because they exceed the pixel cap even at minimum scale. */
  skipped: number;
  /** Pages beyond the per-document page cap (never attempted). */
  overCap: number;
  /** True when the time budget ended the run early. */
  timedOut: boolean;
}

export interface RasterOptions {
  /** Pages beyond this are dropped (the text tier still read them if any). */
  maxPages?: number;
  /** Render scale; 1.0 ≈ 72 dpi. 2.2 ≈ 160 dpi — good OCR, sane size. */
  scale?: number;
  /** Refuse to render pages larger than this (width × height after scale). */
  maxPixelsPerPage?: number;
  /** Overall render time budget in ms. */
  timeoutMs?: number;
}

export const RASTER_DEFAULTS: Required<RasterOptions> = {
  maxPages: Number(process.env.RASTER_MAX_PAGES || 10),
  scale: Number(process.env.RASTER_SCALE || 2.2),
  maxPixelsPerPage: Number(process.env.RASTER_MAX_PIXELS || 4000 * 4000),
  timeoutMs: Number(process.env.RASTER_TIMEOUT_MS || 120_000),
};

/**
 * Render up to `maxPages` pages of a PDF and hand each PNG to `onPage`
 * IMMEDIATELY — the caller OCRs it and drops the buffer, so memory holds
 * one page at a time instead of the whole rendered document. Throws when
 * the file can't be opened (the caller's status check explains why).
 */
export async function rasterizePdf(
  buf: Buffer,
  opts: RasterOptions = {},
  onPage?: (page: RasterPage) => Promise<void> | void
): Promise<RasterReport> {
  const o = { ...RASTER_DEFAULTS, ...opts };
  const started = Date.now();
  const report: RasterReport = { rendered: 0, skipped: 0, overCap: 0, timedOut: false };

  const canvasFactory = {
    create(width: number, height: number): { canvas: Canvas; context: CanvasRenderingContext2D } {
      const canvas = createCanvas(width, height);
      return { canvas, context: canvas.getContext("2d") };
    },
    reset(c: { canvas: Canvas; context: CanvasRenderingContext2D }, width: number, height: number): void {
      c.canvas.width = width;
      c.canvas.height = height;
    },
    destroy(c: { canvas: Canvas; context: CanvasRenderingContext2D }): void {
      c.canvas.width = 0;
      c.canvas.height = 0;
    },
  };

  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    useSystemFonts: true,
    isEvalSupported: false,
    verbosity: 0,
    canvasFactory,
  }).promise;

  try {
    const count = Math.min(doc.numPages, o.maxPages);
    report.overCap += Math.max(0, doc.numPages - count);
    for (let p = 1; p <= count; p++) {
      if (Date.now() - started > o.timeoutMs) {
        report.timedOut = true;
        log(`rasterize: time budget reached after ${report.rendered} page(s)`, "warn");
        break;
      }
      const page = await doc.getPage(p);
      try {
        let viewport = page.getViewport({ scale: o.scale });
        // Guard against absurd page sizes (a hostile PDF can claim 100000×…).
        while (viewport.width * viewport.height > o.maxPixelsPerPage && viewport.scale > 0.5) {
          viewport = page.getViewport({ scale: viewport.scale * 0.8 });
        }
        if (viewport.width * viewport.height > o.maxPixelsPerPage) {
          report.skipped++;
          log(`rasterize: page ${p} skipped — still ${Math.round(viewport.width * viewport.height / 1e6)}MP at minimum scale`, "warn");
          continue;
        }

        const { canvas, context } = canvasFactory.create(
          Math.floor(viewport.width),
          Math.floor(viewport.height)
        );
        // White background: PDFs paint on transparent by default and black
        // text on transparent crushes to black in OCR.
        context.fillStyle = "white";
        context.fillRect(0, 0, canvas.width, canvas.height);

        await page.render({ canvasContext: context as any, viewport, canvasFactory } as any).promise;
        const raster: RasterPage = {
          pageNumber: p,
          buffer: canvas.toBuffer("image/png"),
          width: canvas.width,
          height: canvas.height,
        };
        report.rendered++;
        if (onPage) await onPage(raster);
      } finally {
        page.cleanup();
      }
    }
  } finally {
    await doc.destroy();
  }
  return report;
}

/**
 * Pre-flight an image attachment before OCR: normalise to PNG and apply
 * EXIF rotation (phone photos routinely carry sideways ID shots). Returns
 * null when the bytes aren't a readable image — the caller keeps the
 * original bytes and lets OCR/tier-fallback decide.
 */
export async function preprocessImage(buf: Buffer): Promise<Buffer | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sharp = require("sharp");
    return await sharp(buf, { animated: false })
      .rotate() // auto-rotate by EXIF orientation
      .png()
      .toBuffer();
  } catch (e) {
    // The caller falls back to the raw bytes; OCR decides. Logged because a
    // systematic sharp failure (e.g. TIFF support missing) would otherwise
    // disable preprocessing silently and forever.
    log(`preprocessImage: sharp failed (${(e as Error).message}); using original bytes`);
    return null;
  }
}
