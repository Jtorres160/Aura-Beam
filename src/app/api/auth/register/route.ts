import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/password";

export async function POST(req: NextRequest) {
  try {
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

    // Return success without password hash
    return NextResponse.json(
      {
        message: "Account created successfully.",
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
