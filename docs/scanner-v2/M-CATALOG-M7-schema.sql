-- ─── Scanner V2 · M-CATALOG · M7 — recency ordering ─────────────────────────
-- Adds the set release date to catalog_cards so candidate generation can offer
-- the NEWEST printings of a name first, matching the live path it replaced.
--
-- Why this exists: catalogFetchAllPrintings caps at 20 printings. It originally
-- ordered by setName asc, which sorts alphabetically and therefore buried the
-- newest sets — a real Vulpix from Mega Evolution (me1-138) fell past position
-- 20 behind "McDonald's Collection 2016" and could not be picked by the user.
-- The cap makes ordering load-bearing: it decides which candidates exist at all.
--
-- Applied by hand against the production DB (this project has no migrations
-- directory — see the aura-database-topology note). Written idempotently and
-- kept additive on purpose:
--   • the column is NULLABLE, so it is a metadata-only change: no table rewrite,
--     no lock beyond the brief catalog ACCESS EXCLUSIVE for the ADD COLUMN, and
--     existing rows/readers are unaffected until the backfill populates it.
--   • ordering places NULLs last, so rows are correct (just recency-unranked)
--     in the window between this DDL and the backfill.
--
-- Deliberately NOT applied via `prisma db push`: the pending diff also contains
-- `ALTER TABLE card_fingerprints ALTER COLUMN "pHash" SET DATA TYPE bit(64)`,
-- which is a Prisma round-trip artifact (the column is ALREADY bit(64)) and
-- would needlessly rewrite 20,429 fingerprint rows. Scope stays on this fix.
--
-- Backfill: scripts/backfill-catalog-release-dates.mjs (set-level, idempotent).

ALTER TABLE "catalog_cards"
  ADD COLUMN IF NOT EXISTS "setReleaseDate" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "catalog_cards_game_name_setReleaseDate_idx"
  ON "catalog_cards" ("game", "name", "setReleaseDate");
