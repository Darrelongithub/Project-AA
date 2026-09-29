/**
 * /db/repo — vision cache and usage ledger. Extracted verbatim from the Repo god class;
 * every function takes the Repo as its first argument and the Repo
 * facade in ../repo.ts delegates to it (same API, same behaviour).
 */
import { VisionCacheStore, isValidCachedVision } from "../../extraction/gemini";
import { VisionExtraction } from "../../types";
import type { Repo } from "../repo";
import { utcDay } from "../../util/day";

// ── Vision cache (round 19) ──────────────────────────────────────────────
// Gemini results cached by content SHA-256 so the same bytes are never paid
// for twice; a dead vision model can replay the last-known reading instead
// of failing the document.
export function visionCacheGet(repo: Repo, sha256: string): VisionExtraction | null {
  const r = repo.db.prepare("SELECT result_json FROM gemini_cache WHERE sha256 = ?").get(sha256) as
    | { result_json: string }
    | undefined;
  if (!r) return null;
  try {
    const parsed = JSON.parse(r.result_json);
    // A corrupt/truncated cache row is a MISS, never trusted data.
    if (!isValidCachedVision(parsed)) {
      repo.db.prepare("DELETE FROM gemini_cache WHERE sha256 = ?").run(sha256);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}


export function visionCacheSet(repo: Repo, sha256: string, result: VisionExtraction): void {
  repo.db
    .prepare(
      `INSERT INTO gemini_cache (sha256, result_json) VALUES (?, ?)
       ON CONFLICT(sha256) DO UPDATE SET result_json = excluded.result_json`
    )
    .run(sha256, JSON.stringify(result));
}


export function visionCallsToday(repo: Repo): number {
  const today = utcDay();
  const key = `gemini_calls_${today}`;
  const val = repo.getSetting(key, "0");
  const n = Number(val);
  return Number.isFinite(n) ? n : 0;
}


export function noteVisionCall(repo: Repo): void {
  const today = utcDay();
  const key = `gemini_calls_${today}`;
  repo.setSetting(key, String(repo.visionCallsToday() + 1));
  // One counter row per day accumulates forever otherwise; drop the rest.
  repo.db
    .prepare(`DELETE FROM settings WHERE key LIKE 'gemini_calls_%' AND key <> ?`)
    .run(key);
}


/** Adapter factory: hands the extraction layer a DB-backed cache store. */
export function visionCacheStore(repo: Repo): VisionCacheStore {
  return {
    get: (sha) => repo.visionCacheGet(sha),
    set: (sha, r) => repo.visionCacheSet(sha, r),
    callsToday: () => repo.visionCallsToday(),
    noteCall: () => repo.noteVisionCall(),
  };
}
