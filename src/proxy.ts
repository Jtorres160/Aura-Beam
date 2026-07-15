import { auth } from "@/auth";
import { isDevAuthBypassEnabled } from "@/lib/auth-dev-bypass";
import { NextResponse } from "next/server";

export default auth((req) => {
  // TEMPORARY (Phase 5.14.x): the page-level half of the dev auth bypass. The
  // `auth()` wrapper covers API routes, but this proxy decides whether a PAGE
  // redirects to /login, and it reads req.auth rather than calling auth().
  // Without this line the bypass would authorize every API call while the
  // scanner page itself still bounced to the login screen.
  // isDevAuthBypassEnabled() is env-only by design — no Prisma on this path.
  // To remove: delete the `||` clause.
  const isLoggedIn = !!req.auth || isDevAuthBypassEnabled();
  const isAuthPage = req.nextUrl.pathname.startsWith("/login") || req.nextUrl.pathname.startsWith("/register");
  
  const protectedRoutes = ["/dashboard", "/insights", "/collection", "/scanner", "/settings", "/watchlist", "/search", "/admin"];
  const isProtectedRoute = protectedRoutes.some(route => req.nextUrl.pathname.startsWith(route));

  if (isAuthPage) {
    if (isLoggedIn) {
      return NextResponse.redirect(new URL("/scanner", req.url));
    }
    return null;
  }

  if (isProtectedRoute && !isLoggedIn) {
    let from = req.nextUrl.pathname;
    if (req.nextUrl.search) {
      from += req.nextUrl.search;
    }
    return NextResponse.redirect(new URL(`/login?from=${encodeURIComponent(from)}`, req.url));
  }

  return null;
});

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
