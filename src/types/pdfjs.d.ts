/**
 * pdf.js 6 ships ESM only, and this CommonJS project reaches it through one
 * externalized bridge module (src/extraction/pdfjs-esm.mjs, loaded from
 * src/extraction/pdfOptions.ts). Declared here so `require()` of the bridge
 * typechecks without pulling the ESM package into the CommonJS graph.
 */
declare module "*/pdfjs-esm.mjs" {
  export function loadPdfjs(): Promise<unknown>;
}
