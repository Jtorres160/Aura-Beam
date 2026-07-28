"use client";

// ─── Catalog entry — the card detail page ───────────────────────────────────
// Everything on this screen is a field Aura actually stores or a figure it
// actually recorded. Deliberately ABSENT, because there is no data source
// behind them: other listings, seller counts, listed medians, volatility
// grades, "as low as" figures, and the rules-text block (ability / attack /
// HP / weakness / retreat cost) — the schema has no columns for any of it.
// Adding that block is a future ticket: it needs new Card fields plus a
// re-import to backfill from the Pokémon API's card object.

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { ArrowLeft, Sparkles, Heart, Check, Loader2, Library, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useSession } from "next-auth/react";
import { formatMarketPrice } from "@/lib/cards/market-price";
import { addCardToCollection } from "@/lib/collections/add-to-collection";
import { PriceHistoryChart, type PriceHistoryPoint } from "./price-history-chart";

/** One row of the specification block. Rendered only when the field has a
 *  value — an empty row would imply we looked and found nothing, when in fact
 *  we never recorded it. */
function Spec({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border py-2.5 last:border-b-0">
      <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </dt>
      <dd className="text-right text-sm text-foreground">{value}</dd>
    </div>
  );
}

export default function CardDetailsPage() {
  const params = useParams();
  const router = useRouter();
  const { data: session, status: sessionStatus } = useSession();

  const [card, setCard] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [addingToWatchlist, setAddingToWatchlist] = useState(false);
  const [inWatchlist, setInWatchlist] = useState(false);
  const [addingToCollection, setAddingToCollection] = useState(false);
  const [inCollection, setInCollection] = useState(false);
  /** Why the last action on this screen didn't happen. Null when nothing has
   *  failed. A click must always produce either a state change or one of these. */
  const [actionError, setActionError] = useState<string | null>(null);

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

  /**
   * Why a click can't proceed yet, or null if it can.
   *
   * This used to be `if (!session?.user?.id || !card) return;` — a bare return
   * that produced no state change, no message and no console line. A collector
   * who clicked before `useSession()` resolved saw the button sit there doing
   * literally nothing, which is indistinguishable from a broken feature. The
   * session gate is real and must stay; what it must not be is invisible.
   */
  const blockedReason = (): string | null => {
    if (!card) return "This card is still loading — try again in a moment.";
    if (sessionStatus === "loading") {
      return "Still confirming your session — try again in a second.";
    }
    if (!session?.user?.id) {
      return "You're signed out, so nothing was saved. Sign in and try again.";
    }
    return null;
  };

  const handleAddToWatchlist = async () => {
    const blocked = blockedReason();
    if (blocked) return setActionError(blocked);
    setActionError(null);
    setAddingToWatchlist(true);
    try {
      // The watchlist/add route resolves the card by local id OR externalId,
      // so we only need to pass an identifier — never a whole card object.
      const res = await fetch(`/api/watchlist/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardId: card.id || card.externalId }),
      });
      if (res.ok) {
        setInWatchlist(true);
      } else {
        const json = await res.json().catch(() => null);
        setActionError(json?.message || "We couldn't add this card to your watchlist. Try again in a moment.");
      }
    } catch {
      setActionError("We couldn't reach Aura to add this card, so nothing was saved. Check your connection.");
    } finally {
      setAddingToWatchlist(false);
    }
  };

  const handleAddToCollection = async () => {
    const blocked = blockedReason();
    if (blocked) return setActionError(blocked);
    setActionError(null);
    setAddingToCollection(true);

    // Same contract as the scanner's "Add to Collection": the collections/add
    // route resolves by id OR externalId and owns the upsert. We pass `game` so
    // a card not yet in the local DB is re-fetched from the RIGHT source
    // (Pokémon / MTG / Yu-Gi-Oh), never assumed to be Pokémon.
    const result = await addCardToCollection({
      cardId: card.id || card.externalId,
      game: card.game,
    });

    // "In Collection" is only ever shown for an add the server confirmed.
    if (result.ok) setInCollection(true);
    else setActionError(result.message);
    setAddingToCollection(false);
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
  const marketPrice = formatMarketPrice(prices.marketPrice);
  const history: PriceHistoryPoint[] = Array.isArray(card.priceHistory) ? card.priceHistory : [];
  const rarity = card.rarity?.replace(/_/g, " ");
  // Card.types / Card.subtypes are stored as comma-joined strings.
  const readList = (raw?: string | null) =>
    raw?.split(",").map((s) => s.trim()).filter(Boolean).join(" · ") || null;
  const lastUpdated = prices.lastUpdated ? new Date(prices.lastUpdated) : null;

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

          {/* Specification plate — sits under the object like an exhibit label.
              Every row is a stored Card column, and a row with no value simply
              doesn't print rather than showing an empty field.

              Note: Card.artist / .types / .subtypes are columns that NOTHING
              currently populates — no provider extracts them and
              CandidatePrinting has no such fields (0/131 stored cards have
              them). Those rows are wired and will light up the moment an
              importer fills the columns; until then they correctly render
              nothing. Populating them is the same ticket as the rules-text
              block: contract fields + extractor work + a re-import backfill. */}
          <dl className="mt-6 rounded-lg border border-border bg-card px-4 py-1">
            <Spec label="Set" value={card.setName} />
            <Spec label="Number" value={card.collectorNumber} />
            <Spec label="Rarity" value={rarity} />
            <Spec label="Type" value={readList(card.types)} />
            <Spec label="Subtype" value={readList(card.subtypes)} />
            <Spec label="Artist" value={card.artist} />
          </dl>
        </motion.div>

        {/* Right Column: valuation, recorded history, actions */}
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
                {[card.setName, rarity, card.collectorNumber && `№ ${card.collectorNumber}`]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
            <Badge variant="outline" className="px-3 py-1 font-mono text-[10px] uppercase tracking-wide border-brass/40 text-foreground">
              {card.game}
            </Badge>
          </div>

          {/* Foil rule — the screen's single foil moment */}
          <div className="foil-edge h-px w-24 my-6" />

          {/* Market Value.
              Our price sources return a single market value per printing;
              low/mid/high tiers aren't captured, so showing them would only
              repeat the market figure four times and imply a precision we don't
              have. One truthful number — or an honest absence.

              "No market data" also covers rows stored as 0 before prices became
              nullable; see lib/cards/market-price.ts for why that is a
              disclosed convention rather than a guess. */}
          <section className="mb-8">
            <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground mb-4">
              Market value
            </h2>
            <div className="rounded-lg border border-brass/40 bg-card p-6">
              {marketPrice ? (
                <>
                  <p className="font-serif text-5xl leading-none tracking-tight tabular-nums">
                    {marketPrice}
                  </p>
                  <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                    {lastUpdated
                      ? `Last refreshed ${lastUpdated.toLocaleDateString()}`
                      : "Quoted live from the card database"}
                  </p>
                </>
              ) : (
                <>
                  <p className="font-serif text-2xl leading-none tracking-tight text-muted-foreground">
                    No market data
                  </p>
                  <p className="mt-3 text-sm text-muted-foreground">
                    No price source has quoted this printing. Aura shows nothing rather
                    than a figure it cannot support.
                  </p>
                </>
              )}
            </div>
          </section>

          {/* Recorded price history */}
          <section className="mb-8">
            <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground mb-4">
              Recorded history
            </h2>
            <PriceHistoryChart points={history} />
          </section>

          {/* Actions */}
          <div className="mt-auto pt-6 border-t border-border">
            {/* A refused or failed action says so, in place, every time. The
                screen never shows a saved state it hasn't been told about. */}
            {actionError && (
              <div
                role="status"
                className="mb-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs text-amber-600 dark:text-amber-500"
              >
                <AlertTriangle className="h-4 w-4 shrink-0 mt-px" />
                <span>{actionError}</span>
              </div>
            )}

            <div className="flex flex-col sm:flex-row gap-3">
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
          </div>
        </motion.div>
      </div>
    </div>
  );
}
