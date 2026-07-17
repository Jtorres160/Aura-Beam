// ─── Recognition Memory (Phase 5.18) ────────────────────────────────────────
// Aura's durable memory of card identities it has ALREADY verified.
//
// The problem this closes (proved by the Phase 5.17B adversarial harness): a
// re-scan of a card Aura already accepted still depends on external provider
// health. Mimikyu ex accepted at 97% when the Pokémon API answered, and
// degraded to a negative-evidence disambiguation when the SAME image hit a
// Pokémon timeout. The scorer and truth boundary were both correct — Aura
// simply had no memory of its own prior verdict, so it re-litigated a settled
// identity against a flaky provider every time.
//
// Recognition memory records the Decision Gate's ACCEPT verdicts as addressable
// identities. A later scan can consult Aura's own memory BEFORE asking a
// provider. This is not a new decision authority and does not touch scoring,
// evidence weights, the gate, OCR, provider adapters, or the truth boundary:
//
//   - WRITE happens only after gateDecision returns action === "accept"
//     (rememberVerifiedIdentity). Rejected/ambiguous/guessed candidates and
//     un-verified provider responses are never written.
//   - READ (lookupRecognitionMemory) rebuilds the accepted printing from the
//     canonical global Card row the accept already persisted — so a memory hit
//     serves a printing Aura itself verified, with zero provider calls.
//
// Keys are a deterministic function of the OCR-derived identity, computed the
// SAME way at write and read time so a repeat scan lands on the same row.

import type { Card, CardPrice, RecognitionMemory } from "@prisma/client";
import { dbRetry, prisma } from "@/lib/prisma";
import type { CandidatePrinting, GameId } from "@/lib/scanner/evidence";

// ─── Feature flags ───────────────────────────────────────────────────────────
// Shadow mode (Stage 2) is always on: it only observes and records, never
// changes behavior. Serving (Stage 3) bypasses provider discovery on a verified
// hit; opt-in via env (Phase 5.18A). Default OFF — the validation strategy
// depends on the live pipeline running alongside memory so agreement can be
// measured; a served scan never runs providers, so it can never prove itself
// safe. Serving is enabled only after shadow telemetry shows zero
// disagreements, by explicitly setting RECOGNITION_MEMORY_SERVE=1.
export const RECOGNITION_MEMORY_SHADOW = process.env.RECOGNITION_MEMORY_SHADOW !== "0";
export const RECOGNITION_MEMORY_SERVE = process.env.RECOGNITION_MEMORY_SERVE === "1";

/** Canonical game id, or null for a game we hold no memory strategy for.
 *  Mirrors the route's usesSetCnEvidence()/sourceForGame() vocabulary so the
 *  key strategy never drifts from how the rest of the pipeline names games. */
export function canonicalGame(game: string | null | undefined): GameId | null {
  const g = game?.toUpperCase?.() || "";
  if (g.includes("MTG") || g.includes("MAGIC")) return "MTG";
  if (g.includes("POKEMON") || g.includes("POKÉMON")) return "POKEMON";
  if (g.includes("YUGIOH") || g.includes("YU-GI-OH")) return "YUGIOH";
  return null;
}

/** Set/CN is identity-bearing for every game except Yu-Gi-Oh (which resolves by
 *  art variant, exactly as usesSetCnEvidence() decides in the route). */
function usesSetCn(game: GameId): boolean {
  return game !== "YUGIOH";
}

function normName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Collector-number prefix — "069/159" → "069", matching the cleanCn logic the
 *  Scryfall/Pokemon direct lookups already use, so the key reflects the same
 *  value the candidate layer keyed on. */
function normCn(cn: string): string {
  return cn.split("/")[0].trim().toLowerCase();
}

export interface RecognitionKeys {
  game: GameId;
  nameKey: string;
  setCodeKey: string | null;
  collectorNumberKey: string | null;
  /** The row's unique write key AND the primary read key. */
  primaryKey: string;
  /** True when primaryKey is the set/CN key (precise); false when name-based. */
  keyedBySetCn: boolean;
}

/**
 * Deterministic identity keys from the OCR-derived fields. Returns null only
 * when the game is one we have no memory strategy for (then the caller simply
 * skips memory, exactly as it would for an unsupported game today).
 */
export function buildRecognitionKeys(input: {
  game: string;
  name: string;
  setCode?: string | null;
  collectorNumber?: string | null;
}): RecognitionKeys | null {
  const game = canonicalGame(input.game);
  if (!game || !input.name?.trim()) return null;

  const nameKey = normName(input.name);
  const setCodeKey = input.setCode?.trim() ? input.setCode.trim().toUpperCase() : null;
  const collectorNumberKey = input.collectorNumber?.trim() ? normCn(input.collectorNumber) : null;

  const keyedBySetCn = usesSetCn(game) && Boolean(setCodeKey && collectorNumberKey);
  const primaryKey = keyedBySetCn
    ? `${game}|setcn|${setCodeKey}|${collectorNumberKey}`
    : `${game}|name|${nameKey}`;

  return { game, nameKey, setCodeKey, collectorNumberKey, primaryKey, keyedBySetCn };
}

// ─── Stage 1: remember a verified identity (accept only) ─────────────────────

/**
 * Record (or refresh) a verified identity AFTER the Decision Gate accepted it.
 *
 * Contract: the caller MUST only invoke this when decision.action === "accept".
 * This function does not re-check the verdict — it is the accept path's job to
 * gate the call, exactly as it already gates persistPrinting.
 *
 * Best-effort by construction: memory must never break identification, so a
 * failed write is logged and swallowed. The scan has already succeeded.
 */
export async function rememberVerifiedIdentity(input: {
  game: string;
  ocrName: string;
  ocrSetCode?: string | null;
  ocrCollectorNumber?: string | null;
  card: Pick<Card, "id" | "externalId" | "name">;
  method: string;
  confidence: number; // 0–100
  signals?: unknown; // evidence summary; serialized to JSON
}): Promise<void> {
  const keys = buildRecognitionKeys({
    game: input.game,
    name: input.ocrName,
    setCode: input.ocrSetCode,
    collectorNumber: input.ocrCollectorNumber,
  });
  if (!keys) return; // unsupported game — nothing to remember, honestly
  if (!input.card.externalId) return; // no canonical id → nothing addressable

  const data = {
    game: keys.game,
    nameKey: keys.nameKey,
    setCodeKey: keys.setCodeKey,
    collectorNumberKey: keys.collectorNumberKey,
    cardId: input.card.id,
    externalId: input.card.externalId,
    cardName: input.card.name,
    verificationState: "VERIFIED",
    method: input.method,
    confidence: Math.round(input.confidence),
    signals: input.signals != null ? JSON.stringify(input.signals) : null,
  };

  await dbRetry(() =>
    prisma.recognitionMemory.upsert({
      where: { lookupKey: keys.primaryKey },
      // A re-verification refreshes the verdict (method/confidence can only have
      // come from another accept) and re-points at the current canonical card.
      update: { ...data, verifiedAt: new Date() },
      create: { lookupKey: keys.primaryKey, ...data },
    })
  ).catch((err) =>
    console.warn(`[RecognitionMemory] Could not remember "${input.card.name}" (non-fatal):`, err?.message)
  );
}

// ─── Stage 2/3: look up a verified identity ──────────────────────────────────

export type MemoryMatchedBy = "set-cn" | "name";

export interface RecognitionHit {
  memory: RecognitionMemory;
  card: Card & { prices: CardPrice | null };
  /** Which key strategy found it — precise set/CN, or the name fallback. */
  matchedBy: MemoryMatchedBy;
}

/**
 * Consult recognition memory for an OCR-derived identity. Returns a hit only
 * when a VERIFIED row exists AND its canonical Card row is still present (the
 * printing must be rebuildable without a provider). Best-effort: any error
 * resolves to a miss (null), so a memory hiccup degrades to normal discovery
 * rather than failing a scan.
 *
 * Two probes, precise first:
 *   1. the set/CN key (exact identity) when the game is set/CN-bearing;
 *   2. a name-key fallback (game + normalized name), which covers Yu-Gi-Oh and
 *      any identity stored under a name key.
 */
export async function lookupRecognitionMemory(input: {
  game: string;
  name: string;
  setCode?: string | null;
  collectorNumber?: string | null;
}): Promise<RecognitionHit | null> {
  const keys = buildRecognitionKeys(input);
  if (!keys) return null;

  try {
    // Probe 1 — precise set/CN identity.
    if (keys.keyedBySetCn) {
      const hit = await loadHitByKey(keys.primaryKey);
      if (hit) return { ...hit, matchedBy: "set-cn" };
    }

    // Probe 2 — name fallback (also the primary path for Yu-Gi-Oh). Most recent
    // verification wins if several printings share a name key.
    const byName = await dbRetry(() =>
      prisma.recognitionMemory.findFirst({
        where: { game: keys.game, nameKey: keys.nameKey, verificationState: "VERIFIED" },
        orderBy: { verifiedAt: "desc" },
      })
    );
    if (byName) {
      const card = await loadCardWithPrice(byName.cardId);
      if (card) return { memory: byName, card, matchedBy: "name" };
    }
  } catch (err) {
    console.warn("[RecognitionMemory] Lookup failed (non-fatal, treated as miss):", (err as Error)?.message);
  }
  return null;
}

async function loadHitByKey(lookupKey: string): Promise<Omit<RecognitionHit, "matchedBy"> | null> {
  const memory = await dbRetry(() =>
    prisma.recognitionMemory.findUnique({ where: { lookupKey } })
  );
  if (!memory || memory.verificationState !== "VERIFIED") return null;
  const card = await loadCardWithPrice(memory.cardId);
  if (!card) return null;
  return { memory, card };
}

async function loadCardWithPrice(cardId: string): Promise<(Card & { prices: CardPrice | null }) | null> {
  return dbRetry(() =>
    prisma.card.findUnique({ where: { id: cardId }, include: { prices: true } })
  );
}

/**
 * Whether a memory hit is precise enough to SERVE (Phase 5.18A, P0-1).
 *
 * Evidence Philosophy: memory must never override stronger live evidence. For
 * set/CN-bearing games (MTG, Pokémon), set + collector number is the identity —
 * a name-key hit only proves "some printing of this name was once verified",
 * which is weaker than the set/CN evidence a live scan may be carrying. So for
 * those games only a "set-cn" match may serve; a "name" hit still counts for
 * shadow telemetry but serving behaves exactly as if memory missed. Name-keyed
 * games (Yu-Gi-Oh) are unaffected: name IS their key strategy.
 */
export function memoryServeEligible(hit: RecognitionHit): boolean {
  const game = canonicalGame(hit.memory.game);
  if (!game) return false;
  return !usesSetCn(game) || hit.matchedBy === "set-cn";
}

/**
 * Rebuild the authoritative CandidatePrinting from a memory hit — entirely from
 * Aura's own stored Card + CardPrice, with NO provider call. This is what makes
 * serving provider-independent: the printing Aura verified on accept is
 * reconstructed from the row that accept persisted.
 */
export function printingFromMemory(hit: RecognitionHit): CandidatePrinting {
  const { card } = hit;
  return {
    externalId: card.externalId ?? hit.memory.externalId,
    name: card.name,
    game: card.game as GameId,
    setName: card.setName,
    setCode: card.setCode,
    collectorNumber: card.collectorNumber,
    rarity: card.rarity,
    imageUrl: card.imageUrl,
    thumbnailUrl: card.thumbnailUrl,
    price: {
      marketPrice: card.prices?.marketPrice ?? 0,
      lowPrice: card.prices?.lowPrice ?? null,
      midPrice: card.prices?.midPrice ?? null,
      highPrice: card.prices?.highPrice ?? null,
    },
  };
}

// ─── Stage 2/3 telemetry ─────────────────────────────────────────────────────
// One record that answers every question the phase asks of the memory layer,
// so hits, misses, provider calls avoided, and disagreements are separable
// straight from the data (embedded in ScanHistory.ocrText, and logged).

export type MemoryAgreement =
  | "agree"        // memory and the live pipeline accepted the SAME printing
  | "disagree"     // both accepted, but DIFFERENT printings — the alarm case
  | "memory-only"  // memory had it; the live pipeline did NOT accept (e.g. a
                   // provider timeout degraded the scan) — memory would have
                   // served the verified identity the pipeline just lost
  | "n/a";         // memory miss — nothing to compare

export interface MemoryShadowRecord {
  /** "serve" = memory answered and providers were skipped; "shadow" = providers
   *  ran and memory only observed. */
  mode: "serve" | "shadow";
  outcome: "hit" | "miss";
  matchedBy?: MemoryMatchedBy;
  memoryExternalId?: string;
  memoryMethod?: string;
  memoryConfidence?: number;
  /** The live pipeline's verdict — absent on the serve path (it never ran). */
  pipelineAction?: string;
  pipelineExternalId?: string;
  agreement?: MemoryAgreement;
  /** How many provider sources this scan actually consulted (0 when served). */
  providerSourcesConsulted?: number;
  /** A hit means a repeat scan of a card Aura already knew — true iff hit. */
  wouldAvoidProviders: boolean;
  /** Phase 5.18A (additive): whether the tightened serve gate WOULD have served
   *  this hit — eligible key strategy AND confidence over this mode's accept
   *  threshold. Recorded in shadow so validation can prove serve behavior
   *  before serving is ever enabled. Always true on the serve path. */
  wouldServe?: boolean;
}

/** Build the shadow record for the SERVE path (memory answered, no providers). */
export function buildServeRecord(hit: RecognitionHit): MemoryShadowRecord {
  return {
    mode: "serve",
    outcome: "hit",
    matchedBy: hit.matchedBy,
    memoryExternalId: hit.memory.externalId,
    memoryMethod: hit.memory.method,
    memoryConfidence: hit.memory.confidence,
    providerSourcesConsulted: 0,
    wouldAvoidProviders: true,
    wouldServe: true,
  };
}

/** Build the shadow record for the OBSERVE path (providers ran; memory watched).
 *  `acceptedExternalId` is the printing the live pipeline accepted, or null if
 *  it did not accept. */
export function buildShadowRecord(
  hit: RecognitionHit | null,
  pipelineAction: string,
  acceptedExternalId: string | null,
  providerSourcesConsulted: number,
  wouldServe: boolean,
): MemoryShadowRecord {
  if (!hit) {
    return {
      mode: "shadow",
      outcome: "miss",
      pipelineAction,
      pipelineExternalId: acceptedExternalId ?? undefined,
      agreement: "n/a",
      providerSourcesConsulted,
      wouldAvoidProviders: false,
      wouldServe: false,
    };
  }

  let agreement: MemoryAgreement;
  if (!acceptedExternalId) agreement = "memory-only";
  else if (acceptedExternalId === hit.memory.externalId) agreement = "agree";
  else agreement = "disagree";

  return {
    mode: "shadow",
    outcome: "hit",
    matchedBy: hit.matchedBy,
    memoryExternalId: hit.memory.externalId,
    memoryMethod: hit.memory.method,
    memoryConfidence: hit.memory.confidence,
    pipelineAction,
    pipelineExternalId: acceptedExternalId ?? undefined,
    agreement,
    providerSourcesConsulted,
    wouldAvoidProviders: true,
    wouldServe,
  };
}

/** Compact one-line log of a shadow/serve record — mirrors the ⏱ summary style
 *  so memory outcomes are greppable from the same server logs. */
export function formatMemoryLog(r: MemoryShadowRecord): string {
  if (r.outcome === "miss") {
    return `🧠 memory MISS | mode=${r.mode} pipeline=${r.pipelineAction} providerSources=${r.providerSourcesConsulted}`;
  }
  const cmp =
    r.mode === "serve"
      ? "served (no providers)"
      : `pipeline=${r.pipelineAction}${r.pipelineExternalId ? `:${r.pipelineExternalId}` : ""} ${r.agreement} wouldServe=${r.wouldServe ? "yes" : "no"}`;
  return (
    `🧠 memory HIT ${r.matchedBy} → ${r.memoryExternalId} (${r.memoryMethod} ${r.memoryConfidence}%) | ` +
    `${cmp} | providerSources=${r.providerSourcesConsulted} avoided=${r.wouldAvoidProviders ? "yes" : "no"}`
  );
}

/** Increment the served counter for a memory row (fire-and-forget telemetry). */
export function markMemoryServed(memoryId: string): void {
  prisma.recognitionMemory
    .update({ where: { id: memoryId }, data: { timesServed: { increment: 1 } } })
    .catch(() => {});
}
