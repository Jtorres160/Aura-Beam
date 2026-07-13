// ─── Printing Ranking ───────────────────────────────────────────────────────
// Step 3 of the scan pipeline: choose among multiple printings of an identified
// card. Order matters: deterministic evidence (printed set/CN) beats vision, and
// vision is only consulted where it CAN work — between different illustrations.

import { assessArtworkBoundary, collectorNumberKey, type CandidatePrinting } from "@/lib/scanner/evidence";
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
  ocr: { setCode: string; collectorNumber: string },
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
