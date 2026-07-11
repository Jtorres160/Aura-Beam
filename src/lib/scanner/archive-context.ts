import { prisma } from "@/lib/prisma";

// ─── Archive Context (Phase 5 · Batch 2) ────────────────────────────────────
// Answers "what does this card mean in MY collection?" at the moment of
// recognition. Read-only, computed AFTER identification succeeds, and shared
// by the two save paths (scan auto-accept and disambiguation selection) so
// both respond with identical context.
//
// This deliberately runs before the user decides to add the card — it
// describes the archive as it stands, so the result screen can say
// "already in your archive ×2" or "first from this set".

export interface ArchiveContext {
  /** The user already holds this exact printing. */
  inCollection: boolean;
  /** Copies held (0 when not in collection). */
  quantity: number;
  /** When the first copy was filed (ISO string), null if not held. */
  addedAt: string | null;
  /** Distinct cards the user holds from this same set (this game). */
  setOwnedCount: number;
  setName: string;
}

/**
 * Failure-safe by contract: any error returns null so a context lookup can
 * never fail a scan response. Callers treat null as "no context available".
 */
export async function getArchiveContext(
  userId: string,
  card: { id: string; setName: string; game: string }
): Promise<ArchiveContext | null> {
  try {
    const collection = await prisma.collection.findFirst({
      where: { userId },
      select: { id: true },
    });
    if (!collection) {
      return {
        inCollection: false,
        quantity: 0,
        addedAt: null,
        setOwnedCount: 0,
        setName: card.setName,
      };
    }

    const [entry, setOwnedCount] = await Promise.all([
      prisma.collectionCard.findUnique({
        where: {
          collectionId_cardId: { collectionId: collection.id, cardId: card.id },
        },
        select: { quantity: true, addedAt: true },
      }),
      prisma.collectionCard.count({
        where: {
          collectionId: collection.id,
          card: { setName: card.setName, game: card.game },
        },
      }),
    ]);

    return {
      inCollection: !!entry,
      quantity: entry?.quantity ?? 0,
      addedAt: entry?.addedAt.toISOString() ?? null,
      setOwnedCount,
      setName: card.setName,
    };
  } catch (err) {
    console.warn("[ArchiveContext] Lookup failed (non-fatal):", (err as Error)?.message);
    return null;
  }
}
