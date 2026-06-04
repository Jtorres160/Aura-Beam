"use client";

import { motion } from "framer-motion";
import { Mail, ArrowRight, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

function VerifyEmailContent() {
  const searchParams = useSearchParams();
  const email = searchParams.get("email");

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
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl gradient-bg mx-auto mb-6 shadow-xl shadow-aura-purple/20">
            <Mail className="h-8 w-8 text-white" />
          </div>
          
          <h1 className="text-2xl font-bold mb-2">Check your inbox</h1>
          
          <p className="text-muted-foreground mb-8">
            We've sent a verification link to<br/>
            <span className="font-semibold text-foreground">{email || "your email address"}</span>.<br/>
            Please check your email to activate your account.
          </p>

          <Link href="/login">
            <Button variant="outline" className="w-full h-11 rounded-xl">
              Return to Login
              <ArrowRight className="h-4 w-4 ml-2" />
            </Button>
          </Link>
        </div>
      </motion.div>
    </div>
  );
}

export default function VerifyEmailInfoPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center">
        <Sparkles className="h-6 w-6 animate-pulse text-aura-purple" />
      </div>
    }>
      <VerifyEmailContent />
    </Suspense>
  );
}
