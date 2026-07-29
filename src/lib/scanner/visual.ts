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
// Letters, not digits, deliberately: whether the model's pick is 0- or 1-based
// was a live defect at the time, and numeric keys would have put a thumb on that
// scale. Letters carry no base information.
//
// ─── The pick: keyed too — and this did NOT fix the ±1 defect ───────────────
// The model used to answer `{"index": N}`, a NUMBER whose base it had to infer.
// Measured over the 49-entry stratified corpus, the reported index was ALWAYS
// either the correct candidate or the correct candidate + 1 (49/49, two reps).
// Because a 1-based answer only lands OUT of range when the correct candidate is
// last, the defect was invisible for first/middle positions and produced silent
// WRONG ACCEPTS: 10 of 36 subsetted corpus entries (28%). A "realign when out of
// range" rule was measured against the same corpus and refuted — it cannot see an
// in-range wrong base, and left the middle-position cells bit-for-bit unchanged.
//
// So the pick became a LABEL, not a number: `{"pick": "c"}` names one of the very
// same letters `scores` is keyed by, enum-constrained in the strict schema. No
// base to infer, no counting for the model to do in either field.
//
// MEASURED RESULT: this did not fix it. Re-run against the same corpus, the ±1
// signature survived UNCHANGED — every miss still exactly +1 (12/36 subsetted,
// 0 "neither"), middle-position cells still 3/10, and the subsetted wrong-accept
// rate rose to 33%. Letters carry no base, so the base was never the cause. The
// scores object shifts in LOCKSTEP with the pick (argmax agrees 36/36, versus
// 12/36 disagreement under the numeric contract), which places the fault in how
// the model maps images to candidates — most likely counting the scanned image
// as one of them — upstream of the reply format entirely. Last position now
// scores 13/13 only because the enum has no letter past the Nth, so a +1
// overflow is clamped back onto the correct answer; that cell is rescued by an
// artifact, not understood. Do not read it as a fix.
//
// Kept because it is strictly better-formed than a bare integer and removes one
// confounder from the next experiment, NOT because it solved the defect. See
// scratch/REPORT-artgroup-letter-label.md. The open lead is message structure —
// interleaving a text label before each candidate image, and/or separating the
// scanned card from the candidate sequence.
//
// The letters are deliberately SHARED between the two fields rather than given
// separate alphabets. `pick` names one of the keys the model has just scored, so
// one vocabulary makes the two fields cross-checkable and reads as a single
// question ("score every candidate, then name the winner"); two alphabets would
// invent a second mapping for the model to get wrong, which is the class of bug
// this whole change removes.
const CANDIDATE_KEY_ALPHABET = "abcdefghijklmnopqrstuvwxyz";

// The "none of these match" label. Multi-character, so it can never collide with
// a candidate letter, and it is a member of the same enum — the sensor's
// uncertainty channel is part of the contract, not an out-of-band value.
// It decodes to index -1, which is what rank.ts routes to disambiguation.
export const NONE_MATCH_LABEL = "none";

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

/**
 * Decode the model's `pick` label into a candidate index.
 *
 * Returns a LABELLED outcome rather than a bare null so telemetry can tell a
 * reply it could not read from one that named a candidate we did not offer —
 * the same distinction `decodeVisionReply` draws for the reply as a whole.
 *
 * Case and surrounding whitespace are normalised. That is not leniency about
 * the contract: a letter identifies the same candidate whatever its case, and
 * unlike a number it carries no base for normalisation to get wrong.
 */
export type PickDecode =
  | { outcome: "ok"; index: number }
  | { outcome: "malformed" }
  | { outcome: "out-of-range" };

export function decodePick(raw: unknown, count: number): PickDecode {
  if (typeof raw !== "string") return { outcome: "malformed" };
  const label = raw.trim().toLowerCase();
  // Checked before the single-character test: "none" is a real answer, and the
  // one the scanner must never lose. It is valid at any candidate count.
  if (label === NONE_MATCH_LABEL) return { outcome: "ok", index: -1 };
  if (label.length !== 1) return { outcome: "malformed" };
  const index = CANDIDATE_KEY_ALPHABET.indexOf(label);
  if (index < 0) return { outcome: "malformed" };
  // A real letter that names no live candidate (e.g. "d" of 3) is the label-space
  // equivalent of the old out-of-range index. The strict enum should make it
  // unreachable; it is still labelled rather than silently clamped.
  if (index >= count) return { outcome: "out-of-range" };
  return { outcome: "ok", index };
}

/** What the reply contained, for telemetry — reported whether or not it passed. */
export interface VisionReplyShape {
  /** The RESOLVED candidate index (-1 for "none"), whichever field it came from. */
  index?: number;
  /** The raw `pick` label as the model wrote it, when it sent one. */
  pick?: string;
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
 * The reply's pick arrives as a LABEL (`pick: "c"`), which this resolves to the
 * numeric index the rest of the pipeline consumes. Resolution is a lookup in the
 * same letter order the candidate images were attached in — it is not a
 * correction, and nothing here shifts, clamps or realigns a candidate.
 *
 * "none of these candidates match" is preserved end to end: the `"none"` label
 * decodes to -1, rank.ts routes -1 to user disambiguation, and no other path can
 * produce it. Collapsing it onto a real candidate would convert the sensor's
 * only uncertainty channel into a silent wrong accept.
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

  // `body?.pick` — NOT `body.pick`. A reply of the literal text "null" parses
  // fine and then throws on the property read, landing in the outer catch where
  // it is logged as outcome=error, i.e. blamed on the transport. A reply we
  // could read but not use is a different defect from a call we could not make,
  // and the telemetry has to be able to tell them apart.
  const rawPick = body?.pick;
  const pick = typeof rawPick === "string" ? rawPick : undefined;

  let index: number | undefined;
  let outOfRange = false;

  if (rawPick !== undefined) {
    const decoded = decodePick(rawPick, count);
    if (decoded.outcome === "ok") index = decoded.index;
    else outOfRange = decoded.outcome === "out-of-range";
  } else if (typeof body?.index === "number") {
    // Legacy numeric pick. The strict schema below makes `index` unreachable for
    // every candidate count the pipeline actually produces (rank.ts caps art
    // groups at 6, well inside the alphabet), so this only covers a reply that
    // predates the schema or one made without it. It is READ, not trusted: this
    // is the field whose base ambiguity caused the 28% wrong-accept rate, so it
    // is deliberately not given any realignment here either — it passes through
    // exactly as reported and an out-of-range value is still rejected.
    index = body.index;
  }

  const shape: VisionReplyShape = { index, pick, scoresLen, scoresArgmax };

  // Unreadable scores outrank an unreadable pick: the scores feed rank.ts's
  // decision margin, so a reply missing them is unusable regardless of its pick.
  if (scores === null) {
    return { outcome: "rejected-malformed", result: null, shape };
  }
  if (index === undefined) {
    return {
      outcome: outOfRange ? "rejected-index-out-of-range" : "rejected-malformed",
      result: null,
      shape,
    };
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
  pick?: string;
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
  // `index` here is the RESOLVED candidate index; `pick` is the raw label the
  // model wrote. Both are logged: the pair is what makes a label-resolution
  // problem distinguishable from a recognition problem after the fact.
  const pick =
    input.index === undefined && input.scoresLen === undefined && input.pick === undefined
      ? ""
      : ` pick=${input.pick ?? "?"} index=${input.index ?? "?"}`
        + ` scoresArgmax=${input.scoresArgmax ?? "?"} scoresLen=${input.scoresLen ?? "?"}`;
  console.log(
    `[Scanner] ⏱  vision-cost art-compare | candidates=${candidateCount} ` +
    `image=${approxImageKB(scannedImageUrl)}KB detail=high ` +
    `promptTokens=${u.prompt_tokens ?? "?"} completionTokens=${u.completion_tokens ?? "?"} ` +
    `${timing} outcome=${outcome}${pick}`
  );
}

// ─── Message structure: every image carries its own name ────────────────────
// The heading that introduces each image. These are not decoration — they are
// the load-bearing part of this call, and the reason it is a pure exported
// function with a test rather than an inline array literal.
//
// The candidates used to be a bare run of images whose letters existed only in
// the system prompt ("labelled a, b, c in the order they are attached"). That
// asked the model to count through an image sequence that BEGINS WITH THE
// SCANNED CARD, and the measured result was a pick that was correct-or-
// correct+1 — precisely what counting the scan as the first candidate produces.
// It failed SILENTLY: a +1 that stays in range is a wrong printing written into
// a collection with no fall-through for the collector to see. 28% of the
// stratified corpus, and two reply-schema fixes in a row could not touch it.
//
// Anchoring each letter to the image directly below it took the stratified
// corpus from 24/36 to 36/36 with zero wrong accepts, across two reps, and
// removed the +1 population entirely (12 -> 0). See
// scratch/REPORT-artgroup-message-structure.md.
export const SCANNED_CARD_HEADING = "SCANNED CARD:";
export const candidateHeading = (label: string): string => `Candidate ${label}:`;

/**
 * Assemble the chat messages for the art-group comparison.
 *
 * Pure and exported so the structural invariant is testable without a network
 * call: every candidate image is immediately preceded by its own heading, and
 * the scanned card is introduced as something that is NOT a candidate. Nothing
 * in this function may make a candidate's identity depend on its position in
 * the content array.
 */
export function buildArtGroupMessages(
  scannedImageUrl: string,
  representatives: CandidatePrinting[],
  learningRule: LearningRuleInfo | null,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  // One letter per candidate, in the order the images are attached. The
  // example is built at this width too, so it can never teach a 3-wide
  // answer to a 2- or 4-candidate question (the measured failure).
  const keys = candidateKeys(representatives.length);
  const exampleScores = keys
    .map((k, i) => `"${k}": ${i === 0 ? "0.95" : i === 1 ? "0.25" : "0.15"}`)
    .join(", ");
  // The exact heading strings the candidate images are attached under, quoted
  // back in the prompt so the model is pointed at text it can actually see.
  const candidateHeadings = keys.map((k) => `"${candidateHeading(k)}"`).join(", ");

  const labeledCandidates = representatives.flatMap((p, i) => {
    const image = {
      type: "image_url" as const,
      // Candidate references stay low detail to keep the call fast and cheap.
      image_url: { url: p.thumbnailUrl as string, detail: "low" as const },
    };
    // Past the alphabet there is no label to anchor to — the strict schema is
    // already dropped in that case (canKeyScores), so the image goes in bare.
    // rank.ts caps art groups at 6, so this is unreachable in the pipeline.
    const label = keys[i];
    return label
      ? [{ type: "text" as const, text: candidateHeading(label) }, image]
      : [image];
  });

  return [
    {
      role: "system",
      // No image is referred to by number OR by position anywhere in this
      // prompt. The original wording ("candidate images (images 2 through
      // N+1)") asked the model to answer with a 0-based index while numbering
      // the images from 1 including the scan. Replacing the numeric answer
      // with a letter did not help — the ±1 shift survived — so the remaining
      // ambiguity was the mapping itself. Every image now carries its own name
      // on the line directly above it, and this prompt points at those lines
      // rather than at any ordering.
      content: `You are an expert trading card artwork identifier.

Every image in this request is named by the text line immediately above it:
- "${SCANNED_CARD_HEADING}" introduces the photograph of the physical card to identify. It is NOT a candidate and has no letter.
- ${candidateHeadings} each introduce one of the ${representatives.length} candidate cards.

Read each candidate's letter off the line directly above its image. Never determine a letter by counting images or by an image's position in the request.

Compare the artwork, border style, foil pattern, and card layout of the scanned card against each candidate.

Respond with ONLY valid JSON in this format:
{"pick": <label>, "scores": {${keys.map((k) => `"${k}": <confidence>`).join(", ")}}}

Where:
- "pick" is the LABEL of the candidate that BEST matches — one of: ${keys.map((k) => `"${k}"`).join(", ")}. Answer with the letter itself, never a number.
- If none of the candidates match the scanned card, answer "pick": "${NONE_MATCH_LABEL}". Say so rather than naming your closest guess — a wrong pick is worse than no pick.
- "scores" has exactly one confidence value [0.0-1.0] per candidate, under that candidate's label. Every label listed above must appear, and no others.
- Confidence 1.0 means EXACTLY matches; 0.9+ means very close match
- Confidence 0.1-0.4 means possible but uncertain match
- Confidence 0.0-0.1 means does not match

Example for ${representatives.length} candidates where candidate "${keys[0]}" is the clear winner:
{"pick": "${keys[0]}", "scores": {${exampleScores}}}${
        learningRule?.ruleType === "HINT"
          ? `\n\nIMPORTANT HINT from past scans: ${learningRule.content}`
          : ""
      }`,
    },
    {
      role: "user",
      content: [
        // Each image is introduced by the text part directly before it, so the
        // letter-to-image mapping is anchored rather than positional.
        { type: "text", text: SCANNED_CARD_HEADING },
        // The scanned card goes in at HIGH detail — it's the one image the
        // model must read precisely to tell near-identical artworks apart.
        { type: "image_url", image_url: { url: scannedImageUrl, detail: "high" } },
        ...labeledCandidates,
      ],
    },
  ];
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
    shape?: VisionReplyShape,
  ) =>
    logVisionCost({
      candidateCount: representatives.length,
      scannedImageUrl,
      usage,
      spans: spansRef.current,
      outcome,
      index: shape?.index,
      pick: shape?.pick,
      scoresArgmax: shape?.scoresArgmax,
      scoresLen: shape?.scoresLen,
    });

  try {
    const keys = candidateKeys(representatives.length);
    const keyed = canKeyScores(representatives.length);
    // Every label the model may answer with, including the uncertainty channel.
    const pickEnum = [...keys, NONE_MATCH_LABEL];

    // Routed through the SAME gate as the two OCR passes (Phase 5.13 audit).
    // This call was the one vision request in the pipeline that bypassed it: a
    // full-detail scanned image plus one thumbnail per art group is the single
    // most token-heavy call we make, and in bulk it landed on OpenAI's token
    // bucket unpaced, alongside the next scan's OCR pair. Single scans pay
    // nothing for this — by the time scoring runs, the OCR passes have long
    // since consumed their spacing gap — so it buys burst safety for free.
    const visualResponse = await throttleVision(() => openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: buildArtGroupMessages(scannedImageUrl, representatives, learningRule),
      // Both the arity AND the pick are enforced here, not in the parser. Every
      // candidate key is `required` with `additionalProperties: false`, so the
      // API will not return a scores object of the wrong width; and `pick` is an
      // enum over exactly the live candidate labels plus "none", so the API will
      // not return a pick that names a candidate we did not offer. Neither field
      // asks the model to count or to infer an index base.
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
                  required: ["pick", "scores"],
                  properties: {
                    pick: { type: "string", enum: pickEnum },
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
    logCost(decoded.outcome, decoded.shape);
    return decoded.result;
  } catch (visualErr: any) {
    logCost(`error:${visualErr?.status ?? ""}${visualErr?.code ? `/${visualErr.code}` : ""}`);
    console.warn("[Scanner] Visual comparison failed, falling back to disambiguation:", visualErr?.message);
    return null;
  }
}
