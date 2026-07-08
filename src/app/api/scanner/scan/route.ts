import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/auth";
import { reconcileSetCn, type CandidatePrinting } from "@/lib/scanner/evidence";
import {
  type Decision,
  acceptDecision,
  disambiguateDecision,
  notFoundDecision,
  gateDecision,
} from "@/lib/scanner/decision";
import { extractBottomStrip, extractCardFields } from "@/lib/scanner/extract";
import { fetchAllPrintings } from "@/lib/scanner/candidates";
import { decideAmongPrintings } from "@/lib/scanner/rank";

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

    // ─── Step 1: OCR — two passes over the same image, in PARALLEL ──────
    // The strip pass only depends on the image, not on the full pass, so
    // firing it now hides its entire round-trip behind the full pass instead
    // of adding one. When the full pass fails or the game turns out to be
    // Yugioh its result is simply discarded — that costs a fraction of a
    // cent, versus seconds of added latency on every scan if run serially.
    const stripPromise = extractBottomStrip(imageUrl);
    const extraction = await extractCardFields(imageUrl);
    if (!extraction.ok) {
      return NextResponse.json({ success: false, message: extraction.message }, { status: extraction.status });
    }

    const { identifiedCard, cardName, aiGame, manaCost, typeLine, powerToughness } = extraction.fields;
    // Reconciled below by the strip pass, so set/CN are mutable.
    let { setCode, collectorNumber } = extraction.fields;
    const effectiveGame = game || aiGame;
    console.log(`[Scanner] Identified: "${cardName}" (${effectiveGame || "unknown game"}) [Set: ${setCode}, CN: ${collectorNumber}, Mana: ${manaCost}, Type: ${typeLine}, PT: ${powerToughness}]`);

    // ─── Step 1c: Reconcile the bottom-strip OCR pass (Phase 3) ────────
    // The strip pass re-read the set/collector strip at high detail; merge it
    // with the full-pass reading. Set/CN drives the strongest match paths
    // (set-cn-verified 0.97, single-art-group 0.85), so sharpening it yields
    // more auto-accepts and fewer disambiguation prompts. Yugioh
    // identification ignores set/CN, so its strip result is discarded.
    if (usesSetCnEvidence(effectiveGame)) {
      const strip = await stripPromise;
      const reconciled = reconcileSetCn({ setCode, collectorNumber }, strip);
      if (reconciled.setCode !== setCode || reconciled.collectorNumber !== collectorNumber) {
        console.log(`[Scanner] Strip OCR reconciled set/CN: [${setCode || "∅"}, ${collectorNumber || "∅"}] -> [${reconciled.setCode || "∅"}, ${reconciled.collectorNumber || "∅"}]`);
      }
      setCode = reconciled.setCode;
      collectorNumber = reconciled.collectorNumber;
    }

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
      return disambiguationResponse(cardName, decision.candidates, identifiedCard, decision.bestMatchExternalId);
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

// ─── Game gating for the strip pass ─────────────────────────────────────────
// The bottom-strip OCR pass only pays for itself when set/CN actually feeds the
// decision. Yugioh identification ignores set/CN (it disambiguates by art
// variant), so it skips the extra call; every other game — including unknown,
// which may still resolve to MTG/Pokemon — runs it.
function usesSetCnEvidence(game: string): boolean {
  const g = game?.toUpperCase?.() || "";
  return !(g.includes("YUGIOH") || g.includes("YU-GI-OH"));
}

// ─── Disambiguation response ────────────────────────────────────────────────
function disambiguationResponse(cardName: string, candidates: CandidatePrinting[], ocrData: any, bestMatchExternalId?: string) {
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
    // Vision's best guess — the UI highlights this one at the top of the grid.
    isBestMatch: Boolean(bestMatchExternalId) && c.externalId === bestMatchExternalId,
  }));

  return NextResponse.json({
    success: true,
    requiresDisambiguation: true,
    cardName,
    candidates: list,
    ocrData,
  });
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
  }

  // Always refresh the stored price with what the card database returned just
  // now — a card first scanned months ago must not keep its stale price.
  await prisma.cardPrice.upsert({
    where: { cardId: localCard.id },
    update: {
      marketPrice: matchedCard.price?.marketPrice || 0,
      lowPrice: matchedCard.price?.lowPrice || null,
      midPrice: matchedCard.price?.midPrice || null,
      highPrice: matchedCard.price?.highPrice || null,
      lastUpdated: new Date(),
    },
    create: {
      cardId: localCard.id,
      marketPrice: matchedCard.price?.marketPrice || 0,
      lowPrice: matchedCard.price?.lowPrice || null,
      midPrice: matchedCard.price?.midPrice || null,
      highPrice: matchedCard.price?.highPrice || null,
    },
  });

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
