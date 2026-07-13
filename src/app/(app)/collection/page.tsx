"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { useSession } from "next-auth/react";
import { Library, Grid3X3, List, Plus, Search, Filter, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export default function CollectionPage() {
  // `status` ("loading" | "authenticated" | "unauthenticated") is NextAuth's
  // reliable readiness signal. We key on it instead of the ad-hoc
  // session.accessToken field, which is regenerated on every /api/auth/session
  // call and can be absent on a client-side back-navigation — the old guard
  // then skipped the fetch and the page rendered its empty "0 cards" state.
  // The API authenticates via the server session cookie, so no token is needed.
  const { status } = useSession();
  const [view, setView] = useState<"grid" | "list">("grid");
  const [search, setSearch] = useState("");
  const [collection, setCollection] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (status === "loading") return;
    if (status !== "authenticated") {
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    fetch(`/api/collections`)
      .then((res) => res.json())
      .then((json) => {
        if (json.success && json.data) {
          // Flatten backend structure to simple UI structure
          const mapped = json.data.cards.map((c: any) => ({
            id: c.id,
            cardId: c.card.id,
            name: c.card.name,
            set: c.card.setName,
            price: c.card.prices?.marketPrice || 0,
            game: c.card.game,
            rarity: c.card.rarity,
            qty: c.quantity,
            imageUrl: c.card.imageUrl,
            thumbnailUrl: c.card.thumbnailUrl,
          }));
          setCollection(mapped);
        }
      })
      .catch((err) => console.error("Failed to fetch collection:", err))
      .finally(() => setIsLoading(false));
  }, [status]);

  const filtered = collection.filter((c) =>
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    c.set.toLowerCase().includes(search.toLowerCase())
  );

  const totalValue = collection.reduce((sum, c) => sum + (c.price * c.qty), 0);

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6">
      {/* Header */}
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <h1 className="font-serif text-3xl sm:text-4xl tracking-tight">Collection</h1>
            <p className="text-muted-foreground mt-1 text-sm">
              <span className="font-mono">{collection.length}</span> cards · Total value{" "}
              <span className="font-mono text-foreground">${totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            </p>
          </div>
          <Link href="/search">
            <Button className="font-medium">
              <Plus className="h-4 w-4 mr-2" />
              Add card
            </Button>
          </Link>
        </div>
      </motion.div>

      {/* Tabs */}
      <Tabs defaultValue="all" className="w-full">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <TabsList className="bg-accent/50 rounded-xl">
            <TabsTrigger value="all" className="rounded-lg text-xs">All Cards</TabsTrigger>
            <TabsTrigger value="binders" className="rounded-lg text-xs">Binders</TabsTrigger>
            <TabsTrigger value="decks" className="rounded-lg text-xs">Decks</TabsTrigger>
            <TabsTrigger value="folders" className="rounded-lg text-xs">Folders</TabsTrigger>
          </TabsList>
          <div className="flex items-center gap-2">
            <Button
              variant={view === "grid" ? "default" : "outline"}
              size="icon"
              className="h-9 w-9 rounded-lg"
              onClick={() => setView("grid")}
            >
              <Grid3X3 className="h-4 w-4" />
            </Button>
            <Button
              variant={view === "list" ? "default" : "outline"}
              size="icon"
              className="h-9 w-9 rounded-lg"
              onClick={() => setView("list")}
            >
              <List className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Search */}
        <div className="flex gap-3 mt-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search your collection..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-10 h-10 rounded-xl"
            />
          </div>
          <Button variant="outline" className="h-10 rounded-xl">
            <Filter className="h-4 w-4 mr-2" />
            Filters
          </Button>
        </div>

        <TabsContent value="all" className="mt-6">
          {isLoading ? (
            /* Binder-page shimmer — empty card slots while the archive loads */
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-x-4 gap-y-6">
              {Array.from({ length: 10 }).map((_, i) => (
                <div key={i}>
                  <div className="card-frame shimmer border border-border" />
                  <div className="h-3 w-3/4 mt-2 rounded shimmer" />
                  <div className="h-3 w-1/2 mt-1.5 rounded shimmer" />
                </div>
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
              <div className="card-frame w-28 border border-dashed border-border mb-5 flex items-center justify-center">
                <Library className="h-8 w-8 opacity-30" />
              </div>
              <p className="font-serif text-lg text-foreground">No cards found</p>
              <p className="text-sm mt-1">Scan a card to start your archive.</p>
              {search && <Button variant="link" onClick={() => setSearch("")}>Clear filters</Button>}
            </div>
          ) : view === "grid" ? (
            /* Binder page — the card artwork is the object; metadata is a caption */
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-x-4 gap-y-6">
              {filtered.map((card, i) => (
                <motion.div
                  key={card.id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3, delay: Math.min(i, 12) * 0.03 }}
                >
                  <Link href={`/cards/${card.cardId}`} className="group block cursor-pointer">
                    <div className="card-frame relative border border-border bg-muted card-hover">
                      {(card.imageUrl || card.thumbnailUrl) ? (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img src={card.imageUrl || card.thumbnailUrl} alt={card.name} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <Sparkles className="h-8 w-8 text-muted-foreground/30" />
                        </div>
                      )}

                      {card.qty > 1 && (
                        <Badge className="absolute top-2 right-2 bg-background/90 text-foreground font-mono text-[10px] shadow-sm">
                          ×{card.qty}
                        </Badge>
                      )}
                    </div>
                    <div className="mt-2 px-0.5">
                      <p className="text-sm font-medium truncate">{card.name}</p>
                      <p className="text-xs text-muted-foreground truncate">{card.set}</p>
                      <div className="flex items-baseline justify-between mt-1">
                        <span className="font-mono text-sm">${(card.price || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                        <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">{card.game}</span>
                      </div>
                    </div>
                  </Link>
                </motion.div>
              ))}
            </div>
          ) : (
            /* Catalog ledger */
            <div className="rounded-lg border border-border bg-card divide-y divide-border overflow-hidden">
              {filtered.map((card, i) => (
                <motion.div
                  key={card.id}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.3, delay: Math.min(i, 12) * 0.03 }}
                >
                  <Link href={`/cards/${card.cardId}`} className="flex items-center gap-4 p-3 cursor-pointer hover:bg-muted/60 transition-colors">
                    <div className="w-9 shrink-0 card-frame bg-muted border border-border flex items-center justify-center">
                      {(card.imageUrl || card.thumbnailUrl) ? (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img src={card.imageUrl || card.thumbnailUrl} alt={card.name} className="w-full h-full object-cover" />
                      ) : (
                        <Sparkles className="h-4 w-4 text-muted-foreground/40" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{card.name}</p>
                      <p className="text-xs text-muted-foreground truncate">{card.set} · {card.rarity?.replace('_', ' ')}</p>
                    </div>
                    <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground shrink-0 hidden sm:inline">
                      {card.game}
                    </span>
                    <div className="text-right shrink-0">
                      <p className="font-mono text-sm whitespace-nowrap">${(card.price || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                      <p className="font-mono text-[10px] text-muted-foreground">×{card.qty}</p>
                    </div>
                  </Link>
                </motion.div>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="binders">
          <div className="py-16 text-center text-muted-foreground">
            <Library className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm">Create your first binder to organize cards.</p>
            <Button className="mt-4" size="sm">
              <Plus className="h-4 w-4 mr-1" />Create Binder
            </Button>
          </div>
        </TabsContent>
        <TabsContent value="decks">
          <div className="py-16 text-center text-muted-foreground">
            <Library className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm">Create your first deck.</p>
            <Button className="mt-4" size="sm">
              <Plus className="h-4 w-4 mr-1" />Create Deck
            </Button>
          </div>
        </TabsContent>
        <TabsContent value="folders">
          <div className="py-16 text-center text-muted-foreground">
            <Library className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm">Create a folder to categorize your collection.</p>
            <Button className="mt-4" size="sm">
              <Plus className="h-4 w-4 mr-1" />Create Folder
            </Button>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
