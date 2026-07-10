"use client";

import { motion } from "framer-motion";

const games = [
  {
    name: "Pokémon",
    features: ["Modern & vintage sets", "Alternate arts", "Trainer & energy cards", "Full set coverage"],
  },
  {
    name: "Magic: The Gathering",
    features: ["Standard & Commander", "Secret Lair editions", "Vintage & Reserved List", "All major printings"],
  },
  {
    name: "Yu-Gi-Oh!",
    features: ["All major printings", "Alternate rarities", "Promo cards", "OCG & TCG editions"],
  },
];

export function GamesSection() {
  return (
    <section id="games" className="relative py-32">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
          className="text-center mb-20"
        >
          <p className="font-mono text-xs uppercase tracking-[0.24em] text-muted-foreground mb-4">Supported Games</p>
          <h2 className="font-serif text-3xl sm:text-4xl lg:text-5xl tracking-tight">
            Every major trading card game
          </h2>
        </motion.div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 lg:gap-8">
          {games.map((game, i) => (
            <motion.div
              key={game.name}
              initial={{ opacity: 0, y: 40 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-80px" }}
              transition={{ duration: 0.6, delay: i * 0.15 }}
              className="rounded-xl border border-border bg-card p-8 card-hover"
            >
              {/* Brass catalog rule */}
              <div className="w-8 h-px bg-brass mb-6" />
              <h3 className="font-serif text-2xl mb-5">{game.name}</h3>

              <ul className="space-y-2.5">
                {game.features.map((f) => (
                  <li key={f} className="flex items-center gap-2.5 text-sm text-muted-foreground">
                    <div className="w-1 h-1 rounded-full bg-brass shrink-0" />
                    {f}
                  </li>
                ))}
              </ul>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
