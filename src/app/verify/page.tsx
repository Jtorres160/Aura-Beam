"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { motion } from "framer-motion";
import { CheckCircle2, XCircle, Loader2, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import Link from "next/link";

function VerifyContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const email = searchParams.get("email");

  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [message, setMessage] = useState("Verifying your email...");

  useEffect(() => {
    if (!token || !email) {
      setStatus("error");
      setMessage("Invalid verification link. Missing token or email.");
      return;
    }

    fetch("/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, email }),
    })
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (ok) {
          setStatus("success");
          setMessage("Your email has been successfully verified!");
        } else {
          setStatus("error");
          setMessage(data.message || "Failed to verify email. The link may have expired.");
        }
      })
      .catch(() => {
        setStatus("error");
        setMessage("An unexpected error occurred. Please try again.");
      });
  }, [token, email]);

  return (
    <div className="min-h-screen flex items-center justify-center relative overflow-hidden">
      <div className="absolute inset-0 mesh-gradient opacity-50" />
      <div className="absolute top-1/3 right-1/4 w-72 h-72 rounded-full bg-aura-purple/15 blur-[100px]" />
      <div className="absolute bottom-1/3 left-1/4 w-96 h-96 rounded-full bg-aura-indigo/10 blur-[120px]" />

      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.4 }}
        className="relative z-10 w-full max-w-md mx-4"
      >
        <div className="glass-elevated rounded-2xl p-8 sm:p-10 text-center">
          <div className="flex justify-center mb-6">
            {status === "loading" && (
              <div className="h-16 w-16 rounded-full bg-muted/50 flex items-center justify-center">
                <Loader2 className="h-8 w-8 text-aura-purple animate-spin" />
              </div>
            )}
            {status === "success" && (
              <div className="h-16 w-16 rounded-full bg-green-500/10 flex items-center justify-center">
                <CheckCircle2 className="h-8 w-8 text-green-500" />
              </div>
            )}
            {status === "error" && (
              <div className="h-16 w-16 rounded-full bg-destructive/10 flex items-center justify-center">
                <XCircle className="h-8 w-8 text-destructive" />
              </div>
            )}
          </div>
          
          <h1 className="text-2xl font-bold mb-3">
            {status === "loading" && "Verifying Email"}
            {status === "success" && "Email Verified"}
            {status === "error" && "Verification Failed"}
          </h1>
          
          <p className="text-muted-foreground mb-8">{message}</p>

          {status !== "loading" && (
            <Link href={status === "success" ? "/login" : "/register"}>
              <Button className="w-full h-11 rounded-xl">
                {status === "success" ? "Continue to Login" : "Back to Register"}
                <ArrowRight className="h-4 w-4 ml-2" />
              </Button>
            </Link>
          )}
        </div>
      </motion.div>
    </div>
  );
}

export default function VerifyPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-aura-purple" />
      </div>
    }>
      <VerifyContent />
    </Suspense>
  );
}
