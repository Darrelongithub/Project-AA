/**
 * Best-effort extraction of embedded images from a PDF byte stream.
 *
 * Scanned PDFs are usually just big images wrapped in a PDF shell. To hand
 * them to Tesseract we pull the image XObjects out directly:
 *   - /DCTDecode  → the stream is a JPEG; use it as-is
 *   - /FlateDecode→ zlib-inflate, undo PNG predictors if present, re-encode
 *     as PNG
 * Anything exotic (JPXDecode, CCITT, JBIG2…) is skipped — those documents
 * fall through to the Gemini vision tier, which reads PDFs natively.
 */
import * as zlib from "zlib";
import { encodePNG, unfilterPNG } from "./png";

export interface ExtractedImage {
  buffer: Buffer;
  kind: "jpeg" | "png";
  width: number;
  height: number;
}

function num(dict: string, re: RegExp): number | undefined {
  const m = dict.match(re);
  return m ? parseInt(m[1], 10) : undefined;
}

export function extractPdfImages(pdfBuf: Buffer, maxImages = 3): ExtractedImage[] {
  const s = pdfBuf.toString("latin1");
  const out: ExtractedImage[] = [];
  const re = /\/Subtype\s*\/Image/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(s)) !== null && out.length < maxImages) {
    const objStart = s.lastIndexOf(" obj", m.index);
    if (objStart < 0) continue;
    const dictStart = s.indexOf("<<", objStart);
    const streamStart = s.indexOf("stream", m.index);
    const endobj = s.indexOf("endobj", m.index);
    if (dictStart < 0 || streamStart < 0) continue;
    if (endobj > 0 && dictStart > endobj) continue;

    const dict = s.slice(dictStart, streamStart);
    const width = num(dict, /\/Width\s+(\d+)/);
    const height = num(dict, /\/Height\s+(\d+)/);
    if (!width || !height || width > 10000 || height > 10000) continue;
    // The unfilter/re-encode path below assumes 8 bits per component. A
    // 16-bit scan would produce garbage pixels → garbage OCR text that then
    // flows into classification as if it were real. Skip them; the Gemini
    // tier handles those PDFs natively.
    const bpc = num(dict, /\/BitsPerComponent\s+(\d+)/) ?? 8;
    if (bpc !== 8) continue;

    let dataStart = streamStart + "stream".length;
    if (s[dataStart] === "\r") dataStart++;
    if (s[dataStart] === "\n") dataStart++;
    const endstream = s.indexOf("endstream", dataStart);
    if (endstream < 0) continue;
    let dataEnd = endstream;
    while (dataEnd > dataStart && (s[dataEnd - 1] === "\n" || s[dataEnd - 1] === "\r")) dataEnd--;
    const raw = Buffer.from(pdfBuf.subarray(dataStart, dataEnd));

    if (/\/DCTDecode/.test(dict)) {
      out.push({ buffer: raw, kind: "jpeg", width, height });
      continue;
    }

    if (/\/FlateDecode/.test(dict)) {
      let inflated: Buffer;
      try {
        inflated = zlib.inflateSync(raw);
      } catch {
        continue;
      }
      const colors = /\/DeviceRGB/.test(dict) ? 3 : 1;
      const predictor = num(dict, /\/Predictor\s+(\d+)/) ?? 0;
      const expected = width * height * colors;
      let pixels: Buffer;
      if (predictor >= 10) {
        try {
          pixels = unfilterPNG(inflated, width, height, colors);
        } catch {
          continue;
        }
      } else if (inflated.length >= expected) {
        pixels = Buffer.from(inflated.subarray(0, expected));
      } else {
        continue;
      }
      out.push({
        buffer: encodePNG(width, height, colors as 1 | 3, pixels),
        kind: "png",
        width,
        height,
      });
      continue;
    }
    // Unsupported codec → skip; the Gemini tier will handle the document.
  }
  return out;
}
