// ─── Scoring Seam ───────────────────────────────────────────────────────────
// The single interface between "what the sensors saw" and "which printing we
// believe it is". The route builds evidence and candidates, hands both to the
// Scorer, and gates on the Scorer's output shape — it never consults
// METHOD_CONFIDENCE or branches on match paths itself.
//
// Today's implementation is the HEURISTIC scorer: the method-based decision
// logic that has run since Phase 1, plus the strip-rarity contradiction guard.
// The planned evidence-based ProbabilisticScorer (log-odds fusion + softmax
// posterior — see the target-architecture design) drops in behind this same
// interface once a labeled evaluation dataset exists to calibrate it. Margin
// and evidenceMass exist on the output NOW so gating and telemetry don't need
// to change shape when that swap happens.

import {
  assessIdentitySignals,
  calculateEvidenceMass,
  calculateEvidenceCoverage,
  normalizeRarity,
  type CandidatePrinting,
  type EvidenceCoverage,
  type EvidenceSignal,
  type ScanEvidence,
} from "@/lib/scanner/evidence";
import {
  type Decision,
  type MatchMethod,
  acceptDecision,
  disambiguateDecision,
  notFoundDecision,
} from "@/lib/scanner/decision";
import { decideAmongPrintings } from "@/lib/scanner/rank";
import type { LearningRuleInfo } from "@/lib/scanner/visual";

export interface ScoreInput {
  cardName: string;
  printings: CandidatePrinting[];
  fallbackCard: CandidatePrinting | null;
  fallbackMethod?: MatchMethod;
  evidence: ScanEvidence;
  scannedImageUrl: string;
  learningRule: LearningRuleInfo | null;
}

export interface ScoreOutput {
  decision: Decision;
  /** Final belief the chosen printing is exactly right, in [0, 1]. */
  confidence: number;
  /** Separation between the best and second-best candidate, in [0, 1].
   *  Heuristic scorer: 1 for accepts, 0 for disambiguation — coarse but
   *  shape-compatible with the probabilistic posterior margin. */
  margin: number;
  /** How many independent evidence fields contributed to the decision. */
  evidenceMass: number;
  /** The per-signal breakdown that produced `evidenceMass`, in stable order.
   *  Observational only — carried through to telemetry so future calibration
   *  can weigh each signal against ground truth. Empty when no printing was
   *  chosen (disambiguate/not-found). Never an input to gating or ranking. */
  evidenceSignals: EvidenceSignal[];
  /** Availability breakdown of the same signals (Phase 5.10): how many expected
   *  sensors fired, how many failed, how many are unavailable for this game.
   *  Observational CONTEXT for the score — never an input to gating or ranking,
   *  and it does not change EvidenceMass. Empty coverage when no printing was
   *  chosen (disambiguate/not-found). */
  evidenceCoverage: EvidenceCoverage;
  /** Which path produced the verdict — telemetry, not a confidence source. */
  methodLabel: string;
}

export interface Scorer {
  score(input: ScoreInput): Promise<ScoreOutput>;
}

// ─── Rarity contradiction guard ─────────────────────────────────────────────
// The strip pass reads the printed rarity as corroboration. When it clearly
// contradicts the accepted printing's rarity, the accept is demoted to user
// disambiguation. Only methods WITHOUT printing-level corroboration are
// guarded — a set+CN-verified match outranks a one-letter rarity read.

const RARITY_GUARDED_METHODS: ReadonlyArray<MatchMethod> = ["single-printing", "art-group-vision"];

function rarityContradicts(evidence: ScanEvidence, printing: CandidatePrinting): boolean {
  const read = evidence.printing.rarity?.value;
  if (!read || !printing.rarity) return false;
  const a = normalizeRarity(read);
  const b = normalizeRarity(printing.rarity);
  return a !== null && b !== null && a !== b;
}

// ─── Heuristic scorer ───────────────────────────────────────────────────────

export class HeuristicScorer implements Scorer {
  async score(input: ScoreInput): Promise<ScoreOutput> {
    const { cardName, printings, fallbackCard, fallbackMethod, evidence, scannedImageUrl, learningRule } = input;

    let decision: Decision;

    if (printings.length === 1) {
      console.log(`[Scanner] Exactly one printing exists — no disambiguation needed.`);
      decision = acceptDecision(printings[0], "single-printing");
    } else if (printings.length === 0) {
      decision = fallbackCard
        ? acceptDecision(fallbackCard, fallbackMethod ?? "fallback-guess")
        : notFoundDecision();
    } else if (learningRule?.ruleType === "FORCE_DISAMBIGUATION") {
      // We KNOW this card is hard — skip AI comparison entirely
      console.log(`[Scanner] 🧠 FORCE_DISAMBIGUATION rule active for "${cardName}" — skipping AI comparison.`);
      decision = disambiguateDecision(printings);
    } else {
      console.log(`[Scanner] Deciding among ${printings.length} printings...`);
      decision = await decideAmongPrintings(
        printings,
        scannedImageUrl,
        {
          setCode: evidence.printing.setCode?.value ?? "",
          collectorNumber: evidence.printing.collectorNumber?.value ?? "",
        },
        learningRule,
      );
      // artworkBoundary is now attached by decideAmongPrintings
    }

    // Rarity guard: a printed-rarity contradiction demotes accepts that lack
    // printing-level corroboration of their own.
    if (
      decision.action === "accept" &&
      decision.printing &&
      decision.method &&
      RARITY_GUARDED_METHODS.includes(decision.method) &&
      rarityContradicts(evidence, decision.printing)
    ) {
      console.log(
        `[Scanner] Strip rarity "${evidence.printing.rarity?.value}" contradicts ` +
        `"${decision.printing.rarity}" on ${decision.printing.setName} — demoting to disambiguation.`
      );
      decision = {
        ...decision,
        action: "disambiguate",
        candidates: decision.candidates ?? (printings.length > 0 ? printings : [decision.printing]),
      };
    }

    // Use calculated margin from vision comparison if available; otherwise use heuristic.
    const margin = decision.decisionMargin ?? (decision.action === "accept" ? 1 : 0);

    // EvidenceMass: net independent identity confirmation for the chosen printing
    // (Phase 5.5, Batch 3). Signals are assessed against the SPECIFIC candidate we
    // landed on — how much deterministic proof backs THIS card — never against
    // vision confidence. When nothing was chosen (disambiguate/not-found) there is
    // no candidate to confirm, so mass is 0.
    const signals = decision.printing ? assessIdentitySignals(evidence, decision.printing) : [];
    const evidenceMass = calculateEvidenceMass(signals);
    // Coverage is CONTEXT for the mass, not a term in it (Phase 5.10): how many
    // of the sensors that could have fired for this game actually did.
    const evidenceCoverage = calculateEvidenceCoverage(signals);
    if (decision.printing) {
      console.log(
        `[Scanner] EvidenceMass ${evidenceMass.toFixed(1)} — ` +
        signals.map((s) => `${s.type}:${s.state}`).join(", ")
      );
      console.log(
        `[Scanner] Coverage ${evidenceCoverage.present}/${evidenceCoverage.expected} sensors present` +
        (evidenceCoverage.failed ? `, ${evidenceCoverage.failed} failed` : "") +
        (evidenceCoverage.unavailable ? `, ${evidenceCoverage.unavailable} unavailable for this game` : "")
      );
    }

    return {
      decision,
      confidence: decision.confidence,
      margin,
      evidenceMass,
      evidenceSignals: signals,
      evidenceCoverage,
      methodLabel: decision.method ?? decision.action,
    };
  }
}

export const scorer: Scorer = new HeuristicScorer();
