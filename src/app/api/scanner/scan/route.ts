import { NextRequest, NextResponse } from "next/server";
import { dbRetry, prisma } from "@/lib/prisma";
import { auth } from "@/auth";
import { messageForStage, messageForUnavailableSources, runStage, stageOfError, type FailureStage } from "@/lib/scanner/failure";
import {
  reading,
  reconcileSetCn,
  SET_CN_CONFIDENCE,
  type CandidatePrinting,
  type ScanEvidence,
} from "@/lib/scanner/evidence";
import { type Decision, gateDecision } from "@/lib/scanner/decision";
import { extractBottomStrip, extractCardFields } from "@/lib/scanner/extract";
import { fetchAllPrintings } from "@/lib/scanner/candidates";
import { scorer } from "@/lib/scanner/score";
import { buildScanTelemetry } from "@/lib/scanner/telemetry";
import { getArchiveContext } from "@/lib/scanner/archive-context";
import { persistPrinting } from "@/lib/cards/persist-printing";
import { serializeSavedCard } from "@/lib/cards/serialize-card";
import type { DisambiguationCandidate } from "@/types/card";
import { checkScanBurst, SCAN_DAILY_LIMIT, startOfUtcDay } from "@/lib/rate-limit";

// Two OCR passes + a possible vision comparison + card-DB fetches can
// legitimately take a while; without this, a slow upstream hits the platform
// default and dies as an unclassifiable infra error.
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  // Hoisted for the catch-all: persisting a failed attempt needs the user, and
  // stage timings should survive a mid-pipeline throw.
  let userId: string | null = null;
  const timings: Record<string, number> = {};
  const timed = async <T,>(key: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    try {
      return await fn();
    } finally {
      timings[key] = Date.now() - t0;
    }
  };

  try {
    // Phase 5.13: the pre-OCR stages were the pipeline's dark matter — ~19% of
    // the median scan sat outside every timed() call, so no amount of staring at
    // ocrMs/candidatesMs could explain it. They are cheap to measure and were
    // simply never instrumented.
    const session = await timed("authMs", () => auth());
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    userId = session.user.id;

    // ─── Rate limits — every scan costs 2–3 vision-model calls ─────────
    const burst = checkScanBurst(session.user.id);
    if (!burst.ok) {
      return NextResponse.json(
        { success: false, stage: "rate-limit", message: `You're scanning too fast — try again in ${burst.retryAfterSeconds}s.` },
        { status: 429, headers: { "Retry-After": String(burst.retryAfterSeconds) } }
      );
    }
    // cardId != null: only SAVED scans count against the daily cap. Telemetry
    // rows for disambiguation/not-found attempts have cardId null and must not
    // tighten the limit (same semantics as before those rows existed).
    const scansToday = await runStage("database", () => timed("rateLimitMs", () => dbRetry(() =>
      prisma.scanHistory.count({
        where: { userId: session.user.id, cardId: { not: null }, createdAt: { gte: startOfUtcDay() } },
      })
    )));
    if (scansToday >= SCAN_DAILY_LIMIT) {
      return NextResponse.json(
        { success: false, stage: "rate-limit", message: "You've reached today's scan limit. It resets at midnight UTC." },
        { status: 429 }
      );
    }

    // The body carries a base64 image — this is not a free JSON.parse.
    const body = await runStage("parse", () => timed("parseMs", () => req.json()));
    const { image, game, isAutoScan } = body;

    if (!image) {
      return NextResponse.json({ success: false, stage: "parse", message: "No image provided from scanner" }, { status: 400 });
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
    // Both depend only on the image, not on each other, so they run together
    // and the strip pass's round-trip hides behind the full pass rather than
    // adding one. When the full pass fails or the game turns out to be Yugioh
    // the strip result is simply discarded — a fraction of a cent, versus
    // seconds of added latency on every scan if run serially.
    //
    // Order matters now that throttleVision() paces call STARTS (see
    // vision-throttle.ts): the SECOND vision call to acquire absorbs the pacing
    // gap. Start the full pass FIRST so that gap lands on the non-critical
    // strip pass (whose result isn't awaited until after the candidate fetch),
    // keeping the critical-path full pass — and single-scan latency — untouched.
    const extractionPromise = extractCardFields(imageUrl);
    const stripPromise = extractBottomStrip(imageUrl);
    const extraction = await timed("ocrMs", () => extractionPromise);
    if (!extraction.ok) {
      // 404 = OCR worked but saw no card; anything else = the OCR call failed.
      const stage: FailureStage = extraction.status === 404 ? "no-card" : "ocr";
      return NextResponse.json({ success: false, stage, message: extraction.message }, { status: extraction.status });
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
    // Everything the sensors saw is collected into ONE evidence bundle —
    // the only identification input the scorer receives.
    const evidence: ScanEvidence = {
      identity: { name: reading(cardName, 0.85, "ocr-full") },
      printing: {},
    };
    if (usesSetCnEvidence(effectiveGame)) {
      const strip = await stripPromise;
      const reconciled = reconcileSetCn({ setCode, collectorNumber }, strip);
      if (reconciled.setCode !== setCode || reconciled.collectorNumber !== collectorNumber) {
        console.log(`[Scanner] Strip OCR reconciled set/CN: [${setCode || "∅"}, ${collectorNumber || "∅"}] -> [${reconciled.setCode || "∅"}, ${reconciled.collectorNumber || "∅"}]`);
      }
      setCode = reconciled.setCode;
      collectorNumber = reconciled.collectorNumber;
      evidence.printing.setCode = reconciled.setCodeReading;
      evidence.printing.collectorNumber = reconciled.collectorNumberReading;
      evidence.printing.rarity = strip.rarity;
    } else {
      // Yugioh: no strip pass, but the full-pass set/CN still feeds ranking.
      if (setCode) evidence.printing.setCode = reading(setCode, SET_CN_CONFIDENCE.full, "ocr-full");
      if (collectorNumber) evidence.printing.collectorNumber = reading(collectorNumber, SET_CN_CONFIDENCE.full, "ocr-full");
    }

    // ─── Step 1b: Check AI Learning Rules for this card ───────────────
    // Best-effort: a learning rule refines a scan but must never fail one — a
    // DB hiccup here degrades to "no rule" instead of killing the attempt.
    //
    // Started here but NOT awaited until scoring (Phase 5.13). It needs only the
    // OCR'd name, and the candidate fetch never reads it, so the two are
    // independent; awaiting it here put a DB round trip on the critical path
    // ahead of the slowest stage in the pipeline for no reason. The scorer is
    // the first thing that actually consumes it.
    const learningRulePromise = timed("learningRuleMs", () =>
      prisma.aiLearningRule.findUnique({
        where: { targetName: cardName },
      }).catch((err) => {
        console.warn("[Scanner] Learning-rule lookup failed (non-fatal):", err?.message);
        return null;
      })
    );

    // ─── Step 2: Fetch all printings of this card ─────────────────────
    console.log(`[Scanner] Step 2: Fetching all printings for "${cardName}"...`);
    const candidates = await runStage("candidates", () =>
      timed("candidatesMs", () =>
        fetchAllPrintings(cardName, effectiveGame, setCode, collectorNumber, manaCost, typeLine, powerToughness)
      )
    );
    const { printings, fallbackCard } = candidates;
    const fallbackMethod = candidates.status === "found" ? candidates.fallbackMethod : undefined;

    // Now the rule is genuinely needed — usually already resolved behind the
    // candidate fetch, so this await costs nothing.
    const learningRule = await learningRulePromise;
    if (learningRule) {
      console.log(`[Scanner] 🧠 Found learning rule for "${cardName}": ${learningRule.ruleType}`);
      // Increment timesApplied asynchronously — don't await to avoid slowing the scan
      prisma.aiLearningRule.update({
        where: { id: learningRule.id },
        data: { timesApplied: { increment: 1 } },
      }).catch(() => {});
    }

    // ─── Step 3: Score — the scorer owns the identification verdict ────
    // Models only produced evidence; the scorer (heuristic today, probabilistic
    // once a labeled dataset exists) turns evidence + candidates into a
    // decision. The route never branches on match paths itself.
    const scored = await runStage("scoring", () =>
      timed("scoreMs", () =>
        scorer.score({
          cardName,
          printings,
          fallbackCard,
          fallbackMethod,
          evidence,
          scannedImageUrl: imageUrl,
          learningRule,
        })
      )
    );

    // ─── Step 4: Gate and respond ──────────────────────────────────────
    // Auto-scan saves without a review screen, so it demands more confidence.
    const decision: Decision = gateDecision(scored.decision, Boolean(isAutoScan), scored);

    // The failure path has always logged timings; the SUCCESS path only wrote
    // them to the DB, so a healthy-but-slow scan was invisible in the terminal —
    // exactly the scan you want to watch. One line, same data as the telemetry.
    // Phase 5.13C: per-source spans ride along here too. candidatesMs is one
    // number over up to three providers, so it could never show WHICH one was
    // slow — the question every provider decision starts with.
    const sourceSummary = candidates.sources
      .map((s) => `${s.source}=${s.durationMs}ms${s.availability === "failed" ? `:${s.reason}` : ""}`)
      .join(" ");
    console.log(
      `[Scanner] ⏱  ${effectiveGame || "unknown"} ${Date.now() - startedAt}ms total | ` +
      Object.entries(timings).map(([k, v]) => `${k.replace(/Ms$/, "")}=${v}`).join(" ") +
      (sourceSummary ? ` | ${sourceSummary}` : "") +
      ` | printings=${printings.length} → ${decision.action}`
    );

    // ─── Telemetry (pre-Phase 5): every attempt leaves an evidence record ─
    // Evidence + verdict + candidate counts, persisted with the attempt so
    // real scans accumulate into the Phase 6 evaluation dataset. Stored in
    // ScanHistory.ocrText (versioned JSON, previously unused column).
    const telemetryJson = JSON.stringify(buildScanTelemetry({
      evidence,
      scored,
      decision,
      // Phase 5.13C: carried on EVERY outcome, not just the failing ones. A scan
      // that found the card while a source timed out was indistinguishable from
      // a fully healthy scan — the partial outage left no trace anywhere.
      candidates: { status: candidates.status, sources: candidates.sources },
      printingsCount: printings.length,
      ocr: identifiedCard,
      game: effectiveGame,
      isAutoScan: Boolean(isAutoScan),
      timings,
    }));

    if (decision.action === "accept" && decision.printing) {
      return await runStage("database", () =>
        saveAndRespond(decision.printing!, session.user.id, identifiedCard, decision, telemetryJson, startedAt)
      );
    }

    if (decision.action === "disambiguate" && decision.candidates && decision.candidates.length > 0) {
      console.log(`[Scanner] Requesting user disambiguation among ${decision.candidates.length} candidate(s).`);
      // cardId stays null until (unless) the user picks — save-selection then
      // updates THIS row, linking the pick (ground truth) to this evidence.
      // Best-effort: if the telemetry row can't be written, the user still gets
      // their grid (without a scanId to link the pick back to).
      const pending = await dbRetry(() =>
        prisma.scanHistory.create({
          data: {
            userId: session.user.id,
            confidence: Math.round(decision.confidence * 100),
            matchMethod: "disambiguation-pending",
            ocrText: telemetryJson,
            processingTime: Date.now() - startedAt,
          },
        })
      ).catch((err) => {
        console.warn("[Scanner] Could not persist pending disambiguation (non-fatal):", err?.message);
        return null;
      });
      return disambiguationResponse(cardName, decision.candidates, identifiedCard, pending?.id ?? null, decision.bestMatchExternalId);
    }

    // ─── Nothing to show. Which of the two reasons is it? (Phase 5.13B) ──
    // This is the fork the whole phase exists for. "The databases don't have
    // this card" and "the databases didn't answer" both arrive here with zero
    // candidates, and only one of them licenses us to say the card wasn't found.
    //
    // Note the ORDER: unavailable is checked FIRST. A source that went quiet
    // makes the zero uninterpretable, so it outranks the not-found verdict no
    // matter what else completed.
    if (candidates.status === "provider_unavailable") {
      // A verdict of "we don't know" — persisted like any other, so the rate of
      // unanswerable scans is measurable rather than folded into not-found.
      await dbRetry(() =>
        prisma.scanHistory.create({
          data: {
            userId: session.user.id,
            confidence: 0,
            matchMethod: "provider-unavailable",
            ocrText: telemetryJson,
            processingTime: Date.now() - startedAt,
          },
        })
      ).catch((err) => console.warn("[Scanner] Could not persist unavailable attempt (non-fatal):", err?.message));

      console.log(`[Scanner] ⚠ Cannot verify "${cardName}" — unavailable: ${candidates.unavailable.join(", ")}`);
      // 503, not 404: 404 asserts the card does not exist. It might; we did not
      // find out. The status code has to mean what it says.
      return NextResponse.json({
        success: false,
        stage: "provider-unavailable",
        message: messageForUnavailableSources(candidates.unavailable, cardName),
        unavailableSources: candidates.unavailable,
        cardName,
      }, { status: 503 });
    }

    // Not-found is a VERDICT, not an error — and now an EARNED one: every source
    // we consulted answered, and none of them had this card.
    await dbRetry(() =>
      prisma.scanHistory.create({
        data: {
          userId: session.user.id,
          confidence: 0,
          matchMethod: "not-found",
          ocrText: telemetryJson,
          processingTime: Date.now() - startedAt,
        },
      })
    ).catch((err) => console.warn("[Scanner] Could not persist not-found attempt (non-fatal):", err?.message));
    return NextResponse.json({
      success: false,
      stage: "not-found",
      message: `AI identified "${cardName}" but no match was found in any card database. Try scanning again with better lighting.`
    }, { status: 404 });

  } catch (error: any) {
    // ─── Stage-classified failure (Phase 5.2.5) ─────────────────────────
    // Name WHERE the pipeline failed, persist the attempt so failures are
    // measurable, and never blame the image for an infrastructure error.
    const stage = stageOfError(error);
    const causeMessage: string = error?.cause_?.message || error?.message || String(error);
    console.error(`[Scanner] Pipeline error at stage "${stage}" after ${Date.now() - startedAt}ms:`, causeMessage, "timings:", JSON.stringify(timings));

    if (userId) {
      // Best-effort black-box record — matchMethod "error:<stage>" makes
      // failure rates per stage queryable straight from ScanHistory.
      await prisma.scanHistory.create({
        data: {
          userId,
          confidence: 0,
          matchMethod: `error:${stage}`,
          ocrText: JSON.stringify({ v: 1, error: { stage, message: causeMessage }, timings }),
          processingTime: Date.now() - startedAt,
        },
      }).catch(() => { /* the DB may be the failing stage */ });
    }

    return NextResponse.json({ success: false, stage, message: messageForStage(stage) }, { status: 500 });
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
// scanId identifies the pending ScanHistory row for this attempt; the client
// echoes it to save-selection so the user's pick lands on the same record.
// null when the telemetry row couldn't be written (non-fatal).
function disambiguationResponse(cardName: string, candidates: CandidatePrinting[], ocrData: any, scanId: string | null, bestMatchExternalId?: string) {
  const withImages = candidates.filter((c) => c.thumbnailUrl);
  const list: DisambiguationCandidate[] = (withImages.length > 0 ? withImages : candidates).map((c) => ({
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
    scanId,
    candidates: list,
    ocrData,
  });
}

// ─── Database Save Helper ──────────────────────────────────────────────────
async function saveAndRespond(matchedCard: CandidatePrinting, userId: string, ocrData: any, decision: Decision, telemetryJson: string, startedAt: number) {
  const confidencePct = Math.round(decision.confidence * 100);

  // Shared Card + CardPrice persistence (Phase 2 · C4) — identical to the
  // user-selection save path.
  const localCard = await persistPrinting(matchedCard);

  const history = await dbRetry(() => prisma.scanHistory.create({
    data: {
      userId,
      cardId: localCard.id,
      confidence: confidencePct,
      matchMethod: decision.method || null,
      imageUrl: localCard.imageUrl,
      ocrText: telemetryJson,
      processingTime: Date.now() - startedAt,
    },
  }));

  console.log(`[Scanner] ✅ Saved: "${localCard.name}" from "${localCard.setName}" (method: ${decision.method}, confidence: ${confidencePct}%)`);

  // Archive context (Phase 5 · Batch 2): what this card means in the user's
  // collection. Read-only, failure-safe (null on any error), and strictly
  // additive to the response — identification is already complete here.
  const archive = await getArchiveContext(userId, localCard);

  return NextResponse.json({
    success: true,
    data: serializeSavedCard({
      localCard,
      printing: matchedCard,
      archive,
      confidence: confidencePct,
      method: decision.method,
      historyId: history.id,
    }),
    ocrData,
  });
}
