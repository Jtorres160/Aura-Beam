"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { Sparkles, Mail, ArrowRight, Loader2, AlertCircle } from "lucide-react";
import { signIn } from "next-auth/react";
import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";

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

  const handleGoogleSignIn = () => {
    signIn("google", { callbackUrl: "/scanner" });
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

          {/* Google OAuth */}
          <Button 
            variant="outline" 
            className="w-full h-11 rounded-xl font-medium text-sm mb-4"
            onClick={handleGoogleSignIn}
            type="button"
          >
            <svg className="h-5 w-5 mr-2" viewBox="0 0 24 24">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
            </svg>
            Continue with Google
          </Button>

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

          <p className="text-center text-sm text-muted-foreground mt-6">
            Don&apos;t have an account?{" "}
            <Link href="/register" className="text-aura-purple hover:text-aura-violet font-medium transition-colors">
              Sign up
            </Link>
          </p>
        </div>
      </motion.div>
    </div>
  );
}
