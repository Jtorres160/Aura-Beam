"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Cookie, X } from "lucide-react";
import { Button } from "@/components/ui/button";

export function CookieConsent() {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    // Check if the user has already answered the cookie prompt
    const consent = localStorage.getItem("aura_cookie_consent");
    if (!consent) {
      // Show the banner with a slight delay for modern aesthetic flow
      const timer = setTimeout(() => setIsOpen(true), 1500);
      return () => clearTimeout(timer);
    }
  }, []);

  const handleAccept = () => {
    localStorage.setItem("aura_cookie_consent", "accepted");
    setIsOpen(false);
  };

  const handleDecline = () => {
    localStorage.setItem("aura_cookie_consent", "declined");
    setIsOpen(false);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed bottom-4 right-4 left-4 sm:left-auto sm:max-w-md z-[100] animate-in slide-in-from-bottom-8 duration-500">
      <div className="glass-elevated border border-border p-6 rounded-2xl shadow-2xl flex flex-col gap-4 relative overflow-hidden">
        {/* Subtle decorative glow */}
        <div className="absolute -top-12 -right-12 h-24 w-24 rounded-full bg-primary/10 blur-xl pointer-events-none" />

        {/* Content */}
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg bg-primary/10 text-primary shrink-0">
            <Cookie className="h-5 w-5 animate-pulse" />
          </div>
          <div className="space-y-1">
            <h4 className="text-sm font-bold text-foreground">Cookie Consent</h4>
            <p className="text-xs text-muted-foreground leading-relaxed">
              We use essential cookies to manage your secure session logins and save your interface preferences. By clicking &quot;Accept&quot;, you consent to our use of these helper cookies. Learn more in our{" "}
              <Link href="/cookies" className="text-primary hover:underline font-medium">
                Cookie Policy
              </Link>
              .
            </p>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 self-end sm:self-auto sm:justify-end mt-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleDecline}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Decline
          </Button>
          <Button
            size="sm"
            onClick={handleAccept}
            className="gradient-bg text-white border-0 text-xs font-semibold px-4"
          >
            Accept
          </Button>
        </div>

        {/* Close Button */}
        <button
          onClick={() => setIsOpen(false)}
          className="absolute top-3 right-3 p-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
