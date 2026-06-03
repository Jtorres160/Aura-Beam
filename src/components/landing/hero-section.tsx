"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowRight, ScanLine, TrendingUp, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";

export function HeroSection() {
  return (
    <section className="relative min-h-screen flex items-center justify-center pt-16 overflow-hidden">
      {/* Mesh gradient background */}
      <div className="absolute inset-0 mesh-gradient" />

      {/* Animated orbs */}
      <div className="absolute top-1/4 left-1/4 w-72 h-72 rounded-full bg-aura-purple/20 blur-[100px] animate-float" />
      <div className="absolute bottom-1/4 right-1/4 w-96 h-96 rounded-full bg-aura-indigo/15 blur-[120px] animate-float" style={{ animationDelay: "2s" }} />
      <div className="absolute top-1/2 right-1/3 w-64 h-64 rounded-full bg-aura-violet/10 blur-[80px] animate-float" style={{ animationDelay: "4s" }} />

      <div className="relative z-10 mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 text-center">
        {/* Badge */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="inline-flex items-center gap-2 rounded-full border border-aura-purple/30 bg-aura-purple/10 px-4 py-1.5 mb-8"
        >
          <span className="h-2 w-2 rounded-full bg-aura-purple animate-pulse" />
          <span className="text-sm font-medium text-aura-violet">Now supporting Pokémon, MTG & Yu-Gi-Oh!</span>
        </motion.div>

        {/* Headline */}
        <motion.h1
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.1 }}
          className="text-5xl sm:text-6xl lg:text-8xl font-bold tracking-tight leading-[1.05]"
        >
          <span className="gradient-text">Aura</span>
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.2 }}
          className="mt-4 text-xl sm:text-2xl lg:text-3xl font-medium text-muted-foreground max-w-3xl mx-auto leading-relaxed"
        >
          The fastest way to identify and value
          <br className="hidden sm:block" />
          your trading cards.
        </motion.p>

        {/* CTA */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.35 }}
          className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4"
        >
          <Link href="/register">
            <Button size="lg" className="gradient-bg text-white border-0 text-base h-12 px-8 font-medium rounded-xl group">
              Start Scanning Free
              <ArrowRight className="ml-2 h-4 w-4 transition-transform group-hover:translate-x-1" />
            </Button>
          </Link>
          <a href="#features">
            <Button size="lg" variant="outline" className="text-base h-12 px-8 font-medium rounded-xl">
              See How It Works
            </Button>
          </a>
        </motion.div>

        {/* Stats row */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.5 }}
          className="mt-16 grid grid-cols-3 gap-8 max-w-lg mx-auto"
        >
          {[
            { value: "2s", label: "Scan Speed" },
            { value: "95%+", label: "Accuracy" },
            { value: "50K+", label: "Cards in DB" },
          ].map((stat) => (
            <div key={stat.label} className="text-center">
              <div className="text-2xl sm:text-3xl font-bold gradient-text">{stat.value}</div>
              <div className="text-xs sm:text-sm text-muted-foreground mt-1">{stat.label}</div>
            </div>
          ))}
        </motion.div>

        {/* Floating preview cards */}
        <motion.div
          initial={{ opacity: 0, y: 60 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 1, delay: 0.6 }}
          className="mt-20 relative"
        >
          <div className="mx-auto max-w-4xl">
            <div className="relative rounded-2xl overflow-hidden glass border border-border/50 p-1 aura-glow">
              <div className="rounded-xl bg-card overflow-hidden">
                {/* Mock scanner UI */}
                <div className="aspect-[16/9] bg-gradient-to-b from-background to-card relative flex items-center justify-center">
                  {/* Scanner frame */}
                  <div className="relative w-48 h-64 sm:w-56 sm:h-72 rounded-xl border-2 border-aura-purple/50 flex items-center justify-center">
                    {/* Corner markers */}
                    <div className="absolute -top-0.5 -left-0.5 w-6 h-6 border-t-2 border-l-2 border-aura-purple rounded-tl-lg" />
                    <div className="absolute -top-0.5 -right-0.5 w-6 h-6 border-t-2 border-r-2 border-aura-purple rounded-tr-lg" />
                    <div className="absolute -bottom-0.5 -left-0.5 w-6 h-6 border-b-2 border-l-2 border-aura-purple rounded-bl-lg" />
                    <div className="absolute -bottom-0.5 -right-0.5 w-6 h-6 border-b-2 border-r-2 border-aura-purple rounded-br-lg" />

                    {/* Scan line */}
                    <div className="absolute left-2 right-2 h-0.5 bg-gradient-to-r from-transparent via-aura-purple to-transparent animate-scan-line opacity-60" />

                    {/* Placeholder card icon */}
                    <div className="text-center space-y-3">
                      <ScanLine className="h-10 w-10 text-aura-purple/50 mx-auto" />
                      <p className="text-sm text-muted-foreground">Point camera at card</p>
                    </div>
                  </div>

                  {/* Side info panels */}
                  <div className="absolute right-4 top-4 bottom-4 hidden sm:flex flex-col gap-3 w-52">
                    <div className="flex-1 rounded-xl glass p-3 space-y-2">
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <TrendingUp className="h-3 w-3 text-aura-purple" />
                        Market Price
                      </div>
                      <div className="text-2xl font-bold">$24.99</div>
                      <div className="text-xs text-emerald-400">+12.5% this week</div>
                    </div>
                    <div className="flex-1 rounded-xl glass p-3 space-y-2">
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Shield className="h-3 w-3 text-aura-purple" />
                        Confidence
                      </div>
                      <div className="text-2xl font-bold gradient-text">98.7%</div>
                      <div className="text-xs text-muted-foreground">Exact match found</div>
                    </div>
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
