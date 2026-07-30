"use client";

// Client half of the reveal-accent comparison (see page.tsx for why this route
// exists). Structured identity arrives from the server; the two art-derived
// columns are computed HERE, in the browser, by the same client-side canvas read
// the production feature would use — so what the screenshot shows is the real
// extraction result, not a hand-picked color.

import { useEffect, useState } from "react";
import { RevealPlate } from "@/components/scanner/reveal-plate";
import {
  accentFromColorIdentity,
  accentFromPokemonTypes,
  clampToHouse,
  REVIEWED_WARM_PULL,
  type CardAccent,
} from "@/lib/cards/card-color";
import { extractArtColor } from "@/lib/cards/extract-art-color";

export interface PreviewCard {
  game: "MTG" | "POKEMON";
  name: string;
  setName: string;
  imageUrl: string | null;
  colorIdentity: string[] | null;
  pokemonTypes: string[] | null;
}

const COLUMNS = [
  { key: "baseline", title: "A · Current", blurb: "Ships today. No accent." },
  { key: "identity", title: "B · Identity", blurb: "Curated palette from game data." },
  { key: "raw", title: "C · Art, raw", blurb: "Dominant art color, as sampled." },
  { key: "warmed", title: "D · Art + warm pull", blurb: "Hue rotated 18% toward brass." },
  { key: "clamped", title: "E · Art, S/L clamp", blurb: "Art hue kept. No rotation." },
] as const;

function identityAccent(card: PreviewCard): CardAccent {
  return card.game === "MTG"
    ? accentFromColorIdentity(card.colorIdentity)
    : accentFromPokemonTypes(card.pokemonTypes);
}

export function RevealComparisonGrid({
  cards,
  only,
}: {
  cards: PreviewCard[];
  /** Column keys to show; undefined ⇒ all of them. */
  only?: string[];
}) {
  const columns = only?.length ? COLUMNS.filter((c) => only.includes(c.key)) : COLUMNS;
  // null = not read yet; a present key with null value = extraction returned
  // nothing usable, which the grid must show as "no color", not as a blank cell.
  const [art, setArt] = useState<Record<string, string | null>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const card of cards) {
        if (!card.imageUrl) continue;
        const reading = await extractArtColor(card.imageUrl);
        if (cancelled) return;
        setArt((prev) => ({ ...prev, [card.name + card.setName]: reading?.rawHex ?? null }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cards]);

  return (
    <main className="min-h-screen bg-background px-6 py-10">
      <header className="mx-auto max-w-6xl mb-10">
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
          Design review · Scan reveal
        </p>
        <h1 className="font-serif text-3xl sm:text-4xl mt-2">A card&apos;s own color, at the reveal</h1>
        <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
          {columns.length} treatment{columns.length === 1 ? "" : "s"} of the same moment, on real cards through the real{" "}
          <span className="font-mono text-xs">RevealPlate</span>. The foil hairline stays neutral in
          every one — it remains the screen&apos;s single foil moment.
        </p>
      </header>

      <div className="mx-auto max-w-6xl space-y-14">
        {cards.map((card) => {
          const identity = identityAccent(card);
          const key = card.name + card.setName;
          const rawRead = key in art ? art[key] : undefined;
          const accents: Record<string, string | null> = {
            baseline: null,
            identity: identity.source === "neutral" ? null : identity.hex,
            raw: rawRead ?? null,
            warmed: rawRead ? clampToHouse(rawRead, REVIEWED_WARM_PULL) : null,
            clamped: rawRead ? clampToHouse(rawRead) : null,
          };

          return (
            <section key={key}>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border pb-3 mb-6">
                <h2 className="font-serif text-xl">{card.name}</h2>
                <span className="text-sm text-muted-foreground">{card.setName}</span>
                <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                  {card.game} ·{" "}
                  {card.game === "MTG"
                    ? `identity ${card.colorIdentity?.length ? card.colorIdentity.join("") : "—"}`
                    : `type ${card.pokemonTypes?.[0] ?? "—"}`}
                  {identity.source === "neutral" && " · declares no color"}
                </span>
              </div>

              <div className="grid gap-x-5 gap-y-10"
                style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}>
                {columns.map((col) => (
                  <div key={col.key} className="flex flex-col items-center">
                    <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-foreground">
                      {col.title}
                    </p>
                    <p className="mt-1 mb-6 text-center text-[11px] text-muted-foreground h-8 max-w-[15rem]">
                      {col.blurb}
                    </p>

                    <RevealPlate
                      name={card.name}
                      imageUrl={card.imageUrl}
                      accent={accents[col.key]}
                      still
                    />

                    {/* The adjacent element in the real reveal, included so the
                        wash can be judged against the neutral foil hairline it
                        sits next to rather than in isolation. */}
                    <div className="foil-edge h-px w-24 mt-6" />

                    <div className="mt-4 flex items-center gap-2 h-5">
                      {accents[col.key] ? (
                        <>
                          <span
                            className="h-3 w-3 rounded-full border border-border"
                            style={{ background: accents[col.key] as string }}
                          />
                          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                            {accents[col.key]}
                            {col.key === "identity" && ` · ${identity.label}`}
                          </span>
                        </>
                      ) : (
                        <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                          {col.key === "baseline"
                            ? "flat"
                            : rawRead === undefined && col.key !== "identity"
                              ? "sampling…"
                              : "no color"}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </main>
  );
}
