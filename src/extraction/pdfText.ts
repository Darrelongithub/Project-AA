/**
 * Tier 1: embedded text-layer extraction. Free, local, first attempt — always.
 *
 * Note on tooling: the spec named `pdf-parse`, but that package pins a 2018
 * pdf.js core that fails nondeterministically ("bad XRef entry", state
 * leaking between parses) on modern PDF generators. We use the maintained
 * pdf.js directly (pdfjs-dist legacy build) — same engine family, same
 * free/local cost profile, dramatically more reliable.
 *
 * Round 19: failures are CLASSIFIED instead of swallowed. "It didn't work"
 * is not one situation: a password-protected PDF needs a different message
 * to the applicant than a corrupt upload or a valid-but-empty file.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfjs = require("pdfjs-dist/legacy/build/pdf.js");

export type PdfStatus = "ok" | "encrypted" | "corrupt" | "empty";

export interface PdfInspection {
  status: PdfStatus;
  numPages: number;
  /** True when the page cap trimmed the read. */
  truncated: boolean;
  /** Raw error text for logs (never shown to applicants). */
  error?: string;
}

export const PDF_MAX_PAGES = 25;

interface TextItem {
  str: string;
  transform: number[]; // [a, b, c, d, x, y]
}

/** Classify WHY a pdf.js open failed. */
function classifyOpenError(e: unknown): { status: "encrypted" | "corrupt"; error: string } {
  const name = (e as any)?.name || "";
  const msg = String((e as Error)?.message || e);
  if (/password/i.test(name) || /PasswordException/.test(name) || /password/i.test(msg)) {
    return { status: "encrypted", error: msg };
  }
  return { status: "corrupt", error: msg };
}

/** Open a PDF and classify WHY it can't be opened. */
export async function pdfInspect(buf: Buffer): Promise<PdfInspection> {
  try {
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(buf),
      verbosity: 0,
    }).promise;
    const numPages = doc.numPages;
    await doc.destroy();
    if (numPages === 0) return { status: "empty", numPages: 0, truncated: false };
    return { status: "ok", numPages, truncated: numPages > PDF_MAX_PAGES };
  } catch (e) {
    const c = classifyOpenError(e);
    return { status: c.status, numPages: 0, truncated: false, error: c.error };
  }
}

export interface PdfTextResult {
  text: string | null;
  inspection: PdfInspection;
}

/**
 * Text layer + inspection in ONE pass — the document is opened a single
 * time. `text` is null when it could not be opened at all; check
 * `inspection.status` for the reason.
 */
export async function pdfRead(buf: Buffer): Promise<PdfTextResult> {
  let doc: any;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(buf),
      useSystemFonts: true,
      isEvalSupported: false,
      verbosity: 0,
    }).promise;
  } catch (e) {
    const c = classifyOpenError(e);
    return {
      text: null,
      inspection: { status: c.status, numPages: 0, truncated: false, error: c.error },
    };
  }

  const numPages = doc.numPages;
  const inspection: PdfInspection =
    numPages === 0
      ? { status: "empty", numPages: 0, truncated: false }
      : { status: "ok", numPages, truncated: numPages > PDF_MAX_PAGES };

  const lines: string[] = [];
  try {
    const limit = Math.min(numPages, PDF_MAX_PAGES);
    for (let p = 1; p <= limit; p++) {
      const page = await doc.getPage(p);
      try {
        const content = await page.getTextContent();
        lines.push(itemsToLines(content.items as TextItem[]));
      } finally {
        page.cleanup();
      }
    }
  } catch (e) {
    await doc.destroy();
    return {
      text: null,
      inspection: { ...inspection, status: "corrupt", error: String((e as Error)?.message || e) },
    };
  }
  await doc.destroy();
  return { text: lines.join("\n"), inspection };
}

/** Legacy signature kept for callers that only want the text. */
export async function pdfExtractText(buf: Buffer): Promise<string | null> {
  const r = await pdfRead(buf);
  return r.text;
}

/** Reassemble text items into visual lines (grouped by y-coordinate). */
function itemsToLines(items: TextItem[]): string {
  const rows = new Map<number, Array<{ x: number; str: string }>>();
  for (const it of items) {
    if (!it.str) continue;
    const y = Math.round(it.transform[5]);
    const x = it.transform[4];
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y)!.push({ x, str: it.str });
  }
  return [...rows.entries()]
    .sort((a, b) => b[0] - a[0]) // top of page first
    .map(([, cells]) => cells.sort((a, b) => a.x - b.x).map((c) => c.str).join(" "))
    .join("\n");
}
