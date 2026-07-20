// ─── Scanner V2 · M2-A — Fingerprint Shadow Matcher ─────────────────────────
// Given a card image, find the visually nearest printings in the
// card_fingerprints index (20,429 Pokémon printings, HNSW-indexed on
// `embedding vector_cosine_ops`). This is a SENSOR, not a judge: it returns
// candidate evidence for a later scoring stage, and per the truth boundary it is
// allowed to be *silent* (return null) but never to throw into a caller.
//
// NOT wired into the scan path yet — no scan-path file imports this. Live wiring
// is M2-B. This module exists to be proven correct in isolation first
// (scripts/verify-fingerprint-match.mjs).
//
// CRITICAL: the query embedding MUST be computed identically to the index
// embeddings, or cosine distances are meaningless. The index was built by
// scripts/build-fingerprint-index.mjs using MobileCLIP-S2
// (Xenova/mobileclip_s2), 512-dim, L2-normalized, onnxruntime-node backend. The
// embedding computation below is duplicated VERBATIM from that script's
// computeEmbedding() rather than refactored out of it: that script is a proven
// artifact that already wrote every production row, and refactoring it earns no
// correctness — the proof script empirically confirms the two computations agree
// (re-embedding an indexed image yields distance ≈ 0, which only holds if the
// math is bit-for-bit the same preprocessing + model). Keep the two in sync by
// hand; the proof script is the guard.

import { prisma } from "@/lib/prisma";

const MODEL_ID = "Xenova/mobileclip_s2";

// ─── Feature flag (Scanner V2 · M2-B wiring) ─────────────────────────────────
// Wiring this sensor into the live scan route is explicit opt-in, mirroring
// RECOGNITION_MEMORY_SERVE's gating: even a provably inert shadow sensor stays
// dark until deliberately switched on. Default OFF — when unset, the scan route
// skips the model load, the DB query, and the after() schedule entirely, so the
// live path pays nothing. Enable by setting FINGERPRINT_SHADOW_ENABLED=1.
export const FINGERPRINT_SHADOW_ENABLED = process.env.FINGERPRINT_SHADOW_ENABLED === "1";

export interface FingerprintMatch {
  externalId: string;
  /** Cosine distance in [0, 2]; 0 = identical direction. Lower is closer. */
  distance: number;
}

// ─── Lazy model singleton ────────────────────────────────────────────────────
// Load MobileCLIP-S2 once and reuse across calls. Matters for warm serverless
// invocations later; here it just avoids reloading the model per match. `any` on
// the transformers.js handles is deliberate — the ESM package's types are
// awkward across a dynamic import boundary, and correctness is proven at runtime
// by the self-consistency check, not by these structural types.
let modelPromise: Promise<{ model: any; processor: any; RawImage: any }> | null = null;

function getModel(): Promise<{ model: any; processor: any; RawImage: any }> {
  if (!modelPromise) {
    modelPromise = (async () => {
      const { AutoProcessor, CLIPVisionModelWithProjection, RawImage } = await import(
        "@huggingface/transformers"
      );
      const processor = await AutoProcessor.from_pretrained(MODEL_ID);
      const model = await CLIPVisionModelWithProjection.from_pretrained(MODEL_ID);
      return { model, processor, RawImage };
    })();
  }
  return modelPromise;
}

/**
 * Compute the query embedding as a pgvector literal string, e.g. "[0.1,-0.2,…]".
 *
 * VERBATIM from scripts/build-fingerprint-index.mjs computeEmbedding() — see the
 * header note. Do not "improve" one without the other; the proof script fails
 * loudly if they drift.
 */
async function embedImage(imageBuffer: Buffer): Promise<string> {
  const { model, processor, RawImage } = await getModel();
  // new Uint8Array(buf) is byte-identical to the Buffer the builder passed to
  // `new Blob([imgBuffer])`; it just satisfies the DOM BlobPart type cleanly.
  const image = await RawImage.fromBlob(new Blob([new Uint8Array(imageBuffer)]));
  const inputs = await processor(image);
  const { image_embeds } = await model(inputs);
  const raw = Array.from(image_embeds.data as ArrayLike<number>);
  const norm = Math.sqrt(raw.reduce((s, v) => s + v * v, 0)) || 1;
  const unit = raw.map((v) => v / norm);
  return `[${unit.map((v) => v.toFixed(7)).join(",")}]`;
}

/**
 * Find the visually nearest indexed printings to `imageBuffer`.
 *
 * @returns the top-5 matches (ascending cosine distance), or `null` when there
 *   is no index to consult (unsupported game) or anything went wrong. Never
 *   throws — a shadow sensor may go dark, but it must not break its caller.
 *   An empty array means "the index was consulted and holds nothing for this
 *   game" (not expected for POKEMON, but not assumed).
 */
export async function matchFingerprint(
  imageBuffer: Buffer,
  game: string,
): Promise<FingerprintMatch[] | null> {
  // No fingerprint index exists for MTG/YUGIOH yet — degrade silently.
  if (game !== "POKEMON") return null;

  try {
    const embedding = await embedImage(imageBuffer);
    // Parameterized: the embedding is bound as $1 (cast to vector), game as $2.
    // The ORDER BY repeats the same distance expression so the HNSW index on
    // `embedding vector_cosine_ops` drives the ANN scan; LIMIT 5 bounds it.
    const rows = await prisma.$queryRaw<Array<{ externalId: string; distance: number }>>`
      SELECT "externalId", (embedding <=> ${embedding}::vector) AS distance
      FROM card_fingerprints
      WHERE game = ${game}
      ORDER BY embedding <=> ${embedding}::vector
      LIMIT 5
    `;
    return rows.map((r) => ({ externalId: r.externalId, distance: Number(r.distance) }));
  } catch (err) {
    console.error("[fingerprint-match] match failed:", (err as Error)?.message ?? err);
    return null;
  }
}
