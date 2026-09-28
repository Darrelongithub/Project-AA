/**
 * Preset loader — the data-driven organization presets live in data/presets/
 * (NOT in code). The "admissions" preset carries everything education-flavoured:
 * intake vocabulary, document-matrix cases, grade scales, system labels,
 * subject catalogues, programmes, requirement sets, reply templates, pack
 * slots and decision copy. Core modules read the active preset through here
 * instead of hardcoding education assumptions.
 *
 * The file is loaded once and cached. A missing/corrupt preset fails fast
 * with a clear error — never a silent empty configuration.
 */
import * as fs from "fs";
import * as path from "path";
import type { DocType, SystemBlock } from "../types";

/**
 * Where the BUNDLED data lives (presets, migration JSON, pack PDFs).
 *
 * Resolved from THIS module's own location — never from the process CWD and
 * never from DB_PATH (see the C-1 note once kept in src/pack.ts: a database
 * outside the checkout must not change where the code finds its bundled
 * files). A deployment that relocates the bundled directory sets
 * BUNDLED_DATA_DIR.
 */
export function bundledDataDir(): string {
  const override = (process.env.BUNDLED_DATA_DIR || "").trim();
  if (override) return path.resolve(override);
  // Walk up from this file to the package root (the directory holding
  // package.json). Works for src/presets/loader.ts (tsx) and
  // dist/src/presets/loader.js (tsc).
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return path.join(dir, "data");
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Last resort: the conventional layout (src/ or dist/src/ under the root).
  return path.resolve(__dirname, "..", "..", "data");
}

export interface IntakeVocabulary {
  strongAppPhrases: string[];
  appKeywords: string[];
  enqPhrases: string[];
  enqKeywords: string[];
  negPhrases: string[];
  negKeywords: string[];
  alwaysNonAdmissions: string[];
  attachmentPattern: string;
  stopTokens: string[];
  thresholds: { negGate: number; appThreshold: number; enqThreshold: number };
}

export interface PresetRequirementSpec {
  document_type: DocType;
  label: string;
  required: boolean;
  blocking: boolean;
  conditional?: string;
  source: "pack-pdf" | "owner-prompt" | "web-summary";
}

export interface PresetPackSlot {
  key: string;
  file: string;
  pretty: string;
  pack: "application" | "admission" | "transfer";
  purpose: string;
}

export interface PresetTemplate {
  key: string;
  name: string;
  subject: string;
  body: string;
}

export interface AdmissionsPreset {
  meta: { name: string; version: number };
  intake: IntakeVocabulary & { defaultHotwords: string };
  documents: {
    nationalRequiresPrimaryCert: boolean;
    programmeCases: Record<string, PresetRequirementSpec>;
    primaryCertSpec: PresetRequirementSpec;
    typeLabels: Record<string, string>;
    gradeCheckedTypes: string[];
    examDateAnomaly: string;
    visionPromptTypes: string[];
    resultSlip: { defaultSystem: string; defaultLabel: string; template: string };
  };
  scales: {
    grade: readonly string[];
    oLevel: readonly string[];
    alevel: readonly string[];
    ibSubject: readonly string[];
    diplomaClass: readonly string[];
    degreeClass: readonly string[];
  };
  admissionSystemLabels: Record<string, string>;
  examSystemLabels: Record<string, string>;
  defaultSystem: string;
  subjects: { nationalSecondarySystem: string; nationalSecondary: string[]; generic: string[]; genericSystems: string[]; tickMatrix: string[] };
  programmes: Array<{ code: string; name: string; school: string; entry: string; level: string }>;
  intakes: string[];
  baseRequirements: Array<{ document_type: DocType; required: boolean }>;
  examSystems: Array<{ system: string; label: string; fields: string[]; scale: keyof AdmissionsPreset["scales"] | null }>;
  structuredBase: Array<{ level: string; block: SystemBlock }>;
  structuredCourses: Array<{ programme: string; block: SystemBlock }>;
  templates: PresetTemplate[];
  admissionLetter: { name: string; subject: string; body: string; include_banner: boolean; attach_pack: string };
  admissionDates: { regDate: string; orientationDates: string };
  packSlots: PresetPackSlot[];
  decisionCopy: {
    reverseTitle: string; reverseBody: string; reverseButton: string;
    formTitle: string; formBody: string;
    admitButton: string; declineButton: string; reasonPlaceholder: string;
  };
  decisionRoutes: Array<{ value: string; label: string }>;
  noAutomatedRuleRoute: string[];
  admissionSystems: string[];
  scaleRoutes: { letter: Record<string, keyof AdmissionsPreset["scales"]>; class: Record<string, keyof AdmissionsPreset["scales"]> };
  evaluation: { systemRoutes: Record<string, string[]> };
  classification: Array<{ type: DocType; pattern: string; flags: string }>;
  extraction: {
    pointsPatterns: Array<{ pattern: string; flags: string }>;
    systemDetectors: Array<{ system: string; pattern: string; flags: string; andPattern?: string }>;
  };
  pageSamples: { requirementExample: string; readBackSample: string };
}

let cached: AdmissionsPreset | null = null;

/** The admissions preset (cached). Throws a clear error when unreadable. */
export function admissionsPreset(): AdmissionsPreset {
  if (!cached) {
    const file = path.join(bundledDataDir(), "presets", "admissions.json");
    let parsed: AdmissionsPreset;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8")) as AdmissionsPreset;
    } catch (e) {
      throw new Error(`admissions preset unreadable at ${file}: ${(e as Error).message}`);
    }
    if (!parsed || parsed.meta?.name !== "admissions" || !parsed.intake || !parsed.scales) {
      throw new Error(`admissions preset at ${file} is not a valid admissions preset (meta/intake/scales missing)`);
    }
    cached = parsed;
  }
  return cached;
}
