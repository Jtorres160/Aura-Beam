// ─── Bottom-strip crop (Scanner V2 · M3-B) ──────────────────────────────────
// The strip-read pass (extractBottomStrip) only cares about the set-code /
// collector-number line printed along the card's BOTTOM EDGE. Today it ships the
// WHOLE card image at detail:"high" and asks the model to ignore everything else
// — the model still pays to tile and parse the art, title, and rules text.
//
// This crops to just that bottom band before the call. The crop RATIO is the one
// M3-A validated against 29 real cards spanning WOTC-1999→2024 + secret rares
// (docs/scanner-v2/m3-harness/download_crop.js): the bottom 14% of the card,
// full width, contained the relevant text on every card in that sample. The
// client already crops to the guide-box ROI before upload (ROI_CAPTURE_PAD in
// capture.ts), so the image arriving here is already roughly card-shaped — the
// 14% band lands on the real bottom border, not on background.
//
// SAFETY: this is a best-effort optimization, never a new failure mode. If the
// input is not a data URI, or sharp can't decode it, or the dimensions are
// unexpected, we return the ORIGINAL input unchanged and the strip-read proceeds
// exactly as it does today. A crop failure must never take down the strip-read.

import sharp from "sharp";

/** Fraction of card height, measured from the bottom, the strip crop keeps. */
export const STRIP_BAND_FRACTION = 0.14;

/**
 * Crop `imageDataUri` to its bottom-{STRIP_BAND_FRACTION} full-width band and
 * return a new data URI (JPEG). On ANY problem — non-data-URI input, decode
 * failure, degenerate dimensions, sharp error — returns the original input
 * unchanged so the caller's behavior degrades to sending the full image.
 *
 * The crop is RAW color (no grayscale/normalize): that preprocessing helped
 * classical OCR in the M3-A harness but only hurts a vision model, which wants
 * the real pixels.
 */
export async function cropBottomStrip(imageDataUri: string): Promise<string> {
  try {
    // Only data URIs are croppable here; an http(s) URL would need a fetch we
    // deliberately don't do. Anything else falls straight through unchanged.
    if (!imageDataUri.startsWith("data:")) return imageDataUri;

    const comma = imageDataUri.indexOf(",");
    if (comma < 0) return imageDataUri;
    const buffer = Buffer.from(imageDataUri.slice(comma + 1), "base64");
    if (buffer.length === 0) return imageDataUri;

    const image = sharp(buffer, { failOn: "none" });
    const { width, height } = await image.metadata();
    if (!width || !height || height < 10) return imageDataUri;

    const top = Math.round(height * (1 - STRIP_BAND_FRACTION));
    const bandHeight = height - top;
    // Defensive: a band must be a positive, sane slice inside the image.
    if (bandHeight < 1 || top < 0 || top + bandHeight > height) return imageDataUri;

    const cropped = await image
      .extract({ left: 0, top, width, height: bandHeight })
      .jpeg({ quality: 90 })
      .toBuffer();
    if (cropped.length === 0) return imageDataUri;

    return `data:image/jpeg;base64,${cropped.toString("base64")}`;
  } catch {
    // Corrupt image, unexpected format, sharp failure — send the original.
    return imageDataUri;
  }
}
