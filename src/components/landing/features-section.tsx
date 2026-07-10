"use client";

import { motion } from "framer-motion";
import { ScanLine, TrendingUp, BarChart3, Bell } from "lucide-react";

const features = [
  {
    icon: ScanLine,
    title: "Instant Scan",
    description: "Point your camera at any trading card. Aura reads the printing and identifies the exact card in seconds.",
  },
  {
    icon: TrendingUp,
    title: "Live Pricing",
    description: "Real-time market data from TCGPlayer, Scryfall, and more. See market, low, mid, and high prices instantly.",
  },
  {
    icon: BarChart3,
    title: "Portfolio Tracking",
    description: "Track your collection's total value with daily, weekly, and monthly performance insights.",
  },
  {
    icon: Bell,
    title: "Price Alerts",
    description: "Set thresholds on any card. Get notified when prices move so you never miss a trade.",
  },
];

export function FeaturesSection() {
  return (
    <section id="features" className="relative py-32">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        {/* Section header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
          className="text-center mb-20"
        >
          <p className="font-mono text-xs uppercase tracking-[0.24em] text-muted-foreground mb-4">Features</p>
          <h2 className="font-serif text-3xl sm:text-4xl lg:text-5xl tracking-tight">
            Everything you need to
            <br />
            master your collection
          </h2>
        </motion.div>

        {/* Feature cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 lg:gap-8">
          {features.map((feature, i) => (
            <motion.div
              key={feature.title}
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-80px" }}
              transition={{ duration: 0.5, delay: i * 0.1 }}
              className="rounded-xl border border-border bg-card p-8 card-hover hover:border-brass/40"
            >
              <div className="inline-flex items-center justify-center w-11 h-11 rounded-lg bg-secondary border border-border mb-5">
                <feature.icon className="h-5 w-5 text-brass" />
              </div>
              <h3 className="font-serif text-2xl mb-2">{feature.title}</h3>
              <p className="text-muted-foreground leading-relaxed">{feature.description}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
