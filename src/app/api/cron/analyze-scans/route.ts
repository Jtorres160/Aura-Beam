import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "dummy_build_key",
});

// ─── Thresholds ────────────────────────────────────────────────────────────
// How many manual disambiguations before we create a learning rule
const FAILURE_THRESHOLD = 3;
// Legacy confidence convention for scans recorded before matchMethod existed:
// auto-scan wrote 95, manual disambiguation wrote 90
const MANUAL_CONFIDENCE = 90;
// Secret header to prevent unauthorized external triggers
const CRON_SECRET = process.env.CRON_SECRET || "";

/**
 * GET /api/cron/analyze-scans
 *
 * Analyzes scan history to find cards where the AI frequently fails
 * (i.e., the user had to manually disambiguate) and auto-generates
 * learning rules to help the AI do better next time.
 *
 * Should be called periodically (e.g., daily via a Vercel cron job or
 * manually from the admin dashboard).
 */
export async function GET(req: NextRequest) {
  // Cron-only endpoint. When CRON_SECRET is configured, a matching Bearer token
  // is required; when it is unset the guard is skipped (conditional pattern),
  // which is why CRON_SECRET must be set in every deployed environment. No
  // in-app/admin-dashboard caller triggers this today — it is invoked solely by
  // the Vercel cron schedule in vercel.json.
  const authHeader = req.headers.get("authorization");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    console.log("[Analyzer] Starting scan history analysis...");

    // ── 1. Fetch all scan history with associated card names ─────────────
    const allScans = await prisma.scanHistory.findMany({
      include: {
        card: {
          select: { name: true, game: true },
        },
      },
      orderBy: { createdAt: "desc" },
      // Limit to last 1000 scans for performance
      take: 1000,
    });

    if (allScans.length === 0) {
      return NextResponse.json({
        success: true,
        message: "No scan history found yet.",
        rulesCreated: 0,
        rulesUpdated: 0,
      });
    }

    // ── 2. Group scans by card name, count failures vs successes ─────────
    // A scan is a pipeline failure when the user had to pick the printing
    // themselves. Scans record that as matchMethod "user-selection"; rows
    // written before matchMethod existed fall back to the old confidence
    // convention (90 manual / 95 auto).
    const statsMap = new Map<string, { name: string; game: string; failures: number; total: number }>();

    for (const scan of allScans) {
      if (!scan.card) continue;
      const key = scan.card.name.toLowerCase();
      const existing = statsMap.get(key) || { name: scan.card.name, game: scan.card.game, failures: 0, total: 0 };
      existing.total++;
      const isFailure = scan.matchMethod
        ? scan.matchMethod === "user-selection"
        : (scan.confidence ?? 95) <= MANUAL_CONFIDENCE;
      if (isFailure) {
        existing.failures++;
      }
      statsMap.set(key, existing);
    }

    console.log(`[Analyzer] Analyzed ${allScans.length} scans across ${statsMap.size} unique cards.`);

    // ── 3. Find problem cards that cross the failure threshold ────────────
    const problemCards = Array.from(statsMap.values()).filter(
      (s) => s.failures >= FAILURE_THRESHOLD
    );

    console.log(`[Analyzer] Found ${problemCards.length} problem cards needing learning rules.`);

    let rulesCreated = 0;
    let rulesUpdated = 0;

    // ── 4. For each problem card, generate or update a learning rule ──────
    for (const card of problemCards) {
      // Check if a rule already exists
      const existingRule = await prisma.aiLearningRule.findUnique({
        where: { targetName: card.name },
      });

      // Don't regenerate a FORCE_DISAMBIGUATION rule unless failure rate is very high
      const failureRate = card.failures / card.total;
      const ruleType = failureRate >= 0.75 ? "FORCE_DISAMBIGUATION" : "HINT";

      if (existingRule) {
        // Update failure count but don't regenerate the hint (preserve manual tweaks)
        await prisma.aiLearningRule.update({
          where: { targetName: card.name },
          data: {
            failureCount: card.failures,
            ruleType, // Escalate to FORCE_DISAMBIGUATION if needed
          },
        });
        rulesUpdated++;
        continue;
      }

      // ── Generate a hint via AI ──────────────────────────────────────────
      let hintContent = `When identifying "${card.name}" (${card.game}), be extra careful. This card has many printings with similar artwork. Focus on: the set symbol shape and color, the border color and style, the font of the collector number, and any foil or holo patterns visible.`;

      if (process.env.OPENAI_API_KEY) {
        try {
          const hintResponse = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
              {
                role: "system",
                content: `You are an expert trading card identifier writing a concise hint for an AI scanner system. The hint will be injected into a vision AI prompt to help it correctly identify the exact printing of a card. Keep it under 60 words. Be specific and technical.`,
              },
              {
                role: "user",
                content: `Write a specific identification hint for the card "${card.name}" (game: ${card.game}). The AI has failed to identify the correct printing ${card.failures} out of ${card.total} times. Focus on visual differences between printings (border color, set symbol location, font style, foil pattern, card frame era).`,
              },
            ],
            max_tokens: 80,
            temperature: 0.3,
          });
          hintContent = hintResponse.choices[0]?.message?.content?.trim() || hintContent;
        } catch (e) {
          console.warn(`[Analyzer] Could not generate AI hint for "${card.name}", using default.`);
        }
      }

      // Save the new rule
      await prisma.aiLearningRule.create({
        data: {
          targetName: card.name,
          ruleType,
          content: hintContent,
          failureCount: card.failures,
        },
      });

      console.log(`[Analyzer] ✅ Created ${ruleType} rule for "${card.name}" (${card.failures}/${card.total} failures)`);
      rulesCreated++;
    }

    // ── 5. Return summary ─────────────────────────────────────────────────
    const allRules = await prisma.aiLearningRule.findMany({
      orderBy: { failureCount: "desc" },
      take: 20,
    });

    return NextResponse.json({
      success: true,
      scansAnalyzed: allScans.length,
      uniqueCards: statsMap.size,
      problemCardsFound: problemCards.length,
      rulesCreated,
      rulesUpdated,
      activeRules: allRules.map((r) => ({
        card: r.targetName,
        type: r.ruleType,
        failures: r.failureCount,
        timesApplied: r.timesApplied,
        hint: r.content.substring(0, 80) + "...",
      })),
    });
  } catch (error: any) {
    console.error("[Analyzer] Error:", error?.message || error);
    return NextResponse.json(
      { success: false, message: "Analysis failed: " + (error?.message || "Unknown error") },
      { status: 500 }
    );
  }
}
