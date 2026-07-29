"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { Sparkles, Mail, ArrowRight, Loader2, AlertCircle } from "lucide-react";
import { signIn } from "next-auth/react";
import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { GoogleSignInButton } from "@/components/auth/google-sign-in-button";
import { isRegistrationEnabled } from "@/lib/registration";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // When the failure is specifically an unverified email, offer a resend link.
  const [needsVerification, setNeedsVerification] = useState(false);
  const [resendStatus, setResendStatus] = useState<"idle" | "sending" | "sent">("idle");

  useEffect(() => {
    // Safely check query params on client side
    const params = new URLSearchParams(window.location.search);
    const errorParam = params.get("error");
    // Auth.js surfaces a custom CredentialsSignin `code` in the query string;
    // an unverified email uses code "email_not_verified".
    const codeParam = params.get("code");
    if (errorParam) {
      if (codeParam === "email_not_verified") {
        setError("Please verify your email — check your inbox for the verification link.");
        setNeedsVerification(true);
      } else if (errorParam === "CredentialsSignin" || errorParam === "Credentials") {
        setError("Invalid email or password.");
      } else if (errorParam === "Configuration") {
        setError("OAuth configuration is missing. Google Login may not be configured yet.");
      } else {
        setError(`Authentication error: ${errorParam}`);
      }
    }
  }, []);

  const handleResend = async () => {
    if (!email || resendStatus === "sending") return;
    setResendStatus("sending");
    try {
      await fetch("/api/auth/resend-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      // The endpoint intentionally returns a generic success regardless, so we
      // always show the same confirmation.
      setResendStatus("sent");
    } catch {
      setResendStatus("idle");
      setError("Could not resend the verification email. Please try again.");
    }
  };

  const handleEmailSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);
    setNeedsVerification(false);
    setResendStatus("idle");

    try {
      const result = await signIn("credentials", {
        email,
        password,
        callbackUrl: "/scanner",
        redirect: false,
      });

      if (result?.error) {
        // Auth.js normalizes the thrown error type to "CredentialsSignin"; the
        // specific reason is carried in `result.code`.
        if (result.code === "email_not_verified") {
          setError("Please verify your email — check your inbox for the verification link.");
          setNeedsVerification(true);
        } else if (result.error === "CredentialsSignin" || result.error === "Credentials") {
          setError("Invalid email or password.");
        } else {
          setError(result.error);
        }
        setIsLoading(false);
      } else if (result?.url) {
        window.location.href = result.url;
      }
    } catch (err: any) {
      console.error(err);
      setError("An unexpected error occurred.");
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center relative overflow-hidden">
      {/* Background */}
      <div className="absolute inset-0 mesh-gradient opacity-50" />
      <div className="absolute top-1/3 left-1/4 w-72 h-72 rounded-full bg-aura-purple/15 blur-[100px]" />
      <div className="absolute bottom-1/3 right-1/4 w-96 h-96 rounded-full bg-aura-indigo/10 blur-[120px]" />

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="relative z-10 w-full max-w-md mx-4"
      >
        <div className="glass-elevated rounded-2xl p-8 sm:p-10">
          {/* Logo */}
          <div className="flex flex-col items-center mb-8">
            <Link href="/" className="flex items-center gap-2 mb-6">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl gradient-bg">
                <Sparkles className="h-5 w-5 text-white" />
              </div>
            </Link>
            <h1 className="text-2xl font-bold">Welcome back</h1>
            <p className="text-sm text-muted-foreground mt-1">Sign in to your Aura account</p>
          </div>

          {/* Google OAuth — the only signup path while registration is gated
              off, and unchanged in behaviour by that gating. */}
          <GoogleSignInButton className="mb-4" />

          <div className="relative my-6">
            <Separator />
            <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-card px-3 text-xs text-muted-foreground">
              or
            </span>
          </div>

          {error && (
            <div className="mb-4 p-3 rounded-xl bg-destructive/10 border border-destructive/20 text-destructive text-sm">
              <div className="flex items-center gap-2">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
              {needsVerification && (
                <div className="mt-2 pl-6">
                  {resendStatus === "sent" ? (
                    <span className="text-muted-foreground">
                      Verification email sent. Check your inbox (and spam).
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={handleResend}
                      disabled={resendStatus === "sending"}
                      className="text-aura-purple hover:text-aura-violet font-medium underline underline-offset-2 disabled:opacity-60"
                    >
                      {resendStatus === "sending" ? "Sending…" : "Resend verification email"}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Email form */}
          <form className="space-y-4" onSubmit={handleEmailSignIn}>
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="email">Email</label>
              <Input
                id="email"
                type="email"
                placeholder="you@example.com"
                className="h-11 rounded-xl"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium" htmlFor="password">Password</label>
                <Link href="/forgot-password" className="text-xs text-aura-purple hover:text-aura-violet transition-colors">
                  Forgot password?
                </Link>
              </div>
              <Input
                id="password"
                type="password"
                placeholder="••••••••"
                className="h-11 rounded-xl"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>

            <Button 
              className="w-full h-11 rounded-xl gradient-bg text-white border-0 font-medium group" 
              type="submit"
              disabled={isLoading}
            >
              {isLoading ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Mail className="h-4 w-4 mr-2" />
              )}
              {isLoading ? "Signing in..." : "Sign in with Email"}
              {!isLoading && <ArrowRight className="h-4 w-4 ml-2 transition-transform group-hover:translate-x-1" />}
            </Button>
          </form>

          {/* With registration gated off there is no second account-creation
              route to advertise — the Google button above IS the signup. */}
          {isRegistrationEnabled() && (
            <p className="text-center text-sm text-muted-foreground mt-6">
              Don&apos;t have an account?{" "}
              <Link href="/register" className="text-aura-purple hover:text-aura-violet font-medium transition-colors">
                Sign up
              </Link>
            </p>
          )}
        </div>
      </motion.div>
    </div>
  );
}
