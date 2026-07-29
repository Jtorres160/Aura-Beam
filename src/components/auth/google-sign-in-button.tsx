"use client";

import { signIn } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The Google sign-in entry point.
 *
 * While self-serve registration is gated off (src/lib/registration.ts) this is
 * the ONLY path that completes a sign-in, so it is defined once and reused
 * rather than copied per page — three divergent copies of the one working door
 * is how one of them quietly rots.
 *
 * Behaviour is exactly what the login and register pages each inlined before:
 * `signIn("google", { callbackUrl: "/scanner" })`. This component is presentation
 * only; it does not touch the provider configuration in src/auth.ts.
 */
export function GoogleSignInButton({
  className,
  label = "Continue with Google",
}: {
  className?: string;
  label?: string;
}) {
  return (
    <Button
      variant="outline"
      className={cn("w-full h-11 rounded-xl font-medium text-sm", className)}
      onClick={() => signIn("google", { callbackUrl: "/scanner" })}
      type="button"
    >
      <svg className="h-5 w-5 mr-2" viewBox="0 0 24 24">
        <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
        <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
        <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
        <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
      </svg>
      {label}
    </Button>
  );
}
