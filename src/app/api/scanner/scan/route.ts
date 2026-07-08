import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { searchPokemonCards, fetchAllPokemonPrintings, formatPokemonCard } from "@/lib/services/pokemon";
import { searchScryfallCardByName, fetchAllMTGPrintings, formatScryfallCard, searchScryfallBySetAndCollector, searchScryfallDeepFallback } from "@/lib/services/scryfall";
import { searchYugiohCards, getYugiohPrintings, formatYugiohCard } from "@/lib/services/yugioh";
import { auth } from "@/auth";
import OpenAI from "openai";
import type { CandidatePrinting } from "@/lib/scanner/evidence";
import {
  type Decision,
  type MatchMethod,
  acceptDecision,
  disambiguateDecision,
  notFoundDecision,
  gateDecision,
  groupByIllustration,
  nameMatchesOcr,
} from "@/lib/scanner/decision";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "dummy_build_key",
});

// ─── Max candidate images sent to AI for visual comparison ────────────────
// Max images to send to the vision model (detail: low = 85 tokens each, 150 = ~12,750 tokens, $0.0019)
const MAX_VISUAL_CANDIDATES = 150;

/** The slice of an AiLearningRule the pipeline consumes. */
interface LearningRuleInfo {
  ruleType: string;
  content: string;
}

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { image, game, isAutoScan } = body;

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
      return NextResponse.json({ success: false, message: userMessage }, { status: 400 });
    }

    if (!identifiedCard.name || identifiedCard.name.trim() === "") {
      return NextResponse.json({ success: false, message: "No trading card detected in the image. Try holding the card closer." }, { status: 404 });
    }

    const cardName = identifiedCard.name.trim();
    const aiGame = identifiedCard.game || "";
    const setCode = identifiedCard.setCode?.trim() || "";
    const collectorNumber = identifiedCard.collectorNumber?.trim() || "";
    const manaCost = identifiedCard.manaCost?.trim() || "";
    const typeLine = identifiedCard.typeLine?.trim() || "";
    const powerToughness = identifiedCard.powerToughness?.trim() || "";
    const effectiveGame = game || aiGame;
    console.log(`[Scanner] Identified: "${cardName}" (${effectiveGame || "unknown game"}) [Set: ${setCode}, CN: ${collectorNumber}, Mana: ${manaCost}, Type: ${typeLine}, PT: ${powerToughness}]`);

    // ─── Step 1b: Check AI Learning Rules for this card ───────────────
    const learningRule = await prisma.aiLearningRule.findUnique({
      where: { targetName: cardName },
    });

    if (learningRule) {
      console.log(`[Scanner] 🧠 Found learning rule for "${cardName}": ${learningRule.ruleType}`);
      // Increment timesApplied asynchronously — don't await to avoid slowing the scan
      prisma.aiLearningRule.update({
        where: { id: learningRule.id },
        data: { timesApplied: { increment: 1 } },
      }).catch(() => {});
    }

    // ─── Step 2: Fetch all printings of this card ─────────────────────
    console.log(`[Scanner] Step 2: Fetching all printings for "${cardName}"...`);
    const { printings, fallbackCard, fallbackMethod } = await fetchAllPrintings(cardName, effectiveGame, setCode, collectorNumber, manaCost, typeLine, powerToughness);

    // ─── Step 3: Deterministic decision ───────────────────────────────
    // Models above only produced evidence; the decision layer owns the verdict.
    let decision: Decision;

    if (printings.length === 1) {
      console.log(`[Scanner] Exactly one printing exists — no disambiguation needed.`);
      decision = acceptDecision(printings[0], "single-printing");
    } else if (printings.length === 0) {
      decision = fallbackCard
        ? acceptDecision(fallbackCard, fallbackMethod ?? "fallback-guess")
        : notFoundDecision();
    } else if (learningRule?.ruleType === "FORCE_DISAMBIGUATION") {
      // We KNOW this card is hard — skip AI comparison entirely
      console.log(`[Scanner] 🧠 FORCE_DISAMBIGUATION rule active for "${cardName}" — skipping AI comparison.`);
      decision = disambiguateDecision(printings);
    } else {
      console.log(`[Scanner] Step 3: Deciding among ${printings.length} printings...`);
      decision = await decideAmongPrintings(printings, imageUrl, { setCode, collectorNumber }, learningRule);
    }

    // ─── Step 4: Gate and respond ──────────────────────────────────────
    // Auto-scan saves without a review screen, so it demands more confidence.
    decision = gateDecision(decision, Boolean(isAutoScan));

    if (decision.action === "accept" && decision.printing) {
      return await saveAndRespond(decision.printing, session.user.id, identifiedCard, decision);
    }

    if (decision.action === "disambiguate" && decision.candidates && decision.candidates.length > 0) {
      console.log(`[Scanner] Requesting user disambiguation among ${decision.candidates.length} candidate(s).`);
      return disambiguationResponse(cardName, decision.candidates, identifiedCard);
    }

    return NextResponse.json({
      success: false,
      message: `AI identified "${cardName}" but no match was found in any card database. Try scanning again with better lighting.`
    }, { status: 404 });

  } catch (error: any) {
    console.error("[Scanner] Pipeline Error:", error?.message || error);
    return NextResponse.json({ success: false, message: "Failed to process card image." }, { status: 500 });
  }
}

// ─── Decide among multiple printings ────────────────────────────────────────
// Order matters: deterministic evidence (printed set/CN) beats vision, and
// vision is only consulted where it CAN work — between different illustrations.
async function decideAmongPrintings(
  printings: CandidatePrinting[],
  scannedImageUrl: string,
  ocr: { setCode: string; collectorNumber: string },
  learningRule: LearningRuleInfo | null,
): Promise<Decision> {
  // Evidence narrowing: an OCR'd set code (plus collector number when read)
  // that pins exactly one printing decides without any artwork comparison.
  if (ocr.setCode) {
    const cleanCn = ocr.collectorNumber ? ocr.collectorNumber.split("/")[0].trim().toLowerCase() : "";
    const narrowed = printings.filter((p) => {
      if (!p.setCode || p.setCode.toLowerCase() !== ocr.setCode.toLowerCase()) return false;
      if (cleanCn) return (p.collectorNumber || "").toLowerCase() === cleanCn;
      return true;
    });
    if (narrowed.length === 1) {
      console.log(`[Scanner] OCR set/CN evidence narrowed to one printing: ${narrowed[0].setName}`);
      return acceptDecision(narrowed[0], "single-art-group");
    }
  }

  // Illustration guard: if every candidate shares one illustration, vision
  // would be a coin flip — go straight to the user.
  const groups = Array.from(groupByIllustration(printings).values());
  if (groups.length === 1) {
    console.log(`[Scanner] All ${printings.length} printings share one illustration — vision cannot distinguish them.`);
    return disambiguateDecision(printings);
  }

  // Vision compares ONE representative image per art group, not every printing.
  const comparable = groups
    .map((group) => ({ group, rep: group.find((p) => p.thumbnailUrl) }))
    .filter((entry): entry is { group: CandidatePrinting[]; rep: CandidatePrinting } => Boolean(entry.rep))
    .slice(0, MAX_VISUAL_CANDIDATES);

  if (comparable.length < 2) {
    // Not enough candidate images to compare anything
    return disambiguateDecision(printings);
  }

  console.log(`[Scanner] Visual comparison across ${comparable.length} art groups (${printings.length} printings)...`);
  const pickedIndex = await pickArtGroupByVision(scannedImageUrl, comparable.map((c) => c.rep), learningRule);

  if (pickedIndex === null) {
    console.log(`[Scanner] AI is uncertain — requesting user disambiguation.`);
    return disambiguateDecision(printings);
  }

  const picked = comparable[pickedIndex];
  if (picked.group.length === 1) {
    console.log(`[Scanner] Visual match selected art group -> ${picked.group[0].setName}`);
    return acceptDecision(picked.group[0], "art-group-vision");
  }

  // The matched artwork is shared by several printings (e.g. a set card and
  // its promo). Artwork can go no further — the user picks within the group.
  console.log(`[Scanner] Visual match is an art group of ${picked.group.length} identical-art printings — user must pick.`);
  return disambiguateDecision(picked.group);
}

// ─── Vision: pick the matching art group ───────────────────────────────────
// Returns the index of the matching representative, or null when the model is
// uncertain, answers out of range, or the call fails.
async function pickArtGroupByVision(
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
            { type: "image_url", image_url: { url: scannedImageUrl, detail: "low" } },
            ...candidateImages
          ]
        }
      ],
      max_tokens: 5,
      temperature: 0.0,
    });

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

// ─── Disambiguation response ────────────────────────────────────────────────
function disambiguationResponse(cardName: string, candidates: CandidatePrinting[], ocrData: any) {
  const withImages = candidates.filter((c) => c.thumbnailUrl);
  const list = (withImages.length > 0 ? withImages : candidates).map((c) => ({
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
    cardName,
    candidates: list,
    ocrData,
  });
}

// ─── Fetch all printings for visual comparison ─────────────────────────────
interface PrintingsResult {
  printings: CandidatePrinting[];
  fallbackCard: CandidatePrinting | null;
  /** HOW fallbackCard was found — decides whether it may be auto-saved. */
  fallbackMethod?: MatchMethod;
}

async function fetchAllPrintings(
  cardName: string, game: string, setCode: string, collectorNumber: string,
  manaCost: string, typeLine: string, powerToughness: string
): Promise<PrintingsResult> {
  const normalizedGame = game?.toUpperCase?.() || "";

  if (normalizedGame.includes("MTG") || normalizedGame.includes("MAGIC")) {
    return await fetchMTGPrintings(cardName, setCode, collectorNumber, manaCost, typeLine, powerToughness);
  }
  if (normalizedGame.includes("POKEMON") || normalizedGame.includes("POKÉMON")) {
    return await fetchPokemonPrintings(cardName);
  }
  if (normalizedGame.includes("YUGIOH") || normalizedGame.includes("YU-GI-OH")) {
    return await fetchYugiohPrintings(cardName);
  }

  // Unknown game — try all, return first hit
  const mtg = await fetchMTGPrintings(cardName, setCode, collectorNumber, manaCost, typeLine, powerToughness);
  if (mtg.printings.length > 0 || mtg.fallbackCard) return mtg;

  const pkmn = await fetchPokemonPrintings(cardName);
  if (pkmn.printings.length > 0 || pkmn.fallbackCard) return pkmn;

  return await fetchYugiohPrintings(cardName);
}

async function fetchMTGPrintings(cardName: string, setCode: string, collectorNumber: string, manaCost: string, typeLine: string, powerToughness: string): Promise<PrintingsResult> {
  try {
    // ─── Set+collector lookup — bypasses OCR name hallucinations ────
    // Only trusted ("set-cn-verified") when the card it returns also bears
    // the OCR'd name; otherwise the set/CN may itself be the misread field.
    let directMatch: CandidatePrinting | null = null;
    if (setCode && collectorNumber) {
      // e.g. "MH2", "267" or "267/303" -> use just the prefix
      const cleanCn = collectorNumber.split('/')[0].trim();
      const direct = await searchScryfallBySetAndCollector(setCode, cleanCn);
      if (direct) {
        directMatch = formatScryfallCard(direct);
        if (nameMatchesOcr(cardName, directMatch.name)) {
          console.log(`[Scanner] Set/CN match verified by name: "${directMatch.name}" (${setCode} #${cleanCn})`);
          return { printings: [], fallbackCard: directMatch, fallbackMethod: "set-cn-verified" };
        }
        console.log(`[Scanner] Set/CN lookup returned "${directMatch.name}" but OCR read "${cardName}" — holding it as a weak guess.`);
      }
    }

    // Get all unique printings
    const allPrintings = await fetchAllMTGPrintings(cardName);
    const printings = allPrintings.map(formatScryfallCard);

    if (printings.length > 0) {
      console.log(`[Scanner] MTG: fetched ${printings.length} printings for "${cardName}"`);
      return { printings, fallbackCard: null };
    }

    // Name search failed, so the name was probably the hallucinated field
    // after all — an unverified set/CN hit is the best remaining guess.
    if (directMatch) {
      return { printings: [], fallbackCard: directMatch, fallbackMethod: "fallback-guess" };
    }

    // ─── Fallback 2: Deep Semantic Search based on physical attributes ──
    const deepMatch = await searchScryfallDeepFallback(cardName, manaCost, typeLine, powerToughness, setCode);
    if (deepMatch) {
      console.log(`[Scanner] Fallback 2 (Deep Semantic) succeeded for: ${deepMatch.name}`);
      return { printings: [], fallbackCard: formatScryfallCard(deepMatch), fallbackMethod: "fallback-guess" };
    }

    // Fallback 3: single card exact/fuzzy name lookup
    const namedResult = await searchScryfallCardByName(cardName);
    if (namedResult) return { printings: [], fallbackCard: formatScryfallCard(namedResult), fallbackMethod: "fallback-guess" };

    return { printings: [], fallbackCard: null };
  } catch {
    return { printings: [], fallbackCard: null };
  }
}

async function fetchPokemonPrintings(cardName: string): Promise<PrintingsResult> {
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
    if (card) return { printings: [], fallbackCard: formatPokemonCard(card), fallbackMethod: "fallback-guess" };

    return { printings: [], fallbackCard: null };
  } catch {
    return { printings: [], fallbackCard: null };
  }
}

async function fetchYugiohPrintings(cardName: string): Promise<PrintingsResult> {
  try {
    const results = await searchYugiohCards(cardName);
    const exactMatch = results.find((c: any) => c.name.toLowerCase() === cardName.toLowerCase()) || results[0];

    if (!exactMatch) return { printings: [], fallbackCard: null };

    // Yugioh packs alternate arts into card_images[] — treat each as a separate "printing"
    const imagePrintings: CandidatePrinting[] = getYugiohPrintings(exactMatch).map((p: any) => ({
      externalId: exactMatch.id.toString(),
      name: exactMatch.name,
      game: "YUGIOH",
      setName: p.setName,
      setCode: p.setCode,
      rarity: p.rarity,
      imageUrl: p.imageUrl,
      thumbnailUrl: p.thumbnailUrl,
      price: { marketPrice: p.price },
      // Distinct per art variant — without it, the shared card id would fold
      // every variant into one illustration group and block vision comparison.
      illustrationId: p.illustrationId,
    }));

    if (imagePrintings.length > 0) {
      console.log(`[Scanner] Yugioh: fetched ${imagePrintings.length} art variants for "${cardName}"`);
      return { printings: imagePrintings, fallbackCard: null };
    }

    return { printings: [], fallbackCard: formatYugiohCard(exactMatch), fallbackMethod: "fallback-guess" };
  } catch {
    return { printings: [], fallbackCard: null };
  }
}

// ─── Database Save Helper ──────────────────────────────────────────────────
async function saveAndRespond(matchedCard: CandidatePrinting, userId: string, ocrData: any, decision: Decision) {
  const confidencePct = Math.round(decision.confidence * 100);

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
      confidence: confidencePct,
      matchMethod: decision.method || null,
      imageUrl: localCard.imageUrl,
    },
  });

  console.log(`[Scanner] ✅ Saved: "${localCard.name}" from "${localCard.setName}" (method: ${decision.method}, confidence: ${confidencePct}%)`);

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
      confidence: confidencePct,
      method: decision.method,
      imageUrl: localCard.imageUrl,
      thumbnailUrl: localCard.thumbnailUrl,
      historyId: history.id,
    },
    ocrData,
  });
}
