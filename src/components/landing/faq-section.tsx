"use client";

import { motion } from "framer-motion";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";

const faqs = [
  {
    q: "How does the card scanner work?",
    a: "Simply point your phone camera at any trading card. Our AI uses a combination of OCR text extraction and image recognition to identify the card in under 2 seconds. We match against a database of 50,000+ cards across Pokémon, Magic: The Gathering, and Yu-Gi-Oh!",
  },
  {
    q: "How accurate is the card identification?",
    a: "Aura achieves 95%+ accuracy on card identification. We use a hybrid system combining OCR and vision embeddings for best results. If the AI isn't 100% confident, it will show you alternative matches ranked by confidence score.",
  },
  {
    q: "Where do the prices come from?",
    a: "We pull real-time market pricing from TCGPlayer as our primary source, with Scryfall for Magic cards, Pokémon TCG API for Pokémon cards, and YGOProDeck for Yu-Gi-Oh! Prices update every 15 minutes.",
  },
  {
    q: "Can I track my collection's value over time?",
    a: "Yes! Aura tracks daily, weekly, and monthly portfolio performance. You can see your total collection value, biggest movers, and performance charts right from your dashboard.",
  },
  {
    q: "Is there a limit on free scans?",
    a: "Free accounts get 50 scans per day, which is plenty for casual use. Pro subscribers get unlimited scans plus additional features like price alerts, advanced analytics, and bulk scanning.",
  },
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
          <p className="text-sm font-semibold text-aura-purple uppercase tracking-widest mb-3">FAQ</p>
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight">
            Frequently asked <span className="gradient-text">questions</span>
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
                className="rounded-xl glass px-6 border-0 transition-shadow duration-300"
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
