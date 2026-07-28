"use client";

import { Grid3X3, List } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { CardView } from "@/lib/ui/card-view";

/**
 * Grid/list switch for any surface that lays out cards.
 *
 * Lifted verbatim out of the collection page so the search page could show the
 * same control instead of a second one that drifts from it. The visual spec —
 * two 36px icon buttons, the active one filled, the inactive one outlined — is
 * unchanged from what collectors already use; only the accessible names are new
 * (the inline version was two icon buttons with no name at all, which reads to
 * a screen reader as an unlabelled "button, button").
 *
 * `aria-pressed` rather than a radiogroup: this is two toggle buttons, and the
 * pressed state is what conveys which layout is active once the fill is gone.
 */
export function ViewToggle({
  view,
  onChange,
  className,
}: {
  view: CardView;
  onChange: (view: CardView) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <Button
        variant={view === "grid" ? "default" : "outline"}
        size="icon"
        className="h-9 w-9 rounded-lg"
        aria-label="Grid view"
        aria-pressed={view === "grid"}
        title="Grid view"
        onClick={() => onChange("grid")}
      >
        <Grid3X3 className="h-4 w-4" />
      </Button>
      <Button
        variant={view === "list" ? "default" : "outline"}
        size="icon"
        className="h-9 w-9 rounded-lg"
        aria-label="List view"
        aria-pressed={view === "list"}
        title="List view"
        onClick={() => onChange("list")}
      >
        <List className="h-4 w-4" />
      </Button>
    </div>
  );
}
