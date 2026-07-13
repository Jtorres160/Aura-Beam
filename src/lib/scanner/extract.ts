// ─── OCR Extraction ─────────────────────────────────────────────────────────
// Step 1 of the scan pipeline: read the card's printed fields off the image.
// The OCR model is a noisy SENSOR — it only produces readings here; the
// decision layer downstream owns the identification verdict.

import OpenAI from "openai";
import { reading, SET_CN_CONFIDENCE, type FieldReading } from "@/lib/scanner/evidence";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "dummy_build_key",
});

// Per-call ceilings (Phase 5.2.5): a hung vision call must fail fast into a
// classified error, not spin until the platform kills the whole function.
// One SDK-level retry keeps transient blips invisible; 20s × 2 attempts stays
// well inside the route's 60s maxDuration.
const OCR_TIMEOUT_MS = 20_000;
const OCR_MAX_RETRIES = 1;

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
    const aiResponse = await openai.chat.completions.create({
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
      max_tokens: 80,
      temperature: 0.1,
    }, { timeout: OCR_TIMEOUT_MS, maxRetries: OCR_MAX_RETRIES });

    const aiMessage = aiResponse.choices[0]?.message?.content || "{}";
    console.log("[Scanner] OCR response:", aiMessage);

    let cleanMessage = aiMessage.trim();
    if (cleanMessage.startsWith("```")) {
      cleanMessage = cleanMessage.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }
    identifiedCard = JSON.parse(cleanMessage);
  } catch (aiError: any) {
    console.error("[Scanner] OCR Error:", aiError?.message || aiError);
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
    const aiResponse = await openai.chat.completions.create({
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
          content: [{ type: "image_url", image_url: { url: imageUrl, detail: "high" } }]
        }
      ],
      max_tokens: 80,
      temperature: 0.0,
    }, { timeout: OCR_TIMEOUT_MS, maxRetries: OCR_MAX_RETRIES });

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
