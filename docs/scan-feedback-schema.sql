-- ─── ScanFeedback table ──────────────────────────────────────────────────────
-- Additive DDL for the `scan_feedback` table (prisma/schema.prisma → model
-- ScanFeedback). Run this against the database BEFORE deploying the scanner
-- "Report an issue" affordance; until the table exists, every submitted report
-- returns a 500 and the UI correctly tells the tester it was not received.
--
-- ─── WHY THIS IS A HAND-WRITTEN FILE AND NOT `prisma db push` ────────────────
--
-- This repo has no migrations directory, so `db push` is the usual path. Do NOT
-- use it here. `prisma migrate diff` against the live database on 2026-07-30
-- reported three changes besides this table:
--
--   DROP INDEX card_fingerprints_embedding_hnsw;
--   DROP INDEX card_fingerprints_phash_hnsw;
--   ALTER TABLE card_fingerprints ALTER COLUMN "pHash" SET DATA TYPE bit(64);
--
-- Those are pgvector/bit HNSW indexes that Prisma's schema language cannot
-- represent, so it reads them as drift and would DROP them. A push would take
-- out the fingerprint index's query path as a side effect of adding a feedback
-- table. (It would also apply the unrelated in-progress `catalog_cards.types`
-- column from the design branch.)
--
-- Everything below is additive: one new table, three indexes, two foreign keys.
-- It touches nothing that already exists.

CREATE TABLE IF NOT EXISTS "scan_feedback" (
    "id"           TEXT NOT NULL,
    "userId"       TEXT NOT NULL,
    -- One of SCAN_FEEDBACK_CATEGORIES (src/lib/scanner/scan-feedback.ts),
    -- validated at the route boundary.
    "category"     TEXT NOT NULL,
    -- One of SCAN_FEEDBACK_SURFACES: 'result' | 'error'.
    "surface"      TEXT NOT NULL,
    "message"      TEXT,
    -- Scan context, copied from client state at report time. All nullable:
    -- a value we do not have is stored as NULL, never a placeholder.
    "scanId"       TEXT,
    "cardId"       TEXT,
    "cardName"     TEXT,
    "confidence"   INTEGER,
    "matchMethod"  TEXT,
    "failureStage" TEXT,
    "game"         TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scan_feedback_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "scan_feedback_createdAt_idx"
    ON "scan_feedback"("createdAt");
CREATE INDEX IF NOT EXISTS "scan_feedback_userId_createdAt_idx"
    ON "scan_feedback"("userId", "createdAt");
-- Joins a report back to the ScanHistory row it is about. Deliberately not a
-- foreign key: a report must survive its scan row, and a scan that never
-- produced a row at all can still be reported on.
CREATE INDEX IF NOT EXISTS "scan_feedback_scanId_idx"
    ON "scan_feedback"("scanId");

-- Deleting a user removes their reports. Deleting a card must NOT remove the
-- complaint about it — that is precisely the record worth keeping.
ALTER TABLE "scan_feedback"
    ADD CONSTRAINT "scan_feedback_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "scan_feedback"
    ADD CONSTRAINT "scan_feedback_cardId_fkey"
    FOREIGN KEY ("cardId") REFERENCES "cards"("id") ON DELETE SET NULL ON UPDATE CASCADE;
