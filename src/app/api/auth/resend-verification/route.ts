import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// Always responds with the same generic success, regardless of whether the
// email exists or is already verified. This avoids leaking which addresses are
// registered (account enumeration) while still re-sending a fresh link to any
// genuinely-unverified account.
const GENERIC_OK = {
  message: "If an unverified account exists for that email, a new verification link is on its way.",
};

export async function POST(req: NextRequest) {
  try {
    const { email } = await req.json();

    if (!email || typeof email !== "string") {
      return NextResponse.json({ message: "Email is required." }, { status: 400 });
    }

    const normalizedEmail = email.toLowerCase().trim();

    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true, emailVerified: true },
    });

    // Only send for a real, still-unverified account. Otherwise fall through to
    // the identical generic response below.
    if (user && !user.emailVerified) {
      // Replace any outstanding tokens for this identifier so only the newest
      // link is valid.
      await prisma.verificationToken.deleteMany({ where: { identifier: normalizedEmail } });

      const token = crypto.randomUUID();
      const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await prisma.verificationToken.create({
        data: { identifier: normalizedEmail, token, expires },
      });

      const { sendVerificationEmail } = await import("@/lib/email");
      await sendVerificationEmail(normalizedEmail, token);
    }

    return NextResponse.json(GENERIC_OK);
  } catch (error) {
    console.error("Resend verification error:", error);
    return NextResponse.json(
      { message: "An error occurred while resending the verification email." },
      { status: 500 }
    );
  }
}
