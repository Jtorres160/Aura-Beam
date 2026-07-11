"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";

export function HeroSection() {
  return (
    <section className="relative min-h-[100svh] flex items-center pt-16">
      <div className="relative z-10 mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="grid items-center gap-14 lg:grid-cols-2 lg:gap-16">
          {/* ── Left: the pitch ─────────────────────────────── */}
          <div className="text-center lg:text-left">
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
              className="mt-6 font-serif text-4xl sm:text-5xl lg:text-6xl tracking-tight leading-[1.05]"
            >
              Know every card
              <br />
              you own.
            </motion.h1>

            <motion.p
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.2 }}
              className="mt-6 text-lg sm:text-xl text-muted-foreground max-w-xl mx-auto lg:mx-0 leading-relaxed"
            >
              Scan a card, identify the exact printing, and enter it into your
              archive with live market value.
            </motion.p>

            {/* CTA */}
            <motion.div
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.35 }}
              className="mt-10 flex flex-col sm:flex-row items-center justify-center lg:justify-start gap-4"
            >
              <Link href="/register" className="w-full sm:w-auto">
                <Button size="lg" className="w-full text-base h-12 px-8 font-medium group">
                  Start Scanning Free
                  <ArrowRight className="ml-2 h-4 w-4 transition-transform group-hover:translate-x-1" />
                </Button>
              </Link>
              <a href="#features" className="w-full sm:w-auto">
                <Button size="lg" variant="outline" className="w-full text-base h-12 px-8 font-medium">
                  See How It Works
                </Button>
              </a>
            </motion.div>
          </div>

          {/* ── Right: the payoff ───────────────────────────── */}
          {/* The identified card's placard — a museum label, not a dashboard.
              Only what tells the user what the card is and what it's worth:
              category, name, exact printing, market value. Static marketing
              still; no scanner logic. The page's single foil moment lives on
              this frame's hairline rail. */}
          <motion.div
            initial={{ opacity: 0, y: 40 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.9, delay: 0.5 }}
            className="mx-auto w-full max-w-sm sm:max-w-md lg:max-w-none"
          >
            <div className="foil-frame rounded-xl">
              <div className="relative overflow-hidden rounded-xl border border-border bg-[#141311] p-8 sm:p-10 shadow-[0_32px_64px_-40px_rgba(19,18,16,0.6)]">
                {/* The physical specimen: a blind-embossed impression of the
                    card in true 63×88 geometry, seated partly behind its label.
                    Defined only by light (top-left highlight, bottom-right
                    shadow) — no fill, no artwork, no UI. It says a real object
                    was identified, not just a name. */}
                <div
                  aria-hidden
                  className="pointer-events-none absolute -right-10 -bottom-10 w-40 sm:w-48 card-frame border border-white/[0.05] shadow-[inset_1px_1px_0_rgba(255,255,255,0.045),inset_-2px_-3px_8px_rgba(0,0,0,0.36)]"
                />

                <div className="relative">
                  {/* Identity */}
                  <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-white/40">
                    Pokémon
                  </p>
                  <h3 className="mt-3 font-serif text-3xl sm:text-4xl leading-tight text-white">
                    Charizard ex
                  </h3>
                  <p className="mt-2 font-mono text-xs text-white/50">
                    Obsidian Flames · 223/197
                  </p>

                  <div className="my-7 h-px bg-white/10" />

                  {/* Value */}
                  <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-white/40">
                    Market value
                  </p>
                  <p className="mt-2 font-serif text-4xl sm:text-5xl leading-none text-brass">
                    $296.40
                  </p>
                </div>
              </div>
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
