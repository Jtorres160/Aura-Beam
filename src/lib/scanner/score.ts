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

import type { CandidatePrinting, ScanEvidence } from "@/lib/scanner/evidence";
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

/** Map the many printed/database rarity spellings onto one comparable token.
 *  Unknown spellings return null and the guard stands down — conservative. */
function normalizeRarity(raw: string): string | null {
  const map: Record<string, string> = {
    c: "common", common: "common",
    u: "uncommon", uncommon: "uncommon",
    r: "rare", rare: "rare",
    m: "mythic", mythic: "mythic", "mythic rare": "mythic",
  };
  return map[raw.trim().toLowerCase()] ?? null;
}

function rarityContradicts(evidence: ScanEvidence, printing: CandidatePrinting): boolean {
  const read = evidence.printing.rarity?.value;
  if (!read || !printing.rarity) return false;
  const a = normalizeRarity(read);
  const b = normalizeRarity(printing.rarity);
  return a !== null && b !== null && a !== b;
}

// ─── Heuristic scorer ───────────────────────────────────────────────────────

/** Count the evidence fields that actually carried a reading into this scan. */
function countEvidenceMass(evidence: ScanEvidence): number {
  const fields = [
    evidence.identity.name,
    evidence.printing.setCode,
    evidence.printing.collectorNumber,
    evidence.printing.rarity,
  ];
  return fields.filter((f) => f && f.value !== "").length;
}

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

    return {
      decision,
      confidence: decision.confidence,
      margin: decision.action === "accept" ? 1 : 0,
      evidenceMass: countEvidenceMass(evidence),
      methodLabel: decision.method ?? decision.action,
    };
  }
}

export const scorer: Scorer = new HeuristicScorer();
