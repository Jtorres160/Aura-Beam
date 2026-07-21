// ─── OCR Extraction ─────────────────────────────────────────────────────────
// Step 1 of the scan pipeline: read the card's printed fields off the image.
// The OCR model is a noisy SENSOR — it only produces readings here; the
// decision layer downstream owns the identification verdict.

import OpenAI from "openai";
import { reading, SET_CN_CONFIDENCE, type FieldReading } from "@/lib/scanner/evidence";
import { throttleVision } from "@/lib/scanner/vision-throttle";
import { cropBottomStrip } from "@/lib/scanner/crop-strip";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "dummy_build_key",
});

// ─── OCR cost observability (Phase 5.17B) ───────────────────────────────────
// `ocrMs` is a single opaque await around the vision call — the pipeline's
// dominant cost (~1763ms median) but with no visibility into WHY. This logs the
// two real, un-fabricated drivers of that cost so a future OCR phase has a
// before/after signal: the uploaded image size (a resolution/quality change
// moves this) and OpenAI's own token accounting (image tiles land in
// prompt_tokens, so `detail:"high"` vs a smaller image shows up here directly).
//
// Observation ONLY: measured from the request we already send and the response
// we already receive. Nothing is persisted, returned, retried, or branched on —
// the OCR reading and every decision downstream are byte-identical without it.
function approxImageKB(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  const b64 = comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
  // base64 encodes 3 bytes per 4 chars; good enough for an order-of-magnitude log.
  return Math.round((b64.length * 0.75) / 1024);
}
function logOcrCost(pass: string, imageUrl: string, detail: string, usage: any): void {
  const u = usage || {};
  console.log(
    `[Scanner] ⏱  ocr-cost ${pass} | image=${approxImageKB(imageUrl)}KB detail=${detail} ` +
    `promptTokens=${u.prompt_tokens ?? "?"} completionTokens=${u.completion_tokens ?? "?"}`
  );
}

// Per-call ceilings (Phase 5.2.5): a hung vision call must fail fast into a
// classified error, not spin until the platform kills the whole function.
// SDK-level retries keep transient blips (incl. residual 429s) invisible; they
// already honor the server's retry-after timing. With throttleVision() pacing
// the call STARTS, a 429 is now rare, so 2 retries is a safety margin, not a
// blind hammer. The 15s ceiling bounds the worst case (3 attempts = 45s) with
// ~15s of the route's 60s maxDuration left for candidates + scoring + DB save;
// retries only fire on failure, never serially on the happy path.
const OCR_TIMEOUT_MS = 15_000;
const OCR_MAX_RETRIES = 2;

// Image-detail for the strip-read (Phase M3-B). The pass now sends a tight
// bottom-band crop, not the whole card. Measured against M3-A's 29-card ground
// truth (docs/scanner-v2/m3-harness): crop + "high" LIFTS collector-number
// accuracy 62%→79% (it stops the model bailing to empty on full-art secret
// rares) AND cuts prompt tokens ~23% (16.5k→12.7k) and latency (1688→1315ms).
// "auto" on the already-small crop collapses accuracy to 24% (the model
// down-samples the strip away), so "high" stays. See docs/scanner-v2/M3-B-report.md.
const STRIP_DETAIL = "high" as const;

/** The fields OCR reads off a card, trimmed and normalized to strings. */
export interface OcrFields {
  /** Raw parsed OCR object, passed through to the client as ocrData. */
  identifiedCard: any;
  cardName: string;
  aiGame: string;
  setCode: string;
  collectorNumber: string;
  manaCost: string;
  typeLine: string;
  powerToughness: string;
}

export type ExtractResult =
  | { ok: true; fields: OcrFields }
  | { ok: false; status: number; message: string };

// ─── Step 1: OCR — Extract card name and game from image ────────────────────
export async function extractCardFields(imageUrl: string): Promise<ExtractResult> {
  let identifiedCard: any;
  try {
    console.log("[Scanner] Step 1: OCR — identifying card name...");
    const aiResponse = await throttleVision(() => openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are an expert trading card identifier for Pokemon, Magic: The Gathering (MTG), and Yu-Gi-Oh! cards. Look at the image and identify the card. If there is no trading card visible, respond with: {"name":"","game":"","setCode":"","collectorNumber":"","manaCost":"","typeLine":"","powerToughness":""}. Otherwise return ONLY a valid JSON object with these keys:
- "name": The EXACT official English main name of the card as printed. Do NOT include subtitles or flavor text that aren't part of the official name.
- "game": One of "Pokemon", "MTG", or "Yugioh".
- "setCode": The 3-4 letter set code (for MTG/Pokemon) if visible (e.g., "MH2", "BS", "SV3"), otherwise "".
- "collectorNumber": The collector number (for MTG/Pokemon) if visible (e.g., "267", "001/165"), otherwise "".
- "manaCost": The mana cost or energy cost if visible (e.g., "{3}", "{1}{U}", "3"), otherwise "".
- "typeLine": The type line if visible (e.g., "Artifact", "Creature - Goblin", "Trainer"), otherwise "".
- "powerToughness": The power and toughness if visible (e.g., "2/2", "4/5"), otherwise "".
Return ONLY raw JSON. No markdown. No explanation.`
        },
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: imageUrl, detail: "auto" } }]
        }
      ],
      // 160, not 80 (Phase 5.18A): the model pretty-prints the JSON despite the
      // prompt, and a long name + long type line ("Taskmaster, Mercenary Mimic"
      // + "Legendary Creature — Human Mercenary Villain") measured EXACTLY 80
      // completion tokens — truncated mid-object, a repeatable extraction
      // failure. 160 doubles the observed worst case; output is still bounded
      // by the fixed JSON shape, so this adds headroom, not rambling room.
      max_tokens: 160,
      temperature: 0.1,
    }, { timeout: OCR_TIMEOUT_MS, maxRetries: OCR_MAX_RETRIES }));

    logOcrCost("full", imageUrl, "auto", aiResponse.usage);
    const aiMessage = aiResponse.choices[0]?.message?.content || "{}";
    console.log("[Scanner] OCR response:", aiMessage);

    let cleanMessage = aiMessage.trim();
    if (cleanMessage.startsWith("```")) {
      cleanMessage = cleanMessage.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }
    identifiedCard = JSON.parse(cleanMessage);
  } catch (aiError: any) {
    console.error("[Scanner] OCR Error:", aiError?.message || aiError);
    if (aiError?.status === 429 || aiError?.code === "rate_limit_exceeded") {
      // The throttle already waited out several refills and the bucket is
      // still empty — tell the collector to pause, not paste the raw quota
      // dump in their viewfinder. In bulk this lands in the skip chip and the
      // loop simply tries again on the next tick.
      return { ok: false, status: 429, message: "Scanning very fast — pausing a moment to catch up. Hold steady." };
    }
    const userMessage = aiError?.code === "invalid_image_format"
      ? "Camera frame was invalid. Please ensure your camera is working and try again."
      : `AI vision error: ${aiError?.message || "Unknown error"}`;
    return { ok: false, status: 400, message: userMessage };
  }

  if (!identifiedCard.name || identifiedCard.name.trim() === "") {
    return { ok: false, status: 404, message: "No trading card detected in the image. Try holding the card closer." };
  }

  return {
    ok: true,
    fields: {
      identifiedCard,
      cardName: identifiedCard.name.trim(),
      aiGame: identifiedCard.game || "",
      setCode: identifiedCard.setCode?.trim() || "",
      collectorNumber: identifiedCard.collectorNumber?.trim() || "",
      manaCost: identifiedCard.manaCost?.trim() || "",
      typeLine: identifiedCard.typeLine?.trim() || "",
      powerToughness: identifiedCard.powerToughness?.trim() || "",
    },
  };
}

// ─── Step 1c: Dedicated bottom-strip OCR pass (Phase 3) ─────────────────────
// A SECOND, targeted read of only the set-code / collector-number strip along
// the card's bottom edge. The full-card pass above treats that strip as
// incidental and often misreads the tiny text; here it is the whole subject,
// read at detail:"high" so the model receives full-resolution tiles of it. The
// pass is a noisy sensor like any other — it only emits "ocr-strip" readings;
// reconcileSetCn() in evidence.ts weighs them against the full-pass reading.

/** Set/CN (plus corroborating rarity/artist) read from the bottom strip. */
export interface StripReadings {
  setCode?: FieldReading;
  collectorNumber?: FieldReading;
  rarity?: FieldReading;
  artist?: FieldReading;
}

export async function extractBottomStrip(imageUrl: string): Promise<StripReadings> {
  try {
    console.log("[Scanner] Step 1c: Strip OCR — reading the set/collector strip...");
    // M3-B: crop to the bottom set/CN band before the read. cropBottomStrip is
    // best-effort — on any failure it returns the original image unchanged, so
    // this line can only ever shrink the payload, never break the call.
    const stripImage = await cropBottomStrip(imageUrl);
    const cropped = stripImage !== imageUrl;
    const aiResponse = await throttleVision(() => openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are reading ONLY the small printed information strip along the BOTTOM EDGE of a trading card (Magic: The Gathering or Pokemon). Ignore the artwork, the title, and the rules text. Focus on the bottom border line, which typically shows the set/expansion code, the collector number, the rarity, and the illustrator. Return ONLY a valid JSON object with these keys:
- "setCode": The set / expansion code exactly as printed (e.g., "MH2", "SV3", "WOT"). Pokemon often prints only a set symbol; if just a number "x/y" is visible with no letters, return "".
- "collectorNumber": The collector number exactly as printed, keeping any "/" total (e.g., "267", "267/303", "021/198"), otherwise "".
- "rarity": The rarity letter or word if printed (e.g., "R", "M", "C", "Rare"), otherwise "".
- "artist": The illustrator name after "Illus." or an artist credit if legible, otherwise "".
If the bottom strip is not legible, return every value as "". Return ONLY raw JSON. No markdown. No explanation.`
        },
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: stripImage, detail: STRIP_DETAIL } }]
        }
      ],
      max_tokens: 80,
      temperature: 0.0,
    }, { timeout: OCR_TIMEOUT_MS, maxRetries: OCR_MAX_RETRIES }));

    logOcrCost(cropped ? "strip-crop" : "strip-full", stripImage, STRIP_DETAIL, aiResponse.usage);
    const raw = aiResponse.choices[0]?.message?.content || "{}";
    console.log("[Scanner] Strip OCR response:", raw);

    let clean = raw.trim();
    if (clean.startsWith("```")) {
      clean = clean.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }
    const parsed = JSON.parse(clean);

    const readings: StripReadings = {};
    const setCode = (parsed.setCode ?? "").toString().trim();
    const collectorNumber = (parsed.collectorNumber ?? "").toString().trim();
    const rarity = (parsed.rarity ?? "").toString().trim();
    const artist = (parsed.artist ?? "").toString().trim();
    if (setCode) readings.setCode = reading(setCode, SET_CN_CONFIDENCE.strip, "ocr-strip");
    if (collectorNumber) readings.collectorNumber = reading(collectorNumber, SET_CN_CONFIDENCE.strip, "ocr-strip");
    if (rarity) readings.rarity = reading(rarity, SET_CN_CONFIDENCE.strip, "ocr-strip");
    if (artist) readings.artist = reading(artist, SET_CN_CONFIDENCE.strip, "ocr-strip");
    return readings;
  } catch (err: any) {
    // A failed strip pass is non-fatal: the pipeline continues on the full-pass
    // set/CN. It must never take the whole scan down.
    console.warn("[Scanner] Strip OCR failed; continuing with full-pass set/CN:", err?.message || err);
    return {};
  }
}
