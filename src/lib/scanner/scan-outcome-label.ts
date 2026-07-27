// ─── Outcome labels on an accepted scan (Scanner V2) ─────────────────────────
// The write side of confirmation/rejection telemetry: when a collector keeps or
// declines a printing the scanner auto-accepted, that verdict lands on the scan
// row that produced it.
//
// WHY THIS MODULE EXISTS RATHER THAN INLINE CODE IN TWO ROUTES
// Both writes must hold the same three properties, and two hand-rolled copies
// would drift:
//
//   1. UPDATE ONLY, NEVER CREATE. Every scan-volume figure in the product is a
//      row count over ScanHistory — the admin "Total Scans" tile
//      (scanHistory.count) and the per-user daily scan limit (a filtered
//      scanHistory.count in the scan route). A label that inserted a row would
//      inflate both: it would report scans that never happened, and it would
//      consume collectors' daily quota for adding a card they already scanned.
//      `updateMany` with a scoped filter cannot insert.
//
//   2. NO COLUMN BUT ocrText. Notably NOT matchMethod: the learning-rule cron
//      (api/cron/analyze-scans) reads matchMethod === "user-selection" as its
//      FAILURE signal, so writing a method here would teach the system that
//      successful confirmations were failures. Everything this records lives
//      inside the versioned telemetry JSON, where new keys are additive by
//      construction.
//
//   3. SCOPED TO THE OWNER. userId is part of the WHERE clause, not checked
//      after the fact, so a caller cannot label another collector's scan by
//      guessing an id.
//
// FAIL-SILENT BY DESIGN. Every function returns a boolean and never throws. A
// label is observational; losing one costs a data point. Letting its failure
// propagate would cost the collector the add itself — trading the thing the user
// came for against a measurement, which is the wrong way round.

import { dbRetry, prisma } from "@/lib/prisma";
import { withConfirmation, withRejection } from "@/lib/scanner/telemetry";

/** Minimal structural view of the reads/writes here, so tests can inject a fake
 *  instead of touching the production database. */
export interface ScanLabelDb {
  scanHistory: {
    findFirst(args: unknown): Promise<{ id: string; ocrText: string | null } | null>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
}

const defaultDb = prisma as unknown as ScanLabelDb;

/** Read-modify-write of one scan's telemetry JSON, owner-scoped. */
async function appendLabel(
  scanId: string,
  userId: string,
  apply: (raw: string | null) => string,
  db: ScanLabelDb,
): Promise<boolean> {
  // Owner-scoped read: a scan belonging to someone else simply isn't found.
  const row = await dbRetry(() =>
    db.scanHistory.findFirst({
      where: { id: scanId, userId },
      select: { id: true, ocrText: true },
    }),
  );
  if (!row) return false;

  // updateMany, not update: it cannot create, and it keeps the ownership filter
  // in the same statement that writes, so the row cannot change hands between
  // the read and the write.
  const res = await dbRetry(() =>
    db.scanHistory.updateMany({
      where: { id: scanId, userId },
      data: { ocrText: apply(row.ocrText) },
    }),
  );
  return res.count > 0;
}

/**
 * Record that the collector ADDED the printing this scan accepted.
 *
 * `externalId` is what they actually added — pass the observed value, never the
 * scan's own accepted id, or the record can no longer distinguish a
 * confirmation from an overturn.
 */
export async function recordScanConfirmation(input: {
  scanId: string;
  userId: string;
  externalId: string;
  game?: string;
  db?: ScanLabelDb;
}): Promise<boolean> {
  const { scanId, userId, externalId, game, db = defaultDb } = input;
  try {
    return await appendLabel(scanId, userId, (raw) => withConfirmation(raw, { externalId, game }), db);
  } catch (err) {
    console.warn("[Scanner] confirmation label not recorded:", (err as Error)?.message);
    return false;
  }
}

/** Record that the collector DECLINED the printing this scan accepted. */
export async function recordScanRejection(input: {
  scanId: string;
  userId: string;
  rejectedExternalId?: string;
  replacedByExternalId?: string;
  game?: string;
  db?: ScanLabelDb;
}): Promise<boolean> {
  const { scanId, userId, rejectedExternalId, replacedByExternalId, game, db = defaultDb } = input;
  try {
    return await appendLabel(
      scanId,
      userId,
      (raw) => withRejection(raw, { rejectedExternalId, replacedByExternalId, game }),
      db,
    );
  } catch (err) {
    console.warn("[Scanner] rejection label not recorded:", (err as Error)?.message);
    return false;
  }
}
