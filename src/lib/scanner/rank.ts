// ─── Printing Ranking ───────────────────────────────────────────────────────
// Step 3 of the scan pipeline: choose among multiple printings of an identified
// card. Order matters: deterministic evidence (printed set/CN) beats vision, and
// vision is only consulted where it CAN work — between different illustrations.

import {
  SET_CN_CONFIDENCE,
  assessArtworkBoundary,
  collectorNumberKey,
  printedTotalFromCollectorNumber,
  type CandidatePrinting,
} from "@/lib/scanner/evidence";
import { SETCODE_OPTIONAL_MATCH_ENABLED } from "@/lib/scanner/candidates";
import {
  type Decision,
  acceptDecision,
  disambiguateDecision,
  groupByIllustration,
} from "@/lib/scanner/decision";
import { type LearningRuleInfo, pickArtGroupByVision, type VisionResult } from "@/lib/scanner/visual";

// ─── Max candidate images sent to AI for visual comparison ────────────────
// Max images to send to the vision model (detail: low = 85 tokens each, 150 = ~12,750 tokens, $0.0019)
const MAX_VISUAL_CANDIDATES = 150;

// Above this many distinct artworks, a single vision pick is unreliable (too
// many near-identical thumbnails) AND slow. Past this point we skip vision
// entirely and let the user choose — faster, and honest about the uncertainty.
const VISION_MAX_ART_GROUPS = 6;

// ─── Decide among multiple printings ────────────────────────────────────────
export async function decideAmongPrintings(
  printings: CandidatePrinting[],
  scannedImageUrl: string,
  ocr: {
    setCode: string;
    collectorNumber: string;
    /** Confidence of the reconciled collector-number READING (evidence.ts
     *  SET_CN_CONFIDENCE): 0.5 full-pass only, 0.75 strip-pass only, 0.95 both
     *  OCR passes independently agreed. Gates the CN+printed-total narrowing
     *  below — see the comment there for the production evidence. Optional so
     *  callers without a reconciled reading (tests, Yugioh) simply never take
     *  that path. */
    collectorNumberConfidence?: number;
  },
  learningRule: LearningRuleInfo | null,
): Promise<Decision> {
  // Assess artwork boundary upfront — a pure property of the game/source.
  const artworkBoundary = assessArtworkBoundary(printings[0].game);

  // Evidence narrowing: an OCR'd set code (plus collector number when read)
  // that pins exactly one printing decides without any artwork comparison.
  if (ocr.setCode) {
    const cleanCn = ocr.collectorNumber ? collectorNumberKey(ocr.collectorNumber) : "";
    const narrowed = printings.filter((p) => {
      if (!p.setCode || p.setCode.toLowerCase() !== ocr.setCode.toLowerCase()) return false;
      if (cleanCn) return collectorNumberKey(p.collectorNumber || "") === cleanCn;
      return true;
    });
    if (narrowed.length === 1) {
      console.log(`[Scanner] OCR set/CN evidence narrowed to one printing: ${narrowed[0].setName}`);
      // When BOTH set code and collector number pinned this single printing,
      // that is the same verified evidence as the direct set+CN database lookup
      // in candidates.ts — so it must earn the SAME classification,
      // "set-cn-verified" (0.97), not the weaker "single-art-group" (0.85).
      // Emitting different methods for identical evidence was a bug: the ranked
      // path could never auto-accept in bulk (0.97 clears the auto-scan gate,
      // 0.85 does not). Set code alone (no collector number) is weaker printing
      // evidence and stays "single-art-group".
      const method = cleanCn ? "set-cn-verified" : "single-art-group";
      return { ...acceptDecision(narrowed[0], method), artworkBoundary };
    }
  }

  // ─── CN + printed-total narrowing (set-code-independent) ──────────────────
  // The literal setCode comparison above only succeeds when OCR's read and the
  // candidate row happen to share a vocabulary — the stored codes are genuinely
  // mixed (measured 2026-07-29 on catalog_cards: 90.3% of rows carry the
  // printed-symbol ptcgoCode, 9.7% a provider slug like "sv3") and, worse, the
  // set-code "read" is largely a model guess at a set SYMBOL that isn't text at
  // all (matched ground truth 3/14). The number pair the card actually prints —
  // "073/163" — is the stronger key and was being thrown away: within one
  // name's candidate pool, collectorNumberKey + setPrintedSize pins exactly one
  // printing for all but 41 of 2,749 multi-printing pools (worst collision 3).
  //
  // THE AGREEMENT GATE IS LOAD-BEARING. Replaying labeled production scans
  // (user selections are the ground truth, per telemetry.ts) showed the
  // full-card pass can hallucinate the ENTIRE pair, anchored on other cards in
  // the same session: a card the user identified as me1-33 (printed 033/132)
  // was read "038/163" — and 38/163 names a REAL Battle Styles printing of the
  // same Pokémon, so an ungated version of this filter would have confidently
  // accepted the wrong card (3 of 6 replayed cases from the 2026-07-29
  // session). Every one of those hallucinations was a full-pass-only reading
  // (0.5). Agreed readings (both OCR passes independently producing the same
  // collector number, 0.95) replayed 1 confirmed-correct auto-resolve and 2
  // conflicts that are only explainable as exploratory picks in degraded
  // fallback flows — suggestive, but NOT yet the measured hit rate an ungated
  // accept must earn. Hence the flag below. The gate itself stays regardless:
  // a weaker-than-agreed reading falls through to the vision/user path exactly
  // as today, no matter how cleanly it pins one candidate.
  //
  // Gated by SETCODE_OPTIONAL_MATCH_ENABLED — this is the ranking-layer half of
  // the same "set-code-optional matching" feature as resolveByNameNumberTotal
  // in candidates.ts (same method label, same doctrine), and it ships dark
  // under the same flag so one reviewed decision, backed by the set-cn-verified
  // baseline being collected, activates both layers together. Unset ⇒ this
  // block is never entered and ranking is byte-identical to today's.
  //
  // The set code plays NO part here — not even as a tiebreaker. A disagreeing
  // set code must not veto a unique pair match (that would reinstate the
  // vocabulary gate this path exists to bypass), and an AGREEING one has
  // already been claimed by the literal narrowing above at 0.97 — the two
  // compare set codes identically, so any tie this path sees is one the set
  // code already failed to break. 2+ pair-equal candidates fall through.
  //
  // setPrintedSize is only populated by Pokémon sources; where it is absent
  // (MTG, Yugioh) or the read carries no "/total", printedTotal is null and the
  // path stands down without touching behavior.
  const printedTotal = SETCODE_OPTIONAL_MATCH_ENABLED
    ? printedTotalFromCollectorNumber(ocr.collectorNumber || "")
    : null;
  if (printedTotal !== null && (ocr.collectorNumberConfidence ?? 0) >= SET_CN_CONFIDENCE.agree) {
    const cnKey = collectorNumberKey(ocr.collectorNumber);
    const pinned = printings.filter(
      (p) =>
        p.setPrintedSize != null &&
        p.setPrintedSize === printedTotal &&
        p.collectorNumber != null &&
        collectorNumberKey(p.collectorNumber) === cnKey,
    );
    if (pinned.length === 1) {
      const resolved = pinned[0];
      console.log(`[Scanner] Agreed CN + printed total pinned one printing: ${resolved.setName} ${resolved.collectorNumber}/${resolved.setPrintedSize}`);
      // "name-cn-total-verified" (0.9): auto-accepts interactively, where a
      // review screen still stands between it and the collection, but stays
      // below ACCEPT_THRESHOLD_AUTOSCAN — so in bulk mode the gate demotes it
      // to disambiguation. Carry the full pool (best match first) so that
      // demotion still shows the grid, not a one-card dead end.
      const rest = printings.filter((p) => p !== resolved);
      return {
        ...acceptDecision(resolved, "name-cn-total-verified"),
        candidates: [resolved, ...rest],
        bestMatchExternalId: resolved.externalId,
        artworkBoundary,
      };
    }
    // 0 or still-ambiguous: fall through to the vision/user path unchanged —
    // uncertainty, not a guess.
  }

  // Illustration guard: if every candidate shares one illustration, vision
  // would be a coin flip — go straight to the user.
  const groups = Array.from(groupByIllustration(printings).values());
  if (groups.length === 1) {
    console.log(`[Scanner] All ${printings.length} printings share one illustration — vision cannot distinguish them.`);
    return { ...disambiguateDecision(printings), artworkBoundary };
  }

  // Too many distinct artworks for a vision pick to be trustworthy or fast —
  // skip the model call and let the user choose from the grid straight away.
  if (groups.length > VISION_MAX_ART_GROUPS) {
    console.log(`[Scanner] ${groups.length} distinct artworks — beyond reliable vision range; asking the user.`);
    return { ...disambiguateDecision(printings), artworkBoundary };
  }

  // Vision compares ONE representative image per art group, not every printing.
  const comparable = groups
    .map((group) => ({ group, rep: group.find((p) => p.thumbnailUrl) }))
    .filter((entry): entry is { group: CandidatePrinting[]; rep: CandidatePrinting } => Boolean(entry.rep))
    .slice(0, MAX_VISUAL_CANDIDATES);

  if (comparable.length < 2) {
    // Not enough candidate images to compare anything
    return { ...disambiguateDecision(printings), artworkBoundary };
  }

  console.log(`[Scanner] Visual comparison across ${comparable.length} art groups (${printings.length} printings)...`);
  const visionResult = await pickArtGroupByVision(scannedImageUrl, comparable.map((c) => c.rep), learningRule);

  if (visionResult === null || visionResult.index === -1) {
    console.log(`[Scanner] AI is uncertain — requesting user disambiguation.`);
    return { ...disambiguateDecision(printings), artworkBoundary };
  }

  const picked = comparable[visionResult.index];

  // Calculate margin: separation between top and second-best candidate score.
  // With only one candidate, margin is 1 (no competition).
  const sortedScores = [...visionResult.scores].sort((a, b) => b - a);
  const margin = sortedScores.length > 1 ? sortedScores[0] - sortedScores[1] : 1;

  // Surface vision's pick first, then every other printing as an alternative,
  // so a below-threshold match never dead-ends on a single un-overridable card.
  const rest = printings.filter((p) => !picked.group.includes(p));
  const ordered = [...picked.group, ...rest];

  if (picked.group.length === 1) {
    console.log(`[Scanner] Visual match selected art group -> ${picked.group[0].setName}`);
    // Accept semantics stay (so a high-enough confidence would auto-save), but
    // carry the alternatives + best-match marker for when the gate demotes it.
    const decision = acceptDecision(picked.group[0], "art-group-vision");
    return { ...decision, candidates: ordered, bestMatchExternalId: picked.group[0].externalId, artworkBoundary, decisionMargin: margin };
  }

  // The matched artwork is shared by several printings (e.g. a set card and
  // its promo). Artwork can go no further — the user picks within the group.
  // No single member is "best" (identical art), so we don't mark one.
  console.log(`[Scanner] Visual match is an art group of ${picked.group.length} identical-art printings — user must pick.`);
  return { ...disambiguateDecision(ordered), artworkBoundary, decisionMargin: margin };
}
