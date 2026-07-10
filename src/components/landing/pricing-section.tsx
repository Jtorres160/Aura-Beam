"use client";

import { motion } from "framer-motion";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import Link from "next/link";

const plans = [
  {
    name: "Free",
    price: "$0",
    period: "forever",
    description: "Perfect for casual collectors getting started.",
    features: [
      "50 scans per day",
      "Collection tracking",
      "Basic price lookup",
      "1 watchlist",
      "Community support",
    ],
    cta: "Get Started",
    highlighted: false,
  },
  {
    name: "Pro",
    price: "$9.99",
    period: "per month",
    description: "For serious collectors who want the full edge.",
    features: [
      "Unlimited scans",
      "Advanced analytics",
      "Price alerts & notifications",
      "Unlimited watchlists",
      "Historical price charts",
      "Priority support",
      "Bulk scan mode",
      "Export collection data",
    ],
    cta: "Start Pro Trial",
    highlighted: true,
  },
];

export function PricingSection() {
  return (
    <section id="pricing" className="relative py-32">
      <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
          className="text-center mb-20"
        >
          <p className="font-mono text-xs uppercase tracking-[0.24em] text-muted-foreground mb-4">Pricing</p>
          <h2 className="font-serif text-3xl sm:text-4xl lg:text-5xl tracking-tight">
            Simple, transparent pricing
          </h2>
          <p className="mt-4 text-lg text-muted-foreground max-w-xl mx-auto">
            Start scanning for free. Upgrade when you need more power.
          </p>
        </motion.div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-4xl mx-auto">
          {plans.map((plan, i) => (
            <motion.div
              key={plan.name}
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-80px" }}
              transition={{ duration: 0.5, delay: i * 0.15 }}
              className={`relative rounded-xl border bg-card p-8 card-hover ${
                plan.highlighted ? "border-brass/50" : "border-border"
              }`}
            >
              {plan.highlighted && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-4 py-1 rounded-full font-mono text-[10px] uppercase tracking-wide bg-primary text-primary-foreground">
                  Most Popular
                </div>
              )}

              <div className="mb-6">
                <h3 className="font-serif text-2xl">{plan.name}</h3>
                <p className="text-sm text-muted-foreground mt-1">{plan.description}</p>
              </div>

              <div className="mb-8">
                <span className="font-mono text-4xl">{plan.price}</span>
                <span className="text-muted-foreground ml-2">/{plan.period}</span>
              </div>

              <ul className="space-y-3 mb-8">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-center gap-3 text-sm">
                    <Check className="h-4 w-4 text-brass shrink-0" />
                    <span className="text-muted-foreground">{f}</span>
                  </li>
                ))}
              </ul>

              <Link href="/register">
                <Button
                  className="w-full h-11 font-medium"
                  variant={plan.highlighted ? "default" : "outline"}
                >
                  {plan.cta}
                </Button>
              </Link>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
