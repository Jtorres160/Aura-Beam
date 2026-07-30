"use client";

// ═══════════════════════════════════════════════════════════
// Aura — Reveal plate (design exploration, Phase R1)
// ═══════════════════════════════════════════════════════════
// The card-landing visual of the post-scan reveal. Both the scanner result state
// and the /dev/reveal-preview comparison render THIS component, so the design
// review and production can never drift apart — a comparison screenshot is the
// same markup, not a mockup of it.
//
// The scanner passes revealAccentHex(scanResult) (card-color.ts); the preview
// passes each treatment's candidate colour, including `null` for the baseline.
//
// The accent is a WASH, not a glow: a wide, heavily-blurred bounce behind the
// card plus an accent-tinted drop shadow — the color a physical card would spill
// onto the surface it lands on. That framing is what keeps it inside AGENTS.md's
// "no glowing AI visuals": light spilling off an object is museum lighting; a
// symmetrical neon corona around a floating panel is not.
//
// The foil hairline is untouched and stays neutral. It is the screen's one
// --foil moment (globals.css), and the wash is a different device — colored
// light, not iridescence — so the one-foil-per-screen budget still holds.

import { motion } from "framer-motion";
import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

export interface RevealPlateProps {
  name: string;
  imageUrl: string | null;
  /** Hex pigment for the wash, already clamped to the house palette (see
   *  card-color.ts). `null` = this card declares no color, so the reveal stays
   *  exactly as flat as it is today. Absence must never be faked into a color. */
  accent?: string | null;
  /** Skip the entrance animation (used by the design-preview grid, which needs
   *  every tile settled at the same moment for a like-for-like capture). */
  still?: boolean;
  className?: string;
}

export function RevealPlate({ name, imageUrl, accent = null, still = false, className }: RevealPlateProps) {
  const entrance = still
    ? {}
    : {
        initial: { opacity: 0, y: 18, scale: 0.94 },
        animate: { opacity: 1, y: 0, scale: [0.94, 1.015, 1] },
        transition: {
          duration: 0.55,
          ease: [0.22, 1, 0.36, 1] as const,
          // Slight overshoot then settle — the card "lands" in the archive
          // instead of simply fading up.
          scale: { duration: 0.55, times: [0, 0.62, 1], ease: [0.22, 1, 0.36, 1] as const },
        },
      };

  return (
    <motion.div {...entrance} className={cn("relative mx-auto w-44 sm:w-52", className)}>
      {accent && (
        <div
          aria-hidden
          className="reveal-wash"
          style={{ ["--reveal-accent" as string]: accent }}
        />
      )}
      <div
        className="relative card-frame border border-border bg-muted"
        style={{
          boxShadow: accent
            ? // Same geometry as the untinted shadow below — only the pigment
              // changes, so the card's weight on the page never shifts between
              // a colored and a colorless reveal.
              `0 24px 48px -24px color-mix(in oklab, ${accent} 55%, rgba(19,18,16,0.5))`
            : "0 24px 48px -24px rgba(19,18,16,0.5)",
        }}
      >
        {imageUrl ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src={imageUrl} alt={name} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Sparkles className="h-8 w-8 text-muted-foreground/40" />
          </div>
        )}
      </div>
    </motion.div>
  );
}
