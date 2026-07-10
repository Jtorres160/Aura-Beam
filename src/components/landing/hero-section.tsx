"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowRight, ScanLine } from "lucide-react";
import { Button } from "@/components/ui/button";

export function HeroSection() {
  return (
    <section className="relative min-h-screen flex items-center justify-center pt-16">
      <div className="relative z-10 mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 text-center">
        {/* Eyebrow */}
        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="font-mono text-xs uppercase tracking-[0.24em] text-muted-foreground"
        >
          Aura · The Collector&apos;s Instrument
        </motion.p>

        {/* Headline */}
        <motion.h1
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.1 }}
          className="mt-6 font-serif text-5xl sm:text-6xl lg:text-7xl tracking-tight leading-[1.05]"
        >
          Know every card
          <br />
          you own.
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.2 }}
          className="mt-6 text-lg sm:text-xl text-muted-foreground max-w-2xl mx-auto leading-relaxed"
        >
          Scan a card, identify the exact printing, and enter it into your
          archive with live market value.
        </motion.p>

        {/* CTA */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.35 }}
          className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4"
        >
          <Link href="/register">
            <Button size="lg" className="text-base h-12 px-8 font-medium group">
              Start Scanning Free
              <ArrowRight className="ml-2 h-4 w-4 transition-transform group-hover:translate-x-1" />
            </Button>
          </Link>
          <a href="#features">
            <Button size="lg" variant="outline" className="text-base h-12 px-8 font-medium">
              See How It Works
            </Button>
          </a>
        </motion.div>

        {/* Viewfinder vignette — scanner-first storytelling */}
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.9, delay: 0.5 }}
          className="mt-20"
        >
          <div className="mx-auto max-w-3xl">
            <div className="relative rounded-xl overflow-hidden border border-border bg-[#141311] shadow-[0_32px_64px_-40px_rgba(19,18,16,0.6)]">
              <div className="aspect-[16/9] relative flex items-center justify-center">
                {/* Card guide at true trading-card proportions */}
                <div className="relative w-36 sm:w-44 aspect-[63/88] rounded-lg border border-white/20 flex items-center justify-center">
                  <div className="absolute -top-px -left-px w-6 h-6 border-t-2 border-l-2 border-brass rounded-tl-lg" />
                  <div className="absolute -top-px -right-px w-6 h-6 border-t-2 border-r-2 border-brass rounded-tr-lg" />
                  <div className="absolute -bottom-px -left-px w-6 h-6 border-b-2 border-l-2 border-brass rounded-bl-lg" />
                  <div className="absolute -bottom-px -right-px w-6 h-6 border-b-2 border-r-2 border-brass rounded-br-lg" />

                  {/* Read line */}
                  <div className="absolute left-1 right-1 h-px bg-gradient-to-r from-transparent via-brass to-transparent animate-scan-line opacity-80" />

                  <div className="text-center space-y-3">
                    <ScanLine className="h-8 w-8 text-brass/70 mx-auto" />
                    <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/50">
                      Point camera at card
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
