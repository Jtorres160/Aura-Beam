"use client";

import { motion } from "framer-motion";
import { ScanLine, TrendingUp, BarChart3, Bell } from "lucide-react";

const features = [
  {
    icon: ScanLine,
    title: "Instant Scan",
    description: "Point your camera at any trading card. Our AI identifies it in under 2 seconds with 95%+ accuracy.",
    gradient: "from-purple-500 to-indigo-500",
  },
  {
    icon: TrendingUp,
    title: "Live Pricing",
    description: "Real-time market data from TCGPlayer, Scryfall, and more. See market, low, mid, and high prices instantly.",
    gradient: "from-indigo-500 to-blue-500",
  },
  {
    icon: BarChart3,
    title: "Portfolio Tracking",
    description: "Track your collection's total value with daily, weekly, and monthly performance analytics.",
    gradient: "from-violet-500 to-purple-500",
  },
  {
    icon: Bell,
    title: "Price Alerts",
    description: "Set thresholds on any card. Get notified when prices move so you never miss a trade.",
    gradient: "from-blue-500 to-violet-500",
  },
];

export function FeaturesSection() {
  return (
    <section id="features" className="relative py-32 overflow-hidden">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        {/* Section header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
          className="text-center mb-20"
        >
          <p className="text-sm font-semibold text-aura-purple uppercase tracking-widest mb-3">Features</p>
          <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight">
            Everything you need to
            <br />
            <span className="gradient-text">master your collection</span>
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
              className="group relative rounded-2xl glass p-8 card-hover"
            >
              <div className={`inline-flex items-center justify-center w-12 h-12 rounded-xl bg-gradient-to-br ${feature.gradient} mb-5`}>
                <feature.icon className="h-6 w-6 text-white" />
              </div>
              <h3 className="text-xl font-semibold mb-2">{feature.title}</h3>
              <p className="text-muted-foreground leading-relaxed">{feature.description}</p>

              {/* Hover glow */}
              <div className="absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none aura-glow-sm" />
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
