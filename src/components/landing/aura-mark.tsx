/**
 * AuraMark — the Collector's Instrument brand glyph.
 *
 * A viewfinder reticle: four corner brackets locking onto a center point.
 * It reads as a precise instrument aimed at a card, not an "AI sparkle."
 * Pure inline SVG (no hooks) so it renders in both server and client trees.
 * Color follows `currentColor`; size via `className`.
 */
export function AuraMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      {/* Corner brackets */}
      <path d="M4 9 V4 H9" />
      <path d="M15 4 H20 V9" />
      <path d="M20 15 V20 H15" />
      <path d="M9 20 H4 V15" />
      {/* Locked center */}
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
}
