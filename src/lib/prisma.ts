import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

// ─── Transient-failure retry (Phase 5.2.5) ──────────────────────────────────
// Serverless Postgres drops connections between invocations; those one-off
// connection errors were surfacing to users as scan failures. Retry ONCE, only
// for errors that are clearly connection/pool trouble — never for constraint
// violations or anything that could mean the first attempt half-succeeded
// semantically.

/** Prisma error codes for connection/pool trouble (P1xxx = can't reach or
 *  keep a connection; P2024 = connection pool timeout). */
const TRANSIENT_PRISMA_CODES = new Set(["P1001", "P1002", "P1008", "P1017", "P2024"]);

export function isTransientDbError(err: unknown): boolean {
  const e = err as { code?: string; name?: string; message?: string };
  if (e?.code && TRANSIENT_PRISMA_CODES.has(e.code)) return true;
  if (e?.name === "PrismaClientInitializationError") return true;
  const msg = e?.message ?? "";
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|Connection terminated|Closed by the server/i.test(msg);
}

/** Run a DB operation, retrying exactly once after a short beat when the
 *  failure looks transient. Use only for idempotent(-enough) operations. */
export async function dbRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isTransientDbError(err)) throw err;
    console.warn("[DB] Transient error — retrying once:", (err as Error)?.message);
    await new Promise((r) => setTimeout(r, 250));
    return await fn();
  }
}
