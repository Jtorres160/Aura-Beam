import NextAuth, { CredentialsSignin } from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "./lib/prisma";
import GoogleProvider from "next-auth/providers/google";
import CredentialsProvider from "next-auth/providers/credentials";
import { SignJWT, jwtVerify } from "jose";
import { verifyPassword } from "./lib/password";
import { devSession, ensureDevUser, isDevAuthBypassEnabled } from "./lib/auth-dev-bypass";

const JWT_SECRET = process.env.NEXTAUTH_SECRET;

// A plain `throw new Error(...)` inside `authorize` is NOT an AuthError, so
// Auth.js v5 masks it as `error=Configuration` on the client (see
// @auth/core/index.js: non-client-safe errors fall back to "Configuration").
// Subclassing CredentialsSignin keeps the client-facing type as
// "CredentialsSignin" while surfacing our own `code` in the result, letting the
// login page distinguish "unverified email" from "wrong password".
class EmailNotVerifiedError extends CredentialsSignin {
  code = "email_not_verified";
}

if (process.env.NODE_ENV === "production" && !JWT_SECRET) {
  throw new Error("CRITICAL: NEXTAUTH_SECRET environment variable is missing in production. This is a severe security risk.");
}

const fallbackSecret = JWT_SECRET || "aura-beam-super-secret-key-for-development";

export const { handlers, auth: nextAuth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  secret: JWT_SECRET,
  session: { strategy: "jwt" },
  jwt: {
    async encode({ token }) {
      const secretKey = new TextEncoder().encode(fallbackSecret);
      return await new SignJWT(token as any)
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime("30d")
        .sign(secretKey);
    },
    async decode({ token }) {
      if (!token) return null;
      try {
        const secretKey = new TextEncoder().encode(fallbackSecret);
        const { payload } = await jwtVerify(token, secretKey, {
          algorithms: ["HS256"],
        });
        return payload as any;
      } catch (e) {
        return null;
      }
    },
  },
  trustHost: true,
  providers: [
    // ─── Google — the ONLY signup path while registration is gated off ───────
    //
    // On `allowDangerousEmailAccountLinking: true`: when a Google profile's
    // email already matches a User row, Auth.js adopts that row instead of
    // throwing OAuthAccountNotLinked (see @auth/core handle-login.js — the
    // `user = userByEmail` branch). Whoever controlled that pre-existing row
    // then shares the account with the Google signer.
    //
    // Why it is safe to KEEP enabled now: with isRegistrationEnabled() false,
    // /api/auth/register refuses, and it was the only way an unauthenticated
    // caller could put a row in `users`. The remaining creators are this
    // provider itself (which only ever creates a row for an email Google has
    // authenticated), prisma/seed.ts, and the development auth bypass — none
    // reachable by a stranger against production. So no NEW takeover target
    // can be planted, and linking is what lets an existing collector keep their
    // collection when they switch to Google.
    //
    // What this does NOT fix: rows created BEFORE the gate went up. Any
    // credentials account already in the database is still adopted on sight by
    // a matching Google sign-in. That is a data question, not a code one — see
    // the PR description. If registration is ever re-enabled, revisit this flag
    // together with working email verification.
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID || "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
      allowDangerousEmailAccountLinking: true,
    }),
    CredentialsProvider({
      name: "Credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;

        const email = (credentials.email as string).toLowerCase().trim();
        const password = credentials.password as string;

        const user = await prisma.user.findUnique({
          where: { email },
        });

        if (!user) return null;

        // A password hash is the ONLY way a credentials login can succeed.
        // There is deliberately no fallback branch: a row without a hash (an
        // OAuth-only account, or a seeded row) is not credentials-loginable at
        // all. A previous `email === "<seed user>" && password === "password"`
        // escape hatch lived here and granted that row's session — including
        // its ADMIN role — to anyone who guessed it, with no email-verification
        // check. Never reintroduce a branch that returns a user without
        // verifying a hash.
        if (!user.passwordHash) return null;

        if (!verifyPassword(password, user.passwordHash)) return null;

        if (!user.emailVerified) {
          throw new EmailNotVerifiedError();
        }

        return user;
      },
    }),
  ],
  pages: {
    signIn: "/login",
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = (user as any).role;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        (session.user as any).role = token.role;

        // Generate an accessToken for backend API authentication
        const secretKey = new TextEncoder().encode(JWT_SECRET);
        const accessToken = await new SignJWT({
          id: token.id,
          email: session.user.email,
          role: token.role,
        })
          .setProtectedHeader({ alg: "HS256" })
          .setIssuedAt()
          .setExpirationTime("30d")
          .sign(secretKey);

        (session as any).accessToken = accessToken;
      }
      return session;
    },
  },
});

// ─── TEMPORARY: development auth bypass seam (Phase 5.14.x) ──────────────────
// The ONE place the bypass touches the auth stack. Everything above is the real,
// untouched NextAuth configuration; this wrapper only short-circuits the no-arg
// `await auth()` call that protected routes make.
//
// `auth` is overloaded in NextAuth v5 — it is both a session getter AND a
// middleware wrapper (src/proxy.ts does `export default auth((req) => …)`).
// Calls WITH arguments are therefore delegated to NextAuth untouched; only the
// bare `auth()` form can take the dev branch. Getting this wrong would break
// route protection itself rather than bypass it.
//
// To remove: delete this block and rename `nextAuth` back to `auth` above.
// NOTE the wrapper is deliberately NOT async. `auth(handler)` must return the
// middleware FUNCTION synchronously — an async wrapper returns a Promise of it,
// and Next.js rejects the proxy with "must export a function named `proxy` or a
// default function". Only the no-arg branch returns a promise, which is exactly
// what `await auth()` expects.
export const auth = ((...args: unknown[]) => {
  if (args.length === 0 && isDevAuthBypassEnabled()) {
    return (async () => {
      // The FK targets in scan_history / capture_rejections must resolve, so
      // the row has to exist before any route writes against this id.
      await ensureDevUser();
      return devSession();
    })();
  }
  return (nextAuth as any)(...args);
}) as typeof nextAuth;

