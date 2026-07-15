// ─── Card identity & game normalization (Phase 5.12A) ────────────────────────
// One source of truth for two questions the codebase kept answering ad hoc:
//
//   1. "Are these two results the same card?"  → cardIdentity()
//   2. "What game is this, really?"            → normalizeGame()
//
// Both had silently wrong answers before this module existed (see below).

import { foldName, type GameId } from "@/lib/scanner/evidence";
import type { CardSearchResult } from "@/lib/search/types";

// ─── Game normalization ─────────────────────────────────────────────────────
// Game arrives spelled a dozen ways: the Prisma column holds "POKEMON", the
// vision model emits "Pokemon", the UI filter used "Pokémon", and Scryfall says
// "MTG". The old search page keyed its badge colors on the DISPLAY spelling
// while the data carried the ENUM spelling, so no badge ever matched.

const GAME_ALIASES: Record<string, GameId> = {
  mtg: "MTG", magic: "MTG", "magic the gathering": "MTG", scryfall: "MTG",
  pokemon: "POKEMON", pkmn: "POKEMON", ptcg: "POKEMON",
  yugioh: "YUGIOH", ygo: "YUGIOH", "yu gi oh": "YUGIOH", ygoprodeck: "YUGIOH",
};

/**
 * Collapse any spelling of a game onto its canonical id, or null when the input
 * names no game we support. Accent- and punctuation-insensitive, so "Pokémon",
 * "POKEMON" and "pokemon" all land on "POKEMON", and "Yu-Gi-Oh!" on "YUGIOH".
 *
 * Returns null rather than guessing — an unrecognized game must not silently
 * become MTG.
 */
export function normalizeGame(raw: string | null | undefined): GameId | null {
  if (!raw) return null;
  const key = raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return GAME_ALIASES[key] ?? null;
}

/** How a game is written for collectors. The UI must not spell these itself. */
export const GAME_LABELS: Record<GameId, string> = {
  MTG: "Magic: The Gathering",
  POKEMON: "Pokémon",
  YUGIOH: "Yu-Gi-Oh!",
};

/** Short form for badges and chips. */
export const GAME_SHORT_LABELS: Record<GameId, string> = {
  MTG: "MTG",
  POKEMON: "Pokémon",
  YUGIOH: "Yu-Gi-Oh!",
};

// ─── Card identity ──────────────────────────────────────────────────────────

/**
 * A stable key for "is this the same card?", used to merge the same printing
 * arriving from two sources (our catalog and the upstream API).
 *
 * The bug this replaces: dedup compared `a.externalId === b.externalId`
 * directly. `Card.externalId` is nullable and PostgreSQL permits unlimited
 * NULLs under a UNIQUE constraint, so every locally-created card without an
 * upstream link compared EQUAL to every other one — and an entire result set
 * collapsed into a single row. Identity must never be null-valued.
 *
 * Preference order:
 *   1. The source's own id, namespaced by game. Two sources naming the same
 *      externalId for different games must not collide.
 *   2. A composite natural key, for rows that were never linked upstream.
 *      Name/set/collector-number are folded so trivial spelling differences
 *      ("Blue-Eyes" vs "Blue Eyes") do not create phantom duplicates.
 */
export function cardIdentity(card: CardSearchResult): string {
  const { externalId } = card.metadata;
  if (externalId) return `${card.game}:ext:${externalId}`;

  const fold = (s: string | null | undefined) => foldName(s ?? "");

  return [
    card.game,
    "nat",
    fold(card.name),
    fold(card.set.code) || fold(card.set.name),
    fold(card.collectorNumber),
  ].join(":");
}

/**
 * Merge results from several sources, keeping the FIRST occurrence of each
 * identity. Callers order sources by trust (local catalog first), so a local
 * row — which carries our own price history and id — wins over the upstream
 * copy of the same printing.
 */
export function dedupeByIdentity(cards: CardSearchResult[]): CardSearchResult[] {
  const seen = new Set<string>();
  const out: CardSearchResult[] = [];
  for (const card of cards) {
    const key = cardIdentity(card);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(card);
  }
  return out;
}
