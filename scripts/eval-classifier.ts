/**
 * Classifier evaluation harness (Phase C4).
 *
 * Reads a labelled CSV of REAL messages (ids, subject, body, true category),
 * runs either the deterministic categorizer or the tenant's configured
 * (Gemini-labelled) classifier over it, and reports how good that routing is —
 * before anybody lets a category send mail by itself.
 *
 * Outputs contain **ids and labels only**. Never a subject, never a body: this
 * report is meant to be pasteable into an issue tracker.
 *
 * Usage:
 *   ./node_modules/.bin/tsx scripts/eval-classifier.ts --csv labels.csv
 *   ... --classifier configured --categories general_enquiry,complaint \
 *       --auto-send general_enquiry --json report.json
 *
 * `--classifier configured` reads the Gemini key from the same local database
 * secret store used by the web console (DB_PATH or the default DB). It never
 * reads a key from the environment, prints it, or writes it to the report.
 * This harness makes no decision about sending: it reports which
 * categories MEET the bar, and the allowlist in the product stays empty until
 * an administrator acts on that.
 */
import * as fs from "node:fs";
import { categorizeEmail, classifyWithConfiguredCategories, CLASSIFIER_MIN_CONFIDENCE, geminiCategoryLabeler, type CategoryLabeler } from "../src/categorize";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { resolveGeminiCredentials } from "../src/pipeline/adapters";

/** Fixed bars (Phase C4-2). A category may only be allowlisted for automatic
 *  sending when it clears its precision bar on enough labelled examples. */
export const PASS_BARS = {
  /** Overall accuracy across every labelled message. */
  minOverallAccuracy: 0.9,
  /** Per-category precision required before that category may auto-send. */
  minAutoSendPrecision: 0.95,
  /** Minimum labelled examples of a category before its precision means anything. */
  minAutoSendSupport: 30,
  /** At or above this confidence a wrong label is reported individually. */
  highConfidenceWrongFloor: CLASSIFIER_MIN_CONFIDENCE,
} as const;

export interface LabelledRow {
  id: string;
  subject: string;
  body: string;
  trueCategory: string;
  /** Optional: whether the real message carried attachments. */
  hasAttachments?: boolean;
}

export interface Prediction {
  label: string;
  confidence: number;
  source: "gemini" | "fallback" | "deterministic";
}

export interface CategoryStats {
  category: string;
  support: number;      // messages whose TRUE category is this one
  predicted: number;    // messages the classifier labelled this way
  truePositives: number;
  precision: number | null;  // null when nothing was predicted as this category
  recall: number | null;     // null when the category has no examples
  f1: number | null;
  eligibleForAutoSend: boolean;
  ineligibleReason: string | null;
}

export interface EvalReport {
  classifier: string;
  messages: number;
  correct: number;
  accuracy: number;
  /** Share of messages that would go to a person under the product's rules. */
  humanRate: number;
  humanBound: number;
  perCategory: CategoryStats[];
  confusion: Record<string, Record<string, number>>;
  /** Ids only — never message content. */
  wrongWithHighConfidence: Array<{ id: string; trueCategory: string; predicted: string; confidence: number }>;
  bars: {
    overallAccuracyMet: boolean;
    autoSendCategories: string[];
    categoriesBelowBar: Array<{ category: string; precision: number | null; support: number; reason: string }>;
  };
}

// ── CSV ───────────────────────────────────────────────────────────────────

/** Minimal RFC-4180 reader: quoted fields may contain commas, newlines and
 *  doubled quotes. Labels arrive with real mail in them, so this must not be
 *  naive about separators. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const input = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') { field += '"'; i += 1; } else { quoted = false; }
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ",") { row.push(field); field = ""; continue; }
    if (ch === "\r") continue;
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += ch;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

/** id, subject, body, true_category[, has_attachments] — header-driven, so
 *  column order does not matter.
 *
 *  `requireLabels: false` is for reading a FRESH export from the console
 *  (`GET /export/labels.csv`), whose `true_category` column is deliberately
 *  blank until a human fills it in. Scoring still refuses unlabelled rows: the
 *  CLI path keeps the default. */
export function rowsFromCsv(text: string, opts: { requireLabels?: boolean } = {}): LabelledRow[] {
  const requireLabels = opts.requireLabels !== false;
  const parsed = parseCsv(text);
  if (parsed.length === 0) throw new Error("the CSV is empty");
  // The console's labelling export starts with a "#" note about the personal
  // data it contains. Comment lines before the header are skipped; nothing
  // after the header is, so a real row can never be silently dropped.
  let start = 0;
  while (start < parsed.length && (parsed[start][0] ?? "").trimStart().startsWith("#")) start += 1;
  const table = parsed.slice(start);
  if (table.length === 0) throw new Error("the CSV has only comment lines");
  const header = table[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  const need = ["id", "subject", "body", "true_category"];
  for (const column of need) {
    if (!header.includes(column)) throw new Error(`the CSV has no "${column}" column (found: ${header.join(", ")})`);
  }
  const at = (cells: string[], name: string): string => (cells[header.indexOf(name)] ?? "").trim();
  const rows = table.slice(1).map((cells) => ({
    id: at(cells, "id"),
    subject: at(cells, "subject"),
    body: cells[header.indexOf("body")] ?? "",
    trueCategory: at(cells, "true_category").toLowerCase(),
    hasAttachments: header.includes("has_attachments") ? /^(1|true|yes|y)$/i.test(at(cells, "has_attachments")) : false,
  }));
  const missingId = rows.filter((r) => !r.id);
  if (missingId.length) throw new Error(`${missingId.length} row(s) have no id — every row needs one so a wrong label can be traced`);
  const duplicate = rows.map((r) => r.id).filter((id, index, all) => all.indexOf(id) !== index);
  if (duplicate.length) throw new Error(`duplicate id(s) in the CSV: ${[...new Set(duplicate)].join(", ")}`);
  const noLabel = rows.filter((r) => !r.trueCategory);
  if (requireLabels && noLabel.length) {
    throw new Error(`${noLabel.length} row(s) have no true_category (ids: ${noLabel.slice(0, 5).map((r) => r.id).join(", ")}) — label them first, or pass requireLabels: false to read an unlabelled export`);
  }
  return rows;
}

// ── predictors ────────────────────────────────────────────────────────────

/** The deterministic keyword matcher the product falls back to. */
export function deterministicPredictor(): (row: LabelledRow) => Promise<Prediction> {
  return async (row) => ({
    label: categorizeEmail(row.subject, row.body, row.hasAttachments ?? false),
    confidence: 1,
    source: "deterministic",
  });
}

/** The tenant's configured classifier: Gemini may only answer from the
 *  allow-list, and any failure falls back to the deterministic matcher. */
export function configuredPredictor(categories: string[], labeler?: CategoryLabeler): (row: LabelledRow) => Promise<Prediction> {
  if (categories.length === 0) throw new Error("the configured classifier needs at least one category (--categories)");
  return async (row) => {
    const result = await classifyWithConfiguredCategories({ subject: row.subject, body: row.body }, categories, labeler);
    return { label: result.label.toLowerCase(), confidence: result.confidence, source: result.source === "gemini" ? "gemini" : "fallback" };
  };
}

// ── evaluation ────────────────────────────────────────────────────────────

/**
 * Would this message go to a person, under the same rules the product applies?
 *  - the category is not on the auto-send allowlist (default: nothing is), or
 *  - the label came from the fallback rather than the model, or
 *  - the model's confidence is below the floor.
 */
export function isHumanBound(prediction: Prediction, autoSendCategories: string[]): boolean {
  if (!autoSendCategories.includes(prediction.label)) return true;
  if (prediction.source === "fallback") return true;
  return !(prediction.confidence >= PASS_BARS.highConfidenceWrongFloor);
}

export function evaluateLabels(
  rows: LabelledRow[],
  predictions: Prediction[],
  opts: { classifier: string; autoSendCategories?: string[] }
): EvalReport {
  if (rows.length !== predictions.length) throw new Error("one prediction per labelled row is required");
  const allowlist = opts.autoSendCategories ?? [];
  const categories = [...new Set([...rows.map((r) => r.trueCategory), ...predictions.map((p) => p.label)])].sort();

  let correct = 0;
  let humanBound = 0;
  const confusion: Record<string, Record<string, number>> = {};
  const wrongWithHighConfidence: EvalReport["wrongWithHighConfidence"] = [];
  for (const category of categories) confusion[category] = Object.fromEntries(categories.map((c) => [c, 0]));

  rows.forEach((row, index) => {
    const prediction = predictions[index];
    const isCorrect = prediction.label === row.trueCategory;
    if (isCorrect) correct += 1;
    confusion[row.trueCategory][prediction.label] += 1;
    if (isHumanBound(prediction, allowlist)) humanBound += 1;
    if (!isCorrect && prediction.confidence >= PASS_BARS.highConfidenceWrongFloor) {
      wrongWithHighConfidence.push({
        id: row.id, trueCategory: row.trueCategory, predicted: prediction.label,
        confidence: Number(prediction.confidence.toFixed(3)),
      });
    }
  });

  const perCategory: CategoryStats[] = categories.map((category) => {
    const support = rows.filter((r) => r.trueCategory === category).length;
    const predicted = predictions.filter((p) => p.label === category).length;
    const truePositives = rows.filter((r, i) => r.trueCategory === category && predictions[i].label === category).length;
    const precision = predicted === 0 ? null : truePositives / predicted;
    const recall = support === 0 ? null : truePositives / support;
    const f1 = precision === null || recall === null || precision + recall === 0 ? null : (2 * precision * recall) / (precision + recall);
    const wanted = allowlist.includes(category);
    let ineligibleReason: string | null = null;
    if (wanted && support < PASS_BARS.minAutoSendSupport) {
      ineligibleReason = `only ${support} labelled examples (needs ${PASS_BARS.minAutoSendSupport})`;
    } else if (wanted && (precision === null || precision < PASS_BARS.minAutoSendPrecision)) {
      ineligibleReason = `precision ${precision === null ? "n/a" : (precision * 100).toFixed(1)}% (needs ${PASS_BARS.minAutoSendPrecision * 100}%)`;
    }
    return {
      category, support, predicted, truePositives,
      precision: precision === null ? null : Number(precision.toFixed(4)),
      recall: recall === null ? null : Number(recall.toFixed(4)),
      f1: f1 === null ? null : Number(f1.toFixed(4)),
      eligibleForAutoSend: wanted && ineligibleReason === null,
      ineligibleReason: wanted ? ineligibleReason : null,
    };
  });

  const accuracy = rows.length === 0 ? 0 : correct / rows.length;
  return {
    classifier: opts.classifier,
    messages: rows.length,
    correct,
    accuracy: Number(accuracy.toFixed(4)),
    humanRate: rows.length === 0 ? 0 : Number((humanBound / rows.length).toFixed(4)),
    humanBound,
    perCategory,
    confusion,
    wrongWithHighConfidence,
    bars: {
      overallAccuracyMet: accuracy >= PASS_BARS.minOverallAccuracy,
      autoSendCategories: perCategory.filter((c) => c.eligibleForAutoSend).map((c) => c.category),
      categoriesBelowBar: perCategory
        .filter((c) => c.ineligibleReason)
        .map((c) => ({ category: c.category, precision: c.precision, support: c.support, reason: c.ineligibleReason! })),
    },
  };
}

// ── reporting (ids and labels only — never message text) ──────────────────

export function formatReport(report: EvalReport): string {
  const pct = (value: number | null): string => (value === null ? "  n/a" : `${(value * 100).toFixed(1)}%`);
  const lines: string[] = [];
  lines.push(`Classifier evaluation — ${report.classifier}`);
  lines.push(`Messages: ${report.messages} · correct: ${report.correct} · accuracy: ${pct(report.accuracy)}`);
  lines.push(`Would go to a person: ${report.humanBound}/${report.messages} (${pct(report.humanRate)})`);
  lines.push("");
  lines.push("Per category (precision = of the messages labelled this, how many really were):");
  lines.push("  category                 support  predicted   TP  precision   recall      F1");
  for (const c of report.perCategory) {
    lines.push(`  ${c.category.padEnd(24)} ${String(c.support).padStart(6)}  ${String(c.predicted).padStart(9)} ${String(c.truePositives).padStart(4)}  ${pct(c.precision).padStart(9)} ${pct(c.recall).padStart(8)} ${pct(c.f1).padStart(7)}`);
  }
  lines.push("");
  lines.push("Confusion matrix (rows = true, columns = predicted):");
  const headers = report.perCategory.map((c) => c.category);
  lines.push(`  ${"true \\ predicted".padEnd(24)}${headers.map((h) => h.slice(0, 10).padStart(11)).join("")}`);
  for (const trueCategory of headers) {
    const cells = headers.map((predicted) => String(report.confusion[trueCategory]?.[predicted] ?? 0).padStart(11));
    lines.push(`  ${trueCategory.padEnd(24)}${cells.join("")}`);
  }
  lines.push("");
  lines.push(`Bars: overall accuracy >= ${PASS_BARS.minOverallAccuracy * 100}% → ${report.bars.overallAccuracyMet ? "MET" : "NOT MET"}`);
  lines.push(`      auto-send needs precision >= ${PASS_BARS.minAutoSendPrecision * 100}% on >= ${PASS_BARS.minAutoSendSupport} examples`);
  lines.push(`      categories that clear the bar for auto-send: ${report.bars.autoSendCategories.length ? report.bars.autoSendCategories.join(", ") : "(none — everything stays draft-only)"}`);
  for (const below of report.bars.categoriesBelowBar) {
    lines.push(`      BELOW BAR: ${below.category} — ${below.reason} → stays draft-only`);
  }
  if (report.wrongWithHighConfidence.length) {
    lines.push("");
    lines.push(`Wrong with confidence >= ${PASS_BARS.highConfidenceWrongFloor} (${report.wrongWithHighConfidence.length}) — every one listed, ids only:`);
    for (const w of report.wrongWithHighConfidence) {
      lines.push(`  ${w.id}  true=${w.trueCategory}  predicted=${w.predicted}  confidence=${w.confidence}`);
    }
  } else {
    lines.push("");
    lines.push("No wrong label carried high confidence.");
  }
  return lines.join("\n");
}

// ── CLI ───────────────────────────────────────────────────────────────────

interface CliOptions {
  csv: string;
  classifier: "deterministic" | "configured";
  categories: string[];
  autoSend: string[];
  json?: string;
}

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { csv: "", classifier: "deterministic", categories: [], autoSend: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === "--csv") opts.csv = next();
    else if (arg === "--classifier") {
      const value = next();
      if (value !== "deterministic" && value !== "configured") throw new Error("--classifier is deterministic or configured");
      opts.classifier = value;
    } else if (arg === "--categories") opts.categories = next().split(",").map((c) => c.trim().toLowerCase()).filter(Boolean);
    else if (arg === "--auto-send") opts.autoSend = next().split(",").map((c) => c.trim().toLowerCase()).filter(Boolean);
    else if (arg === "--json") opts.json = next();
    else if (arg === "--help" || arg === "-h") throw new Error("usage: --csv FILE [--classifier deterministic|configured] [--categories a,b] [--auto-send a,b] [--json OUT]");
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!opts.csv) throw new Error("--csv is required (see docs/eval-template.csv and README.md#classifier-evaluation-and-personal-data-handling)");
  if (opts.classifier === "configured" && opts.categories.length === 0) throw new Error("--classifier configured needs --categories (the tenant's own allow-list)");
  return opts;
}

function storedGeminiLabeler(): CategoryLabeler {
  const cfg = loadConfig();
  if (cfg.dbPath === ":memory:" || !fs.existsSync(cfg.dbPath)) {
    throw new Error("Configured classifier needs the workspace database selected by DB_PATH (or the default) with a Gemini key saved in Settings → Connections.");
  }
  const db = openDb(cfg.dbPath);
  try {
    const credentials = resolveGeminiCredentials(cfg, new Repo(db));
    if (!credentials) throw new Error("Configured classifier needs a Gemini key saved in Settings → Connections; environment keys are not used.");
    return geminiCategoryLabeler(credentials);
  } finally {
    db.close();
  }
}

export async function run(argv: string[]): Promise<{ report: EvalReport; exitCode: number }> {
  const opts = parseArgs(argv);
  const rows = rowsFromCsv(fs.readFileSync(opts.csv, "utf8"));
  const predictor = opts.classifier === "configured"
    ? configuredPredictor(opts.categories, storedGeminiLabeler())
    : deterministicPredictor();
  const predictions: Prediction[] = [];
  for (const row of rows) predictions.push(await predictor(row));
  const report = evaluateLabels(rows, predictions, {
    classifier: opts.classifier === "configured" ? `configured (${opts.categories.join(", ")})` : "deterministic keyword matcher",
    autoSendCategories: opts.autoSend,
  });
  const text = formatReport(report);
  process.stdout.write(`${text}\n`);
  if (opts.json) {
    // The JSON carries the same fields: ids and labels, never message text.
    fs.writeFileSync(opts.json, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`\nwrote ${opts.json}\n`);
  }
  const failed = !report.bars.overallAccuracyMet || report.bars.categoriesBelowBar.length > 0;
  return { report, exitCode: failed ? 1 : 0 };
}

/* istanbul ignore next — CLI entry point */
if (require.main === module) {
  run(process.argv.slice(2))
    .then(({ exitCode }) => { process.exitCode = exitCode; })
    .catch((error: unknown) => {
      process.stderr.write(`${(error as Error).message}\n`);
      process.exitCode = 2;
    });
}
