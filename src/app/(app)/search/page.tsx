"use client";

import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { useSession } from "next-auth/react";
import { Search as SearchIcon, Sparkles, SlidersHorizontal, Loader2, Heart, Check } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useDebounce } from "@/hooks/use-debounce";

const gameColors: Record<string, string> = {
  "Pokémon": "bg-yellow-500/10 text-yellow-500",
  "MTG": "bg-purple-500/10 text-purple-500",
  "Yu-Gi-Oh!": "bg-blue-500/10 text-blue-500",
};

export default function SearchPage() {
  const { data: session } = useSession();
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebounce(query, 300);
  
  const [gameFilter, setGameFilter] = useState<string | null>(null);
  
  const [cards, setCards] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [addingToWatchlist, setAddingToWatchlist] = useState<string | null>(null);
  const [addedToWatchlist, setAddedToWatchlist] = useState<Set<string>>(new Set());

  const handleAddToWatchlist = async (e: React.MouseEvent, cardId: string) => {
    e.stopPropagation();
    if (!session?.user?.id || !(session as any).accessToken) return;
    
    setAddingToWatchlist(cardId);
    try {
      const res = await fetch(`http://localhost:4000/watchlist/add`, {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          Authorization: `Bearer ${(session as any).accessToken}`,
        },
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
    setIsLoading(true);
    
    // Build query params
    const params = new URLSearchParams();
    if (debouncedQuery) params.append("q", debouncedQuery);
    // Convert friendly game name to enum string for API
    if (gameFilter) {
      if (gameFilter === "Pokémon") params.append("game", "POKEMON");
      else if (gameFilter === "Yu-Gi-Oh!") params.append("game", "YUGIOH");
      else params.append("game", gameFilter);
    }

    fetch(`http://localhost:4000/cards?${params.toString()}`)
      .then((res) => res.json())
      .then((json) => {
        if (json.success) {
          setCards(json.data);
        }
      })
      .catch((err) => console.error("Search failed:", err))
      .finally(() => setIsLoading(false));
  }, [debouncedQuery, gameFilter]);

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6">
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
        <h1 className="text-2xl sm:text-3xl font-bold">Search Cards</h1>
        <p className="text-muted-foreground mt-1">Search across the global catalog.</p>
      </motion.div>

      {/* Search input */}
      <motion.div initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.1 }}>
        <div className="relative">
          <SearchIcon className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
          <Input
            placeholder="Search by card name or set..."
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

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <Button variant="outline" size="sm" className="rounded-lg text-xs" onClick={() => setGameFilter(null)}>
          <SlidersHorizontal className="h-3.5 w-3.5 mr-1.5" />
          All Games
        </Button>
        {["Pokémon", "MTG", "Yu-Gi-Oh!"].map((g) => (
          <Button
            key={g}
            variant={gameFilter === g ? "default" : "outline"}
            size="sm"
            className={`rounded-lg text-xs ${gameFilter === g ? "gradient-bg text-white border-0" : ""}`}
            onClick={() => setGameFilter(gameFilter === g ? null : g)}
          >
            {g}
          </Button>
        ))}
      </div>

      {/* Results */}
      <div className="space-y-2">
        {!isLoading && cards.length === 0 && (
          <div className="py-16 text-center text-muted-foreground">
            <SearchIcon className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm">No cards found for &quot;{query}&quot;</p>
          </div>
        )}
        
        {cards.map((card, i) => (
          <motion.div
            key={card.id}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, delay: i * 0.03 }}
          >
            <Card className="glass border-border/50 card-hover cursor-pointer overflow-hidden">
              <CardContent className="p-4 flex items-center gap-4">
                <div className="h-16 w-12 rounded-lg bg-aura-purple/10 flex items-center justify-center shrink-0 overflow-hidden relative">
                  {card.thumbnailUrl ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img src={card.thumbnailUrl} alt={card.name} className="w-full h-full object-cover" />
                  ) : (
                    <Sparkles className="h-5 w-5 text-aura-purple/40" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold truncate text-base">{card.name}</p>
                  <p className="text-sm text-muted-foreground">{card.setName} · {card.rarity?.replace('_', ' ')}</p>
                </div>
                <Badge variant="secondary" className={`text-xs shrink-0 hidden sm:inline-flex ${gameColors[card.game] || 'bg-accent'}`}>
                  {card.game}
                </Badge>
                <div className="text-right shrink-0 flex flex-col items-end gap-2">
                  <div>
                    <p className="text-lg font-bold leading-none">${card.prices?.marketPrice?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) || '0.00'}</p>
                    <p className="text-xs text-muted-foreground mt-1">Market</p>
                  </div>
                  <Button 
                    variant="outline" 
                    size="icon" 
                    className={`h-8 w-8 rounded-full ${addedToWatchlist.has(card.id || card.externalId) ? 'bg-pink-500/10 border-pink-500/50 text-pink-500' : 'hover:text-pink-500 hover:border-pink-500/50 hover:bg-pink-500/10'}`}
                    onClick={(e) => handleAddToWatchlist(e, card.id || card.externalId)}
                    disabled={addingToWatchlist === (card.id || card.externalId) || addedToWatchlist.has(card.id || card.externalId)}
                  >
                    {addingToWatchlist === (card.id || card.externalId) ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : addedToWatchlist.has(card.id || card.externalId) ? (
                      <Check className="h-4 w-4" />
                    ) : (
                      <Heart className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
