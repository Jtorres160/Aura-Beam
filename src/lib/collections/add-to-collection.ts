// ─── Adding a card to a collection, from the client ──────────────────────────
// One place where "did this add succeed, and if not, what do we tell the
// collector?" is decided. Before this, each surface inlined its own fetch and
// swallowed every failure into console.error — so a click that did nothing and
// a click that failed for a real reason looked identical to the user.
//
// This is the same rule the scanner and search layers already follow, applied to
// a write instead of a read: never report a state we haven't verified. In
// particular, a failed add must NEVER leave the UI showing "In Collection" —
// that would be a fresh lie told to smooth over an old one.
//
// The server already writes honest, specific copy for the case it knows most
// about (a source database that went quiet → messageForUnavailableAdd), so we
// prefer the server's message whenever it sent one and only fall back to our
// own wording when it didn't.

import type { PostAddArchive } from "@/types/card";

export interface AddToCollectionInput {
  /** Local Card id OR the card's externalId — the route resolves either. */
  cardId: string;
  /** Lets the route re-fetch an unknown card from the RIGHT source database
   *  instead of probing every game. Omit only when genuinely unknown. */
  game?: string;
  /** Present only for adds originating from a scan review screen. */
  scanId?: string;
}

export type AddToCollectionResult =
  | { ok: true; archive: PostAddArchive | null; message: string }
  | { ok: false; message: string };

/** Fallback copy, used only when the server didn't say anything more specific. */
const FALLBACK: Record<number, string> = {
  401: "You're signed out, so this card wasn't added. Sign in and try again.",
  400: "This card is missing an identifier, so it couldn't be added.",
  404: "We looked, and this card isn't in any of our card databases.",
};
const GENERIC = "We couldn't add this card to your collection. Try again in a moment.";
const UNREACHABLE =
  "We couldn't reach Aura to add this card, so nothing was saved. Check your connection and try again.";

/**
 * POST the add and return a verdict the caller can render directly.
 *
 * Never throws: every failure — transport, HTTP status, unparseable body — comes
 * back as `{ ok: false, message }` so no caller can accidentally treat a thrown
 * error as "nothing happened".
 */
export async function addCardToCollection(
  input: AddToCollectionInput,
  fetchImpl: typeof fetch = fetch
): Promise<AddToCollectionResult> {
  let res: Response;
  try {
    res = await fetchImpl("/api/collections/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch {
    // The request never completed, so we know nothing about the server's state.
    return { ok: false, message: UNREACHABLE };
  }

  // A body is optional from our point of view — a 500 from the platform itself
  // may not be JSON at all. Its absence must not turn a failure into a success.
  const json: { success?: boolean; message?: string; archive?: PostAddArchive | null } | null =
    await res.json().catch(() => null);

  if (!res.ok || json?.success !== true) {
    return { ok: false, message: json?.message || FALLBACK[res.status] || GENERIC };
  }

  return {
    ok: true,
    archive: json.archive ?? null,
    message: json.message || "Card added to collection",
  };
}
