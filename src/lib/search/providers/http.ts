// ─── Provider transport — search's view (Phase 5.12A, moved in 5.13B) ───────
// The implementation moved to src/lib/providers/http.ts when the scanner's
// candidate layer turned out to need the identical rule (see that file's header
// for why). This module stays as the search layer's name for it, so nothing in
// search had to change.
//
// SearchProviderError is an ALIAS of ProviderError, not a subclass: the
// `err instanceof SearchProviderError` checks in CardSearchService keep working
// against errors thrown by shared transport, which they would not if these were
// two classes.

export {
  fetchProviderJson,
  PROVIDER_TIMEOUT_MS,
  ProviderError as SearchProviderError,
} from "@/lib/providers/http";
