// ─── Identification Decisions ───────────────────────────────────────────────
// Deterministic decision layer. All rules that keep the scanner from
// confidently returning a wrong printing live HERE, in code — never in a
// model prompt. The prompt asking vision to "return -1 if unsure" is a
// suggestion; the illustration guard below is a guarantee.

import type { CandidatePrinting, Confidence } from "./evidence";

// ─── Match methods and their calibrated confidence ──────────────────────────
// Confidence is a property of HOW a match was made, not a number a model
// reports about itself. Ordered strongest → weakest.

export type MatchMethod =
  | "set-cn-verified"    // set+collector lookup whose name also matches the OCR name
  | "single-printing"    // the identified card has exactly one printing
  | "single-art-group"   // evidence narrowed candidates to one printing without vision
  | "art-group-vision"   // vision picked an art group; that group has one printing
  | "user-selection"     // the user picked from the disambiguation grid
  | "fallback-guess";    // legacy weak path — must never be auto-saved

export const METHOD_CONFIDENCE: Record<MatchMethod, Confidence> = {
  "set-cn-verified": 0.97,
  "single-printing": 0.9,
  "single-art-group": 0.85,
  "art-group-vision": 0.8,
  "user-selection": 1.0,
  "fallback-guess": 0.4,
};

/** Minimum confidence to auto-save without user involvement. */
export const ACCEPT_THRESHOLD = 0.85;
/** Auto/bulk scanning saves without a review screen, so demand more. */
export const ACCEPT_THRESHOLD_AUTOSCAN = 0.95;

export type DecisionAction =
  | "accept"        // save automatically
  | "disambiguate"  // show candidates, let the user choose
  | "not-found";    // nothing matched — ask for a rescan

export interface Decision {
  action: DecisionAction;
  confidence: Confidence;
  method?: MatchMethod;
  printing?: CandidatePrinting;
  candidates?: CandidatePrinting[];
}

// ─── Illustration guard ─────────────────────────────────────────────────────

/**
 * Group candidate printings by illustration. Two printings with the same
 * illustrationId are visually identical in artwork (e.g. MH2 Counterspell
 * vs its MagicFest promo) — no artwork comparison can tell them apart.
 *
 * Candidates without an illustrationId (Pokemon/Yugioh sources don't provide
 * one yet) each form their own group: we can't PROVE two arts are identical,
 * so vision may still compare them — same behavior as before Phase 1.
 */
export function groupByIllustration(
  candidates: CandidatePrinting[]
): Map<string, CandidatePrinting[]> {
  const groups = new Map<string, CandidatePrinting[]>();
  for (const c of candidates) {
    const key = c.illustrationId || `unknown:${c.externalId}`;
    const group = groups.get(key);
    if (group) group.push(c);
    else groups.set(key, [c]);
  }
  return groups;
}

/**
 * THE core safety rule: artwork comparison is only meaningful when the
 * candidates span more than one illustration. If every candidate shares one
 * illustration, vision must not be asked to pick — the answer would be a
 * coin flip dressed up as a match.
 */
export function canVisionDisambiguate(candidates: CandidatePrinting[]): boolean {
  return groupByIllustration(candidates).size > 1;
}

// ─── Decision helpers ────────────────────────────────────────────────────────

export function acceptDecision(printing: CandidatePrinting, method: MatchMethod): Decision {
  return { action: "accept", confidence: METHOD_CONFIDENCE[method], method, printing };
}

export function disambiguateDecision(candidates: CandidatePrinting[]): Decision {
  return { action: "disambiguate", confidence: 0, candidates };
}

export function notFoundDecision(): Decision {
  return { action: "not-found", confidence: 0 };
}

/**
 * Final gate before auto-saving: an accept decision below the threshold for
 * the current scan mode is demoted to user disambiguation.
 */
export function gateDecision(decision: Decision, isAutoScan: boolean): Decision {
  if (decision.action !== "accept" || !decision.printing) return decision;
  const threshold = isAutoScan ? ACCEPT_THRESHOLD_AUTOSCAN : ACCEPT_THRESHOLD;
  if (decision.confidence >= threshold) return decision;
  return { ...decision, action: "disambiguate", candidates: [decision.printing] };
}
