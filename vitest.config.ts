import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 180_000,
    hookTimeout: 180_000,
    include: ["test/**/*.test.ts"],
    // A failing test should say why it failed, not just that it did. The second
    // reporter classifies every failure and prints next steps; it is inert when
    // the suite is green. For a deeper, re-runnable pass: npm run test:troubleshoot.
    reporters: ["default", "./test/troubleshootReporter.ts"],
    server: {
      deps: {
        // pdf.js v4+ is ESM-only. Both the package and our one-line bridge are
        // left to Node's real loader: inside a transformed module a runtime
        // import() has no import callback ("A dynamic import callback was not
        // specified"), so the bridge must never be transformed.
        external: [/pdfjs-esm\.mjs$/, /pdfjs-dist/],
      },
    },
  },
});
