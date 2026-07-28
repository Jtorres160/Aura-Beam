import { useCallback, useEffect, useState } from "react";

import {
  readCardView,
  writeCardView,
  type CardView,
} from "@/lib/ui/card-view";

/**
 * Grid/list preference for one surface, persisted across visits.
 *
 * Hydration note — the reason the stored value is read in an effect rather than
 * in a lazy initializer: this component tree is server-rendered, where there is
 * no localStorage. Seeding state from storage during the first client render
 * would make the client's markup disagree with the server's and React would
 * discard the tree. So the first paint is always `fallback`, and a stored
 * preference is applied immediately after mount. This mirrors how the scanner
 * page loads its own persisted toggles.
 */
export function useCardView(
  storageKey: string,
  fallback: CardView = "grid",
): [CardView, (view: CardView) => void] {
  const [view, setViewState] = useState<CardView>(fallback);

  useEffect(() => {
    const stored = readCardView(
      typeof window === "undefined" ? null : window.localStorage,
      storageKey,
    );
    if (stored) setViewState(stored);
  }, [storageKey]);

  const setView = useCallback(
    (next: CardView) => {
      setViewState(next);
      writeCardView(
        typeof window === "undefined" ? null : window.localStorage,
        storageKey,
        next,
      );
    },
    [storageKey],
  );

  return [view, setView];
}

export type { CardView };
