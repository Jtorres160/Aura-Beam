import { NextRequest, NextResponse } from "next/server";
import { dbRetry, prisma } from "@/lib/prisma";
import { auth } from "@/auth";
import { METHOD_CONFIDENCE } from "@/lib/scanner/decision";
import { fetchPrintingById, type PrintingLookupResult } from "@/lib/scanner/candidates";
import type { CandidatePrinting } from "@/lib/scanner/evidence";
import { withSelection, withSelectionAttempt, type SelectionAttemptFailure } from "@/lib/scanner/telemetry";
import { getArchiveContext } from "@/lib/scanner/archive-context";
import { persistPrinting } from "@/lib/cards/persist-printing";
import { serializeSavedCard } from "@/lib/cards/serialize-card";
import { messageForStage, messageForUnavailableSelection, runStage, stageOfError } from "@/lib/scanner/failure";

// The user looked at the physical card and picked — that's ground truth.
const USER_SELECTION_CONFIDENCE = Math.round(METHOD_CONFIDENCE["user-selection"] * 100);

// The provider lookup can eat up to two 8s timeouts back-to-back; give the
// route room for that plus the DB writes.
export const maxDuration = 30;

/**
 * By-id lookup with one bounded retry. The Pokémon API in particular flaps —
 * a 404/504 followed by a 200 on the SAME url is a measured behavior (see
 * providers/http.ts) — and this call has a user standing on the grid waiting.
 * One short pause + re-ask converts most of those flaps into a save. A timeout
 * is not retried (we already waited the full 8s ceiling once).
 */
const LOOKUP_RETRY_DELAY_MS = 1500;
async function fetchPrintingWithRetry(game: string, externalId: string): Promise<PrintingLookupResult> {
  const first = await fetchPrintingById(game, externalId);
  if (first.status !== "provider_unavailable" || first.reason === "timeout") return first;
  await new Promise((r) => setTimeout(r, LOOKUP_RETRY_DELAY_MS));
  return fetchPrintingById(game, externalId);
}

/**
 * Last-resort source when the provider stays dark: OUR OWN copy of the card,
 * persisted by an earlier scan of this same printing. This does not weaken the
 * trust boundary — the row was written server-side from the provider's
 * authoritative answer at the time; the request still contributes identifiers
 * only. The price may be as stale as that last fetch, which beats telling a
 * collector their save failed.
 */
async function printingFromLocalCache(externalId: string): Promise<CandidatePrinting | null> {
  const cached = await dbRetry(() => prisma.card.findUnique({
    where: { externalId },
    include: { prices: true },
  }));
  if (!cached?.externalId) return null;
  return {
    externalId: cached.externalId,
    name: cached.name,
    game: cached.game as CandidatePrinting["game"],
    setName: cached.setName,
    setCode: cached.setCode,
    collectorNumber: cached.collectorNumber,
    rarity: cached.rarity,
    imageUrl: cached.imageUrl,
    thumbnailUrl: cached.thumbnailUrl,
    price: {
      marketPrice: cached.prices?.marketPrice ?? 0,
      lowPrice: cached.prices?.lowPrice ?? null,
      midPrice: cached.prices?.midPrice ?? null,
      highPrice: cached.prices?.highPrice ?? null,
    },
  };
}

/**
 * Append a failed save attempt to the originating scan's telemetry (5.13C).
 *
 * Best-effort and non-fatal throughout: the collector is already receiving an
 * honest 503, and a telemetry write must never turn that into a 500. The
 * ownership filter is the same one the success path uses — one user must not be
 * able to write onto another user's scan row.
 */
async function recordSelectionAttempt(
  scanId: string,
  userId: string,
  attempt: Omit<SelectionAttemptFailure, "at">,
): Promise<void> {
  try {
    const origin = await dbRetry(() => prisma.scanHistory.findFirst({ where: { id: scanId, userId } }));
    if (!origin) return;
    await dbRetry(() => prisma.scanHistory.update({
      where: { id: origin.id },
      data: { ocrText: withSelectionAttempt(origin.ocrText, attempt) },
    }));
  } catch (err) {
    console.warn("[SaveSelection] Could not record failed attempt (non-fatal):", (err as Error)?.message);
  }
}

// ─── POST /api/scanner/save-selection ─────────────────────────────────────
// Called by the frontend when the user manually selects their card variant
// from the disambiguation grid.
//
// TRUST BOUNDARY: the request names a card by IDENTIFIERS only (externalId +
// game). Card and CardPrice are GLOBAL tables shared by every user, so nothing
// written to them may come from the request body — the card is re-fetched from
// its source database server-side and that authoritative copy is what gets
// persisted. A tampered request can, at worst, save a card that exists.
export async function POST(req: NextRequest) {
  // Hoisted for the catch-all's structured log — a failure should name the
  // card it was trying to save, not just "an error".
  let externalId: string | undefined;
  let game: string | undefined;
  let cardName: string | undefined;
  let localCardId: string | undefined;
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    // body.candidate is the legacy shape (kept so a cached client keeps
    // working across the deploy); only its identifiers are read.
    externalId = body.externalId ?? body.candidate?.externalId;
    game = body.game ?? body.candidate?.game;
    // Links the pick back to the originating scan attempt's telemetry row.
    const scanId: string | undefined = typeof body.scanId === "string" ? body.scanId : undefined;

    if (!externalId || !game) {
      return NextResponse.json({ success: false, message: "No card selection provided." }, { status: 400 });
    }

    // ─── Authoritative re-fetch — the ONLY source of persisted card data ──
    // Phase 5.13C: this lookup has three outcomes, not two. It used to have two,
    // because a provider failure was collapsed into null and rendered as
    // "Could not verify the selected card. Please scan again." — a 404 asserting
    // the card isn't real, told to someone who just picked it off our own grid.
    let lookup = await fetchPrintingWithRetry(game, externalId);

    // Provider still dark after the retry → serve the card from our own DB if
    // an earlier scan already persisted this exact printing.
    if (lookup.status === "provider_unavailable") {
      const cached = await printingFromLocalCache(externalId);
      if (cached) {
        console.warn(
          `[SaveSelection] ${lookup.label} unavailable (${lookup.reason}) — ` +
          `saving "${cached.name}" (${externalId}) from the local card cache`
        );
        lookup = { status: "found", card: cached };
      }
    }

    if (lookup.status === "provider_unavailable") {
      // We could not ASK. That is not a verdict about the user's card, so it
      // must not borrow 404's voice. 503 + the source that went quiet.
      console.warn(
        `[SaveSelection] ⚠ Cannot confirm selection ${externalId} (${game}) — ` +
        `${lookup.label} unavailable (${lookup.reason})`
      );
      // Record the failed attempt ON the pending row (best-effort, additive).
      // NOT as matchMethod: the row is still legitimately "disambiguation-pending"
      // — the user may retry and succeed, and overwriting the method here would
      // both destroy that pending state and delete the Phase 6 ground-truth link.
      // The attempt goes in the telemetry JSON instead, where it makes selection
      // failures measurable without costing us the label.
      if (scanId) {
        await recordSelectionAttempt(scanId, session.user.id, {
          status: "provider_unavailable",
          source: lookup.source,
          reason: lookup.reason,
        });
      }
      return NextResponse.json(
        {
          success: false,
          stage: "selection-provider",
          message: messageForUnavailableSelection([lookup.label]),
          unavailableSources: [lookup.label],
        },
        { status: 503 }
      );
    }

    if (lookup.status === "not_found") {
      // The source ANSWERED and has no such card — an earned 404. Reachable if
      // the printing was withdrawn upstream between the grid and the save.
      return NextResponse.json(
        { success: false, stage: "not-found", message: "Could not verify the selected card. Please scan again." },
        { status: 404 }
      );
    }

    const card = lookup.card;
    cardName = card.name;

    // ─── Persist (Phase 5.2.5 parity) ──────────────────────────────────
    // Same reliability contract as the scan route's saveAndRespond: every
    // write is dbRetry-wrapped so a transient serverless connection drop is
    // recovered instead of surfacing as a 500, and the whole block is tagged
    // "database" so a hard failure is stage-classified (not a generic error).
    const { localCard, history } = await runStage("database", async () => {
      // Shared Card + CardPrice persistence (Phase 2 · C4) — identical to the
      // scan auto-accept path.
      const localCard = await persistPrinting(card);

      // Save to scan history. matchMethod "user-selection" is what the learning
      // analyzer counts as a pipeline failure — the AI couldn't finish the job.
      // When the client echoed the scanId, UPDATE the originating attempt's row
      // instead of creating a new one: the pick becomes the ground-truth label
      // attached to that scan's evidence (Phase 6 eval dataset). The ownership
      // check keeps one user from labeling another user's scan.
      let history = null;
      if (scanId) {
        const origin = await dbRetry(() => prisma.scanHistory.findFirst({
          where: { id: scanId, userId: session.user.id },
        }));
        if (origin) {
          history = await dbRetry(() => prisma.scanHistory.update({
            where: { id: origin.id },
            data: {
              cardId: localCard.id,
              confidence: USER_SELECTION_CONFIDENCE,
              matchMethod: "user-selection",
              imageUrl: localCard.imageUrl,
              ocrText: withSelection(origin.ocrText, { externalId: card.externalId, game: card.game }),
            },
          }));
        }
      }
      if (!history) {
        history = await dbRetry(() => prisma.scanHistory.create({
          data: {
            userId: session.user.id,
            cardId: localCard.id,
            confidence: USER_SELECTION_CONFIDENCE,
            matchMethod: "user-selection",
            imageUrl: localCard.imageUrl,
            ocrText: withSelection(null, { externalId: card.externalId, game: card.game }),
          },
        }));
      }

      return { localCard, history };
    });
    localCardId = localCard.id;

    console.log(`[Scanner] User-selected: "${localCard.name}" from "${localCard.setName}"`);

    // Archive context (Phase 5 · Batch 2) — same additive, failure-safe field
    // the auto-accept path returns, so both save paths feel identical.
    const archive = await getArchiveContext(session.user.id, localCard);

    return NextResponse.json({
      success: true,
      data: serializeSavedCard({
        localCard,
        printing: card,
        archive,
        confidence: USER_SELECTION_CONFIDENCE,
        historyId: history.id,
      }),
    });

  } catch (error: any) {
    // ─── Stage-classified failure (Phase 5.2.5 parity) ──────────────────
    // Same taxonomy the scan route uses: name WHERE the save failed and never
    // blame the image. Persistence throws surface here tagged "database".
    const stage = stageOfError(error);
    const causeMessage: string = error?.cause_?.message || error?.message || String(error);
    console.error(
      `[SaveSelection] Failed at stage "${stage}" — game=${game ?? "?"} card="${cardName ?? "?"}" externalId=${externalId ?? "?"} localId=${localCardId ?? "?"}:`,
      causeMessage
    );
    return NextResponse.json({ success: false, stage, message: messageForStage(stage) }, { status: 500 });
  }
}
