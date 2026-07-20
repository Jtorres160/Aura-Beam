-- Scanner V2 · Milestone 1-B — pgvector + CardFingerprint (schema only, no data)
-- Branch: feature/scanner-v2
--
-- This repo has NO prisma/migrations directory; schema changes go through
-- `prisma db push`. Prisma cannot emit pgvector's `CREATE EXTENSION` or the
-- HNSW index definitions (the `vector`/`bit` columns are Unsupported(...) in
-- schema.prisma), so this file is the authoritative, reviewable record of the
-- raw SQL that was applied by hand against DIRECT_URL (the direct, non-pooled
-- Supabase connection — never the pgbouncer pooler URL).
--
-- Order of application matters: extension first (so the column types exist),
-- then the table, then the HNSW indexes. The table + its two btree indexes are
-- verbatim from `prisma migrate diff --from-url <DIRECT_URL>
-- --to-schema-datamodel prisma/schema.prisma --script`, so `db push` and this
-- file agree. Re-running is safe (IF NOT EXISTS throughout except the table).
--
-- Known cosmetic quirk: `prisma migrate diff` re-emits a no-op
--   ALTER TABLE "card_fingerprints" ALTER COLUMN "pHash" SET DATA TYPE bit(64);
-- because it cannot introspect the length of an Unsupported bit type. The
-- physical column is genuinely bit(64) (verified via information_schema:
-- character_maximum_length = 64). Ignore that drift line.

-- 1) Extension (Supabase ships pgvector 0.8.0; enables `vector` + `bit` HNSW ops)
CREATE EXTENSION IF NOT EXISTS vector;

-- 2) Table (verbatim from `prisma migrate diff`)
CREATE TABLE "card_fingerprints" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "game" TEXT NOT NULL DEFAULT 'POKEMON',
    "setCode" TEXT,
    "collectorNumber" TEXT,
    "imageUrl" TEXT NOT NULL,
    "sourceUpdatedAt" TIMESTAMP(3),
    "pHash" bit(64),
    "embedding" vector(512),
    "embeddingModel" TEXT NOT NULL DEFAULT 'mobileclip_s2',
    "builtAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "card_fingerprints_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "card_fingerprints_externalId_key" ON "card_fingerprints"("externalId");
CREATE INDEX "card_fingerprints_game_setCode_collectorNumber_idx" ON "card_fingerprints"("game", "setCode", "collectorNumber");

-- 3) HNSW indexes (raw SQL — Prisma cannot express these)
--    Primary ANN: cosine over the L2-normalized MobileCLIP-S2 embedding.
CREATE INDEX IF NOT EXISTS card_fingerprints_embedding_hnsw
    ON card_fingerprints USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

--    Coarse pre-filter: Hamming ANN over the 64-bit perceptual hash.
CREATE INDEX IF NOT EXISTS card_fingerprints_phash_hnsw
    ON card_fingerprints USING hnsw ("pHash" bit_hamming_ops)
    WITH (m = 16, ef_construction = 64);
