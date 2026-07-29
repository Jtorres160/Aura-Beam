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

// ─── Reply arity: keyed, not counted ────────────────────────────────────────
// The model used to be asked for `"scores": [a, b, c]` — an array whose length
// it had to get right by counting. It frequently did not. Measured over 378
// logged replies, the over-emission is a counting failure, not a fixed offset:
//
//   N=2 -> 40 replies of length 3      N=3 -> 0 wrong (matches the 3-wide example)
//   N=4 -> 40 replies of length 5      N=5 -> 1 wrong      N=6 -> 0 wrong
//
// A length-N+1 array fails the `scores.length === representatives.length` check
// below and the whole reply is discarded before `index` is ever read, so the
// scan falls through to user disambiguation.
//
// The fix is to stop asking for a counted array. `scores` is now an OBJECT with
// one letter-keyed entry per candidate, declared through a strict json_schema
// with every key in `required` and `additionalProperties: false`. Arity becomes
// an API-enforced invariant rather than something the model tallies.
//
// Letters, not digits, deliberately: the separate question of whether `index`
// is 0- or 1-based is a live, unresolved defect, and numeric keys would put a
// thumb on that scale. Letters carry no base information, so this change is
// orthogonal to it — `index` is read exactly as it was before.
const CANDIDATE_KEY_ALPHABET = "abcdefghijklmnopqrstuvwxyz";

/** Keys for N candidates, in candidate order: a, b, c, … */
function candidateKeys(count: number): string[] {
  return CANDIDATE_KEY_ALPHABET.slice(0, count).split("");
}

/** Schema-enforceable only up to the alphabet; rank.ts caps art groups at 6. */
function canKeyScores(count: number): boolean {
  return count > 0 && count <= CANDIDATE_KEY_ALPHABET.length;
}

const isUnitScore = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

/**
 * Decode the model's `scores` field into one score per candidate, in candidate
 * order. Accepts the keyed object the schema now requests, and still accepts a
 * bare array so a reply that predates the schema (or slips past it) is read
 * rather than thrown away.
 *
 * Arity is exact in both shapes. A wrong-length reply is REJECTED, never
 * trimmed to fit: rank.ts computes its decision margin from this array and
 * decision.ts demotes accepts below MARGIN_FLOOR, so dropping an element would
 * quietly move a live gate. Measured on the long arrays we have, trimming moves
 * the margin in 90% of them and crosses MARGIN_FLOOR in 77%.
 */
export function decodeScores(raw: unknown, count: number): number[] | null {
  if (Array.isArray(raw)) {
    if (raw.length !== count) return null;
    return raw.every(isUnitScore) ? (raw as number[]) : null;
  }
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (Object.keys(obj).length !== count) return null;
    const values = candidateKeys(count).map((k) => obj[k]);
    return values.every(isUnitScore) ? (values as number[]) : null;
  }
  return null;
}

/** What the reply contained, for telemetry — reported whether or not it passed. */
export interface VisionReplyShape {
  index?: number;
  scoresLen?: number;
  scoresArgmax: number;
}

export type VisionDecode =
  | { outcome: "accepted" | "accepted-none-match"; result: VisionResult; shape: VisionReplyShape }
  | { outcome: "rejected-malformed" | "rejected-index-out-of-range"; result: null; shape: VisionReplyShape };

/**
 * Turn a parsed reply body into either a VisionResult or a labelled rejection.
 * Pure, so the reply contract is testable without a network call.
 *
 * `index` is passed through EXACTLY as the model reported it. In particular -1
 * ("none of these candidates match") is preserved: rank.ts routes it to user
 * disambiguation, and remapping it to a real candidate would convert honest
 * uncertainty into a silent wrong accept.
 */
export function decodeVisionReply(parsed: unknown, count: number): VisionDecode {
  const body = parsed as Record<string, unknown> | null | undefined;
  const rawScores = body?.scores;

  const scoresLen = Array.isArray(rawScores)
    ? rawScores.length
    : rawScores && typeof rawScores === "object"
      ? Object.keys(rawScores).length
      : undefined;

  const scores = decodeScores(rawScores, count);
  const scoresArgmax = scores && scores.length > 0 ? scores.indexOf(Math.max(...scores)) : -1;

  // `parsed?.index` — NOT `parsed.index`. A reply of the literal text "null"
  // parses fine and then throws on the property read, landing in the outer
  // catch where it is logged as outcome=error, i.e. blamed on the transport.
  // A reply we could read but not use is a different defect from a call we
  // could not make, and the telemetry has to be able to tell them apart.
  const index = typeof body?.index === "number" ? body.index : undefined;
  const shape: VisionReplyShape = { index, scoresLen, scoresArgmax };

  if (index === undefined || scores === null) {
    return { outcome: "rejected-malformed", result: null, shape };
  }
  if (index !== -1 && !(index >= 0 && index < count)) {
    return { outcome: "rejected-index-out-of-range", result: null, shape };
  }
  return {
    outcome: index === -1 ? "accepted-none-match" : "accepted",
    result: { index, scores },
    shape,
  };
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
    // One letter per candidate, in the order the images are attached. The
    // example is built at this width too, so it can never teach a 3-wide
    // answer to a 2- or 4-candidate question (the measured failure).
    const keys = candidateKeys(representatives.length);
    const keyed = canKeyScores(representatives.length);
    const exampleScores = keys
      .map((k, i) => `"${k}": ${i === 0 ? "0.95" : i === 1 ? "0.25" : "0.15"}`)
      .join(", ");

    const visualResponse = await throttleVision(() => openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are an expert trading card artwork identifier. The user has scanned a physical card (first image). You are given ${representatives.length} candidate card images (images 2 through ${representatives.length + 1}). Compare the artwork, border style, foil pattern, and card layout of the scanned card against each candidate.

Respond with ONLY valid JSON in this format:
{"index": <number>, "scores": {${keys.map((k) => `"${k}": <confidence>`).join(", ")}}}

Where:
- The candidate images are labelled ${keys.join(", ")}, in the order they are attached.
- "index" is the 0-based index of the candidate that BEST matches (or -1 if none match)
- "scores" has exactly one confidence value [0.0-1.0] per candidate, under that candidate's label. Every label listed above must appear, and no others.
- Confidence 1.0 means EXACTLY matches; 0.9+ means very close match
- Confidence 0.1-0.4 means possible but uncertain match
- Confidence 0.0-0.1 means does not match

Example for ${representatives.length} candidates where the first candidate is the clear winner:
{"index": 0, "scores": {${exampleScores}}}${
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
      // Arity enforcement lives here, not in the parser. Every candidate key is
      // `required` and `additionalProperties` is false, so the API itself will
      // not return a scores object of the wrong width. `index` is left as a
      // plain integer — deliberately unconstrained beyond its type, so this
      // does not alter how the model chooses or encodes it.
      ...(keyed
        ? {
            response_format: {
              type: "json_schema" as const,
              json_schema: {
                name: "art_group_pick",
                strict: true,
                schema: {
                  type: "object",
                  additionalProperties: false,
                  required: ["index", "scores"],
                  properties: {
                    index: { type: "integer" },
                    scores: {
                      type: "object",
                      additionalProperties: false,
                      required: keys,
                      properties: Object.fromEntries(
                        keys.map((k) => [k, { type: "number" }]),
                      ),
                    },
                  },
                },
              },
            },
          }
        : {}),
      max_tokens: 200,
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

    // `scoresArgmax` is the model's own argmax, recorded next to the index it
    // reported. These should agree; a divergence means the reported pick
    // contradicts the reported evidence. Read-only — the decision uses `index`.
    const decoded = decodeVisionReply(parsed, representatives.length);
    const { index, scoresArgmax, scoresLen } = decoded.shape;
    logCost(decoded.outcome, index, scoresArgmax, scoresLen);
    return decoded.result;
  } catch (visualErr: any) {
    logCost(`error:${visualErr?.status ?? ""}${visualErr?.code ? `/${visualErr.code}` : ""}`);
    console.warn("[Scanner] Visual comparison failed, falling back to disambiguation:", visualErr?.message);
    return null;
  }
}
