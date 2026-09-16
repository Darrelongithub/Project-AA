/**
 * Extraction-quality heuristics. Pure functions — the gate between
 * extraction tiers. "Good" means: enough text, mostly letters, real words.
 * Anything else falls through to the next (more expensive) tier.
 */

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

export function isGoodText(text: string | null | undefined): boolean {
  if (!text) return false;
  return assessTextQuality(text).ok;
}
