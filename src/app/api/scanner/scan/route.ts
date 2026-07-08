import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { searchPokemonCards, fetchAllPokemonPrintings, formatPokemonCard } from "@/lib/services/pokemon";
import { searchScryfallCardByName, searchScryfallCards, fetchAllMTGPrintings, formatScryfallCard } from "@/lib/services/scryfall";
import { searchYugiohCards, getYugiohPrintings, formatYugiohCard } from "@/lib/services/yugioh";
import { auth } from "@/auth";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "dummy_build_key",
});

// ─── Max candidate images sent to AI for visual comparison ────────────────
// Keep low to minimize token cost. Thumbnails are ~1-2KB each vs 20KB+ for large images.
const MAX_VISUAL_CANDIDATES = 8;

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { image, game } = body;

    if (!image) {
      return NextResponse.json({ success: false, message: "No image provided from scanner" }, { status: 400 });
    }

    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json({ success: false, message: "OpenAI API key is missing. Please add it to your .env file." }, { status: 500 });
    }

    // Validate image format — must be a proper data URI
    let imageUrl = image;
    if (!imageUrl.startsWith("data:image/")) {
      imageUrl = `data:image/jpeg;base64,${imageUrl}`;
    }

    // ─── Step 1: OCR — Extract card name and game from image ────────────
    let identifiedCard: any;
    try {
      console.log("[Scanner] Step 1: OCR — identifying card name...");
      const aiResponse = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You are an expert trading card identifier for Pokemon, Magic: The Gathering (MTG), and Yu-Gi-Oh! cards. Look at the image and identify the card. If there is no trading card visible, respond with: {"name":"","game":"","set":""}. Otherwise return ONLY a valid JSON object with these keys:
- "name": The EXACT official English main name of the card as printed. Do NOT include subtitles or flavor text that aren't part of the official name.
- "game": One of "Pokemon", "MTG", or "Yugioh".
- "set": The set or expansion name if visible, otherwise an empty string.
Return ONLY raw JSON. No markdown. No explanation.`
          },
          {
            role: "user",
            content: [{ type: "image_url", image_url: { url: imageUrl, detail: "low" } }]
          }
        ],
        max_tokens: 60,
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
      return NextResponse.json({ success: false, message: userMessage }, { status: 400 });
    }

    if (!identifiedCard.name || identifiedCard.name.trim() === "") {
      return NextResponse.json({ success: false, message: "No trading card detected in the image. Try holding the card closer." }, { status: 404 });
    }

    const cardName = identifiedCard.name.trim();
    const aiGame = identifiedCard.game || "";
    const effectiveGame = game || aiGame;
    console.log(`[Scanner] Identified: "${cardName}" (${effectiveGame || "unknown game"})`);

    // ─── Step 2: Fetch all printings of this card ─────────────────────
    console.log(`[Scanner] Step 2: Fetching all printings for "${cardName}"...`);
    const { printings, fallbackCard } = await fetchAllPrintings(cardName, effectiveGame);

    // If only 1 printing exists (or database found nothing), skip visual comparison
    if (!printings || printings.length <= 1) {
      console.log(`[Scanner] Only ${printings?.length || 0} printing(s) found — skipping visual comparison.`);
      const matched = printings?.[0] || fallbackCard;
      if (!matched) {
        return NextResponse.json({
          success: false,
          message: `AI identified "${cardName}" but no match was found in any card database. Try scanning again with better lighting.`
        }, { status: 404 });
      }
      return await saveAndRespond(matched, session.user.id);
    }

    // ─── Step 3: Visual artwork comparison — pick the exact printing ──
    console.log(`[Scanner] Step 3: Visual comparison across ${printings.length} printings...`);

    // Cap candidates & use SMALL thumbnails to minimize token cost
    const candidates = printings.slice(0, MAX_VISUAL_CANDIDATES);
    const validCandidates = candidates.filter((p: any) => p.thumbnailUrl);

    if (validCandidates.length === 0) {
      // No images available — fall back to first result
      return await saveAndRespond(candidates[0], session.user.id);
    }

    let bestMatchIndex: number = 0;
    let isUncertain = false;

    try {
      const candidateImages = validCandidates.map((p: any) => ({
        type: "image_url" as const,
        image_url: { url: p.thumbnailUrl, detail: "low" as const }
      }));

      const visualResponse = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You are an expert trading card artwork identifier. The user has scanned a physical card (first image). You are given ${validCandidates.length} candidate card images (images 2 through ${validCandidates.length + 1}). Compare the artwork, border style, foil pattern, and card layout of the scanned card against each candidate. Respond with ONLY a single integer:
- The 0-based index of the candidate that CLEARLY matches the scanned card.
- Return -1 if you are not confident or if multiple candidates look similar.`
          },
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: imageUrl, detail: "low" } },
              ...candidateImages
            ]
          }
        ],
        max_tokens: 5,
        temperature: 0.0,
      });

      const raw = (visualResponse.choices[0]?.message?.content || "-1").trim();
      const parsed = parseInt(raw, 10);
      if (parsed === -1) {
        isUncertain = true;
        console.log(`[Scanner] AI is uncertain — requesting user disambiguation.`);
      } else if (!isNaN(parsed) && parsed >= 0 && parsed < validCandidates.length) {
        bestMatchIndex = parsed;
        console.log(`[Scanner] Visual match selected index: ${bestMatchIndex} (${validCandidates[bestMatchIndex]?.setName})`);
      } else {
        isUncertain = true;
      }
    } catch (visualErr: any) {
      console.warn("[Scanner] Visual comparison failed, falling back to disambiguation:", visualErr?.message);
      isUncertain = true;
    }

    // ─── Step 4: If AI is uncertain, return candidates for user to pick ──
    if (isUncertain) {
      const disambigCandidates = validCandidates.map((c: any) => ({
        externalId: c.externalId,
        name: c.name,
        game: c.game,
        setName: c.setName,
        setCode: c.setCode || null,
        collectorNumber: c.collectorNumber || null,
        rarity: c.rarity,
        imageUrl: c.imageUrl,
        thumbnailUrl: c.thumbnailUrl,
        price: c.price,
      }));

      return NextResponse.json({
        success: true,
        requiresDisambiguation: true,
        cardName: cardName,
        candidates: disambigCandidates,
      });
    }

    const matchedCard = validCandidates[bestMatchIndex] || candidates[0];
    return await saveAndRespond(matchedCard, session.user.id);

  } catch (error: any) {
    console.error("[Scanner] Pipeline Error:", error?.message || error);
    return NextResponse.json({ success: false, message: "Failed to process card image." }, { status: 500 });
  }
}

// ─── Fetch all printings for visual comparison ─────────────────────────────
async function fetchAllPrintings(cardName: string, game: string): Promise<{ printings: any[], fallbackCard: any | null }> {
  const normalizedGame = game?.toUpperCase?.() || "";

  if (normalizedGame.includes("MTG") || normalizedGame.includes("MAGIC")) {
    return await fetchMTGPrintings(cardName);
  }
  if (normalizedGame.includes("POKEMON") || normalizedGame.includes("POKÉMON")) {
    return await fetchPokemonPrintings(cardName);
  }
  if (normalizedGame.includes("YUGIOH") || normalizedGame.includes("YU-GI-OH")) {
    return await fetchYugiohPrintings(cardName);
  }

  // Unknown game — try all, return first hit
  const mtg = await fetchMTGPrintings(cardName);
  if (mtg.printings.length > 0 || mtg.fallbackCard) return mtg;

  const pkmn = await fetchPokemonPrintings(cardName);
  if (pkmn.printings.length > 0 || pkmn.fallbackCard) return pkmn;

  return await fetchYugiohPrintings(cardName);
}

async function fetchMTGPrintings(cardName: string) {
  try {
    // Get all unique printings
    const allPrintings = await fetchAllMTGPrintings(cardName);
    const printings = allPrintings.map(formatScryfallCard);

    if (printings.length > 0) {
      console.log(`[Scanner] MTG: fetched ${printings.length} printings for "${cardName}"`);
      return { printings, fallbackCard: null };
    }

    // Fallback: single card lookup
    const namedResult = await searchScryfallCardByName(cardName);
    if (namedResult) return { printings: [], fallbackCard: formatScryfallCard(namedResult) };

    return { printings: [], fallbackCard: null };
  } catch {
    return { printings: [], fallbackCard: null };
  }
}

async function fetchPokemonPrintings(cardName: string) {
  try {
    const allPrintings = await fetchAllPokemonPrintings(cardName);
    const printings = allPrintings.map(formatPokemonCard);

    if (printings.length > 0) {
      console.log(`[Scanner] Pokemon: fetched ${printings.length} printings for "${cardName}"`);
      return { printings, fallbackCard: null };
    }

    // Fallback: fuzzy name search
    const results = await searchPokemonCards(cardName);
    const exactMatch = results.find((c: any) => c.name.toLowerCase() === cardName.toLowerCase());
    const card = exactMatch || results[0];
    if (card) return { printings: [], fallbackCard: formatPokemonCard(card) };

    return { printings: [], fallbackCard: null };
  } catch {
    return { printings: [], fallbackCard: null };
  }
}

async function fetchYugiohPrintings(cardName: string) {
  try {
    const results = await searchYugiohCards(cardName);
    const exactMatch = results.find((c: any) => c.name.toLowerCase() === cardName.toLowerCase()) || results[0];

    if (!exactMatch) return { printings: [], fallbackCard: null };

    // Yugioh packs alternate arts into card_images[] — treat each as a separate "printing"
    const imagePrintings = getYugiohPrintings(exactMatch).map((p: any) => ({
      externalId: exactMatch.id.toString(),
      name: exactMatch.name,
      game: "YUGIOH",
      setName: p.setName,
      setCode: p.setCode,
      rarity: p.rarity,
      imageUrl: p.imageUrl,
      thumbnailUrl: p.thumbnailUrl,
      price: { marketPrice: p.price },
    }));

    if (imagePrintings.length > 0) {
      console.log(`[Scanner] Yugioh: fetched ${imagePrintings.length} art variants for "${cardName}"`);
      return { printings: imagePrintings, fallbackCard: null };
    }

    return { printings: [], fallbackCard: formatYugiohCard(exactMatch) };
  } catch {
    return { printings: [], fallbackCard: null };
  }
}

// ─── Save to DB and return response ───────────────────────────────────────
async function saveAndRespond(matchedCard: any, userId: string) {
  // Upsert card into local DB
  let localCard = await prisma.card.findFirst({
    where: { externalId: matchedCard.externalId }
  });

  if (!localCard) {
    localCard = await prisma.card.create({
      data: {
        externalId: matchedCard.externalId,
        name: matchedCard.name,
        game: matchedCard.game,
        setName: matchedCard.setName,
        setCode: matchedCard.setCode || null,
        collectorNumber: matchedCard.collectorNumber || null,
        rarity: matchedCard.rarity,
        imageUrl: matchedCard.imageUrl,
        thumbnailUrl: matchedCard.thumbnailUrl,
      }
    });
    await prisma.cardPrice.create({
      data: {
        cardId: localCard.id,
        marketPrice: matchedCard.price?.marketPrice || 0,
        lowPrice: matchedCard.price?.lowPrice || null,
        midPrice: matchedCard.price?.midPrice || null,
        highPrice: matchedCard.price?.highPrice || null,
      },
    });
  }

  const history = await prisma.scanHistory.create({
    data: {
      userId,
      cardId: localCard.id,
      confidence: 95,
      imageUrl: localCard.imageUrl,
    },
  });

  console.log(`[Scanner] ✅ Saved: "${localCard.name}" from "${localCard.setName}"`);

  return NextResponse.json({
    success: true,
    data: {
      id: localCard.id,
      name: localCard.name,
      set: localCard.setName,
      game: localCard.game,
      prices: {
        marketPrice: matchedCard.price?.marketPrice || 0,
        lowPrice: matchedCard.price?.lowPrice || 0,
        midPrice: matchedCard.price?.midPrice || 0,
        highPrice: matchedCard.price?.highPrice || 0,
      },
      rarity: localCard.rarity,
      confidence: 95,
      imageUrl: localCard.imageUrl,
      thumbnailUrl: localCard.thumbnailUrl,
      historyId: history.id,
    },
  });
}

// ─── Helper: Clean common AI misreads from card names ─────────────────────
function cleanCardName(name: string): string {
  let cleaned = name;
  cleaned = cleaned.replace(/[.,;:!?'"]+$/, "").trim();
  cleaned = cleaned.replace(/^["']|["']$/g, "").trim();
  cleaned = cleaned.replace(/\s*\([^)]*\)\s*$/, "").trim();
  return cleaned;
}
