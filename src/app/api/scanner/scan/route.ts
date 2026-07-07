import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { searchPokemonCards, formatPokemonCard } from "@/lib/services/pokemon";
import { searchScryfallCardByName, searchScryfallCards, formatScryfallCard } from "@/lib/services/scryfall";
import { searchYugiohCards, formatYugiohCard } from "@/lib/services/yugioh";
import { auth } from "@/auth";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "dummy_build_key",
});

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

    // ─── Step 1: Send image to OpenAI Vision ────────────────────────────
    let identifiedCard;
    try {
      console.log("[Scanner] Sending image to OpenAI gpt-4o-mini...");
      const aiResponse = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You are an expert trading card identifier for Pokemon, Magic: The Gathering (MTG), and Yu-Gi-Oh! cards. Look at the image and identify the card. If there is no trading card visible, respond with: {"name":"","game":"","set":""}. Otherwise return ONLY a valid JSON object with these keys:
- "name": The EXACT official English main name of the card as printed. CRITICAL: DO NOT include subtitles, epithets, or flavor names (e.g. if a card says "Captain America" and below it says "First Avenger", output "Captain America, First Avenger" only if it's the official name, but otherwise stick to the primary name without subtitles). Do NOT hallucinate words not printed.
- "game": One of "Pokemon", "MTG", or "Yugioh".
- "set": The set or expansion name if visible, otherwise your best guess.
- "set_code": The 3-4 letter official set code (e.g., LOB, THB, CRZ) if visible or known.
- "collector_number": The collector number (e.g., 124/165, EN001) if visible.
Return ONLY raw JSON. No markdown. No explanation. No extra text.`
          },
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: {
                  url: imageUrl,
                  detail: "high"
                }
              }
            ]
          }
        ],
        max_tokens: 80,
        temperature: 0.1,
      });

      const aiMessage = aiResponse.choices[0]?.message?.content || "{}";
      console.log("[Scanner] OpenAI response:", aiMessage);

      // Clean the response — sometimes the model wraps in ```json blocks
      let cleanMessage = aiMessage.trim();
      if (cleanMessage.startsWith("```")) {
        cleanMessage = cleanMessage.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
      }

      identifiedCard = JSON.parse(cleanMessage);
    } catch (aiError: any) {
      console.error("[Scanner] OpenAI API Error:", aiError?.message || aiError);
      const userMessage = aiError?.code === "invalid_image_format"
        ? "Camera frame was invalid. Please ensure your camera is working and try again."
        : `AI vision error: ${aiError?.message || "Unknown error"}`;
      return NextResponse.json({ success: false, message: userMessage }, { status: 400 });
    }

    if (!identifiedCard.name || identifiedCard.name.trim() === "") {
      return NextResponse.json({ success: false, message: "No trading card detected in the image. Try holding the card closer." }, { status: 404 });
    }

    const cardName = identifiedCard.name.trim();
    // Use the AI's game detection, but allow user's explicit filter to override
    const aiGame = identifiedCard.game || "";
    const effectiveGame = game || aiGame;
    const setCode = identifiedCard.set_code || "";
    const collectorNumber = identifiedCard.collector_number || "";
    console.log(`[Scanner] AI identified: "${cardName}" (${effectiveGame || "unknown game"}) from set "${identifiedCard.set || "unknown"}" (Code: ${setCode}, Num: ${collectorNumber})`);

    // ─── Step 2: Search TCG databases — prioritize by game ──────────────
    let matchedCard = await searchByGame(cardName, effectiveGame, setCode, collectorNumber);

    // If prioritized search failed, try ALL databases as fallback
    if (!matchedCard && effectiveGame) {
      console.log(`[Scanner] Primary search for "${cardName}" in ${effectiveGame} failed. Trying all databases...`);
      matchedCard = await searchAllDatabases(cardName, effectiveGame, setCode, collectorNumber);
    }

    // If still nothing, try with cleaned-up name (remove common AI mistakes) and ignore exact set details
    if (!matchedCard) {
      const cleanedName = cleanCardName(cardName);
      if (cleanedName !== cardName) {
        console.log(`[Scanner] Retrying with cleaned name: "${cleanedName}"`);
        matchedCard = await searchAllDatabases(cleanedName, "", setCode, collectorNumber);
      }
      
      // Fallback: If the name contains a comma (likely a subtitle), try searching just the primary name before the comma
      if (!matchedCard && cardName.includes(',')) {
        const splitName = cardName.split(',')[0].trim();
        console.log(`[Scanner] Retrying with split name (no subtitle): "${splitName}"`);
        matchedCard = await searchAllDatabases(splitName, "", setCode, collectorNumber);
      }

      // Final fallback: Strip set data, maybe the AI hallucinated the set or read it wrong
      if (!matchedCard && (setCode || collectorNumber)) {
        console.log(`[Scanner] Retrying generic name match without set details...`);
        matchedCard = await searchByGame(cardName, effectiveGame, "", "");
      }
    }

    if (!matchedCard) {
      console.error(`[Scanner] FAILED: No match found in any database for "${cardName}"`);
      return NextResponse.json({ 
        success: false, 
        message: `AI identified "${cardName}" but no match was found in any card database. This may be a misread — try scanning again with better lighting.` 
      }, { status: 404 });
    }

    console.log(`[Scanner] ✅ Matched to database card: "${matchedCard.name}" (${matchedCard.game})`);

    // ─── Step 3: Upsert card into local DB ──────────────────────────────
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
          marketPrice: (matchedCard.price as any)?.marketPrice || 0,
          lowPrice: (matchedCard.price as any)?.lowPrice || null,
          midPrice: (matchedCard.price as any)?.midPrice || null,
          highPrice: (matchedCard.price as any)?.highPrice || null,
        },
      });
    }

    // ─── Step 4: Save to ScanHistory ────────────────────────────────────
    const history = await prisma.scanHistory.create({
      data: {
        userId: session.user.id,
        cardId: localCard.id,
        confidence: 95,
        imageUrl: localCard.imageUrl,
      },
    });

    console.log(`[Scanner] Success! Card "${localCard.name}" saved.`);

    return NextResponse.json({
      success: true,
      data: {
        id: localCard.id,
        name: localCard.name,
        set: localCard.setName,
        game: localCard.game,
        prices: {
          marketPrice: (matchedCard.price as any)?.marketPrice || 0,
          lowPrice: (matchedCard.price as any)?.lowPrice || 0,
          midPrice: (matchedCard.price as any)?.midPrice || 0,
          highPrice: (matchedCard.price as any)?.highPrice || 0,
        },
        rarity: localCard.rarity,
        confidence: 95,
        imageUrl: localCard.imageUrl,
        thumbnailUrl: localCard.thumbnailUrl,
        historyId: history.id,
      },
    });
  } catch (error: any) {
    console.error("[Scanner] Pipeline Error:", error?.message || error);
    return NextResponse.json({ success: false, message: "Failed to process card image." }, { status: 500 });
  }
}

// ─── Helper: Search by the AI-detected game first ─────────────────────────
async function searchByGame(cardName: string, game: string, setCode?: string, collectorNumber?: string): Promise<any | null> {
  const normalizedGame = game?.toUpperCase?.() || "";
  
  if (normalizedGame.includes("MTG") || normalizedGame.includes("MAGIC")) {
    return await searchMTG(cardName, setCode, collectorNumber);
  }
  if (normalizedGame.includes("POKEMON") || normalizedGame.includes("POKÉMON")) {
    return await searchPokemon(cardName, setCode, collectorNumber);
  }
  if (normalizedGame.includes("YUGIOH") || normalizedGame.includes("YU-GI-OH")) {
    return await searchYugioh(cardName, setCode);
  }
  
  // Game not specified — search all
  return await searchAllDatabases(cardName, "", setCode, collectorNumber);
}

// ─── Helper: Search all databases with smart ordering ─────────────────────
async function searchAllDatabases(cardName: string, skipGame: string, setCode?: string, collectorNumber?: string): Promise<any | null> {
  const normalizedSkip = skipGame?.toUpperCase?.() || "";
  
  // Try each database that we haven't already tried
  if (!normalizedSkip.includes("MTG") && !normalizedSkip.includes("MAGIC")) {
    const mtgResult = await searchMTG(cardName, setCode, collectorNumber);
    if (mtgResult) return mtgResult;
  }
  
  if (!normalizedSkip.includes("POKEMON")) {
    const pokemonResult = await searchPokemon(cardName, setCode, collectorNumber);
    if (pokemonResult) return pokemonResult;
  }
  
  if (!normalizedSkip.includes("YUGIOH")) {
    const yugiohResult = await searchYugioh(cardName, setCode);
    if (yugiohResult) return yugiohResult;
  }
  
  return null;
}

// ─── Individual game search functions ─────────────────────────────────────

async function searchMTG(cardName: string, setCode?: string, collectorNumber?: string): Promise<any | null> {
  try {
    // Strategy 1: Exact/fuzzy named lookup (most reliable for single cards if set is known)
    // If we have a collector number, we can't use the named endpoint (it only accepts set code).
    // So we skip to strategy 2 if collector number is present.
    if (!collectorNumber) {
      const namedResult = await searchScryfallCardByName(cardName, setCode);
      if (namedResult) {
        return formatScryfallCard(namedResult);
      }
    }
    
    // Strategy 2: Full search endpoint
    const searchResults = await searchScryfallCards(cardName, setCode, collectorNumber);
    if (searchResults && searchResults.length > 0) {
      // Find the best match by exact name comparison
      const exactMatch = searchResults.find(
        (c: any) => c.name.toLowerCase() === cardName.toLowerCase()
      );
      return formatScryfallCard(exactMatch || searchResults[0]);
    }
    
    console.log(`[Scanner] MTG: No results for "${cardName}"`);
    return null;
  } catch (err) {
    console.error(`[Scanner] MTG search error for "${cardName}":`, err);
    return null;
  }
}

async function searchPokemon(cardName: string, setCode?: string, collectorNumber?: string): Promise<any | null> {
  try {
    const results = await searchPokemonCards(cardName, setCode, collectorNumber);
    if (results && results.length > 0) {
      // Find exact name match first
      const exactMatch = results.find(
        (c: any) => c.name.toLowerCase() === cardName.toLowerCase()
      );
      console.log(`[Scanner] Pokemon: Found ${results.length} results for "${cardName}"`);
      return formatPokemonCard(exactMatch || results[0]);
    }
    console.log(`[Scanner] Pokemon: No results for "${cardName}"`);
    return null;
  } catch (err) {
    console.error(`[Scanner] Pokemon search error for "${cardName}":`, err);
    return null;
  }
}

async function searchYugioh(cardName: string, setCode?: string): Promise<any | null> {
  try {
    const results = await searchYugiohCards(cardName, setCode);
    if (results && results.length > 0) {
      // Find exact name match first
      const exactMatch = results.find(
        (c: any) => c.name.toLowerCase() === cardName.toLowerCase()
      );
      console.log(`[Scanner] Yugioh: Found ${results.length} results for "${cardName}"`);
      return formatYugiohCard(exactMatch || results[0], setCode);
    }
    console.log(`[Scanner] Yugioh: No results for "${cardName}"`);
    return null;
  } catch (err) {
    console.error(`[Scanner] Yugioh search error for "${cardName}":`, err);
    return null;
  }
}

// ─── Helper: Clean common AI misreads from card names ─────────────────────
function cleanCardName(name: string): string {
  let cleaned = name;
  // Remove trailing punctuation the AI might add
  cleaned = cleaned.replace(/[.,;:!?'"]+$/, "").trim();
  // Remove leading/trailing quotes
  cleaned = cleaned.replace(/^["']|["']$/g, "").trim();
  // Remove any "(set name)" suffixes the AI might append
  cleaned = cleaned.replace(/\s*\([^)]*\)\s*$/, "").trim();
  return cleaned;
}
