/**
 * Tier 2: Tesseract.js OCR. Free, local. Runs on images only — for PDFs the
 * caller first pulls embedded images out (see pdfImages.ts).
 *
 * If Tesseract can't initialise (e.g. no network to fetch its language
 * data), this tier reports failure and the fixed fallback chain continues
 * to Gemini. The chain order itself never changes.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createWorker } from "tesseract.js";
import { log } from "../util/log";

let workerPromise: Promise<any> | null = null;
const OCR_TIMEOUT_MS = Number(process.env.OCR_TIMEOUT_MS || 90_000);

async function getWorker(): Promise<any> {
  if (!workerPromise) {
    // Language data ships in ./tessdata (eng.traineddata.gz) so OCR works
    // offline out of the box; if it's missing, Tesseract downloads it here.
    const langPath = path.join(process.cwd(), "tessdata");
    fs.mkdirSync(langPath, { recursive: true });
    workerPromise = createWorker("eng", 1, { langPath });
    // Don't crash the process if the worker dies; let the next call retry.
    workerPromise.catch(() => {
      workerPromise = null;
    });
  }
  return workerPromise;
}

export async function ocrImage(image: Buffer, ext: "png" | "jpg" = "png"): Promise<string | null> {
  let tmpFile: string | null = null;
  try {
    const worker = await getWorker();
    tmpFile = path.join(os.tmpdir(), `emailsorter-ocr-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
    fs.writeFileSync(tmpFile, image);

    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race<string>([
        worker.recognize(tmpFile).then((r: any) => (r?.data?.text as string) ?? ""),
        new Promise<string>((_, reject) => {
          timer = setTimeout(() => reject(new Error("OCR timeout")), OCR_TIMEOUT_MS);
        }),
      ]);
      return result;
    } catch (e) {
      // A race timeout does NOT cancel worker.recognize — the job keeps
      // grinding inside the worker and the NEXT ocr call queues behind it,
      // making every later "timeout" late too. Kill the worker; the next
      // call recreates it.
      if ((e as Error).message === "OCR timeout") {
        workerPromise = null;
        worker.terminate().catch(() => {
          /* already dead */
        });
      }
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch (e) {
    log(`ocr: failed (${(e as Error).message}); falling through to next tier`);
    return null;
  } finally {
    if (tmpFile) {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        /* ignore */
      }
    }
  }
}

export async function shutdownOcr(): Promise<void> {
  if (workerPromise) {
    try {
      const w = await workerPromise;
      await w.terminate();
    } catch {
      /* ignore */
    }
    workerPromise = null;
  }
}
