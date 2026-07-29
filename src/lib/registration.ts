// ─── Self-serve registration gate ────────────────────────────────────────────
//
// Email/password signup is switched OFF while Aura has no custom sending
// domain. Resend's sandbox sender (onboarding@resend.dev, see src/lib/email.ts)
// only delivers to the Resend account owner, so a verification email to anyone
// else is never received — and src/auth.ts refuses a credentials login until
// `emailVerified` is set. Registration therefore produces accounts that can
// NEVER be logged into. Google OAuth is the only working way in.
//
// The registration and email-verification code is deliberately left intact and
// untouched behind this gate. Re-enabling is a two-step change: verify a domain
// with Resend and swap the `from:` in src/lib/email.ts, then set the env var
// below to "1".
//
// ─── WHY NEXT_PUBLIC_ ────────────────────────────────────────────────────────
// One flag has to answer the same question on both sides: the API route decides
// whether to create an account, and the landing/login CTAs decide where to send
// a visitor. Two variables would drift, and a UI that offers signup while the
// server refuses it is exactly the "working-looking form that silently fails"
// this gate exists to prevent. NEXT_PUBLIC_ is readable from both, so there is
// one value by construction.
//
// The cost is that Next.js inlines NEXT_PUBLIC_ vars at BUILD time: flipping
// this in Vercel requires a redeploy, not just an env edit. That is acceptable
// for a flag that moves when a domain is provisioned. It does not weaken
// enforcement — the check still runs server-side in the route handler, so a
// stale or hand-edited client cannot create an account.

/** The env var name, in one place so the docs above and the code cannot drift. */
export const REGISTRATION_ENABLED_ENV = "NEXT_PUBLIC_REGISTRATION_ENABLED";

/**
 * Whether self-serve email/password registration is accepted.
 *
 * OFF unless explicitly enabled — same discipline as CATALOG_LOCAL_ENABLED.
 * Only the exact string "1" enables it, so a stray "true"/"yes"/"" cannot
 * quietly reopen signup. Read at CALL time rather than captured in a
 * module-level const, so tests can drive it without import-order games.
 */
export function isRegistrationEnabled(): boolean {
  return process.env.NEXT_PUBLIC_REGISTRATION_ENABLED === "1";
}

/**
 * Where a "Sign up" / "Get Started" call-to-action should point.
 *
 * With registration off this is /login, which carries the Google button — the
 * one path that actually completes. Nothing should link to /register directly;
 * use this instead so a CTA can never strand a tester on a dead form.
 */
export function signupHref(): string {
  return isRegistrationEnabled() ? "/register" : "/login";
}

/** Shown wherever the disabled state surfaces, so the wording stays identical. */
export const REGISTRATION_DISABLED_MESSAGE =
  "Registration is temporarily unavailable. Please sign in with Google to continue.";
