// ═══════════════════════════════════════════════════════════
// Aura — Dominant art color (design exploration, Phase R1)
// ═══════════════════════════════════════════════════════════
// The second candidate source for a card's reveal accent: sample the printed
// ARTWORK and take its dominant hue. Client-only — it needs a canvas.
//
// Why this exists alongside card-color.ts's structured mapping: color identity
// is exact but only exists where a game publishes it (MTG mana, Pokémon energy).
// Yu-Gi-Oh! has no equivalent field, and neither do Trainer/Energy/land cards.
// Extraction always produces something, at the cost of being a DERIVED value —
// weaker evidence, and fuzzier. Feed the result through clampToHouse() so a
// surprising hue can never become a garish color.
//
// Both image CDNs the app serves cards from send `Access-Control-Allow-Origin: *`
// (verified: cards.scryfall.io, images.pokemontcg.io), so the pixels can be read
// back without tainting a canvas. A CDN that ever stops doing so fails CLOSED
// here — the caller gets null and the reveal stays flat, which is the correct
// behavior: an unavailable derivation is not a color.
//
// ⚠ THE CACHE-MODE COLLISION — measured, not theorised. The reveal's own <img>
// has already fetched the identical URL in NO-CORS mode. Chrome then serves that
// cache entry to any later CORS-mode read of the same URL, and the entry carries
// no CORS approval, so the read fails. Both obvious spellings hit this:
//   `new Image(); img.crossOrigin = "anonymous"` → onerror
//   `fetch(url, {mode: "cors"})`                → TypeError: Failed to fetch
// A/B'd in the browser across all six preview cards: `cache: "default"` failed
// on every URL the DOM had already loaded and `cache: "reload"` succeeded on
// every one. So the extraction below forces a fresh, cache-bypassing request.
//
// That is a REAL COST of this approach, not an implementation detail: reading a
// card's art color costs a second full download of a 130KB–690KB image at the
// reveal moment, on top of the copy the browser already has. Weigh it against
// the structured-identity path in card-color.ts, which costs zero bytes.

import { rgbToHsl, hslToHex } from "./card-color";

/** Art window, as a fraction of the card image. Both games print their
 *  illustration in the upper-middle of the standard frame, so one window serves
 *  both. It deliberately excludes the name bar, the type/HP line and the text
 *  box — sampling those would return "the color of black ink on cardstock".
 *  Full-art and extended-art printings put artwork outside this window too;
 *  that only means the sample is a subset of the art, not the wrong region. */
const ART_WINDOW = { top: 0.12, bottom: 0.5, left: 0.1, right: 0.9 };

/** Downsample width. The dominant hue of an illustration survives aggressive
 *  downsampling, and this keeps the whole read under a frame's worth of work. */
const SAMPLE_WIDTH = 48;

/** 24 bins × 15° — fine enough to separate red from orange, coarse enough that
 *  print noise and JPEG ringing land in the same bin as the color they belong to. */
const HUE_BINS = 24;

export interface ArtColorReading {
  /** Dominant color as sampled, before any palette discipline is applied. */
  rawHex: string;
  /** Share of usable pixels that fell in the winning hue bin (0–1). A low share
   *  means the art has no dominant hue — the caller may prefer to stay flat. */
  dominance: number;
}

/**
 * Sample the dominant art color of a card image. Resolves null when the image
 * cannot be read (network, CORS, or an image with no usable chroma at all).
 * Never throws.
 */
export async function extractArtColor(src: string): Promise<ArtColorReading | null> {
  try {
    const bitmap = await loadBitmap(src);
    if (!bitmap) return null;
    const w = SAMPLE_WIDTH;
    const h = Math.max(1, Math.round((bitmap.height / bitmap.width) * w));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();

    const x0 = Math.floor(w * ART_WINDOW.left);
    const x1 = Math.ceil(w * ART_WINDOW.right);
    const y0 = Math.floor(h * ART_WINDOW.top);
    const y1 = Math.ceil(h * ART_WINDOW.bottom);
    const { data } = ctx.getImageData(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));

    // Weighted hue histogram. Weight by saturation so a large flat grey sky
    // cannot outvote the actual subject, and skip pixels with no usable chroma
    // (near-black borders, blown highlights, unsaturated card stock).
    const weight = new Array<number>(HUE_BINS).fill(0);
    const pixels = new Array<number>(HUE_BINS).fill(0);
    const sumS = new Array<number>(HUE_BINS).fill(0);
    const sumL = new Array<number>(HUE_BINS).fill(0);
    const sumSin = new Array<number>(HUE_BINS).fill(0);
    const sumCos = new Array<number>(HUE_BINS).fill(0);
    let usable = 0;

    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 200) continue; // transparent
      const { h: hue, s, l } = rgbToHsl(data[i], data[i + 1], data[i + 2]);
      if (s < 0.12 || l < 0.1 || l > 0.92) continue;
      const bin = Math.floor((hue / 360) * HUE_BINS) % HUE_BINS;
      const rad = (hue * Math.PI) / 180;
      weight[bin] += s;
      pixels[bin] += 1;
      sumS[bin] += s;
      sumL[bin] += l;
      sumSin[bin] += Math.sin(rad) * s;
      sumCos[bin] += Math.cos(rad) * s;
      usable += 1;
    }

    if (usable === 0) return null;

    let best = 0;
    for (let b = 1; b < HUE_BINS; b += 1) if (weight[b] > weight[best]) best = b;
    if (weight[best] <= 0) return null;

    const totalWeight = weight.reduce((a, b) => a + b, 0);
    // Circular mean of the winning bin's hues — a plain arithmetic mean would be
    // wrong for the bin that straddles 0°/360°.
    const meanHue = ((Math.atan2(sumSin[best], sumCos[best]) * 180) / Math.PI + 360) % 360;
    const count = Math.max(1, pixels[best]);

    return {
      rawHex: hslToHex({
        h: meanHue,
        s: Math.min(1, sumS[best] / count),
        l: Math.min(1, sumL[best] / count),
      }),
      dominance: totalWeight > 0 ? weight[best] / totalWeight : 0,
    };
  } catch {
    return null;
  }
}

async function loadBitmap(src: string): Promise<ImageBitmap | null> {
  // cache: "reload" is load-bearing — see the cache-mode collision note above.
  const res = await fetch(src, { mode: "cors", cache: "reload" });
  if (!res.ok) return null;
  return createImageBitmap(await res.blob());
}
