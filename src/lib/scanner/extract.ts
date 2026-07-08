// ─── OCR Extraction ─────────────────────────────────────────────────────────
// Step 1 of the scan pipeline: read the card's printed fields off the image.
// The OCR model is a noisy SENSOR — it only produces readings here; the
// decision layer downstream owns the identification verdict.

import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "dummy_build_key",
});

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
    });

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
