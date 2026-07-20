// Pure decision logic for email-verification tokens.
//
// Kept free of Prisma/HTTP so the token validity/expiry rules can be tested in
// isolation — the route layer is only responsible for fetching the token and
// translating the outcome into a response.

export type VerificationOutcome = "valid" | "missing" | "expired";

/**
 * Decide whether a fetched verification token can be used to verify an email.
 *
 * @param token  the token row (only `expires` is inspected) or null/undefined
 *               when no matching row was found.
 * @param now    the reference time; defaults to the current time.
 */
export function evaluateVerificationToken(
  token: { expires: Date } | null | undefined,
  now: Date = new Date(),
): VerificationOutcome {
  if (!token) return "missing";
  // A token whose expiry is strictly in the past is expired; an exact tie is
  // still considered valid.
  if (now.getTime() > token.expires.getTime()) return "expired";
  return "valid";
}
