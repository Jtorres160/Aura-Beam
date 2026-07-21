// Shape and safe projection of a user row for the admin user list. Kept as a
// pure module (no Prisma import) so the "what fields leave the server" rule is
// unit-testable and lives in exactly one place.
//
// SECURITY: the API allow-lists these fields in its Prisma `select`, so
// passwordHash and any future sensitive column never reach this code. This
// serializer is the second line of the same principle: it constructs the output
// object field by field, so even a raw row that happened to carry extra fields
// (e.g. a future column) cannot pass through by default.

export const ADMIN_USERS_PAGE_SIZE = 25;

/** The exact, safe columns the API selects. No passwordHash, no image, no
 *  tokens. `emailVerified` is a timestamp here; it is reduced to a boolean on
 *  the way out (see below). */
export interface RawAdminUser {
  id: string;
  email: string | null;
  name: string | null;
  username: string | null;
  role: string;
  plan: string;
  createdAt: Date;
  emailVerified: Date | null;
  _count: { scanHistory: number };
}

/** What the client receives. `emailVerified` is a boolean — whether the address
 *  is verified — not the raw timestamp, which the admin list has no use for. */
export interface AdminUserRow {
  id: string;
  email: string | null;
  name: string | null;
  username: string | null;
  role: string;
  plan: string;
  createdAt: string; // ISO 8601
  emailVerified: boolean;
  scanCount: number;
}

/** Project a selected row into the safe, client-facing shape. Constructs the
 *  result explicitly — it never spreads the input, so nothing leaks by accident. */
export function toAdminUserRow(user: RawAdminUser): AdminUserRow {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    username: user.username,
    role: user.role,
    plan: user.plan,
    createdAt: user.createdAt.toISOString(),
    emailVerified: user.emailVerified !== null,
    scanCount: user._count.scanHistory,
  };
}

/** Parse the `?page=` query param into a 1-based page number. Anything that
 *  isn't a positive integer (missing, "0", "-3", "abc", "1.5") falls back to
 *  page 1 rather than erroring. */
export function parsePage(raw: string | null): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}
