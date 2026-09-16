/**
 * Minimal PNG codec + bitmap text renderer.
 *
 * - encodePNG / unfilterPNG are used to reconstruct images pulled out of
 *   scanned PDFs (FlateDecode image XObjects) so Tesseract can read them.
 * - renderTextImage rasterises text with a built-in 5x7 bitmap font; the
 *   simulation harness uses it to build genuine "scanned" PDFs (image-only,
 *   no embedded text layer) that exercise the real OCR path.
 */
import * as zlib from "zlib";

// ── CRC32 ──────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Encode raw (filter-less) pixel rows into a grayscale/RGB PNG. */
export function encodePNG(
  width: number,
  height: number,
  channels: 1 | 3,
  raw: Buffer
): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = channels === 1 ? 0 : 2; // color type: gray | rgb
  const stride = width * channels;
  const withFilters = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    withFilters[y * (stride + 1)] = 0; // filter: none
    raw.copy(withFilters, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(withFilters);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Reverse PNG row filters (needed when a PDF stores predictor-encoded images). */
export function unfilterPNG(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  bitDepth = 8
): Buffer {
  const bpp = Math.max(1, Math.floor((channels * bitDepth) / 8));
  const stride = Math.ceil((width * channels * bitDepth) / 8);
  const out = Buffer.alloc(height * stride);
  let off = 0;
  for (let y = 0; y < height; y++) {
    const filter = data[off++];
    const rowStart = y * stride;
    const prevStart = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const rawByte = data[off++];
      const a = x >= bpp ? out[rowStart + x - bpp] : 0;
      const b = y > 0 ? out[prevStart + x] : 0;
      const c = y > 0 && x >= bpp ? out[prevStart + x - bpp] : 0;
      let v: number;
      switch (filter) {
        case 1:
          v = rawByte + a;
          break;
        case 2:
          v = rawByte + b;
          break;
        case 3:
          v = rawByte + Math.floor((a + b) / 2);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          v = rawByte + pr;
          break;
        }
        default:
          v = rawByte; // filter 0 or unknown
      }
      out[rowStart + x] = v & 0xff;
    }
  }
  return out;
}

// ── 5x7 bitmap font ────────────────────────────────────────────────────────
type Glyph = string[]; // 7 rows of 5 chars ('#' = pixel on)

const G = (rows: string[]): Glyph => rows;

const FONT: Record<string, Glyph> = {
  A: G([".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"]),
  B: G(["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."]),
  C: G([".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."]),
  D: G(["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."]),
  E: G(["#####", "#....", "#....", "####.", "#....", "#....", "#####"]),
  F: G(["#####", "#....", "#....", "####.", "#....", "#....", "#...."]),
  G: G([".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".###."]),
  H: G(["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"]),
  I: G(["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "#####"]),
  J: G(["..###", "...#.", "...#.", "...#.", "...#.", "#..#.", ".##.."]),
  K: G(["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"]),
  L: G(["#....", "#....", "#....", "#....", "#....", "#....", "#####"]),
  M: G(["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"]),
  N: G(["#...#", "##..#", "#.#.#", "#.#.#", "#..##", "#...#", "#...#"]),
  O: G([".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."]),
  P: G(["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."]),
  Q: G([".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"]),
  R: G(["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"]),
  S: G([".####", "#....", "#....", ".###.", "....#", "....#", "####."]),
  T: G(["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."]),
  U: G(["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."]),
  V: G(["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."]),
  W: G(["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "##.##", "#...#"]),
  X: G(["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"]),
  Y: G(["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."]),
  Z: G(["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"]),
  "0": G([".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."]),
  "1": G(["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", "#####"]),
  "2": G([".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"]),
  "3": G(["####.", "....#", "....#", ".###.", "....#", "....#", "####."]),
  "4": G(["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."]),
  "5": G(["#####", "#....", "####.", "....#", "....#", "#...#", ".###."]),
  "6": G([".###.", "#....", "#....", "####.", "#...#", "#...#", ".###."]),
  "7": G(["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."]),
  "8": G([".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."]),
  "9": G([".###.", "#...#", "#...#", ".####", "....#", "....#", ".###."]),
  " ": G([".....", ".....", ".....", ".....", ".....", ".....", "....."]),
  ":": G([".....", "..#..", "..#..", ".....", "..#..", "..#..", "....."]),
  ".": G([".....", ".....", ".....", ".....", ".....", ".##..", ".##.."]),
  ",": G([".....", ".....", ".....", ".....", ".##..", "..#..", "#...."]),
  "-": G([".....", ".....", ".....", "#####", ".....", ".....", "....."]),
  "/": G(["....#", "...#.", "..#..", ".#...", "#....", ".....", "....."]),
  "(": G(["...#.", "..#..", ".#...", ".#...", ".#...", "..#..", "...#."]),
  ")": G([".#...", "..#..", "...#.", "...#.", "...#.", "..#..", ".#..."]),
  "'": G(["..#..", "..#..", ".....", ".....", ".....", ".....", "....."]),
};

export interface RenderedImage {
  png: Buffer;
  width: number;
  height: number;
}

/**
 * Rasterise lines of text into a clean black-on-white PNG.
 * Primary path renders real font outlines via sharp (SVG → PNG), which is
 * what OCR engines actually expect; if sharp is unavailable we fall back to
 * the built-in 5x7 bitmap font below.
 */
export async function renderTextImage(
  lines: string[],
  opts: { scale?: number; padding?: number } = {}
): Promise<RenderedImage> {
  try {
    return await renderTextImageSharp(lines);
  } catch {
    return renderTextImageBitmap(lines, opts);
  }
}

async function renderTextImageSharp(lines: string[]): Promise<RenderedImage> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sharp = require("sharp");
  const fontSize = 34;
  const lineH = 52;
  const pad = 50;
  const width = 1200;
  const height = pad * 2 + Math.max(lines.length, 1) * lineH;
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const texts = lines
    .map((l, i) =>
      l
        ? `<text x="${pad}" y="${pad + (i + 0.8) * lineH}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${fontSize}" fill="black">${esc(l)}</text>`
        : ""
    )
    .join("");
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect width="${width}" height="${height}" fill="white"/>${texts}</svg>`;
  const png: Buffer = await sharp(Buffer.from(svg)).png().toBuffer();
  return { png, width, height };
}

function renderTextImageBitmap(
  lines: string[],
  opts: { scale?: number; padding?: number } = {}
): RenderedImage {
  const scale = opts.scale ?? 4;
  const padding = opts.padding ?? 48;
  const cellW = 6 * scale; // 5px glyph + 1px gap
  const cellH = 9 * scale; // 7px glyph + 2px gap
  const maxLen = Math.max(...lines.map((l) => l.length), 1);
  const width = padding * 2 + maxLen * cellW;
  const height = padding * 2 + lines.length * cellH;
  const raw = Buffer.alloc(width * height, 255); // white

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].toUpperCase();
    for (let ci = 0; ci < line.length; ci++) {
      const glyph = FONT[line[ci]] ?? FONT[" "];
      for (let gy = 0; gy < 7; gy++) {
        for (let gx = 0; gx < 5; gx++) {
          if (glyph[gy][gx] !== "#") continue;
          const baseX = padding + ci * cellW + gx * scale;
          const baseY = padding + li * cellH + gy * scale;
          for (let dy = 0; dy < scale; dy++) {
            for (let dx = 0; dx < scale; dx++) {
              const x = baseX + dx;
              const y = baseY + dy;
              raw[y * width + x] = 0; // black
            }
          }
        }
      }
    }
  }
  return { png: encodePNG(width, height, 1, raw), width, height };
}
