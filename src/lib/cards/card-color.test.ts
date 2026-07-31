// Reveal accent — a card's color must come from what the card DECLARES.
//
// The reveal wash is derived colour, and the whole reason treatment B was chosen
// over sampling the artwork is that a derived-from-pixels colour invents facts:
// the design comparison caught it painting a colourless Karn teal and pulling a
// bright cyan (#63C8D2) out of a Lapras. So the properties worth pinning here are
// not "does blue map to blue" — they are the ones that keep the feature honest:
//
//   1. DECLARED ABSENCE renders nothing. A colourless MTG card (`[]`), a
//      Trainer/Energy card (no `types`) and any Yu-Gi-Oh! card must all stay
//      flat. This is the same rule as the scanner's truth boundary: absence is
//      an answer, and it must not be dressed up as a colour.
//
//   2. `[]` AND `undefined` MUST NOT COLLAPSE at the transport layer. They mean
//      different things — "the card says it has no colours" vs "this source
//      never carried the field" — and the local Pokémon catalog makes the second
//      case real in production, so a `|| []` anywhere in the chain would turn a
//      missing field into a false claim about the card.
//
//   3. NO NEON. Every pigment the map can emit stays inside the house palette,
//      because AGENTS.md bans glowing AI visuals and a literal mana-symbol red
//      would be exactly that.
//
// Run: node --import ./test/register.mjs --test src/lib/cards/card-color.test.ts

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  accentFromColorIdentity,
  accentFromPokemonTypes,
  accentForCard,
  revealAccentHex,
  clampToHouse,
  hexToHsl,
  REVIEWED_WARM_PULL,
} from "@/lib/cards/card-color";
import { formatScryfallCard } from "@/lib/services/scryfall";
import { formatPokemonCard } from "@/lib/services/pokemon";
import { serializeSavedCard } from "@/lib/cards/serialize-card";
import type { Card } from "@prisma/client";
import type { CandidatePrinting } from "@/lib/scanner/evidence";

describe("declared absence renders nothing", () => {
  test("a colourless MTG card asks for no wash", () => {
    assert.equal(accentFromColorIdentity([]).source, "neutral");
    assert.equal(revealAccentHex({ game: "MTG", colorIdentity: [] }), null);
  });

  test("a Trainer/Energy card (no types) asks for no wash", () => {
    assert.equal(revealAccentHex({ game: "POKEMON", types: undefined }), null);
    assert.equal(revealAccentHex({ game: "POKEMON", types: [] }), null);
  });

  test("Colorless is a Pokémon type name, and it still means no wash", () => {
    const accent = accentFromPokemonTypes(["Colorless"]);
    assert.equal(accent.source, "neutral");
    assert.equal(revealAccentHex({ game: "POKEMON", types: ["Colorless"] }), null);
  });

  test("Yu-Gi-Oh! publishes no colour identity, so it stays flat", () => {
    // Not an oversight to be filled in later — inventing a colour for YGO is the
    // extraction mistake the comparison rejected, one layer down.
    assert.equal(revealAccentHex({ game: "YUGIOH" }), null);
    assert.equal(revealAccentHex({ game: "YUGIOH", colorIdentity: ["R"], types: ["Fire"] }), null);
  });

  test("an unknown game stays flat rather than guessing", () => {
    assert.equal(revealAccentHex({ game: "LORCANA", types: ["Fire"] }), null);
  });
});

describe("`[]` and absent must not collapse", () => {
  test("Scryfall's colourless [] survives as [], not as undefined", () => {
    const printing = formatScryfallCard({
      id: "x", name: "Karn, Scion of Urza", set_name: "Dominaria",
      color_identity: [], prices: {},
    });
    assert.deepEqual(printing.colorIdentity, []);
  });

  test("a source that never sent the field leaves it undefined", () => {
    // The distinction the local Pokémon catalog makes real: it stores no type
    // column, so its printings must say "unknown", never "colourless".
    const printing = formatScryfallCard({ id: "x", name: "Old Row", set_name: "S", prices: {} });
    assert.equal(printing.colorIdentity, undefined);

    const pokemon = formatPokemonCard({ id: "p", name: "Trainer", set: { name: "S" } });
    assert.equal(pokemon.types, undefined);
  });

  test("serializeSavedCard omits the key entirely when unknown, and keeps []", () => {
    const localCard = { id: "c", name: "N", setName: "S", game: "MTG", rarity: "R", imageUrl: null, thumbnailUrl: null } as Card;
    const base = { localCard, archive: null, confidence: 90, historyId: "h" };
    const printingOf = (extra: Partial<CandidatePrinting>): CandidatePrinting => ({
      externalId: "e", name: "N", game: "MTG", setName: "S", rarity: "R",
      imageUrl: null, thumbnailUrl: null, price: { marketPrice: null }, ...extra,
    });

    const unknown = serializeSavedCard({ ...base, printing: printingOf({}) });
    assert.equal("colorIdentity" in unknown, false, "unknown must not appear as a key at all");

    const colourless = serializeSavedCard({ ...base, printing: printingOf({ colorIdentity: [] }) });
    assert.deepEqual(colourless.colorIdentity, [], "the card's own 'no colours' must survive");

    const blue = serializeSavedCard({ ...base, printing: printingOf({ colorIdentity: ["U"] }) });
    assert.deepEqual(blue.colorIdentity, ["U"]);
  });

  test("the two absences render the same way but are still distinguishable", () => {
    // Both stay flat — but only one of them is the card making a claim.
    assert.equal(revealAccentHex({ game: "MTG", colorIdentity: [] }), null);
    assert.equal(revealAccentHex({ game: "MTG", colorIdentity: undefined }), null);
  });
});

describe("no neon", () => {
  const identities = [["W"], ["U"], ["B"], ["R"], ["G"], ["U", "R"], ["W", "U", "B", "R", "G"]];
  const types = ["Fire", "Water", "Grass", "Lightning", "Psychic", "Fighting", "Darkness", "Metal", "Fairy", "Dragon"];

  test("every emitted pigment stays inside the house palette", () => {
    const emitted = [
      ...identities.map((i) => accentFromColorIdentity(i).hex),
      ...types.map((t) => accentFromPokemonTypes([t]).hex),
    ];
    for (const hex of emitted) {
      const { s, l } = hexToHsl(hex);
      // Museum pigments, not game-logo colours. A saturated mana-symbol red or a
      // Lightning yellow would clear 0.7 saturation here.
      assert.ok(s <= 0.5, `${hex} is too saturated (${s.toFixed(2)}) — reads as neon`);
      assert.ok(l >= 0.2 && l <= 0.62, `${hex} lightness ${l.toFixed(2)} is outside the palette band`);
    }
  });

  test("multicolour resolves to the house brass, not a blend", () => {
    assert.equal(accentFromColorIdentity(["U", "R"]).hex, accentFromColorIdentity(["W", "B"]).hex);
    assert.equal(accentFromColorIdentity(["U", "R"]).label, "Multicolor");
  });

  test("an unrecognised identity letter stays flat instead of guessing", () => {
    assert.equal(accentFromColorIdentity(["Z"]).source, "neutral");
    assert.equal(accentFromPokemonTypes(["Cosmic"]).source, "neutral");
  });

  test("the clamp tames an arbitrary garish colour", () => {
    // The raw cyan the comparison pulled out of Misty's Lapras.
    const { s } = hexToHsl(clampToHouse("#63C8D2"));
    assert.ok(s <= 0.5, "clamped colour must not stay neon");
  });

  test("a near-grey sample yields no colour rather than an invented hue", () => {
    assert.equal(clampToHouse("#6E6C6A"), "#6E6A62");
  });
});

describe("the rejected warm pull is still reproducible", () => {
  test("rotating toward brass takes blue through violet — the reason it is off by default", () => {
    const blue = "#263269";
    assert.notEqual(clampToHouse(blue, REVIEWED_WARM_PULL), clampToHouse(blue));
    // Default (no rotation) keeps blue in the blue family; the rejected arm does not.
    const kept = hexToHsl(clampToHouse(blue)).h;
    const rotated = hexToHsl(clampToHouse(blue, REVIEWED_WARM_PULL)).h;
    assert.ok(kept > 200 && kept < 260, `expected blue to stay blue, got hue ${kept.toFixed(0)}`);
    assert.ok(rotated > kept, `expected the rejected arm to rotate into violet, got ${rotated.toFixed(0)}`);
  });
});

describe("game dispatch reads the right field", () => {
  test("MTG reads colorIdentity and ignores a stray types array", () => {
    assert.equal(accentForCard({ game: "MTG", colorIdentity: ["R"], types: ["Water"] }).label, "Red");
  });

  test("Pokémon reads types and ignores a stray colorIdentity", () => {
    assert.equal(accentForCard({ game: "POKEMON", colorIdentity: ["R"], types: ["Water"] }).label, "Water");
  });

  test("a dual-type Pokémon takes its primary type, not a blend", () => {
    assert.equal(accentForCard({ game: "POKEMON", types: ["Fire", "Dragon"] }).label, "Fire");
  });
});
