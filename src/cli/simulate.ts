/**
 * `npm run simulate` — run the fixture corpus through the pipeline and score
 * the results against the answer key. Add DISABLE_OCR=1 to skip the
 * Tesseract tier (forces the Gemini mock fallback for scans).
 */
import { runSimulation, printReport } from "../simulation/run";
import { shutdownOcr } from "../extraction/ocr";

async function main(): Promise<void> {
  const disableOcr = process.env.DISABLE_OCR === "1";
  // SIM_DB_PATH=./data/demo.sqlite persists the run so `npm run queue` can inspect it.
  const dbPath = process.env.SIM_DB_PATH;
  const result = await runSimulation({ disableOcr, dbPath });
  printReport(result);
  await shutdownOcr();
  process.exit(result.allPassed ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
