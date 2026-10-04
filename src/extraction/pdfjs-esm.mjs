/**
 * One-line ESM bridge to pdf.js (v4+ ships ESM only).
 *
 * This file is deliberately NOT TypeScript and deliberately NOT transformed:
 * it is externalized in vitest.config.ts so Node's real ESM loader executes it,
 * which is the only context where a runtime `import()` has an import callback.
 * Loaded from CommonJS with `require()`, which Node >= 20.19 / >= 22.12
 * supports for ES modules without top-level await.
 */
export function loadPdfjs() {
  return import("pdfjs-dist/legacy/build/pdf.mjs").then((mod) => mod.default ?? mod);
}
