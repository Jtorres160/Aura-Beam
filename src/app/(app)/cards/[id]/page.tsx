"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { ArrowLeft, Sparkles, Heart, Check, Loader2, Library, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { useSession } from "next-auth/react";

const gameColors: Record<string, string> = {
  "POKEMON": "bg-yellow-500/10 text-yellow-500 border-yellow-500/20",
  "MTG": "bg-purple-500/10 text-purple-500 border-purple-500/20",
  "YUGIOH": "bg-blue-500/10 text-blue-500 border-blue-500/20",
};

export default function CardDetailsPage() {
  const params = useParams();
  const router = useRouter();
  const { data: session } = useSession();
  
  const [card, setCard] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [addingToWatchlist, setAddingToWatchlist] = useState(false);
  const [inWatchlist, setInWatchlist] = useState(false);
  const [addingToCollection, setAddingToCollection] = useState(false);
  const [inCollection, setInCollection] = useState(false);

  useEffect(() => {
    if (!params.id) return;

    // Fetch Card Details
    fetch(`/api/cards/${params.id}`)
      .then(res => res.json())
      .then(json => {
        if (json.success && json.data) {
          setCard(json.data);
        }
      })
      .catch(err => console.error("Failed to fetch card details", err))
      .finally(() => setIsLoading(false));

    // If logged in, fetch status
    if (session?.user?.id) {
      // Check Watchlist
      fetch(`/api/watchlist`)
        .then(res => res.json())
        .then(json => {
          if (json.success && json.data) {
            setInWatchlist(json.data.some((w: any) => w.cardId === params.id || w.card?.externalId === params.id));
          }
        });

      // Check Collection
      fetch(`/api/collections`)
        .then(res => res.json())
        .then(json => {
          if (json.success && json.data) {
            setInCollection(json.data.cards.some((c: any) => c.cardId === params.id || c.card?.externalId === params.id));
          }
        });
    }
  }, [params.id, session]);

  const handleAddToWatchlist = async () => {
    if (!session?.user?.id || !card) return;
    setAddingToWatchlist(true);
    try {
      const res = await fetch(`/api/watchlist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          externalId: card.externalId || card.id,
          name: card.name,
          setName: card.setName,
          game: card.game,
          rarity: card.rarity,
          imageUrl: card.imageUrl,
          thumbnailUrl: card.thumbnailUrl,
          price: card.prices?.marketPrice || 0
        }),
      });
      if (res.ok) setInWatchlist(true);
    } catch (err) {
      console.error(err);
    } finally {
      setAddingToWatchlist(false);
    }
  };

  const handleAddToCollection = async () => {
    if (!session?.user?.id || !card) return;
    setAddingToCollection(true);
    try {
      const res = await fetch(`/api/collections/cards`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          externalId: card.externalId || card.id,
          name: card.name,
          setName: card.setName,
          game: card.game,
          rarity: card.rarity,
          imageUrl: card.imageUrl,
          thumbnailUrl: card.thumbnailUrl,
          price: card.prices?.marketPrice || 0,
          quantity: 1
        }),
      });
      if (res.ok) setInCollection(true);
    } catch (err) {
      console.error(err);
    } finally {
      setAddingToCollection(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[50vh] space-y-4">
        <Loader2 className="h-10 w-10 text-aura-purple animate-spin" />
        <p className="text-muted-foreground animate-pulse">Loading card details...</p>
      </div>
    );
  }

  if (!card) {
    return (
      <div className="p-8 text-center flex flex-col items-center justify-center h-full min-h-[50vh]">
        <h1 className="text-2xl font-bold mb-2">Card Not Found</h1>
        <p className="text-muted-foreground mb-6">We couldn't find a card matching this ID.</p>
        <Button onClick={() => router.back()} variant="outline">Go Back</Button>
      </div>
    );
  }

  const prices = card.prices || {};

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-6xl mx-auto">
      {/* Header */}
      <motion.div initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.3 }}>
        <Button variant="ghost" className="mb-4 -ml-4 text-muted-foreground hover:text-foreground" onClick={() => router.back()}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Results
        </Button>
      </motion.div>

      <div className="grid grid-cols-1 md:grid-cols-12 gap-8 lg:gap-12">
        {/* Left Column: Image */}
        <motion.div 
          className="md:col-span-5 lg:col-span-4"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.1 }}
        >
          <div className="relative group perspective-1000">
            {/* Glow effect */}
            <div className={`absolute -inset-4 bg-gradient-to-tr ${card.game === 'MTG' ? 'from-purple-500/20' : card.game === 'POKEMON' ? 'from-yellow-500/20' : 'from-blue-500/20'} to-transparent rounded-[2rem] blur-xl opacity-0 group-hover:opacity-100 transition-opacity duration-700 -z-10`} />
            
            <div className="w-full aspect-[2.5/3.5] rounded-xl sm:rounded-2xl bg-black/40 border border-white/10 shadow-2xl overflow-hidden flex items-center justify-center relative">
              {(card.imageUrl || card.thumbnailUrl) ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img 
                  src={card.imageUrl || card.thumbnailUrl} 
                  alt={card.name} 
                  className="w-full h-full object-cover shadow-inner"
                />
              ) : (
                <div className="flex flex-col items-center justify-center text-muted-foreground">
                  <Sparkles className="h-12 w-12 mb-4 opacity-20" />
                  <p className="text-sm">No artwork available</p>
                </div>
              )}
            </div>
          </div>
        </motion.div>

        {/* Right Column: Info & Actions */}
        <motion.div 
          className="md:col-span-7 lg:col-span-8 flex flex-col"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.2 }}
        >
          {/* Title & Game Badge */}
          <div className="flex flex-wrap items-start justify-between gap-4 mb-2">
            <div>
              <h1 className="text-3xl sm:text-4xl lg:text-5xl font-extrabold tracking-tight mb-2">
                {card.name}
              </h1>
              <p className="text-lg text-muted-foreground">
                {card.setName} · {card.rarity?.replace('_', ' ')}
              </p>
            </div>
            <Badge variant="outline" className={`px-3 py-1 text-xs uppercase tracking-wider font-bold ${gameColors[card.game] || ''}`}>
              {card.game}
            </Badge>
          </div>

          <div className="w-full h-px bg-border/50 my-6" />

          {/* Pricing Grid */}
          <div className="mb-8">
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4 flex items-center gap-2">
              <TrendingUp className="h-4 w-4" /> Market Value
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="p-4 rounded-xl glass border-border/50 flex flex-col items-center justify-center relative overflow-hidden">
                <div className="absolute top-0 right-0 w-16 h-16 bg-aura-purple/10 rounded-full blur-xl" />
                <p className="text-xs text-muted-foreground mb-1 font-medium">Market</p>
                <p className="text-xl font-bold">${(prices.marketPrice || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
              </div>
              <div className="p-4 rounded-xl bg-accent/30 border border-border/20 flex flex-col items-center justify-center">
                <p className="text-xs text-muted-foreground mb-1 font-medium">Low</p>
                <p className="text-lg font-semibold">${(prices.lowPrice ? prices.lowPrice : prices.marketPrice || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
              </div>
              <div className="p-4 rounded-xl bg-accent/30 border border-border/20 flex flex-col items-center justify-center">
                <p className="text-xs text-muted-foreground mb-1 font-medium">Mid</p>
                <p className="text-lg font-semibold">${(prices.midPrice ? prices.midPrice : prices.marketPrice || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
              </div>
              <div className="p-4 rounded-xl bg-accent/30 border border-border/20 flex flex-col items-center justify-center">
                <p className="text-xs text-muted-foreground mb-1 font-medium">High</p>
                <p className="text-lg font-semibold">${(prices.highPrice ? prices.highPrice : prices.marketPrice || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="mt-auto pt-6 flex flex-col sm:flex-row gap-4 border-t border-border/30">
            <Button 
              className="flex-1 h-12 rounded-xl gradient-bg text-white font-medium shadow-lg shadow-aura-purple/20 transition-all hover:shadow-aura-purple/40 hover:-translate-y-0.5"
              onClick={handleAddToCollection}
              disabled={addingToCollection || inCollection}
            >
              {addingToCollection ? <Loader2 className="h-5 w-5 animate-spin" /> : inCollection ? <><Check className="h-5 w-5 mr-2" /> In Collection</> : <><Library className="h-5 w-5 mr-2" /> Add to Collection</>}
            </Button>
            
            <Button 
              variant="outline"
              className={`flex-1 h-12 rounded-xl font-medium transition-all ${inWatchlist ? 'bg-pink-500/10 border-pink-500/30 text-pink-500' : 'hover:border-pink-500/50 hover:bg-pink-500/5 hover:text-pink-500'}`}
              onClick={handleAddToWatchlist}
              disabled={addingToWatchlist || inWatchlist}
            >
              {addingToWatchlist ? <Loader2 className="h-5 w-5 animate-spin" /> : inWatchlist ? <><Check className="h-5 w-5 mr-2" /> In Watchlist</> : <><Heart className="h-5 w-5 mr-2" /> Add to Watchlist</>}
            </Button>
          </div>

        </motion.div>
      </div>
    </div>
  );
}
