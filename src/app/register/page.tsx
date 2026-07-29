"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { Sparkles, Mail, ArrowRight, Loader2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { useState } from "react";
import { signIn } from "next-auth/react";
import { GoogleSignInButton } from "@/components/auth/google-sign-in-button";
import { isRegistrationEnabled } from "@/lib/registration";

/**
 * Shown when self-serve registration is gated off (the current state — see
 * src/lib/registration.ts). Nothing links here anymore: every CTA routes through
 * signupHref(). This exists for bookmarks, shared links and back-button
 * navigation, so those land on an honest explanation with a working door rather
 * than on a form whose submit is guaranteed to fail.
 */
function RegistrationDisabled() {
  return (
    <div className="min-h-screen flex items-center justify-center relative overflow-hidden">
      <div className="absolute inset-0 mesh-gradient opacity-50" />
      <div className="absolute top-1/3 right-1/4 w-72 h-72 rounded-full bg-aura-purple/15 blur-[100px]" />
      <div className="absolute bottom-1/3 left-1/4 w-96 h-96 rounded-full bg-aura-indigo/10 blur-[120px]" />

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="relative z-10 w-full max-w-md mx-4"
      >
        <div className="glass-elevated rounded-2xl p-8 sm:p-10 text-center">
          <div className="flex flex-col items-center mb-6">
            <Link href="/" className="flex items-center gap-2 mb-6">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl gradient-bg">
                <Sparkles className="h-5 w-5 text-white" />
              </div>
            </Link>
            <h1 className="text-2xl font-bold">Sign up with Google</h1>
          </div>

          <p className="text-sm text-muted-foreground mb-8">
            Email and password sign-up is temporarily unavailable while we finish
            setting up our email domain. Google sign-in works now and gives you
            the full app — you can add a password later.
          </p>

          <GoogleSignInButton className="mb-4" label="Continue with Google" />

          <p className="text-center text-sm text-muted-foreground mt-6">
            Already have an account?{" "}
            <Link href="/login" className="text-aura-purple hover:text-aura-violet font-medium transition-colors">
              Sign in
            </Link>
          </p>
        </div>
      </motion.div>
    </div>
  );
}

export default function RegisterPage() {
  // Gated off by default. The form below is left fully intact and is restored
  // by setting NEXT_PUBLIC_REGISTRATION_ENABLED=1 once a sending domain exists.
  // The API route enforces the same flag independently — this branch only keeps
  // a tester from reaching a form that would fail on submit.
  if (!isRegistrationEnabled()) {
    return <RegistrationDisabled />;
  }

  return <RegistrationForm />;
}

function RegistrationForm() {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError("Password must be at least 8 characters long.");
      return;
    }

    setIsLoading(true);

    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName,
          lastName,
          email,
          password,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.message || "Registration failed.");
      }

      if (data.requiresVerification) {
        window.location.href = `/verify-email-info?email=${encodeURIComponent(email)}`;
        return;
      }

      // Automatically sign in after successful registration (if no verification required)
      const result = await signIn("credentials", {
        email,
        password,
        callbackUrl: "/scanner",
        redirect: false,
      }) as any;
      
      if (result?.error) {
        setError("Account created, but automatic login failed. Please sign in manually.");
        setIsLoading(false);
      } else if (result?.url) {
        window.location.href = result.url;
      }
    } catch (err: any) {
      setError(err.message || "An unexpected error occurred.");
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center relative overflow-hidden">
      <div className="absolute inset-0 mesh-gradient opacity-50" />
      <div className="absolute top-1/3 right-1/4 w-72 h-72 rounded-full bg-aura-purple/15 blur-[100px]" />
      <div className="absolute bottom-1/3 left-1/4 w-96 h-96 rounded-full bg-aura-indigo/10 blur-[120px]" />

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="relative z-10 w-full max-w-md mx-4"
      >
        <div className="glass-elevated rounded-2xl p-8 sm:p-10">
          <div className="flex flex-col items-center mb-8">
            <Link href="/" className="flex items-center gap-2 mb-6">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl gradient-bg">
                <Sparkles className="h-5 w-5 text-white" />
              </div>
            </Link>
            <h1 className="text-2xl font-bold">Create your account</h1>
            <p className="text-sm text-muted-foreground mt-1">Start scanning cards in minutes</p>
          </div>

          <GoogleSignInButton className="mb-4" />

          <div className="relative my-6">
            <Separator />
            <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-card px-3 text-xs text-muted-foreground">or</span>
          </div>

          {error && (
            <div className="mb-4 p-3 rounded-xl bg-destructive/10 border border-destructive/20 text-destructive text-sm flex items-center gap-2">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <form className="space-y-4" onSubmit={handleRegister}>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="firstName">First name</label>
                <Input 
                  id="firstName" 
                  placeholder="John" 
                  className="h-11 rounded-xl"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="lastName">Last name</label>
                <Input 
                  id="lastName" 
                  placeholder="Doe" 
                  className="h-11 rounded-xl"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  required
                />
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="reg-email">Email</label>
              <Input 
                id="reg-email" 
                type="email" 
                placeholder="you@example.com" 
                className="h-11 rounded-xl"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="reg-password">Password</label>
              <Input 
                id="reg-password" 
                type="password" 
                placeholder="Min. 8 characters" 
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
              {isLoading ? "Creating Account..." : "Create Account"}
              {!isLoading && <ArrowRight className="h-4 w-4 ml-2 transition-transform group-hover:translate-x-1" />}
            </Button>
          </form>

          <p className="text-center text-sm text-muted-foreground mt-6">
            Already have an account?{" "}
            <Link href="/login" className="text-aura-purple hover:text-aura-violet font-medium transition-colors">
              Sign in
            </Link>
          </p>
        </div>
      </motion.div>
    </div>
  );
}
