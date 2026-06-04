import NextAuth from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "./lib/prisma";
import GoogleProvider from "next-auth/providers/google";
import CredentialsProvider from "next-auth/providers/credentials";
import { SignJWT, jwtVerify } from "jose";
import { verifyPassword } from "./lib/password";

const JWT_SECRET = process.env.NEXTAUTH_SECRET || "aura-beam-super-secret-key-for-development";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  secret: JWT_SECRET,
  session: { strategy: "jwt" },
  jwt: {
    async encode({ token }) {
      const secretKey = new TextEncoder().encode(JWT_SECRET);
      return await new SignJWT(token as any)
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime("30d")
        .sign(secretKey);
    },
    async decode({ token }) {
      if (!token) return null;
      try {
        const secretKey = new TextEncoder().encode(JWT_SECRET);
        const { payload } = await jwtVerify(token, secretKey, {
          algorithms: ["HS256"],
        });
        return payload as any;
      } catch (e) {
        return null;
      }
    },
  },
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
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

        // If user has a password hash, verify it.
        // Otherwise, if they are the seeded user, fallback to password verification
        if (user.passwordHash) {
          const isValid = verifyPassword(password, user.passwordHash);
          if (isValid) {
            return user;
          }
        } else if (email === "ash@aura.gg" && password === "password") {
          return user;
        }

        return null;
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

