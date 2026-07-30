// ═══════════════════════════════════════════════════════════
// Aura — Card accent color (design exploration, Phase R1)
// ═══════════════════════════════════════════════════════════
// One card, one accent color, derived from what the card ACTUALLY is.
//
// This is the data half of the "reveal is no longer flat" direction: the reveal
// moment earns a whisper of color from real card data instead of painting
// decorative chrome. It follows the same rule Gain/Loss already follow — color
// appears only where it carries meaning.
//
// LAYER: pure data → color mapping. No DOM, no React, no I/O. Safe on both
// server and client. Sampling the card ART lives in extract-art-color.ts
// (client-only, needs a canvas); the CLAMP that keeps a sampled color inside
// the house palette lives here, because both halves must obey one discipline.
//
// Design constraints this file exists to enforce (AGENTS.md · Design Language):
//   - No neon. Every pigment below is capped near S≈40%, L≈40–55%: these are
//     museum-case pigments (oxide, moss, slate, plum), not game-logo colors.
//     A literal Scryfall red or Pokémon Fire orange would read as an AI toy.
//   - Warm bias. Cool hues (blue, slate) are pulled a few degrees toward warm
//     and desaturated harder than warm hues, so nothing fights the paper/ink
//     grounds or the brass accent.
//   - Colorless is not a color. Artifacts, lands and Colorless Pokémon resolve
//     to graphite — i.e. the reveal stays exactly as flat as it is today.
//     "No color identity" must not be dressed up as one.

/** A resolved card accent: the pigment plus where it came from. The source is
 *  carried so the UI can stay honest about a DERIVED color vs. a DECLARED one,
 *  and so telemetry can measure how often each path actually fires. */
export interface CardAccent {
  /** Hex pigment, already inside the house palette. */
  hex: string;
  /** Short human label for the identity, e.g. "Blue", "Fire", "Multicolor". */
  label: string;
  /** How the pigment was decided. `neutral` = the card declares no color. */
  source: "mtg-identity" | "pokemon-type" | "art-extracted" | "neutral";
}

/** Graphite — the "this card declares no color" pigment. Deliberately the same
 *  warm neutral the rest of the system uses for absent data. */
const NEUTRAL_HEX = "#6E6A62";

export const NEUTRAL_ACCENT: CardAccent = {
  hex: NEUTRAL_HEX,
  label: "Colorless",
  source: "neutral",
};

// ─── MTG: mana color identity ────────────────────────────────────────────────
// Scryfall's `color_identity` is an exact, deterministic field (["U"], ["B","G"],
// [] for colorless) — evidence, not inference, which is why it is the preferred
// source. Single colors get a pigment; two-or-more resolves to brass, because
// MTG's own visual language already calls multicolor cards "gold" and brass IS
// the house gold. That coincidence is the reason this mapping stays harmonious.

const MTG_PIGMENTS: Record<string, { hex: string; label: string }> = {
  // Plains ivory — warm bone, not white (white-on-paper would vanish).
  W: { hex: "#BFA878", label: "White" },
  // Island slate — blue pulled toward teal-grey so it reads as ink, not UI-blue.
  U: { hex: "#4E7590", label: "Blue" },
  // Swamp aubergine — warm near-black with a violet cast, never pure grey.
  B: { hex: "#4A4148", label: "Black" },
  // Mountain oxide — a sibling of the existing Loss red (#A64B3F), on purpose:
  // the palette already contains this pigment, so red costs no new vocabulary.
  R: { hex: "#A8563F", label: "Red" },
  // Forest moss — a lighter sibling of the existing Gain green (#2C5E44).
  G: { hex: "#4F7355", label: "Green" },
};

/** Brass — the house accent, and MTG's own "gold" for multicolor cards. */
const MTG_MULTICOLOR = { hex: "#9C7C4D", label: "Multicolor" };

/**
 * Resolve an MTG accent from Scryfall's `color_identity`.
 * `[]` (artifacts, colorless, most lands) is a real answer, not missing data —
 * it returns the neutral pigment, leaving the reveal as flat as it is today.
 */
export function accentFromColorIdentity(identity: readonly string[] | null | undefined): CardAccent {
  if (!identity || identity.length === 0) return NEUTRAL_ACCENT;

  if (identity.length > 1) {
    return { ...MTG_MULTICOLOR, source: "mtg-identity" };
  }

  const pigment = MTG_PIGMENTS[identity[0].toUpperCase()];
  if (!pigment) return NEUTRAL_ACCENT;
  return { ...pigment, source: "mtg-identity" };
}

// ─── Pokémon: energy type ────────────────────────────────────────────────────
// The Pokémon TCG API's `types` is likewise an exact field (["Fire"], ["Water"]).
// Trainer/Energy cards carry no `types` at all — again a real answer, resolved to
// neutral rather than guessed at.

const POKEMON_PIGMENTS: Record<string, { hex: string; label: string }> = {
  fire: { hex: "#B4623A", label: "Fire" },
  water: { hex: "#4E7590", label: "Water" },
  grass: { hex: "#4F7355", label: "Grass" },
  // Lightning as antique amber, NOT yellow — saturated yellow is the single
  // fastest way to make a warm-neutral page look like a toy.
  lightning: { hex: "#A8842F", label: "Lightning" },
  psychic: { hex: "#7A5470", label: "Psychic" },
  // Leather brown, kept clearly cooler/darker than Fire so the two never blur.
  fighting: { hex: "#8C6248", label: "Fighting" },
  darkness: { hex: "#3E4147", label: "Darkness" },
  metal: { hex: "#6E7378", label: "Metal" },
  fairy: { hex: "#A56576", label: "Fairy" },
  dragon: { hex: "#8A6B3E", label: "Dragon" },
  colorless: { hex: NEUTRAL_HEX, label: "Colorless" },
};

/**
 * Resolve a Pokémon accent from the API's `types` array. Dual-type cards take
 * the FIRST type — that is the card's primary energy identity and the one its
 * own frame is printed in, so it is the honest choice rather than a blend.
 */
export function accentFromPokemonTypes(types: readonly string[] | null | undefined): CardAccent {
  if (!types || types.length === 0) return NEUTRAL_ACCENT;
  const pigment = POKEMON_PIGMENTS[types[0].trim().toLowerCase()];
  if (!pigment) return NEUTRAL_ACCENT;
  if (pigment.hex === NEUTRAL_HEX) return { ...NEUTRAL_ACCENT, label: pigment.label };
  return { ...pigment, source: "pokemon-type" };
}

// ─── The house clamp ────────────────────────────────────────────────────────
// A sampled art color arrives with whatever saturation and lightness the
// printer used — often far outside the palette. Rather than trusting it, keep
// only its HUE (the one genuinely card-specific signal) and re-impose the same
// saturation/lightness discipline the curated pigments above already obey.
// This is what makes the extracted path safe: it can pick a surprising hue, but
// it cannot pick a garish color.

/** Target discipline, measured off the curated pigments above. */
const CLAMP_SATURATION = 0.34;
const CLAMP_LIGHTNESS = 0.42;
/** Brass hue, in degrees. Sampled hues are nudged this far toward it so even a
 *  cool extraction keeps the warm bias of the brand. */
const BRASS_HUE = 36;
const WARM_PULL = 0.18;

export interface Hsl {
  h: number; // 0–360
  s: number; // 0–1
  l: number; // 0–1
}

export function hexToHsl(hex: string): Hsl {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  return rgbToHsl(r * 255, g * 255, b * 255);
}

/** rgb components in 0–255. */
export function rgbToHsl(r255: number, g255: number, b255: number): Hsl {
  const r = r255 / 255;
  const g = g255 / 255;
  const b = b255 / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h: h * 360, s, l };
}

export function hslToHex({ h, s, l }: Hsl): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0] :
    hp < 2 ? [x, c, 0] :
    hp < 3 ? [0, c, x] :
    hp < 4 ? [0, x, c] :
    hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  const to = (v: number) => Math.round(Math.min(255, Math.max(0, (v + m) * 255))).toString(16).padStart(2, "0");
  return `#${to(r1)}${to(g1)}${to(b1)}`;
}

/** Shortest-path interpolation between two hues, in degrees. */
function mixHue(from: number, to: number, amount: number): number {
  const delta = ((to - from + 540) % 360) - 180;
  return (from + delta * amount + 360) % 360;
}

/**
 * Pull an arbitrary color into the house palette: keep its hue, optionally nudge
 * that hue toward brass, and re-impose the curated saturation/lightness. The
 * result is always a legal Aura pigment, whatever went in.
 *
 * ⚠ `warmPull` defaults to 0, and the design review is why. Rotating hues toward
 * brass sounds like the obvious way to keep a sampled color "on brand", but
 * measured on real cards it does two unacceptable things:
 *
 *   1. It rotates the WRONG WAY out of blue. Brass sits at 36°, and the shortest
 *      arc from a blue ~231° reaches it through purple, so blue Counterspell
 *      clamped to #5E4790 — a violet wash on a blue card.
 *   2. It COLLAPSES distinct cards together. Every cool hue converges on the
 *      same teal band: three different cards landed on #479084, #479085 and
 *      #479075 — visually one color, which destroys the entire premise that
 *      every reveal should look different because every card is different.
 *
 * Clamping saturation and lightness alone achieves the "no neon" goal without
 * either failure. The parameter is kept so the comparison stays reproducible.
 */
export function clampToHouse(hex: string, warmPull: number = 0): string {
  const { h, s } = hexToHsl(hex);
  // A near-grey sample carries no usable hue — don't invent one from noise.
  if (s < 0.06) return NEUTRAL_HEX;
  return hslToHex({
    h: warmPull > 0 ? mixHue(h, BRASS_HUE, warmPull) : h,
    s: CLAMP_SATURATION,
    l: CLAMP_LIGHTNESS,
  });
}

/** The warm-pull strength the review measured and rejected. Exported only so the
 *  design-comparison route can render the rejected arm side by side. */
export const REVIEWED_WARM_PULL = WARM_PULL;
