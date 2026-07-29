// ─── Vision Comparison ──────────────────────────────────────────────────────
// The scanner's visual sensor: given the scanned image and one representative
// image per art group, ask the vision model which art group matches. Produces
// a single reading (an index or "uncertain"); the ranking layer decides what
// that reading means.

import OpenAI from "openai";
import type { CandidatePrinting } from "@/lib/scanner/evidence";
import { throttleVision, type VisionCallSpans } from "@/lib/scanner/vision-throttle";
import { approxImageKB } from "@/lib/scanner/vision-cost";

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

// ─── Art-comparison cost observability (Phase 5.17C) ────────────────────────
// The OCR passes have logOcrCost (extract.ts); this call had nothing, so it was
// the one leg of the pipeline whose cost and failure mode were invisible. It is
// folded into `scoreMs`, a single opaque number covering grouping + vision +
// ranking, which is why a 9916ms scan could not be attributed after the fact.
//
// Logs the three things that turned out to matter: where the wall-clock went
// (gate vs model vs our own 429 backoff), what the call cost in tokens (the
// scanned image at detail:"high" dominates it), and what the model actually
// answered — `index` alongside the argmax of its own `scores`, plus whether the
// reply passed validation. That last pair is deliberately recorded even when
// the reply is accepted: an index that disagrees with its own scores is a
// silent wrong pick, and only a production sample can say how often that lands.
//
// Observation ONLY: every value is read off the request we already send and the
// response we already receive. Nothing is persisted, retried, or branched on —
// the returned VisionResult is byte-identical without any of this.
function logVisionCost(input: {
  candidateCount: number;
  scannedImageUrl: string;
  usage: any;
  spans: VisionCallSpans | null;
  outcome: string;
  index?: number;
  scoresArgmax?: number;
  scoresLen?: number;
}): void {
  const { candidateCount, scannedImageUrl, usage, spans, outcome } = input;
  const u = usage || {};
  const timing = spans
    ? `gate=${spans.gateMs}ms call=${spans.callMs}ms backoff=${spans.backoffMs}ms attempts=${spans.attempts}`
    : "gate=? call=? backoff=? attempts=?";
  // `scoresLen` vs `candidates` is the discriminator for a malformed reply: a
  // wrong-length scores array and an out-of-range index fail the same check.
  const pick =
    input.index === undefined && input.scoresLen === undefined
      ? ""
      : ` index=${input.index ?? "?"} scoresArgmax=${input.scoresArgmax ?? "?"} scoresLen=${input.scoresLen ?? "?"}`;
  console.log(
    `[Scanner] ⏱  vision-cost art-compare | candidates=${candidateCount} ` +
    `image=${approxImageKB(scannedImageUrl)}KB detail=high ` +
    `promptTokens=${u.prompt_tokens ?? "?"} completionTokens=${u.completion_tokens ?? "?"} ` +
    `${timing} outcome=${outcome}${pick}`
  );
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
  // Held in a ref so the throttle's span callback can fill it in without TS
  // narrowing the binding to `null` at the logging sites below.
  const spansRef: { current: VisionCallSpans | null } = { current: null };
  let usage: any = null;
  const logCost = (
    outcome: string,
    index?: number,
    scoresArgmax?: number,
    scoresLen?: number,
  ) =>
    logVisionCost({
      candidateCount: representatives.length,
      scannedImageUrl,
      usage,
      spans: spansRef.current,
      outcome,
      index,
      scoresArgmax,
      scoresLen,
    });

  try {
    const candidateImages = representatives.map((p) => ({
      type: "image_url" as const,
      image_url: { url: p.thumbnailUrl as string, detail: "low" as const }
    }));

    // Routed through the SAME gate as the two OCR passes (Phase 5.13 audit).
    // This call was the one vision request in the pipeline that bypassed it: a
    // full-detail scanned image plus one thumbnail per art group is the single
    // most token-heavy call we make, and in bulk it landed on OpenAI's token
    // bucket unpaced, alongside the next scan's OCR pair. Single scans pay
    // nothing for this — by the time scoring runs, the OCR passes have long
    // since consumed their spacing gap — so it buys burst safety for free.
    const visualResponse = await throttleVision(() => openai.chat.completions.create({
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
    }, { timeout: VISION_TIMEOUT_MS, maxRetries: 1 }),
    (s) => { spansRef.current = s; });
    usage = visualResponse.usage;

    const raw = (visualResponse.choices[0]?.message?.content || "").trim();
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Previously indistinguishable from a transport failure — both landed in
      // the outer catch as "Visual comparison failed". A reply we couldn't read
      // is a different defect from a call we couldn't make.
      logCost(`unparseable:${JSON.stringify(raw.slice(0, 40))}`);
      return null;
    }

    // The model's own argmax, recorded next to the index it reported. These
    // should agree; a divergence means the reported pick contradicts the
    // reported evidence. Read-only — the decision still uses `index`.
    const scoresLen = Array.isArray(parsed?.scores) ? parsed.scores.length : undefined;
    const scoresArgmax =
      scoresLen && scoresLen > 0 ? parsed.scores.indexOf(Math.max(...parsed.scores)) : -1;
    const reportedIndex = typeof parsed?.index === "number" ? parsed.index : undefined;

    if (
      typeof parsed.index === "number" &&
      Array.isArray(parsed.scores) &&
      parsed.scores.length === representatives.length &&
      parsed.scores.every((s: any) => typeof s === "number" && s >= 0 && s <= 1)
    ) {
      if (parsed.index === -1 || (parsed.index >= 0 && parsed.index < representatives.length)) {
        logCost(parsed.index === -1 ? "accepted-none-match" : "accepted", reportedIndex, scoresArgmax, scoresLen);
        return parsed as VisionResult;
      }
      logCost("rejected-index-out-of-range", reportedIndex, scoresArgmax, scoresLen);
      return null;
    }
    logCost("rejected-malformed", reportedIndex, scoresArgmax, scoresLen);
    return null;
  } catch (visualErr: any) {
    logCost(`error:${visualErr?.status ?? ""}${visualErr?.code ? `/${visualErr.code}` : ""}`);
    console.warn("[Scanner] Visual comparison failed, falling back to disambiguation:", visualErr?.message);
    return null;
  }
}
