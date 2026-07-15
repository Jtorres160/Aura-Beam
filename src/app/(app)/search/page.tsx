"use client";

// ─── Card search (Phase 5.12A) ──────────────────────────────────────────────
// This page renders a SearchOutcome, not a list. The distinction matters: it is
// no longer possible for this screen to say "No cards found" because a card
// database timed out. That claim now requires every source to have answered.

import { useState, useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { useSession } from "next-auth/react";
import { Search as SearchIcon, Sparkles, SlidersHorizontal, Loader2, Heart, Check, AlertTriangle } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { useDebounce } from "@/hooks/use-debounce";
import type { GameId } from "@/lib/scanner/evidence";
import { GAME_SHORT_LABELS } from "@/lib/search/identity";
import type { CardSearchResult, SearchOutcome, SearchSourceStatus } from "@/lib/search/types";

const gameColors: Record<GameId, string> = {
  POKEMON: "bg-yellow-500/10 text-yellow-500",
  MTG: "bg-purple-500/10 text-purple-500",
  YUGIOH: "bg-blue-500/10 text-blue-500",
};

const GAME_FILTERS: GameId[] = ["POKEMON", "MTG", "YUGIOH"];

/** Why a source could not answer, in words a collector can act on. */
const REASON_TEXT: Record<string, string> = {
  timeout: "timed out",
  rate_limited: "rate limit reached",
  http_error: "returned an error",
  network: "unreachable",
  not_configured: "not configured",
  unexpected: "unavailable",
};

/** Per-source availability. Aura explains uncertainty rather than hiding it. */
function SourceList({ sources }: { sources: SearchSourceStatus[] }) {
  const consulted = sources.filter((s) => s.availability !== "unavailable");
  if (consulted.length === 0) return null;

  return (
    <ul className="mt-4 space-y-1.5 text-left inline-block">
      {consulted.map((s) => {
        const failed = s.availability === "failed";
        return (
          <li key={s.source} className="flex items-center gap-2 text-xs">
            <span className={failed ? "text-amber-500" : "text-emerald-500"} aria-hidden>
              {failed ? "✕" : "✓"}
            </span>
            <span className={failed ? "text-amber-500" : "text-muted-foreground"}>
              {s.label}
              {failed && s.reason ? ` — ${REASON_TEXT[s.reason] ?? "unavailable"}` : ""}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export default function SearchPage() {
  const { data: session } = useSession();
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebounce(query, 300);

  const [gameFilter, setGameFilter] = useState<GameId | null>(null);
  const [outcome, setOutcome] = useState<SearchOutcome | null>(null);
  const [requestFailed, setRequestFailed] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [addingToWatchlist, setAddingToWatchlist] = useState<string | null>(null);
  const [addedToWatchlist, setAddedToWatchlist] = useState<Set<string>>(new Set());

  // Guards against out-of-order responses: a slow request for an earlier query
  // must never overwrite the results of a later one.
  const requestSeq = useRef(0);

  const handleAddToWatchlist = async (e: React.MouseEvent, cardId: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (!session?.user?.id) return;

    setAddingToWatchlist(cardId);
    try {
      const res = await fetch(`/api/watchlist/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardId }),
      });
      if (!res.ok) throw new Error("Failed to add to watchlist");
      setAddedToWatchlist((prev) => new Set(prev).add(cardId));
    } catch (error) {
      console.error(error);
    } finally {
      setAddingToWatchlist(null);
    }
  };

  useEffect(() => {
    if (!debouncedQuery.trim()) {
      setOutcome(null);
      setRequestFailed(false);
      setIsLoading(false);
      return;
    }

    const seq = ++requestSeq.current;
    setIsLoading(true);
    setRequestFailed(false);

    const params = new URLSearchParams({ q: debouncedQuery });
    if (gameFilter) params.append("game", gameFilter);

    fetch(`/api/cards?${params.toString()}`)
      .then((res) => res.json())
      .then((json) => {
        if (seq !== requestSeq.current) return; // superseded by a newer query
        if (json.success) setOutcome(json as SearchOutcome);
        else setRequestFailed(true);
      })
      .catch(() => {
        if (seq !== requestSeq.current) return;
        setRequestFailed(true);
      })
      .finally(() => {
        if (seq === requestSeq.current) setIsLoading(false);
      });
  }, [debouncedQuery, gameFilter]);

  const cards: CardSearchResult[] = outcome?.cards ?? [];
  const degraded =
    outcome?.status === "results" && outcome.sources.some((s) => s.availability === "failed");

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6">
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
        <h1 className="text-2xl sm:text-3xl font-bold">Search Cards</h1>
        <p className="text-muted-foreground mt-1">Search across the global catalog.</p>
      </motion.div>

      <motion.div initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.1 }}>
        <div className="relative">
          <SearchIcon className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
          <Input
            placeholder="Card name, or name and number — “Charizard 006/165”"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-12 pr-12 h-12 rounded-xl text-base glass border-border/50"
            autoFocus
          />
          {isLoading && (
            <Loader2 className="absolute right-4 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground animate-spin" />
          )}
        </div>
      </motion.div>

      <div className="flex items-center gap-2 flex-wrap">
        <Button variant="outline" size="sm" className="rounded-lg text-xs" onClick={() => setGameFilter(null)}>
          <SlidersHorizontal className="h-3.5 w-3.5 mr-1.5" />
          All Games
        </Button>
        {GAME_FILTERS.map((g) => (
          <Button
            key={g}
            variant={gameFilter === g ? "default" : "outline"}
            size="sm"
            className={`rounded-lg text-xs ${gameFilter === g ? "gradient-bg text-white border-0" : ""}`}
            onClick={() => setGameFilter(gameFilter === g ? null : g)}
          >
            {GAME_SHORT_LABELS[g]}
          </Button>
        ))}
      </div>

      <div className="space-y-2">
        {/* The request itself failed — we know nothing about the catalog. */}
        {!isLoading && requestFailed && (
          <div className="py-16 text-center">
            <AlertTriangle className="h-10 w-10 mx-auto mb-3 text-amber-500/60" />
            <p className="text-sm font-medium">Search is temporarily unavailable</p>
            <p className="text-xs text-muted-foreground mt-1">
              This is a problem on our side, not a result about your card. Try again shortly.
            </p>
          </div>
        )}

        {/* Every source we asked failed. We do NOT know whether this card exists. */}
        {!isLoading && outcome?.status === "provider_unavailable" && (
          <div className="py-16 text-center">
            <AlertTriangle className="h-10 w-10 mx-auto mb-3 text-amber-500/60" />
            <p className="text-sm font-medium">
              {outcome.unavailable.length === 1
                ? `${outcome.unavailable[0]} is temporarily unavailable`
                : "Some card databases are temporarily unavailable"}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              We couldn’t complete this search, so we can’t say whether this card exists.
            </p>
            <SourceList sources={outcome.sources} />
            <p className="text-xs text-muted-foreground mt-4">Try again, or search another source.</p>
          </div>
        )}

        {/* Every source answered, and none of them had it. A real negative. */}
        {!isLoading && outcome?.status === "no_matches" && (
          <div className="py-16 text-center">
            <SearchIcon className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm">No cards matched “{debouncedQuery}”</p>
            <p className="text-xs text-muted-foreground mt-1">
              Every source answered — this card isn’t in them.
            </p>
            <SourceList sources={outcome.sources} />
          </div>
        )}

        {/* Results, but a source never answered: say so rather than imply the
            list is complete. */}
        {!isLoading && degraded && outcome?.status === "results" && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs text-amber-600 dark:text-amber-500 flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-px" />
            <span>
              These results may be incomplete —{" "}
              {outcome.sources
                .filter((s) => s.availability === "failed")
                .map((s) => s.label)
                .join(", ")}{" "}
              didn’t respond.
            </span>
          </div>
        )}

        {cards.map((card, i) => (
          <motion.div
            key={card.id}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, delay: Math.min(i, 8) * 0.03 }}
          >
            <Link href={`/cards/${encodeURIComponent(card.id)}`}>
              <Card className="glass border-border/50 card-hover cursor-pointer overflow-hidden transition-all hover:-translate-y-1">
                <CardContent className="p-4 flex items-center gap-4">
                  <div className="h-20 w-16 sm:h-24 sm:w-16 rounded-lg bg-aura-purple/10 flex items-center justify-center shrink-0 overflow-hidden relative shadow-md">
                    {card.artwork.thumbnailUrl || card.artwork.imageUrl ? (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img
                        src={(card.artwork.thumbnailUrl || card.artwork.imageUrl) as string}
                        alt={card.name}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <Sparkles className="h-5 w-5 text-aura-purple/40" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold truncate text-base sm:text-lg">{card.name}</p>
                    <p className="text-sm text-muted-foreground truncate">
                      {card.set.name}
                      {card.collectorNumber ? ` · #${card.collectorNumber}` : ""} · {card.rarity}
                    </p>
                  </div>
                  <Badge variant="secondary" className={`text-xs shrink-0 hidden sm:inline-flex ${gameColors[card.game]}`}>
                    {GAME_SHORT_LABELS[card.game]}
                  </Badge>
                  <div className="text-right shrink-0 flex flex-col items-end gap-2">
                    <div>
                      {/* A card with no quoted price is not a card worth $0.00. */}
                      {card.metadata.marketPrice !== null ? (
                        <>
                          <p className="text-lg font-bold leading-none">
                            ${card.metadata.marketPrice.toLocaleString(undefined, {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })}
                          </p>
                          <p className="text-xs text-muted-foreground mt-1">Market</p>
                        </>
                      ) : (
                        <>
                          <p className="text-sm font-medium leading-none text-muted-foreground">—</p>
                          <p className="text-xs text-muted-foreground mt-1">No price</p>
                        </>
                      )}
                    </div>
                    <Button
                      variant="outline"
                      size="icon"
                      className={`h-8 w-8 rounded-full ${
                        addedToWatchlist.has(card.id)
                          ? "bg-pink-500/10 border-pink-500/50 text-pink-500"
                          : "hover:text-pink-500 hover:border-pink-500/50 hover:bg-pink-500/10"
                      }`}
                      onClick={(e) => handleAddToWatchlist(e, card.id)}
                      disabled={addingToWatchlist === card.id || addedToWatchlist.has(card.id)}
                    >
                      {addingToWatchlist === card.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : addedToWatchlist.has(card.id) ? (
                        <Check className="h-4 w-4" />
                      ) : (
                        <Heart className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </Link>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
