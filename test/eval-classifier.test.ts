/**
 * The classifier evaluation harness (Phase C4).
 *
 * These fixtures are TINY and SYNTHETIC: they prove the harness counts,
 * thresholds and reports correctly. They say nothing whatsoever about the real
 * accuracy of any classifier — that needs the 100 labelled real messages
 * described in docs/LABELLING-GUIDE.md.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  PASS_BARS,
  configuredPredictor,
  deterministicPredictor,
  evaluateLabels,
  formatReport,
  isHumanBound,
  parseArgs,
  parseCsv,
  rowsFromCsv,
  type LabelledRow,
  type Prediction,
} from "../scripts/eval-classifier";
import type { CategoryLabeler } from "../src/categorize";

const rows: LabelledRow[] = [
  { id: "a1", subject: "s1", body: "b1", trueCategory: "complaint" },
  { id: "a2", subject: "s2", body: "b2", trueCategory: "complaint" },
  { id: "a3", subject: "s3", body: "b3", trueCategory: "general_enquiry" },
  { id: "a4", subject: "s4", body: "b4", trueCategory: "general_enquiry" },
  { id: "a5", subject: "s5", body: "b5", trueCategory: "other" },
];
const predictions: Prediction[] = [
  { label: "complaint", confidence: 0.9, source: "gemini" },
  { label: "general_enquiry", confidence: 0.8, source: "gemini" },   // wrong, confident
  { label: "general_enquiry", confidence: 0.95, source: "gemini" },
  { label: "complaint", confidence: 0.3, source: "gemini" },          // wrong, unconfident
  { label: "other", confidence: 0.9, source: "gemini" },
];

describe("CSV reading", () => {
  it("handles quoted commas, embedded newlines, doubled quotes, CRLF and a BOM", () => {
    const text = '\uFEFFid,subject,body,true_category\r\n1,"Quote, please","line one\nline two ""quoted""",general_enquiry\r\n2,plain,body text,complaint\r\n';
    const table = parseCsv(text);
    expect(table.length).toBe(3);
    expect(table[1]).toEqual(["1", "Quote, please", 'line one\nline two "quoted"', "general_enquiry"]);
    expect(table[2][1]).toBe("plain");
  });

  it("is header-driven and validates what an evaluation needs", () => {
    const csv = "true_category,body,id,subject\ncomplaint,b,a1,s\n";
    expect(rowsFromCsv(csv).map((r) => [r.id, r.trueCategory])).toEqual([["a1", "complaint"]]);
    expect(() => rowsFromCsv("id,subject,body\na1,s,b\n")).toThrow(/no "true_category" column/);
    expect(() => rowsFromCsv("id,subject,body,true_category\n,s,b,complaint\n")).toThrow(/no id/);
    expect(() => rowsFromCsv("id,subject,body,true_category\na1,s,b,complaint\na1,s2,b2,other\n")).toThrow(/duplicate id/);
    expect(() => rowsFromCsv("id,subject,body,true_category\na1,s,b,\n")).toThrow(/no true_category/);
    expect(() => rowsFromCsv("")).toThrow(/empty/);
  });

  it("reads attachments when the column is present", () => {
    const csv = "id,subject,body,true_category,has_attachments\na1,s,b,document_submission,yes\na2,s,b,other,no\n";
    expect(rowsFromCsv(csv).map((r) => r.hasAttachments)).toEqual([true, false]);
  });

  it("the shipped template parses and is clearly synthetic", () => {
    const template = fs.readFileSync(path.join(__dirname, "..", "docs", "eval-template.csv"), "utf8");
    const parsed = rowsFromCsv(template);
    expect(parsed.length).toBe(3);
    expect(parsed.every((r) => r.id.startsWith("EXAMPLE-"))).toBe(true);
  });
});

describe("scoring", () => {
  it("counts accuracy, per-category precision/recall and the confusion matrix", () => {
    const report = evaluateLabels(rows, predictions, { classifier: "unit-test" });
    expect(report.messages).toBe(5);
    expect(report.correct).toBe(3);
    expect(report.accuracy).toBe(0.6);
    const byName = Object.fromEntries(report.perCategory.map((c) => [c.category, c]));
    expect(byName.complaint).toMatchObject({ support: 2, predicted: 2, truePositives: 1, precision: 0.5, recall: 0.5, f1: 0.5 });
    expect(byName.general_enquiry).toMatchObject({ support: 2, predicted: 2, truePositives: 1, precision: 0.5, recall: 0.5 });
    expect(byName.other).toMatchObject({ support: 1, predicted: 1, truePositives: 1, precision: 1, recall: 1, f1: 1 });
    expect(report.confusion.complaint).toMatchObject({ complaint: 1, general_enquiry: 1, other: 0 });
    expect(report.confusion.general_enquiry).toMatchObject({ complaint: 1, general_enquiry: 1 });
    expect(report.confusion.other).toMatchObject({ other: 1 });
  });

  it("lists every wrong-with-high-confidence case individually, by id", () => {
    const report = evaluateLabels(rows, predictions, { classifier: "unit-test" });
    expect(report.wrongWithHighConfidence).toEqual([
      { id: "a2", trueCategory: "complaint", predicted: "general_enquiry", confidence: 0.8 },
    ]);
    expect(PASS_BARS.highConfidenceWrongFloor).toBeGreaterThan(0.3); // a4 was wrong but unconfident
  });

  it("applies the auto-send bars: precision AND enough examples", () => {
    const report = evaluateLabels(rows, predictions, { classifier: "unit-test", autoSendCategories: ["other", "complaint"] });
    const byName = Object.fromEntries(report.perCategory.map((c) => [c.category, c]));
    // "other" is perfect but has 1 example: not enough to trust.
    expect(byName.other.eligibleForAutoSend).toBe(false);
    expect(byName.other.ineligibleReason).toMatch(/only 1 labelled examples/);
    // "complaint" has plenty of nothing either, and its precision is 50%.
    expect(byName.complaint.eligibleForAutoSend).toBe(false);
    expect(byName.complaint.ineligibleReason).toMatch(/only 2 labelled examples/);
    expect(report.bars.autoSendCategories).toEqual([]);
    expect(report.bars.overallAccuracyMet).toBe(false);
    expect(report.bars.categoriesBelowBar.length).toBe(2);
    // A category nobody asked to auto-send is simply not a candidate.
    expect(byName.general_enquiry.eligibleForAutoSend).toBe(false);
    expect(byName.general_enquiry.ineligibleReason).toBeNull();
  });

  it("clears a category that has both the precision and the examples", () => {
    const many: LabelledRow[] = [];
    const manyPredictions: Prediction[] = [];
    for (let i = 0; i < 40; i += 1) {
      many.push({ id: `m${i}`, subject: "s", body: "b", trueCategory: "general_enquiry" });
      manyPredictions.push({ label: i === 0 ? "other" : "general_enquiry", confidence: 0.95, source: "gemini" });
    }
    const report = evaluateLabels(many, manyPredictions, { classifier: "unit-test", autoSendCategories: ["general_enquiry"] });
    const stats = report.perCategory.find((c) => c.category === "general_enquiry")!;
    expect(stats.support).toBe(40);
    // 39 of the 40 truly-general messages were labelled correctly (recall
    // 97.5%), and every message labelled "general_enquiry" really was one
    // (precision 100%) — which is what the auto-send bar cares about.
    expect(stats.precision).toBe(1);
    expect(stats.recall).toBeCloseTo(39 / 40, 4);
    expect(stats.eligibleForAutoSend).toBe(true);
    expect(report.bars.autoSendCategories).toEqual(["general_enquiry"]);
    expect(report.bars.overallAccuracyMet).toBe(true); // 39/40 = 97.5% >= 90%
  });
});

describe("what goes to a person", () => {
  it("an empty allowlist holds everything", () => {
    const report = evaluateLabels(rows, predictions, { classifier: "unit-test" });
    expect(report.humanBound).toBe(5);
    expect(report.humanRate).toBe(1);
  });

  it("an allowlisted, confident, model-labelled message is the only thing that may send", () => {
    const report = evaluateLabels(rows, predictions, { classifier: "unit-test", autoSendCategories: ["other"] });
    expect(report.humanBound).toBe(4);
    expect(isHumanBound({ label: "other", confidence: 0.9, source: "gemini" }, ["other"])).toBe(false);
    // Not on the allowlist…
    expect(isHumanBound({ label: "complaint", confidence: 0.99, source: "gemini" }, ["other"])).toBe(true);
    // …a fallback label rather than the model's…
    expect(isHumanBound({ label: "other", confidence: 0.99, source: "fallback" }, ["other"])).toBe(true);
    // …or below the confidence floor: all held.
    expect(isHumanBound({ label: "other", confidence: PASS_BARS.highConfidenceWrongFloor - 0.01, source: "gemini" }, ["other"])).toBe(true);
  });
});

describe("predictors", () => {
  it("the deterministic predictor labels without any model", async () => {
    const predict = deterministicPredictor();
    const label = await predict({ id: "d1", subject: "Complaint about the service", body: "This is unacceptable and I want a reply.", trueCategory: "complaint" });
    expect(label).toEqual({ label: "complaint", confidence: 1, source: "deterministic" });
  });

  it("the configured predictor only accepts labels from the allow-list", async () => {
    const labeler: CategoryLabeler = async () => ({ label: "complaint", confidence: 0.91, source: "gemini" });
    const predict = configuredPredictor(["complaint", "general_enquiry"], labeler);
    expect(await predict(rows[0])).toEqual({ label: "complaint", confidence: 0.91, source: "gemini" });
  });

  it("a model that answers off-list or fails falls back — and is therefore held", async () => {
    const offList: CategoryLabeler = async () => ({ label: "approve_everything", confidence: 1, source: "gemini" });
    const fallbackLabel = await configuredPredictor(["complaint"], offList)(rows[0]);
    expect(fallbackLabel.source).toBe("fallback");
    expect(isHumanBound(fallbackLabel, ["complaint"])).toBe(true);

    const dead: CategoryLabeler = async () => { throw new Error("model unavailable"); };
    expect((await configuredPredictor(["complaint"], dead)(rows[0])).source).toBe("fallback");
    expect(() => configuredPredictor([], dead)).toThrow(/at least one category/);
  });
});

describe("the report never leaks message content", () => {
  it("prints ids, labels and numbers only", () => {
    const sensitive: LabelledRow[] = [
      { id: "s1", subject: "UNIQUE-SUBJECT-CANARY", body: "UNIQUE-BODY-CANARY 0712 345 678", trueCategory: "complaint" },
    ];
    const report = evaluateLabels(sensitive, [{ label: "other", confidence: 0.99, source: "gemini" }], { classifier: "unit-test", autoSendCategories: ["other"] });
    const text = formatReport(report);
    expect(text).toContain("s1");
    expect(text).toContain("complaint");
    expect(text).not.toContain("UNIQUE-SUBJECT-CANARY");
    expect(text).not.toContain("UNIQUE-BODY-CANARY");
    expect(text).not.toContain("0712 345 678");
    expect(JSON.stringify(report)).not.toContain("UNIQUE-BODY-CANARY");
    expect(text).toMatch(/Confusion matrix/);
    expect(text).toMatch(/Would go to a person/);
    expect(text).toMatch(/stays draft-only|clear the bar/);
  });
});

describe("CLI arguments", () => {
  it("requires a CSV and validates the classifier choice", () => {
    expect(() => parseArgs([])).toThrow(/--csv is required/);
    expect(() => parseArgs(["--csv", "x.csv", "--classifier", "magic"])).toThrow(/deterministic or configured/);
    expect(() => parseArgs(["--csv", "x.csv", "--classifier", "configured"])).toThrow(/needs --categories/);
    expect(() => parseArgs(["--csv", "x.csv", "--nope"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["--csv"])).toThrow(/needs a value/);
    expect(parseArgs(["--csv", "labels.csv", "--auto-send", "Complaint, general_enquiry", "--json", "out.json"])).toEqual({
      csv: "labels.csv", classifier: "deterministic", categories: [], autoSend: ["complaint", "general_enquiry"], json: "out.json",
    });
  });
});
