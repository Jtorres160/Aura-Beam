import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { evaluateVerificationToken } from "@/lib/verification";

export async function POST(req: NextRequest) {
  try {
    const { token, email } = await req.json();

    if (!token || !email) {
      return NextResponse.json(
        { message: "Missing token or email." },
        { status: 400 }
      );
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Find the token
    const verificationToken = await prisma.verificationToken.findUnique({
      where: {
        identifier_token: {
          identifier: normalizedEmail,
          token,
        },
      },
    });

    const outcome = evaluateVerificationToken(verificationToken);

    if (outcome === "missing") {
      return NextResponse.json(
        { message: "Invalid or expired verification token." },
        { status: 400 }
      );
    }

    if (outcome === "expired") {
      // Delete the expired token so it can't linger.
      await prisma.verificationToken.delete({
        where: {
          identifier_token: { identifier: normalizedEmail, token },
        },
      });
      return NextResponse.json(
        { message: "Verification token has expired. Please request a new link." },
        { status: 400 }
      );
    }

    // Mark user email as verified
    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (!user) {
      return NextResponse.json(
        { message: "User not found." },
        { status: 404 }
      );
    }

    await prisma.user.update({
      where: { email: normalizedEmail },
      data: { emailVerified: new Date() },
    });

    // Delete the token
    await prisma.verificationToken.delete({
      where: {
        identifier_token: { identifier: normalizedEmail, token },
      },
    });

    return NextResponse.json({ message: "Email successfully verified." });
  } catch (error) {
    console.error("Verification error:", error);
    return NextResponse.json(
      { message: "An error occurred during verification." },
      { status: 500 }
    );
  }
}
