// ─── Catalog sync core (Scanner V2 · M-CATALOG · M5) ─────────────────────────
// The enumerate → list → normalize → upsert machinery that populates
// catalog_cards, factored OUT of scripts/build-catalog.mjs so the exact same
// code path serves two callers with zero duplication:
//
//   • scripts/build-catalog.mjs  — the manual/one-shot importer (CLI driver).
//   • /api/cron/refresh-catalog  — the M5 freshness cron (price refresh + the
//     new-set sync, which re-imports newly released or updated sets through
//     THIS module, never a reimplementation).
//
// Everything here is a thin wrapper over machinery that already existed:
//   • transport   → fetchProviderJson (providers/http.ts): the classified 8s
//     timeout that turns a non-answer into a ProviderError, never a false zero.
//   • normalization → formatPokemonCard (services/pokemon.ts): the SAME formatter
//     the scan path consumes, so the catalog can never drift from what candidate
//     generation expects — it stores that function's own output column-for-column.
//
// Truth boundary (AGENTS.md): a card that can't be fetched or normalized is
// classified and skipped — never written half-formed, never fabricated. One bad
// card never aborts a set; one bad set never aborts the run. That discipline is
// what lets the cron run unattended.

import { fetchProviderJson } from "@/lib/providers/http";
import type { ProviderFetchBudget } from "@/lib/providers/http";
import { formatPokemonCard } from "@/lib/services/pokemon";

const API_CARDS = "https://api.pokemontcg.io/v2/cards";
const API_SETS = "https://api.pokemontcg.io/v2/sets";

// select carries everything formatPokemonCard() reads: rarity + set (ptcgoCode,
// id, name, printedTotal, updatedAt) + images + tcgplayer/cardmarket prices. This
// is the one line that makes a catalog row full instead of embed-only.
export const CARD_SELECT = "id,name,number,rarity,set,images,tcgplayer,cardmarket,types";
// Set enumeration carries updatedAt so the cron can detect a set that changed
// upstream since we last stored it (mirrors card_fingerprints.sourceUpdatedAt).
const SET_SELECT = "id,name,releaseDate,updatedAt";

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function pokemonHeaders(): Record<string, string> {
  const key = process.env.POKEMON_TCG_API_KEY;
  return key ? { "X-Api-Key": key } : {};
}

// ─── Retry ───────────────────────────────────────────────────────────────────
// There is deliberately NO retry wrapper here any more. One used to sit around
// every fetchProviderJson call (withRetry, tries:3, 1.5s backoff) — and once
// PR #2 gave fetchProviderJson its OWN 8-attempt/16s retry, the two layers
// MULTIPLIED: a single "list sets" call could consume ~52s, eating a whole
// serverless window before the caller checked its budget even once. That is the
// M5 budget bug. One retry layer, one clock.
//
// Callers express patience through ProviderFetchBudget instead, so the manual
// importer can be generous (many attempts, no deadline) and the cron can be
// strict (few attempts, run deadline) over the exact same code path.

export function errMsg(err: unknown): string {
  return (err as { message?: string })?.message ?? String(err);
}

/** Coarse failure bucket for the run report — kept truthful and finite. */
export function classifyFailure(msg: unknown): string {
  const s = String(msg);
  if (/8000ms|timeout|aborted|AbortError/i.test(s)) return "timeout";
  if (/SQL|prisma|column|constraint/i.test(s)) return "db upsert error";
  if (/format|undefined|cannot read/i.test(s)) return "normalize error";
  return `other: ${s.slice(0, 60)}`;
}

// ─── DB seam ──────────────────────────────────────────────────────────────────
// Only the three catalog_cards operations this module performs, declared
// structurally so the cron passes the real pooled `prisma`, build-catalog.mjs
// passes a raw PrismaClient, and tests inject a fake without a live DB (the DB is
// production — see the aura-database-topology memory; tests must never touch it).
export interface CatalogSyncDb {
  catalogCard: {
    upsert(args: unknown): Promise<unknown>;
    findMany(args: unknown): Promise<{ externalId: string }[]>;
    findFirst(args: unknown): Promise<{ sourceUpdatedAt: Date | null } | null>;
  };
}

// ─── Enumeration ───────────────────────────────────────────────────────────────
export interface CatalogSetMeta {
  id: string;
  releaseDate: string | null;
  /** set.updatedAt from the API — the change-detection key for the cron. */
  updatedAt: string | null;
}

/** All sets, oldest release first (stable import order). Throws on a non-answer
 *  so a flaky enumeration is retried/surfaced, never silently treated as "no
 *  sets exist" (which would look like the whole catalog vanished). */
export async function fetchAllSets(budget: ProviderFetchBudget = {}): Promise<CatalogSetMeta[]> {
  const url = `${API_SETS}?pageSize=250&select=${SET_SELECT}`;
  const json = await fetchProviderJson<{ data?: any[] }>(url, {
    headers: pokemonHeaders(),
    ...budget,
  });
  const sets = json?.data ?? [];
  sets.sort((a, b) => String(a.releaseDate ?? "").localeCompare(String(b.releaseDate ?? "")));
  return sets.map((s) => ({
    id: s.id,
    releaseDate: s.releaseDate ?? null,
    updatedAt: s.updatedAt ?? null,
  }));
}

/** Every card in a set, paginated. Throws if any page fails to list — the caller
 *  treats a set whose card list can't be fetched as a failed set and moves on. */
export async function fetchSetCards(
  setId: string,
  opts: { delayMs?: number; budget?: ProviderFetchBudget } = {},
): Promise<any[]> {
  const { delayMs = 300, budget = {} } = opts;
  const pageSize = 250;
  const out: any[] = [];
  for (let page = 1; ; page++) {
    const url =
      `${API_CARDS}?q=${encodeURIComponent(`set.id:${setId}`)}` +
      `&pageSize=${pageSize}&page=${page}&select=${CARD_SELECT}`;
    const json = await fetchProviderJson<{ data?: any[] }>(url, {
      headers: pokemonHeaders(),
      ...budget,
    });
    const batch = json?.data ?? [];
    out.push(...batch);
    if (batch.length < pageSize) break;
    if (delayMs) await sleep(delayMs);
  }
  return out;
}
// NOTE on the deadline here: pagination deliberately has NO "stop early and
// return what we have" branch. A truncated page walk that returned normally would
// let syncSet record a partially-listed set as fully synced — and because
// setNeedsSync compares the stored sourceUpdatedAt against upstream, that set
// would then look CURRENT forever while missing cards. Instead the next page's
// fetch throws ProviderDeadlineExceeded on its own deadline check, syncSet lets
// it propagate, and the caller records a failed/incomplete set that gets retried.
// A set is either listed in full or not claimed at all.

/**
 * set.releaseDate ("YYYY/MM/DD") → Date, for the recency ordering candidate
 * generation depends on (M7). Unparseable/absent returns null rather than a
 * guessed date: ordering places nulls last, so an unknown release date costs a
 * card its position in the newest-first cap — it never invents a recency the
 * source didn't state. Same truth boundary as sourceUpdatedAt above.
 */
export function parseSetReleaseDate(raw: unknown): Date | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const d = new Date(raw.replace(/\//g, "-"));
  return Number.isNaN(d.getTime()) ? null : d;
}

// catalog_cards.types is a single column, so CandidatePrinting.types (string[]
// | undefined) is flattened to one of three states, mirroring the mana-color
// convention in card-color.ts: undefined (source didn't carry the field, e.g. a
// pre-M-CATALOG row or a Trainer/Energy card) is stored as null; [] ("this card
// declares no type") is stored as ""; a real type list joins on ",". Read back
// by the exact inverse in pokemon-catalog.ts's formatCatalogCard.
export function encodeCatalogTypes(types: string[] | undefined): string | null {
  if (types === undefined) return null;
  return types.join(",");
}

// ─── Per-card upsert ───────────────────────────────────────────────────────────
// Stores formatPokemonCard()'s OWN output, so it cannot drift from what candidate
// generation expects. Prices are (re-)seeded here with priceUpdatedAt=now; the
// price-refresh phase of the cron owns them between full imports. Upsert on the
// unique externalId makes every re-run idempotent.
export async function upsertCatalogCard(db: CatalogSyncDb, card: any): Promise<void> {
  const p = formatPokemonCard(card); // → CandidatePrinting
  const set = card.set ?? {};
  const parsedUpdated = set.updatedAt ? new Date(set.updatedAt) : null;
  const sourceUpdatedAt =
    parsedUpdated && !Number.isNaN(parsedUpdated.getTime()) ? parsedUpdated : null;

  const data = {
    game: p.game,
    name: p.name,
    setName: p.setName,
    setCode: p.setCode ?? null,
    setPrintedSize: p.setPrintedSize ?? null,
    setReleaseDate: parseSetReleaseDate(set.releaseDate),
    collectorNumber: p.collectorNumber ?? null,
    rarity: p.rarity,
    imageUrl: p.imageUrl ?? null,
    thumbnailUrl: p.thumbnailUrl ?? null,
    types: encodeCatalogTypes(p.types),
    marketPrice: p.price?.marketPrice ?? null,
    lowPrice: p.price?.lowPrice ?? null,
    midPrice: p.price?.midPrice ?? null,
    highPrice: p.price?.highPrice ?? null,
    priceUpdatedAt: new Date(),
    sourceUpdatedAt,
  };

  await db.catalogCard.upsert({
    where: { externalId: p.externalId },
    create: { externalId: p.externalId, ...data },
    update: data,
  });
}

/** externalIds already in the catalog for this set (externalId = `${set.id}-…`),
 *  used to skip already-imported cards on a resumed run. */
export async function existingIdsForSet(db: CatalogSyncDb, setId: string): Promise<Set<string>> {
  const rows = await db.catalogCard.findMany({
    where: { externalId: { startsWith: `${setId}-` } },
    select: { externalId: true },
  });
  return new Set(rows.map((r) => r.externalId));
}

/** Whether the catalog already holds this set, and the newest sourceUpdatedAt it
 *  stored — the two facts the cron's new-set/changed-set detection needs. */
export async function findSetSyncState(
  db: CatalogSyncDb,
  setId: string,
): Promise<{ exists: boolean; newestSourceUpdatedAt: Date | null }> {
  const row = await db.catalogCard.findFirst({
    where: { externalId: { startsWith: `${setId}-` } },
    select: { sourceUpdatedAt: true },
    orderBy: { sourceUpdatedAt: "desc" },
  });
  return { exists: row !== null, newestSourceUpdatedAt: row?.sourceUpdatedAt ?? null };
}

/** True when a set is missing from the catalog, or the API reports it changed
 *  (updatedAt) after what we last stored. A set whose upstream updatedAt we can't
 *  read (null) is only synced if it's missing — an unreadable timestamp is not
 *  evidence of a change, so we don't churn the whole catalog over it. */
export function setNeedsSync(
  meta: CatalogSetMeta,
  state: { exists: boolean; newestSourceUpdatedAt: Date | null },
): boolean {
  if (!state.exists) return true;
  if (!meta.updatedAt) return false;
  const upstream = new Date(meta.updatedAt);
  if (Number.isNaN(upstream.getTime())) return false;
  if (!state.newestSourceUpdatedAt) return true;
  return upstream.getTime() > state.newestSourceUpdatedAt.getTime();
}

// ─── One set, end to end ────────────────────────────────────────────────────────
export interface SetSyncFailure {
  id: string;
  reason: string;
  detail: string;
}
export interface SetSyncResult {
  setId: string;
  /** True when the run's clock stopped the import part-way. The set was NOT fully
   *  imported and must not be treated as current — a resumed run finishes it. */
  incomplete?: boolean;
  listed: number;
  upserted: number;
  skipped: number;
  failed: number;
  failures: SetSyncFailure[];
}

/**
 * List a set and upsert every card, isolating per-card failures. Throws only if
 * the set can't be LISTED at all (caller records it as a failed set); once listing
 * succeeds, a single bad card is classified, pushed to `failures`, and skipped —
 * it never aborts the set.
 *
 * `resume` skips cards whose externalId is already stored (a resumed full import);
 * the cron's changed-set path passes resume=false so existing rows are re-upserted
 * (refreshing static fields + re-seeding prices from the newer upstream data).
 */
export async function syncSet(
  db: CatalogSyncDb,
  setId: string,
  opts: { resume?: boolean; delayMs?: number; budget?: ProviderFetchBudget } = {},
): Promise<SetSyncResult> {
  const { resume = false, delayMs = 300, budget = {} } = opts;
  const deadline = budget.deadline;
  const cards = await fetchSetCards(setId, { delayMs, budget }); // throws → failed set
  const result: SetSyncResult = { setId, listed: cards.length, upserted: 0, skipped: 0, failed: 0, failures: [] };
  const skip = resume ? await existingIdsForSet(db, setId) : new Set<string>();

  for (const [i, card] of cards.entries()) {
    // A set can hold ~250 cards and the delay between upserts alone can exceed a
    // whole serverless window, so the import must be able to stop mid-set. It is
    // safe to do so ONLY because the result says it did: `incomplete` keeps the
    // caller from marking the set synced, and a resumed run skips what landed.
    if (deadline !== undefined && Date.now() >= deadline) {
      result.incomplete = true;
      break;
    }
    if (skip.has(card.id)) {
      result.skipped++;
      continue;
    }
    try {
      await upsertCatalogCard(db, card);
      result.upserted++;
    } catch (err) {
      const detail = errMsg(err);
      result.failed++;
      result.failures.push({ id: card.id, reason: classifyFailure(detail), detail });
    }
    if (delayMs && i < cards.length - 1) await sleep(delayMs);
  }
  return result;
}
