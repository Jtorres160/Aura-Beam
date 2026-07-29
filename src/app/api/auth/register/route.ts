import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/password";
import { REGISTRATION_DISABLED_MESSAGE, isRegistrationEnabled } from "@/lib/registration";

export async function POST(req: NextRequest) {
  try {
    // The gate goes FIRST — before the body is read, before any database work.
    // This is the authoritative check; the UI gating is only there so a tester
    // never reaches a form that would land here. See src/lib/registration.ts.
    if (!isRegistrationEnabled()) {
      return NextResponse.json(
        { message: REGISTRATION_DISABLED_MESSAGE, registrationDisabled: true },
        { status: 503 }
      );
    }

    const body = await req.json();
    const { firstName, lastName, email, password } = body;

    // Simple validation
    if (!firstName || !lastName || !email || !password) {
      return NextResponse.json(
        { message: "All fields (firstName, lastName, email, password) are required." },
        { status: 400 }
      );
    }

    if (password.length < 8) {
      return NextResponse.json(
        { message: "Password must be at least 8 characters long." },
        { status: 400 }
      );
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return NextResponse.json(
        { message: "Invalid email address format." },
        { status: 400 }
      );
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (existingUser) {
      return NextResponse.json(
        { message: "An account with this email already exists." },
        { status: 409 }
      );
    }

    // Hash the password
    const passwordHash = hashPassword(password);

    // Generate unique username based on email
    const emailPrefix = normalizedEmail.split("@")[0].replace(/[^a-zA-Z0-9]/g, "");
    const randomSuffix = Math.random().toString(36).substring(2, 6);
    const username = `${emailPrefix}_${randomSuffix}`;

    // Create user in the database
    const newUser = await prisma.user.create({
      data: {
        name: `${firstName.trim()} ${lastName.trim()}`,
        email: normalizedEmail,
        username,
        passwordHash,
        role: "USER",
        plan: "FREE",
      },
    });

    // Generate verification token (expires in 24 hours)
    const token = crypto.randomUUID();
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    // Save token to DB
    await prisma.verificationToken.create({
      data: {
        identifier: normalizedEmail,
        token,
        expires,
      },
    });

    // Send the verification email
    const { sendVerificationEmail } = await import("@/lib/email");
    const emailResult = await sendVerificationEmail(normalizedEmail, token);

    if (!emailResult.success) {
      console.error("Verification email failed to send for", normalizedEmail, emailResult.error);
    }

    // Return success without password hash. The account was created either way;
    // emailSent tells the client whether to surface a "resend" prompt immediately.
    return NextResponse.json(
      {
        message: emailResult.success
          ? "Account created successfully. Please verify your email."
          : "Account created, but we couldn't send the verification email. Please use the resend option.",
        requiresVerification: true,
        emailSent: emailResult.success,
        user: {
          id: newUser.id,
          name: newUser.name,
          email: newUser.email,
          username: newUser.username,
        },
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("Registration error:", error);
    return NextResponse.json(
      { message: "An error occurred while creating your account. Please try again." },
      { status: 500 }
    );
  }
}
