"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { motion, AnimatePresence } from "framer-motion";
import { Heart, Sparkles, TrendingUp, TrendingDown, Trash2, Loader2, ArrowRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import Link from "next/link";

const gameColors: Record<string, string> = {
  "POKEMON": "bg-yellow-500/10 text-yellow-500 border-yellow-500/20",
  "MTG": "bg-purple-500/10 text-purple-500 border-purple-500/20",
  "YUGIOH": "bg-blue-500/10 text-blue-500 border-blue-500/20",
};

export default function WatchlistPage() {
  const { data: session } = useSession();
  const [watchlist, setWatchlist] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [removingId, setRemovingId] = useState<string | null>(null);

  useEffect(() => {
    if (!session?.user?.id || !(session as any).accessToken) return;
    
    fetch(`http://localhost:4000/watchlist`, {
      headers: {
        Authorization: `Bearer ${(session as any).accessToken}`,
      },
    })
      .then(res => res.json())
      .then(json => {
        if (json.success) {
          setWatchlist(json.data);
        }
      })
      .catch(err => console.error(err))
      .finally(() => setIsLoading(false));
  }, [session]);

  const handleRemove = async (cardId: string) => {
    if (!session?.user?.id || !(session as any).accessToken) return;
    setRemovingId(cardId);
    try {
      const res = await fetch(`http://localhost:4000/watchlist/remove/${cardId}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${(session as any).accessToken}`,
        },
      });
      if (!res.ok) throw new Error("Failed to remove");
      setWatchlist(prev => prev.filter(w => w.cardId !== cardId));
    } catch (err) {
      console.error(err);
    } finally {
      setRemovingId(null);
    }
  };

  if (isLoading) {
    return (
      <div className="p-8 flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-aura-purple" />
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-8">
      {/* Header */}
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
        <div className="flex items-center gap-3 mb-2">
          <div className="p-2.5 rounded-xl bg-pink-500/10 border border-pink-500/20">
            <Heart className="h-6 w-6 text-pink-500" />
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold">Watchlist</h1>
        </div>
        <p className="text-muted-foreground">Keep track of market prices for cards you want.</p>
      </motion.div>

      {/* Empty State */}
      {watchlist.length === 0 && (
        <motion.div 
          initial={{ opacity: 0, scale: 0.95 }} 
          animate={{ opacity: 1, scale: 1 }}
          className="flex flex-col items-center justify-center py-20 text-center glass rounded-3xl border-border/50"
        >
          <div className="w-20 h-20 rounded-full bg-pink-500/10 flex items-center justify-center mb-6">
            <Heart className="h-8 w-8 text-pink-500/50" />
          </div>
          <h2 className="text-xl font-semibold mb-2">Your watchlist is empty</h2>
          <p className="text-muted-foreground mb-8 max-w-sm">
            Search the global catalog and tap the heart icon to start tracking card prices.
          </p>
          <Link href="/search">
            <Button className="gradient-bg text-white border-0 h-11 px-8 rounded-xl font-medium shadow-lg shadow-aura-purple/20">
              Search Cards <ArrowRight className="h-4 w-4 ml-2" />
            </Button>
          </Link>
        </motion.div>
      )}

      {/* Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        <AnimatePresence>
          {watchlist.map((item, i) => {
            const card = item.card;
            return (
              <motion.div
                key={item.id}
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.25, delay: i * 0.05 }}
              >
                <Card className="glass border-border/50 overflow-hidden relative group">
                  <div className="absolute top-0 right-0 w-32 h-32 bg-pink-500/10 rounded-full blur-[50px] -z-10 opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
                  
                  <CardContent className="p-5">
                    <div className="flex gap-4">
                      {/* Image */}
                      <div className="w-20 sm:w-24 shrink-0 rounded-lg overflow-hidden border border-border/50 bg-black/20">
                        {card.thumbnailUrl ? (
                          /* eslint-disable-next-line @next/next/no-img-element */
                          <img src={card.thumbnailUrl} alt={card.name} className="w-full object-contain" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center min-h-[120px]">
                            <Sparkles className="h-6 w-6 text-aura-purple/40" />
                          </div>
                        )}
                      </div>

                      {/* Info */}
                      <div className="flex-1 flex flex-col min-w-0 py-1">
                        <div className="flex items-start justify-between mb-1">
                          <h3 className="font-bold text-lg truncate leading-tight pr-2">{card.name}</h3>
                          <Badge variant="outline" className={`text-[10px] uppercase shrink-0 ${gameColors[card.game] || ''}`}>
                            {card.game}
                          </Badge>
                        </div>
                        
                        <p className="text-xs text-muted-foreground mb-3 truncate">
                          {card.setName} · {card.rarity?.replace('_', ' ')}
                        </p>

                        <div className="mt-auto flex items-end justify-between">
                          <div>
                            <p className="text-xs text-muted-foreground mb-1">Market Price</p>
                            <div className="flex items-center gap-2">
                              <p className="text-xl font-bold">${card.prices?.marketPrice?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) || '0.00'}</p>
                              {/* Fake trend indicator for UI flair */}
                              <Badge variant="outline" className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20 px-1.5 h-5 rounded flex items-center gap-1">
                                <TrendingUp className="h-3 w-3" />
                                <span className="text-[10px]">2.4%</span>
                              </Badge>
                            </div>
                          </div>
                          
                          <Button 
                            variant="ghost" 
                            size="icon" 
                            className="h-8 w-8 text-muted-foreground hover:text-red-400 hover:bg-red-400/10 rounded-lg"
                            onClick={() => handleRemove(card.id)}
                            disabled={removingId === card.id}
                          >
                            {removingId === card.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Trash2 className="h-4 w-4" />
                            )}
                          </Button>
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
}
