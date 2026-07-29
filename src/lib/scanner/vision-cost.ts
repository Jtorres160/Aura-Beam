// ─── Vision-call cost helpers ────────────────────────────────────────────────
// Shared by the OCR passes (extract.ts) and the artwork comparison (visual.ts).
// Both log what a vision call actually cost; neither reads the result back.

/** Approximate the decoded size of a base64 data URL, for cost logs. */
export function approxImageKB(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  const b64 = comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
  // base64 encodes 3 bytes per 4 chars; good enough for an order-of-magnitude log.
  return Math.round((b64.length * 0.75) / 1024);
}
