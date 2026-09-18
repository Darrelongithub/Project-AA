/**
 * Extraction-quality heuristics. Pure functions — the gate between
 * extraction tiers. "Good" means: enough text, mostly letters, real words.
 * Anything else falls through to the next (more expensive) tier.
 *
 * Round 19: thresholds are DOCUMENT-TYPE AWARE. A birth certificate or an ID
 * card legitimately carries very little text — judging it by transcript
 * standards sent genuine short documents to Gemini for no reason. Academic
 * results keep the strict gate because half-read grade tables are dangerous.
 */
import type { DocType } from "../types";

export interface QualityReport {
  ok: boolean;
  length: number;
  letterRatio: number;
  distinctWords: number;
  avgWordLength: number;
  maxRepeatRun: number;
  reasons: string[];
}

export interface QualityThresholds {
  minLength?: number;
  minLetterRatio?: number;
  minDistinctWords?: number;
  minAvgWordLength?: number;
  maxRepeatRun?: number;
}

/**
 * Per-document-type gates. `unknown` keeps the strict defaults: we do not
 * loosen the bar for text we cannot even place.
 */
export function thresholdsFor(docType?: DocType | null): QualityThresholds {
  switch (docType) {
    case "birth_cert":
    case "id":
      // Short by nature: a clean ID page may be ~15 words.
      return { minLength: 15, minLetterRatio: 0.55, minDistinctWords: 3, minAvgWordLength: 3.0, maxRepeatRun: 20 };
    case "kcpe_cert":
      return { minLength: 25, minLetterRatio: 0.55, minDistinctWords: 4, minAvgWordLength: 3.5, maxRepeatRun: 20 };
    case "application_form":
      return { minLength: 30, minLetterRatio: 0.55, minDistinctWords: 5, minAvgWordLength: 3.5, maxRepeatRun: 20 };
    case "credit_transfer_form":
      return { minLength: 30, minLetterRatio: 0.55, minDistinctWords: 5, minAvgWordLength: 3.5, maxRepeatRun: 20 };
    default:
      // academic_cert, unknown — the strict original gate.
      return { minLength: 40, minLetterRatio: 0.6, minDistinctWords: 5, minAvgWordLength: 4.0, maxRepeatRun: 20 };
  }
}

export function assessTextQuality(
  text: string,
  t: QualityThresholds = {}
): QualityReport {
  const minLength = t.minLength ?? 40;
  const minLetterRatio = t.minLetterRatio ?? 0.6;
  const minDistinctWords = t.minDistinctWords ?? 5;
  const minAvgWordLength = t.minAvgWordLength ?? 4.0;
  const maxRepeatRunAllowed = t.maxRepeatRun ?? 20;

  const trimmed = (text || "").trim();
  const reasons: string[] = [];

  const nonWs = trimmed.replace(/\s+/g, "");
  const letters = (nonWs.match(/[A-Za-z]/g) || []).length;
  const letterRatio = nonWs.length === 0 ? 0 : letters / nonWs.length;

  const wordMatches = trimmed.toLowerCase().match(/[a-z]{2,}/g) || [];
  const words = new Set(wordMatches);
  const avgWordLength = wordMatches.length
    ? wordMatches.reduce((n, w) => n + w.length, 0) / wordMatches.length
    : 0;

  let maxRepeatRun = 0;
  let run = 1;
  for (let i = 1; i < trimmed.length; i++) {
    if (trimmed[i] === trimmed[i - 1]) {
      run++;
      if (run > maxRepeatRun) maxRepeatRun = run;
    } else {
      run = 1;
    }
  }

  if (trimmed.length < minLength) reasons.push(`too short (${trimmed.length} chars)`);
  if (letterRatio < minLetterRatio)
    reasons.push(`letter ratio ${(letterRatio * 100).toFixed(0)}% looks like garbage`);
  if (words.size < minDistinctWords)
    reasons.push(`only ${words.size} distinct words`);
  if (wordMatches.length >= minDistinctWords && avgWordLength < minAvgWordLength)
    reasons.push(
      `average word length ${avgWordLength.toFixed(2)} looks like OCR garbage (real documents use longer words)`
    );
  if (maxRepeatRun > maxRepeatRunAllowed)
    reasons.push(`repeated-character run of ${maxRepeatRun}`);

  return {
    ok: reasons.length === 0,
    length: trimmed.length,
    letterRatio,
    distinctWords: words.size,
    avgWordLength,
    maxRepeatRun,
    reasons,
  };
}

/**
 * Classify FIRST, then judge by that document type's bar. A birth
 * certificate with 20 clean words is good text; the same 20 words on a
 * "result slip" is not.
 */
export function isGoodText(
  text: string | null | undefined,
  docType?: DocType | null
): boolean {
  if (!text) return false;
  return assessTextQuality(text, thresholdsFor(docType)).ok;
}
