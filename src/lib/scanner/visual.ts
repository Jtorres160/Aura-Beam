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

export interface VisionResult {
  index: number;
  scores: number[];
}

// ─── Vision: pick the matching art group ───────────────────────────────────
// Returns the index and confidence scores for each candidate representative.
// Scores are in [0, 1] and represent match confidence. Returns null when
// uncertain, out of range, or the call fails.
export async function pickArtGroupByVision(
  scannedImageUrl: string,
  representatives: CandidatePrinting[],
  learningRule: LearningRuleInfo | null,
): Promise<VisionResult | null> {
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
          content: `You are an expert trading card artwork identifier. The user has scanned a physical card (first image). You are given ${representatives.length} candidate card images (images 2 through ${representatives.length + 1}). Compare the artwork, border style, foil pattern, and card layout of the scanned card against each candidate.

Respond with ONLY valid JSON in this format:
{"index": <number>, "scores": [<confidence>, <confidence>, ...]}

Where:
- "index" is the 0-based index of the candidate that BEST matches (or -1 if none match)
- "scores" is an array with one confidence value [0.0-1.0] per candidate
- Confidence 1.0 means EXACTLY matches; 0.9+ means very close match
- Confidence 0.1-0.4 means possible but uncertain match
- Confidence 0.0-0.1 means does not match

Example for 3 candidates where #0 is the clear winner:
{"index": 0, "scores": [0.95, 0.25, 0.15]}${
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
      max_tokens: 100,
      temperature: 0.0,
    }, { timeout: VISION_TIMEOUT_MS, maxRetries: 1 });

    const raw = (visualResponse.choices[0]?.message?.content || "").trim();
    const parsed = JSON.parse(raw);

    if (
      typeof parsed.index === "number" &&
      Array.isArray(parsed.scores) &&
      parsed.scores.length === representatives.length &&
      parsed.scores.every((s: any) => typeof s === "number" && s >= 0 && s <= 1)
    ) {
      if (parsed.index === -1 || (parsed.index >= 0 && parsed.index < representatives.length)) {
        return parsed as VisionResult;
      }
    }
    return null;
  } catch (visualErr: any) {
    console.warn("[Scanner] Visual comparison failed, falling back to disambiguation:", visualErr?.message);
    return null;
  }
}
