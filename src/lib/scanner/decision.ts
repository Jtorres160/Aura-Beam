// ─── Identification Decisions ───────────────────────────────────────────────
// Deterministic decision layer. All rules that keep the scanner from
// confidently returning a wrong printing live HERE, in code — never in a
// model prompt. The prompt asking vision to "return -1 if unsure" is a
// suggestion; the illustration guard below is a guarantee.

import type { ArtworkBoundary, CandidatePrinting, Confidence } from "./evidence";

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
  // A confident vision match to a single UNIQUE-art printing auto-accepts in
  // interactive scanning — the user shouldn't confirm every card. It stays
  // below ACCEPT_THRESHOLD_AUTOSCAN, so bulk scans (no review screen) still
  // fall back to the highlighted disambiguation grid. Shared-art groups and
  // uncertain matches never reach this method — they go straight to the grid.
  "art-group-vision": 0.86,
  "user-selection": 1.0,
  "fallback-guess": 0.4,
};

/** Minimum confidence to auto-save without user involvement. */
export const ACCEPT_THRESHOLD = 0.85;
/** Auto/bulk scanning saves without a review screen, so demand more. */
export const ACCEPT_THRESHOLD_AUTOSCAN = 0.95;
/** Minimum top1–top2 separation for an auto-save. The heuristic scorer emits
 *  1 for accepts (vacuous); the floor becomes live with the probabilistic
 *  scorer, where near-ties must never auto-accept. */
export const MARGIN_FLOOR = 0.2;
/** Minimum count of contributing evidence fields for an auto-save. */
export const MIN_EVIDENCE_MASS = 1;

export type DecisionAction =
  | "accept"        // save automatically
  | "disambiguate"  // show candidates, let the user choose
  | "not-found";    // nothing matched — ask for a rescan

/** Why a decision was made (for telemetry and clarity). */
export type DecisionReason =
  | "accepted"
  | "user_required_art_selection";

export const DECISION_REASON = {
  ACCEPTED: "accepted" as const,
  USER_REQUIRED_ART_SELECTION: "user_required_art_selection" as const,
} as const;

export interface Decision {
  action: DecisionAction;
  confidence: Confidence;
  method?: MatchMethod;
  printing?: CandidatePrinting;
  candidates?: CandidatePrinting[];
  /**
   * externalId of the printing vision judged the best match, when the decision
   * carries a preferred candidate among its alternatives. Lets the UI highlight
   * it at the top of the disambiguation grid.
   */
  bestMatchExternalId?: string;
  /** Artwork capability boundary for this decision's candidates. */
  artworkBoundary?: ArtworkBoundary;
  /** Why this decision was made (e.g., user required due to artwork uncertainty). */
  reason?: DecisionReason;
  /** Separation between best and second-best candidate (0-1). Used for margin-based gating. */
  decisionMargin?: number;
}

// ─── OCR name verification ──────────────────────────────────────────────────

/** Collapse a card name to a comparable form: no case, accents or punctuation. */
function normalizeName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Bounded edit distance for OCR noise tolerance. */
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const prev = new Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      diag = prev[j];
      prev[j] = next;
    }
  }
  return prev[b.length];
}

/**
 * Does an OCR'd name refer to this candidate card? Backs the "set-cn-verified"
 * method: a set+collector lookup only earns its high confidence when the name
 * on the card agrees with the card the lookup returned. Tolerates OCR noise
 * (case, accents, punctuation, up to 2 typos on longer names) and double-faced
 * names, where OCR usually reads only the front face.
 */
export function nameMatchesOcr(ocrName: string, candidateName: string): boolean {
  const ocr = normalizeName(ocrName);
  if (!ocr) return false;
  const targets = [candidateName, ...candidateName.split("//")].map(normalizeName);
  for (const target of targets) {
    if (!target) continue;
    if (target === ocr) return true;
    if (target.length >= 8 && editDistance(ocr, target) <= 2) return true;
  }
  return false;
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
 * the current scan mode is demoted to user disambiguation. The gate consumes
 * the Scorer output SHAPE (confidence + margin + mass), never a method table,
 * so a scorer swap doesn't touch it.
 *
 * Additionally: when artwork identity is unavailable (e.g., Pokémon), demote
 * narrow-margin art-group-vision matches to user selection. Strong evidence
 * (e.g., set-cn-verified) still auto-accepts regardless of artwork boundary.
 *
 * Note: margin/evidenceMass floors are currently dormant in the heuristic
 * scorer (margin always 1/0, evidenceMass always ≥1), but are enforced here
 * so the probabilistic scorer (Phase 6) drops in transparently.
 */
export function gateDecision(
  decision: Decision,
  isAutoScan: boolean,
  score?: { margin: number; evidenceMass: number },
): Decision {
  if (decision.action !== "accept" || !decision.printing) return decision;
  const threshold = isAutoScan ? ACCEPT_THRESHOLD_AUTOSCAN : ACCEPT_THRESHOLD;

  // Confidence is the primary gate for all methods.
  if (decision.confidence < threshold) {
    return { ...decision, action: "disambiguate", candidates: decision.candidates ?? [decision.printing] };
  }

  // Artwork uncertainty guard (Phase 5.5): when artwork identity is unavailable
  // and vision picked the card with a narrow margin, require user selection.
  // This prevents false certainty when the data source can't verify artwork.
  // Strong methods like set-cn-verified (0.97) are unaffected and auto-accept.
  if (
    decision.method === "art-group-vision" &&
    decision.artworkBoundary?.artworkConfidence === "uncertain" &&
    decision.artworkBoundary?.requiresUserSelectionWhenArtworkUncertain &&
    score &&
    score.margin < MARGIN_FLOOR
  ) {
    console.log(
      `[Scanner] Artwork identity uncertain + narrow margin (${score.margin.toFixed(2)}) ` +
      `— requesting user selection instead of auto-accept.`
    );
    return {
      ...decision,
      action: "disambiguate",
      reason: DECISION_REASON.USER_REQUIRED_ART_SELECTION,
      candidates: decision.candidates ?? [decision.printing],
    };
  }

  // Future: margin and evidenceMass floors (Phase 6 probabilistic scorer).
  // For now, these are dormant (heuristic scorer emits margin=1, evidenceMass≥1).
  // const marginOk = !score || score.margin >= MARGIN_FLOOR;
  // const massOk = !score || score.evidenceMass >= MIN_EVIDENCE_MASS;
  // if (!marginOk || !massOk) return disambiguate;

  return decision;
}
