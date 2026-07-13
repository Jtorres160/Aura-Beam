"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { ArrowLeft, Sparkles, Heart, Check, Loader2, Library, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useSession } from "next-auth/react";

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
      // The watchlist/add route resolves the card by local id OR externalId,
      // so we only need to pass an identifier — never a whole card object.
      const res = await fetch(`/api/watchlist/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardId: card.id || card.externalId }),
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
      // Same contract as the scanner's "Add to Collection": the collections/add
      // route resolves by id OR externalId and owns the upsert.
      const res = await fetch(`/api/collections/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardId: card.id || card.externalId }),
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
        <Loader2 className="h-8 w-8 text-brass animate-spin" />
        <p className="font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground">Loading catalog entry…</p>
      </div>
    );
  }

  if (!card) {
    return (
      <div className="p-8 text-center flex flex-col items-center justify-center h-full min-h-[50vh]">
        <h1 className="font-serif text-2xl mb-2">Card not found</h1>
        <p className="text-sm text-muted-foreground mb-6">We couldn&rsquo;t find a catalog entry matching this ID.</p>
        <Button onClick={() => router.back()} variant="outline">Go Back</Button>
      </div>
    );
  }

  const prices = card.prices || {};

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      <motion.div initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.3 }}>
        <Button variant="ghost" className="mb-2 -ml-4 text-muted-foreground hover:text-foreground" onClick={() => router.back()}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back
        </Button>
      </motion.div>

      <div className="grid grid-cols-1 md:grid-cols-12 gap-8 lg:gap-12">
        {/* Left Column: the card object in its archive frame */}
        <motion.div
          className="md:col-span-5 lg:col-span-4"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.1 }}
        >
          <div className="card-frame border border-border bg-muted shadow-[0_24px_48px_-24px_rgba(19,18,16,0.5)]">
            {(card.imageUrl || card.thumbnailUrl) ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={card.imageUrl || card.thumbnailUrl}
                alt={card.name}
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center text-muted-foreground">
                <Sparkles className="h-10 w-10 mb-3 opacity-30" />
                <p className="font-mono text-[11px] uppercase tracking-[0.14em]">No artwork</p>
              </div>
            )}
          </div>
        </motion.div>

        {/* Right Column: catalog details + actions */}
        <motion.div
          className="md:col-span-7 lg:col-span-8 flex flex-col"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.2 }}
        >
          {/* Catalog caption */}
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground mb-3">
            Catalog entry
          </p>

          {/* Title & Game */}
          <div className="flex flex-wrap items-start justify-between gap-4 mb-2">
            <div>
              <h1 className="font-serif text-3xl sm:text-4xl tracking-tight leading-tight mb-2">
                {card.name}
              </h1>
              <p className="text-sm text-muted-foreground">
                {card.setName} · {card.rarity?.replace(/_/g, " ")}
              </p>
            </div>
            <Badge variant="outline" className="px-3 py-1 font-mono text-[10px] uppercase tracking-wide border-brass/40 text-foreground">
              {card.game}
            </Badge>
          </div>

          {/* Foil rule — the screen's single foil moment */}
          <div className="foil-edge h-px w-24 my-6" />

          {/* Market Value */}
          <div className="mb-8">
            <h3 className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground mb-4 flex items-center gap-2">
              <TrendingUp className="h-3.5 w-3.5 text-brass" /> Market value
            </h3>
            {/* Our price sources return a single market value per printing;
                low/mid/high tiers aren't captured, so showing them would only
                repeat the market figure four times and imply a precision we
                don't have. One truthful number instead. */}
            <div className="p-5 rounded-lg border border-brass/40 bg-card flex items-baseline justify-between gap-3">
              <p className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">Market</p>
              <p className="font-mono text-2xl">${(prices.marketPrice || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
            </div>
          </div>

          {/* Actions */}
          <div className="mt-auto pt-6 flex flex-col sm:flex-row gap-3 border-t border-border">
            <Button
              className="flex-1 h-12"
              onClick={handleAddToCollection}
              disabled={addingToCollection || inCollection}
            >
              {addingToCollection ? <Loader2 className="h-5 w-5 animate-spin" /> : inCollection ? <><Check className="h-5 w-5 mr-2" /> In Collection</> : <><Library className="h-5 w-5 mr-2" /> Add to Collection</>}
            </Button>

            <Button
              variant="outline"
              className="flex-1 h-12"
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
