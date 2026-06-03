"use client";

import { motion } from "framer-motion";

const games = [
  {
    name: "Pokémon",
    color: "from-yellow-400 to-orange-500",
    shadowColor: "rgba(250,204,21,0.25)",
    features: ["Modern & vintage sets", "Alternate arts", "Trainer & energy cards", "Full set coverage"],
    emoji: "⚡",
  },
  {
    name: "Magic: The Gathering",
    color: "from-purple-500 to-rose-500",
    shadowColor: "rgba(168,85,247,0.25)",
    features: ["Standard & Commander", "Secret Lair editions", "Vintage & Reserved List", "All major printings"],
    emoji: "🔮",
  },
  {
    name: "Yu-Gi-Oh!",
    color: "from-blue-500 to-cyan-400",
    shadowColor: "rgba(59,130,246,0.25)",
    features: ["All major printings", "Alternate rarities", "Promo cards", "OCG & TCG editions"],
    emoji: "🐉",
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
          <p className="text-sm font-semibold text-aura-purple uppercase tracking-widest mb-3">Supported Games</p>
          <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight">
            Scan cards from <span className="gradient-text">every major TCG</span>
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
              className="relative rounded-2xl glass p-8 card-hover group overflow-hidden"
            >
              {/* Gradient top accent */}
              <div className={`absolute top-0 left-0 right-0 h-1 bg-gradient-to-r ${game.color}`} />

              <div className="text-4xl mb-4">{game.emoji}</div>
              <h3 className="text-xl font-bold mb-4">{game.name}</h3>

              <ul className="space-y-2.5">
                {game.features.map((f) => (
                  <li key={f} className="flex items-center gap-2.5 text-sm text-muted-foreground">
                    <div className={`w-1.5 h-1.5 rounded-full bg-gradient-to-r ${game.color} shrink-0`} />
                    {f}
                  </li>
                ))}
              </ul>

              {/* Hover glow */}
              <div
                className="absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none"
                style={{ boxShadow: `0 0 60px -12px ${game.shadowColor}` }}
              />
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
