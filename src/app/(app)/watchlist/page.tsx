"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { motion, AnimatePresence } from "framer-motion";
import { Heart, Sparkles, TrendingUp, TrendingDown, Trash2, Loader2, ArrowRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import Link from "next/link";
import { Bell, BellOff, Save } from "lucide-react";

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
    
    fetch(`/api/watchlist`)
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
      const res = await fetch(`/api/watchlist`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ cardId }),
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
          {watchlist.map((item, i) => (
            <WatchlistItemCard 
              key={item.id} 
              item={item} 
              index={i} 
              onRemove={handleRemove} 
              removingId={removingId} 
            />
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

// Subcomponent to manage local state for alerts
function WatchlistItemCard({ item, index, onRemove, removingId }: { item: any, index: number, onRemove: (id: string) => void, removingId: string | null }) {
  const card = item.card;
  const [alertAbove, setAlertAbove] = useState(item.alertAbove || "");
  const [alertBelow, setAlertBelow] = useState(item.alertBelow || "");
  const [alertEnabled, setAlertEnabled] = useState(item.alertEnabled !== false);
  const [isSaving, setIsSaving] = useState(false);
  const [isSaved, setIsSaved] = useState(false);

  const handleSaveAlerts = async () => {
    setIsSaving(true);
    setIsSaved(false);
    try {
      const res = await fetch(`/api/watchlist`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cardId: card.id,
          alertAbove: alertAbove ? parseFloat(alertAbove) : null,
          alertBelow: alertBelow ? parseFloat(alertBelow) : null,
          alertEnabled,
        }),
      });
      if (res.ok) {
        setIsSaved(true);
        setTimeout(() => setIsSaved(false), 2000);
      }
    } catch (err) {
      console.error("Failed to save alerts", err);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.25, delay: index * 0.05 }}
    >
      <Card className={`glass border-border/50 overflow-hidden relative group transition-all duration-300 ${alertEnabled ? 'shadow-[0_0_15px_rgba(236,72,153,0.1)]' : ''}`}>
        <div className="absolute top-0 right-0 w-32 h-32 bg-pink-500/10 rounded-full blur-[50px] -z-10 opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
        
        <CardContent className="p-5">
          <div className="flex gap-4 mb-4">
            {/* Image */}
            <div className="w-24 sm:w-28 shrink-0 rounded-lg overflow-hidden border border-border/50 bg-black/20 shadow-md">
              {(card.imageUrl || card.thumbnailUrl) ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={card.imageUrl || card.thumbnailUrl} alt={card.name} className="w-full h-auto object-cover" />
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
                    <p className="text-xl font-bold">${(card.prices?.marketPrice || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                  </div>
                </div>
                
                <Button 
                  variant="ghost" 
                  size="icon" 
                  className="h-8 w-8 text-muted-foreground hover:text-red-400 hover:bg-red-400/10 rounded-lg"
                  onClick={() => onRemove(card.id)}
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

          {/* Price Alerts Section */}
          <div className="pt-4 border-t border-border/50">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Button 
                  variant="ghost" 
                  size="icon" 
                  onClick={() => setAlertEnabled(!alertEnabled)}
                  className={`h-8 w-8 rounded-full ${alertEnabled ? 'bg-pink-500/10 text-pink-500' : 'bg-muted text-muted-foreground'}`}
                >
                  {alertEnabled ? <Bell className="h-4 w-4" /> : <BellOff className="h-4 w-4" />}
                </Button>
                <span className="text-sm font-medium">Price Alerts</span>
              </div>
              
              <Button 
                variant="outline" 
                size="sm" 
                className={`h-8 rounded-lg text-xs transition-all ${isSaved ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20' : ''}`}
                onClick={handleSaveAlerts}
                disabled={isSaving}
              >
                {isSaving ? <Loader2 className="h-3 w-3 mr-1.5 animate-spin" /> : <Save className="h-3 w-3 mr-1.5" />}
                {isSaved ? 'Saved!' : 'Save'}
              </Button>
            </div>
            
            <div className={`grid grid-cols-2 gap-3 transition-opacity duration-300 ${alertEnabled ? 'opacity-100' : 'opacity-40 pointer-events-none'}`}>
              <div>
                <label className="text-[10px] uppercase font-bold text-emerald-500 mb-1 block">Alert Above ($)</label>
                <Input 
                  type="number" 
                  placeholder="0.00" 
                  className="h-9 bg-background/50 border-border/50 text-sm"
                  value={alertAbove}
                  onChange={(e) => setAlertAbove(e.target.value)}
                />
              </div>
              <div>
                <label className="text-[10px] uppercase font-bold text-red-500 mb-1 block">Alert Below ($)</label>
                <Input 
                  type="number" 
                  placeholder="0.00" 
                  className="h-9 bg-background/50 border-border/50 text-sm"
                  value={alertBelow}
                  onChange={(e) => setAlertBelow(e.target.value)}
                />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
