"use client";

import { motion } from "framer-motion";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";

const faqs = [
  {
    q: "How does the card scanner work?",
    a: "Simply point your phone camera at any trading card. Aura combines OCR text extraction and image recognition to identify the card in seconds, matching against a comprehensive database covering Pokémon, Magic: The Gathering, and Yu-Gi-Oh!",
  },
  {
    q: "How accurate is the card identification?",
    a: "Aura uses a hybrid system combining OCR and vision embeddings for best results. If it isn't fully confident about the exact printing, it shows you the closest candidate versions so you can confirm the right one.",
  },
  {
    q: "Where do the prices come from?",
    a: "We pull real-time market pricing from TCGPlayer as our primary source, with Scryfall for Magic cards, Pokémon TCG API for Pokémon cards, and YGOProDeck for Yu-Gi-Oh! Prices update every 15 minutes.",
  },
  {
    q: "Can I track my collection's value over time?",
    a: "Yes! Aura tracks daily, weekly, and monthly portfolio performance. You can see your total collection value, biggest movers, and performance charts right from your dashboard.",
  },
  // BETA: Aura subscription messaging hidden for private beta. Restore this FAQ entry when pricing returns.
  // {
  //   q: "Is there a limit on free scans?",
  //   a: "Free accounts get 50 scans per day, which is plenty for casual use. Pro subscribers get unlimited scans plus additional features like price alerts, advanced analytics, and bulk scanning.",
  // },
  {
    q: "Does Aura work offline?",
    a: "Aura requires an internet connection for card identification and pricing. However, your collection data is cached locally so you can browse your cards offline. PWA support means you can install Aura on your home screen for quick access.",
  },
];

export function FaqSection() {
  return (
    <section id="faq" className="relative py-32">
      <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
          className="text-center mb-16"
        >
          <p className="font-mono text-xs uppercase tracking-[0.24em] text-muted-foreground mb-4">FAQ</p>
          <h2 className="font-serif text-3xl sm:text-4xl tracking-tight">
            Frequently asked questions
          </h2>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.5 }}
        >
          <Accordion className="space-y-3">
            {faqs.map((faq, i) => (
              <AccordionItem
                key={i}
                className="rounded-lg bg-card border border-border px-6 transition-shadow duration-300"
              >
                <AccordionTrigger className="text-left font-medium hover:no-underline py-5 text-sm sm:text-base">
                  {faq.q}
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground pb-5 leading-relaxed text-sm">
                  {faq.a}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </motion.div>
      </div>
    </section>
  );
}
