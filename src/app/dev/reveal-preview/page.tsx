// ═══════════════════════════════════════════════════════════
// Aura — Reveal accent color: design comparison (Phase R1)
// ═══════════════════════════════════════════════════════════
// A DEV-ONLY comparison surface for the "reveal is no longer flat" direction.
// It exists so the accent can be judged on real cards, in the real app, through
// the real <RevealPlate> the scanner renders — not on a static mockup.
//
// 404s outside development. Nothing links to it; it is a review instrument.
//
// The identity colors below come from the LIVE provider responses (Scryfall
// `color_identity`, Pokémon TCG `types`), fetched here at request time. That is
// deliberate: those fields are real and exact, but they are NOT currently
// persisted (Card.types is 0/157 populated in prod, and neither
// CandidatePrinting nor SavedCard carries a color field). Fetching them here
// proves the data exists upstream without pre-wiring a pipeline the user has not
// approved yet.

import { notFound } from "next/navigation";
import { RevealComparisonGrid, type PreviewCard } from "./comparison-grid";

const SCRYFALL_HEADERS = { "User-Agent": "AuraBeam/1.0", Accept: "application/json" };

/** Real rows from the production `cards` table, chosen for visibly different
 *  identities: a cool single color, a warm single color, a multicolor, a
 *  genuinely colorless card (the "no color is earned" control), and two Pokémon
 *  energy types. */
const FIXTURES = [
  { game: "MTG" as const, id: "1920dae4-fb92-4f19-ae4b-eb3276b8dac7" }, // Counterspell (MH2) — U
  { game: "MTG" as const, id: "9e2e3efb-75cb-430f-b9f4-cb58f3aeb91b" }, // Dockside Extortionist (2X2) — R
  { game: "MTG" as const, id: "f3e93085-ffcb-4f48-8649-3fcbc5e97699" }, // Moldervine Reclamation (SOC) — B/G
  { game: "MTG" as const, id: "07a3d9e8-8597-498b-869c-cff79e0df516" }, // Karn, Scion of Urza — colorless
  { game: "POKEMON" as const, id: "sv3pt5-6" },                         // Charizard ex (151) — Fire
  { game: "POKEMON" as const, id: "sv10-194" },                         // Misty's Lapras (DRI) — Water
];

async function loadCard(fixture: (typeof FIXTURES)[number]): Promise<PreviewCard | null> {
  try {
    if (fixture.game === "MTG") {
      const res = await fetch(`https://api.scryfall.com/cards/${fixture.id}`, {
        headers: SCRYFALL_HEADERS,
        next: { revalidate: 86400 },
      });
      if (!res.ok) return null;
      const card = await res.json();
      return {
        game: "MTG",
        name: card.name,
        setName: card.set_name,
        imageUrl: card.image_uris?.large ?? card.card_faces?.[0]?.image_uris?.large ?? null,
        colorIdentity: card.color_identity ?? [],
        pokemonTypes: null,
      };
    }
    const res = await fetch(`https://api.pokemontcg.io/v2/cards/${fixture.id}`, {
      next: { revalidate: 86400 },
    });
    if (!res.ok) return null;
    const { data } = await res.json();
    return {
      game: "POKEMON",
      name: data.name,
      setName: data.set?.name ?? "",
      imageUrl: data.images?.large ?? data.images?.small ?? null,
      colorIdentity: null,
      pokemonTypes: data.types ?? [],
    };
  } catch {
    return null;
  }
}

export default async function RevealPreviewPage() {
  if (process.env.NODE_ENV === "production") notFound();

  // Sequential, not Promise.all: Scryfall asks for ~100ms between requests, and
  // a review page has no reason to hammer a free API.
  const cards: PreviewCard[] = [];
  for (const fixture of FIXTURES) {
    const card = await loadCard(fixture);
    if (card) cards.push(card);
    await new Promise((r) => setTimeout(r, 120));
  }

  return <RevealComparisonGrid cards={cards} />;
}
