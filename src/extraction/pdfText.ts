/**
 * Tier 1: embedded text-layer extraction. Free, local, first attempt — always.
 *
 * Note on tooling: the spec named `pdf-parse`, but that package pins a 2018
 * pdf.js core that fails nondeterministically ("bad XRef entry", state
 * leaking between parses) on modern PDF generators. We use the maintained
 * pdf.js directly (pdfjs-dist legacy build) — same engine family, same
 * free/local cost profile, dramatically more reliable.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfjs = require("pdfjs-dist/legacy/build/pdf.js");

interface TextItem {
  str: string;
  transform: number[]; // [a, b, c, d, x, y]
}

export async function pdfExtractText(buf: Buffer): Promise<string | null> {
  try {
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(buf),
      useSystemFonts: true,
      isEvalSupported: false,
      verbosity: 0,
    }).promise;

    const lines: string[] = [];
    try {
      for (let p = 1; p <= Math.min(doc.numPages, 25); p++) {
        const page = await doc.getPage(p);
        try {
          const content = await page.getTextContent();
          lines.push(itemsToLines(content.items as TextItem[]));
        } finally {
          page.cleanup();
        }
      }
    } finally {
      await doc.destroy();
    }
    return lines.join("\n");
  } catch {
    return null;
  }
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
