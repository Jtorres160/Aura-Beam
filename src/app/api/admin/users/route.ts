import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/auth";
import { checkAdmin } from "@/lib/admin-auth";
import {
  ADMIN_USERS_PAGE_SIZE,
  parsePage,
  toAdminUserRow,
} from "@/lib/admin-users";

/**
 * GET /api/admin/users?page=N
 *
 * Admin-only, gated identically to /api/admin/stats. Returns a paginated list
 * of users with ONLY non-sensitive fields, newest first.
 *
 * The field set is allow-listed in the Prisma `select` below — passwordHash and
 * anything else are never fetched, so a future sensitive column added to User
 * cannot leak by default. This is deliberately not a fetch-then-strip.
 */
export async function GET(request: NextRequest) {
  try {
    const session = await auth();
    const gate = checkAdmin(session);
    if (!gate.ok) {
      return NextResponse.json({ success: false, message: gate.message }, { status: gate.status });
    }

    const page = parsePage(request.nextUrl.searchParams.get("page"));
    const skip = (page - 1) * ADMIN_USERS_PAGE_SIZE;

    // total drives pagination; the page query pulls only the safe columns plus
    // a scan *count* (never the scan history itself).
    const [total, users] = await Promise.all([
      prisma.user.count(),
      prisma.user.findMany({
        select: {
          id: true,
          email: true,
          name: true,
          username: true,
          role: true,
          plan: true,
          createdAt: true,
          emailVerified: true,
          _count: { select: { scanHistory: true } },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: ADMIN_USERS_PAGE_SIZE,
      }),
    ]);

    return NextResponse.json({
      success: true,
      data: {
        users: users.map(toAdminUserRow),
        page,
        pageSize: ADMIN_USERS_PAGE_SIZE,
        total,
        totalPages: Math.max(1, Math.ceil(total / ADMIN_USERS_PAGE_SIZE)),
      },
    });
  } catch (error) {
    console.error("Admin users error:", error);
    return NextResponse.json(
      { success: false, message: "Failed to fetch users" },
      { status: 500 }
    );
  }
}
