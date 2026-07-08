// ─── Printing Ranking ───────────────────────────────────────────────────────
// Step 3 of the scan pipeline: choose among multiple printings of an identified
// card. Order matters: deterministic evidence (printed set/CN) beats vision, and
// vision is only consulted where it CAN work — between different illustrations.

import type { CandidatePrinting } from "@/lib/scanner/evidence";
import {
  type Decision,
  acceptDecision,
  disambiguateDecision,
  groupByIllustration,
} from "@/lib/scanner/decision";
import { type LearningRuleInfo, pickArtGroupByVision } from "@/lib/scanner/visual";

// ─── Max candidate images sent to AI for visual comparison ────────────────
// Max images to send to the vision model (detail: low = 85 tokens each, 150 = ~12,750 tokens, $0.0019)
const MAX_VISUAL_CANDIDATES = 150;

// ─── Decide among multiple printings ────────────────────────────────────────
export async function decideAmongPrintings(
  printings: CandidatePrinting[],
  scannedImageUrl: string,
  ocr: { setCode: string; collectorNumber: string },
  learningRule: LearningRuleInfo | null,
): Promise<Decision> {
  // Evidence narrowing: an OCR'd set code (plus collector number when read)
  // that pins exactly one printing decides without any artwork comparison.
  if (ocr.setCode) {
    const cleanCn = ocr.collectorNumber ? ocr.collectorNumber.split("/")[0].trim().toLowerCase() : "";
    const narrowed = printings.filter((p) => {
      if (!p.setCode || p.setCode.toLowerCase() !== ocr.setCode.toLowerCase()) return false;
      if (cleanCn) return (p.collectorNumber || "").toLowerCase() === cleanCn;
      return true;
    });
    if (narrowed.length === 1) {
      console.log(`[Scanner] OCR set/CN evidence narrowed to one printing: ${narrowed[0].setName}`);
      return acceptDecision(narrowed[0], "single-art-group");
    }
  }

  // Illustration guard: if every candidate shares one illustration, vision
  // would be a coin flip — go straight to the user.
  const groups = Array.from(groupByIllustration(printings).values());
  if (groups.length === 1) {
    console.log(`[Scanner] All ${printings.length} printings share one illustration — vision cannot distinguish them.`);
    return disambiguateDecision(printings);
  }

  // Vision compares ONE representative image per art group, not every printing.
  const comparable = groups
    .map((group) => ({ group, rep: group.find((p) => p.thumbnailUrl) }))
    .filter((entry): entry is { group: CandidatePrinting[]; rep: CandidatePrinting } => Boolean(entry.rep))
    .slice(0, MAX_VISUAL_CANDIDATES);

  if (comparable.length < 2) {
    // Not enough candidate images to compare anything
    return disambiguateDecision(printings);
  }

  console.log(`[Scanner] Visual comparison across ${comparable.length} art groups (${printings.length} printings)...`);
  const pickedIndex = await pickArtGroupByVision(scannedImageUrl, comparable.map((c) => c.rep), learningRule);

  if (pickedIndex === null) {
    console.log(`[Scanner] AI is uncertain — requesting user disambiguation.`);
    return disambiguateDecision(printings);
  }

  const picked = comparable[pickedIndex];
  if (picked.group.length === 1) {
    console.log(`[Scanner] Visual match selected art group -> ${picked.group[0].setName}`);
    return acceptDecision(picked.group[0], "art-group-vision");
  }

  // The matched artwork is shared by several printings (e.g. a set card and
  // its promo). Artwork can go no further — the user picks within the group.
  console.log(`[Scanner] Visual match is an art group of ${picked.group.length} identical-art printings — user must pick.`);
  return disambiguateDecision(picked.group);
}
