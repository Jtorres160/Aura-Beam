"use client";

import { motion } from "framer-motion";

// The product's actual sequence — the "See How It Works" the hero promises.
// Folds the former four features (scan, pricing, portfolio, alerts) into one
// legible narrative: Scan → Identify → Value → Track.
const steps = [
  {
    title: "Scan",
    description:
      "Point your camera at any card. Aura reads the printing in real time — no typing, no set codes.",
  },
  {
    title: "Identify",
    description:
      "OCR and image recognition match the exact printing — down to edition and rarity — in seconds.",
  },
  {
    title: "Value",
    description:
      "Live market pricing from TCGPlayer, Scryfall, and more attaches the moment the card is found.",
  },
  {
    title: "Track",
    description:
      "Every card enters your archive. Watch its value move and set alerts so you never miss a trade.",
  },
];

export function FeaturesSection() {
  return (
    <section id="features" className="relative py-32">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        {/* Header — left-aligned so the section reads as the instrument's
            manual, a directional counterpoint to the centered reference
            sections (Games, FAQ) that follow. */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
          className="max-w-2xl"
        >
          <p className="font-mono text-xs uppercase tracking-[0.24em] text-muted-foreground mb-4">
            How Aura works
          </p>
          <h2 className="font-serif text-3xl sm:text-4xl lg:text-5xl tracking-tight">
            Four steps from camera to catalog
          </h2>
        </motion.div>

        {/* Sequence — numbered steps, each opened by a ledger rule with a
            brass node. The four brass ticks march left→right as the story. */}
        <ol className="mt-16 grid gap-10 sm:grid-cols-2 lg:mt-20 lg:grid-cols-4 lg:gap-8">
          {steps.map((step, i) => (
            <motion.li
              key={step.title}
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-80px" }}
              transition={{ duration: 0.5, delay: i * 0.1 }}
              className="relative"
            >
              {/* Ledger rule + sequence node */}
              <div className="h-px w-full bg-border" />
              <div className="absolute left-0 top-0 h-px w-8 bg-brass" />

              <span className="mt-5 block font-mono text-sm text-brass">
                {String(i + 1).padStart(2, "0")}
              </span>
              <h3 className="mt-3 font-serif text-2xl">{step.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {step.description}
              </p>
            </motion.li>
          ))}
        </ol>
      </div>
    </section>
  );
}
