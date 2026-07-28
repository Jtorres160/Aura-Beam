-- Scanner V2 · M-CATALOG follow-on (PR #14) — price sweep rotation column
-- Branch: fix/catalog-price-sweep-throughput
--
-- Same discipline as docs/scanner-v2/M-CATALOG-schema.sql and M1-B-schema.sql:
-- this repo has NO prisma/migrations directory. This file is the authoritative,
-- reviewable record of the raw SQL applied BY HAND against DIRECT_URL (the
-- direct, non-pooled Supabase connection — never the pgbouncer pooler URL):
--
--   npx prisma db execute --file docs/scanner-v2/M-CATALOG-M14-schema.sql \
--     --url "$DIRECT_URL"
--
-- IMPORTANT — what this deliberately does NOT include: `prisma migrate diff`
-- against this same schema change also emits, as pre-existing cosmetic drift
-- Prisma cannot model (pgvector/bit HNSW indexes on card_fingerprints):
--     DROP INDEX "card_fingerprints_embedding_hnsw";
--     DROP INDEX "card_fingerprints_phash_hnsw";
--     ALTER TABLE "card_fingerprints" ALTER COLUMN "pHash" SET DATA TYPE bit(64);
-- Applying those would blind the fingerprint sensor. Never run `prisma db push`
-- bare on this database — see docs/scanner-v2/M-CATALOG-schema.sql and
-- the aura-database-topology memory for why.
--
-- Non-destructive: pure additive ADD COLUMN (nullable) + CREATE INDEX. No
-- existing column is altered or dropped, no existing row is touched.
--
-- priceUpdatedAt = when a PRICE was last actually written (freshness shown to
-- a collector). priceCheckedAt = when we last ASKED, regardless of answer —
-- the sweep's rotation key. Without the split, a card the upstream quotes no
-- price for keeps stale priceUpdatedAt forever and is re-fetched every run
-- while the rest of the catalog starves. Null sorts first, so every existing
-- row correctly starts at the head of the rotation.

ALTER TABLE "catalog_cards" ADD COLUMN IF NOT EXISTS "priceCheckedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "catalog_cards_game_priceCheckedAt_idx"
    ON "catalog_cards"("game", "priceCheckedAt");
