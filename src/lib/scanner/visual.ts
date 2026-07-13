// ─── Vision Comparison ──────────────────────────────────────────────────────
// The scanner's visual sensor: given the scanned image and one representative
// image per art group, ask the vision model which art group matches. Produces
// a single reading (an index or "uncertain"); the ranking layer decides what
// that reading means.

import OpenAI from "openai";
import type { CandidatePrinting } from "@/lib/scanner/evidence";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "dummy_build_key",
});

// Per-call ceiling (Phase 5.2.5): a hung comparison degrades to "uncertain"
// (user disambiguation) via the existing catch instead of hanging the scan.
const VISION_TIMEOUT_MS = 20_000;

/** The slice of an AiLearningRule the pipeline consumes. */
export interface LearningRuleInfo {
  ruleType: string;
  content: string;
}

// ─── Vision: pick the matching art group ───────────────────────────────────
// Returns the index of the matching representative, or null when the model is
// uncertain, answers out of range, or the call fails.
export async function pickArtGroupByVision(
  scannedImageUrl: string,
  representatives: CandidatePrinting[],
  learningRule: LearningRuleInfo | null,
): Promise<number | null> {
  try {
    const candidateImages = representatives.map((p) => ({
      type: "image_url" as const,
      image_url: { url: p.thumbnailUrl as string, detail: "low" as const }
    }));

    const visualResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are an expert trading card artwork identifier. The user has scanned a physical card (first image). You are given ${representatives.length} candidate card images (images 2 through ${representatives.length + 1}). Compare the artwork, border style, foil pattern, and card layout of the scanned card against each candidate. Respond with ONLY a single integer:
- The 0-based index of the candidate that CLEARLY AND EXACTLY matches the scanned card.
- Return -1 if NONE of the candidate images match the scanned card perfectly.
- Return -1 if you are not confident or if multiple candidates look identical.${
  learningRule?.ruleType === "HINT" ? `\n\nIMPORTANT HINT from past scans: ${learningRule.content}` : ""
}`
        },
        {
          role: "user",
          content: [
            // The scanned card goes in at HIGH detail — it's the one image the
            // model must read precisely to tell near-identical artworks apart.
            // Candidate references stay low detail to keep the call fast/cheap.
            { type: "image_url", image_url: { url: scannedImageUrl, detail: "high" } },
            ...candidateImages
          ]
        }
      ],
      max_tokens: 5,
      temperature: 0.0,
    }, { timeout: VISION_TIMEOUT_MS, maxRetries: 1 });

    const raw = (visualResponse.choices[0]?.message?.content || "-1").trim();
    const parsed = parseInt(raw, 10);
    if (!isNaN(parsed) && parsed >= 0 && parsed < representatives.length) {
      return parsed;
    }
    return null;
  } catch (visualErr: any) {
    console.warn("[Scanner] Visual comparison failed, falling back to disambiguation:", visualErr?.message);
    return null;
  }
}
