-- Scanner V2 · M-CATALOG (M2) — local Pokémon catalog table (schema only, no data)
-- Branch: feature/scanner-v2-catalog
--
-- Same discipline as docs/scanner-v2/M1-B-schema.sql: this repo has NO
-- prisma/migrations directory. This file is the authoritative, reviewable record
-- of the raw SQL applied BY HAND against DIRECT_URL (the direct, non-pooled
-- Supabase connection — never the pgbouncer pooler URL):
--
--   npx prisma db execute --file docs/scanner-v2/M-CATALOG-schema.sql \
--     --url "$DIRECT_URL"
--
-- The CREATE TABLE + index bodies are VERBATIM from
--   npx prisma migrate diff --from-url <DIRECT_URL> \
--     --to-schema-datamodel prisma/schema.prisma --script
-- (only IF NOT EXISTS was added, so the file is safely re-runnable; that changes
-- nothing about the resulting schema, so `db push` / `migrate diff` still agree
-- with prisma/schema.prisma's CatalogCard model afterward).
--
-- IMPORTANT — what this file deliberately OMITS from that same diff output:
-- because Prisma cannot express card_fingerprints' pgvector/bit HNSW indexes,
-- `migrate diff` ALSO emits, as cosmetic drift, two lines we must NEVER apply:
--     DROP INDEX "card_fingerprints_embedding_hnsw";
--     DROP INDEX "card_fingerprints_phash_hnsw";
-- plus a no-op `ALTER COLUMN "pHash" SET DATA TYPE bit(64)`. Applying the DROPs
-- would blind the fingerprint sensor. This milestone touches CATALOG DATA ONLY —
-- those lines are excluded here on purpose (same quirk M1-B-schema.sql documents).
--
-- Non-destructive: pure additive CREATE. No existing table is altered or dropped.

-- Local card catalog. Columns are exactly the fields formatPokemonCard() emits,
-- so a row maps 1:1 to a CandidatePrinting. externalId is the shared join key to
-- cards + card_fingerprints. Prices seeded at import, refreshed by the M5 cron.
CREATE TABLE IF NOT EXISTS "catalog_cards" (
    "id"              TEXT NOT NULL,
    "externalId"      TEXT NOT NULL,
    "game"            TEXT NOT NULL DEFAULT 'POKEMON',
    "name"            TEXT NOT NULL,
    "setName"         TEXT NOT NULL,
    "setCode"         TEXT,
    "setPrintedSize"  INTEGER,
    "collectorNumber" TEXT,
    "rarity"          TEXT NOT NULL DEFAULT 'Common',
    "imageUrl"        TEXT,
    "thumbnailUrl"    TEXT,
    "marketPrice"     DOUBLE PRECISION,
    "lowPrice"        DOUBLE PRECISION,
    "midPrice"        DOUBLE PRECISION,
    "highPrice"       DOUBLE PRECISION,
    "priceUpdatedAt"  TIMESTAMP(3),
    "sourceUpdatedAt" TIMESTAMP(3),
    "importedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,
    CONSTRAINT "catalog_cards_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "catalog_cards_externalId_key"
    ON "catalog_cards"("externalId");

CREATE INDEX IF NOT EXISTS "catalog_cards_game_setCode_collectorNumber_idx"
    ON "catalog_cards"("game", "setCode", "collectorNumber");

CREATE INDEX IF NOT EXISTS "catalog_cards_game_name_idx"
    ON "catalog_cards"("game", "name");
