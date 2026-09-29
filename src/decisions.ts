/**
 * Decision provenance — the ONE typed path an outcome can travel.
 *
 * Every recorded case outcome is a `Decision`: the outcome itself plus WHO
 * decided (the rules engine automatically, or a named human) and WHY
 * (reasoning). The class is sealed at runtime, not just in the type system:
 *
 * - The constructor requires a module-private seal, so `new Decision(...)`
 *   throws outside this module even through `as any` casts.
 * - Each instance carries a private (#) seal field, so `Object.create`
 *   forgeries fail the genuineness check (`Repo.recordDecision` rejects
 *   anything that is not a genuine `Decision`).
 * - The only factories are `Decision.auto` (the rules engine's provisional
 *   auto-decision, which can ONLY be `auto_approved` — the product never
 *   auto-declines) and `Decision.human` (the ONE explicit human-decision
 *   constructor, which requires a username and can never claim `auto_*`
 *   provenance).
 *
 * Allowed construction sites (verified by review + the Phase-8 break-attempt):
 *   - `Decision.auto`: the pipeline's provisional-admission step, after the
 *     evaluator routed auto_admit and every gate agreed.
 *   - `Decision.human`: the case-page human decision handler.
 *
 * `Repo.recordDecision` is the only writer that accepts a `Decision`, and it
 * re-checks the organization policy gate (`autoDecisionsAllowed`) for every
 * automated decision — an auto-decision with the flags off throws instead of
 * landing, no matter which code path attempted it.
 */
import type { AdmissionDecision, CaseOutcome, CaseType } from "./types";

/** Who/what produced a decision. Persisted as `admission_route`. */
export type DecisionSource = "rules-auto" | "human";

/** Module-private seal: never exported, so nothing outside can forge one. */
const DECISION_SEAL = Symbol("Decision-seal");

const AUTO_OUTCOMES: ReadonlySet<string> = new Set(["auto_approved"]);
const HUMAN_OUTCOMES: ReadonlySet<string> = new Set(["approved_after_review", "not_approved"]);

export class Decision {
  readonly outcome: CaseOutcome;
  readonly source: DecisionSource;
  readonly reasoning: string;
  /** Staff username for human decisions; null when the rules engine decided. */
  readonly decidedBy: string | null;
  /** Instance seal — present only on genuinely constructed Decisions. */
  readonly #seal: symbol = DECISION_SEAL;

  private constructor(seal: symbol, outcome: CaseOutcome, source: DecisionSource, reasoning: string, decidedBy: string | null) {
    if (seal !== DECISION_SEAL) {
      throw new Error("Decision: refusing direct construction — use Decision.auto() / Decision.human()");
    }
    this.outcome = outcome;
    this.source = source;
    this.reasoning = reasoning;
    this.decidedBy = decidedBy;
  }

  /**
   * The rules engine's provisional auto-decision. Only `auto_approved` can
   * be produced here — there is no automated decline path in this product.
   */
  static auto(input: { outcome: "auto_approved"; reasoning: string }): Decision {
    if (!input.reasoning || !input.reasoning.trim()) throw new Error("Decision.auto: reasoning is required");
    if (!AUTO_OUTCOMES.has(input.outcome)) throw new Error(`Decision.auto: refusing outcome "${input.outcome}"`);
    return new Decision(DECISION_SEAL, input.outcome, "rules-auto", input.reasoning, null);
  }

  /**
   * The ONE explicit human-decision constructor. Requires the decider's
   * staff username and can only record human provenance (never `auto_*`).
   */
  static human(input: { outcome: "approved_after_review" | "not_approved"; reasoning: string; decidedBy: string }): Decision {
    if (!input.reasoning || !input.reasoning.trim()) throw new Error("Decision.human: reasoning is required");
    if (!input.decidedBy || !input.decidedBy.trim()) throw new Error("Decision.human: decidedBy (staff username) is required");
    if (!HUMAN_OUTCOMES.has(input.outcome)) throw new Error(`Decision.human: refusing outcome "${input.outcome}"`);
    return new Decision(DECISION_SEAL, input.outcome, "human", input.reasoning, input.decidedBy);
  }

  /**
   * Genuineness check: instanceof AND the private seal field. `Object.create`
   * forgeries (right prototype, no private field) throw on the field access
   * and are rejected.
   */
  static isGenuine(value: unknown): value is Decision {
    if (!(value instanceof Decision)) return false;
    try {
      return (value as Decision).checkSeal();
    } catch {
      return false;
    }
  }

  /** The legacy admissions-vocabulary mirror of this outcome. */
  legacyDecision(): AdmissionDecision {
    switch (this.outcome) {
      case "auto_approved": return "auto_admitted";
      case "approved_after_review": return "admitted_after_review";
      case "not_approved": return "not_admitted";
      default: return "undecided";
    }
  }

  /** The `admission_route` value for this decision's provenance. */
  route(): string {
    return this.source === "rules-auto" ? "auto" : "human";
  }

  private checkSeal(): boolean {
    return this.#seal === DECISION_SEAL;
  }
}

/** The narrow store surface the auto-decision policy gate reads. */
export interface AutoPolicyStore {
  getApplicant(id: number): { category?: string | null } | undefined;
  caseTypeForCase(id: number): Pick<CaseType, "education_module" | "auto_admit" | "default_reply_action"> | undefined;
  automationMode(category: string): string;
}

/**
 * THE auto-decision policy gate (single enforcement point): an automated
 * decision may land only on an education-module profile that explicitly
 * opts into auto-decisions (`auto_admit`), whose reply posture is not
 * draft/hold, while the effective automation mode is "auto".
 * `Repo.recordDecision` calls this for every rules-auto decision;
 * `autoAdmitPolicy` (routing pre-check) delegates to it too.
 */
export function autoDecisionsAllowed(store: AutoPolicyStore, applicantId: number, category?: string): boolean {
  const a = store.getApplicant(applicantId);
  if (!a) return false;
  const profile = store.caseTypeForCase(applicantId);
  if (!profile || profile.education_module !== 1 || profile.auto_admit !== 1) return false;
  const reply = profile.default_reply_action ?? "draft";
  if (reply === "draft" || reply === "hold") return false;
  return store.automationMode(category ?? a.category ?? "normal") === "auto";
}
