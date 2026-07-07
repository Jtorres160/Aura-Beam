"use client";

import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { useSession } from "next-auth/react";
import { Library, Grid3X3, List, Plus, Search, Filter, Sparkles, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const gameColors: Record<string, string> = {
  "Pokémon": "bg-yellow-500/10 text-yellow-500",
  "MTG": "bg-purple-500/10 text-purple-500",
  "Yu-Gi-Oh!": "bg-blue-500/10 text-blue-500",
};

export default function CollectionPage() {
  const { data: session } = useSession();
  const [view, setView] = useState<"grid" | "list">("grid");
  const [search, setSearch] = useState("");
  const [collection, setCollection] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!session?.user?.id || !(session as any).accessToken) return;
    
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
  }, [session]);

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
            <h1 className="text-2xl sm:text-3xl font-bold flex items-center gap-2">
              <Library className="h-6 w-6 text-aura-purple" />
              Collection
            </h1>
            <p className="text-muted-foreground mt-1">
              {collection.length} cards · Total value: <span className="text-foreground font-semibold">${totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            </p>
          </div>
          <Button className="gradient-bg text-white border-0 rounded-xl font-medium">
            <Plus className="h-4 w-4 mr-2" />
            Add Card
          </Button>
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
            <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
              <Loader2 className="h-8 w-8 animate-spin mb-4 text-aura-purple" />
              <p>Loading your collection...</p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
              <Library className="h-12 w-12 mb-4 opacity-30" />
              <p>No cards found.</p>
              {search && <Button variant="link" onClick={() => setSearch("")}>Clear filters</Button>}
            </div>
          ) : view === "grid" ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
              {filtered.map((card, i) => (
                <motion.div
                  key={card.id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3, delay: i * 0.03 }}
                >
                  <Card className="glass border-border/50 card-hover cursor-pointer group overflow-hidden">
                    <div className="aspect-[2.5/3.5] bg-gradient-to-br from-aura-purple/10 to-aura-indigo/5 flex items-center justify-center relative overflow-hidden">
                      {(card.imageUrl || card.thumbnailUrl) ? (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img src={card.imageUrl || card.thumbnailUrl} alt={card.name} className="w-full h-full object-cover opacity-90 group-hover:opacity-100 transition-opacity" />
                      ) : (
                        <Sparkles className="h-8 w-8 text-aura-purple/30" />
                      )}
                      
                      {card.qty > 1 && (
                        <Badge className="absolute top-2 right-2 bg-background/90 text-foreground text-xs shadow-md">
                          ×{card.qty}
                        </Badge>
                      )}
                    </div>
                    <CardContent className="p-3">
                      <p className="text-sm font-semibold truncate">{card.name}</p>
                      <p className="text-xs text-muted-foreground truncate">{card.set}</p>
                      <div className="flex items-center justify-between mt-2">
                        <span className="text-sm font-bold">${(card.price || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                        <Badge variant="secondary" className={`text-[10px] ${gameColors[card.game] || 'bg-accent text-muted-foreground'}`}>
                          {card.game}
                        </Badge>
                      </div>
                    </CardContent>
                  </Card>
                </motion.div>
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              {filtered.map((card, i) => (
                <motion.div
                  key={card.id}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.3, delay: i * 0.03 }}
                >
                  <div className="flex items-center gap-4 p-3 rounded-xl glass border-border/50 card-hover cursor-pointer overflow-hidden">
                    <div className="h-12 w-9 rounded-lg bg-aura-purple/10 flex items-center justify-center shrink-0 overflow-hidden relative">
                      {(card.imageUrl || card.thumbnailUrl) ? (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img src={card.imageUrl || card.thumbnailUrl} alt={card.name} className="w-full h-full object-cover" />
                      ) : (
                        <Sparkles className="h-4 w-4 text-aura-purple/50" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold truncate">{card.name}</p>
                      <p className="text-xs text-muted-foreground">{card.set} · {card.rarity?.replace('_', ' ')}</p>
                    </div>
                    <Badge variant="secondary" className={`text-[10px] shrink-0 hidden sm:inline-flex ${gameColors[card.game] || 'bg-accent'}`}>
                      {card.game}
                    </Badge>
                    <div className="text-right shrink-0">
                      <p className="font-semibold whitespace-nowrap text-right pr-2">${(card.price || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                      <p className="text-xs text-muted-foreground">×{card.qty}</p>
                    </div>
                  </div>
                </motion.div>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="binders">
          <div className="py-16 text-center text-muted-foreground">
            <Library className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm">Create your first binder to organize cards.</p>
            <Button className="mt-4 gradient-bg text-white border-0 rounded-xl" size="sm">
              <Plus className="h-4 w-4 mr-1" />Create Binder
            </Button>
          </div>
        </TabsContent>
        <TabsContent value="decks">
          <div className="py-16 text-center text-muted-foreground">
            <Library className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm">Create your first deck.</p>
            <Button className="mt-4 gradient-bg text-white border-0 rounded-xl" size="sm">
              <Plus className="h-4 w-4 mr-1" />Create Deck
            </Button>
          </div>
        </TabsContent>
        <TabsContent value="folders">
          <div className="py-16 text-center text-muted-foreground">
            <Library className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm">Create a folder to categorize your collection.</p>
            <Button className="mt-4 gradient-bg text-white border-0 rounded-xl" size="sm">
              <Plus className="h-4 w-4 mr-1" />Create Folder
            </Button>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
