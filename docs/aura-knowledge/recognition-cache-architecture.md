# Recognition Cache & Scanner Stabilization — Architecture Plan

**Status:** design only. No code in this document. This is the final production
architecture for the scan pipeline before deadline.

**The goal, stated once:** a collector scans a *known* card and gets a fast,
reliable result. A collector scans an *unknown* card and still gets full
analysis. Nothing below weakens the second to buy the first.

---

## 0. What is actually wrong (grounded in the code, not the vibe)

The five reported problems reduce to **one structural gap and one path bug**,
plus two things the code already does correctly that we must not break.

| Reported symptom | Root cause (from the code) | Verdict |
| --- | --- | --- |
| Repeated scans re-hit external providers | `fetchAllPrintings` in [candidates.ts](../../src/lib/scanner/candidates.ts) has **no local-first tier**. Every scan calls Scryfall/Pokémon/YGO — even for a card we accepted and wrote to `Card` an hour ago. `persistPrinting` writes the printing; nothing ever reads it back as a candidate. | **Structural gap.** The store exists; the read path doesn't. |
| Pokémon timeout → 12–13 s scans | `PROVIDER_TIMEOUT_MS = 8_000` ([http.ts](../../src/lib/providers/http.ts)) **and** the unknown-game path runs MTG → Pokémon → YGO **sequentially** ([candidates.ts:218-232](../../src/lib/scanner/candidates.ts)). A Pokémon card scanned with "All" pays MTG's round-trip *then* an 8 s Pokémon hang, serially. | **Path bug + no circuit breaker.** |
| Provider failure "affects evidence confidence" | It does **not** lower a confidence number — [candidates.ts:26-28](../../src/lib/scanner/candidates.ts) is explicit and correct. What actually happens: a re-scan of a *known* card is needlessly re-exposed to provider state, so an outage turns a card we already verified into a 503 `provider-unavailable`. | **Correct layer, wrong exposure.** Fixed by cache-first, not by touching the truth layer. |
| Persistence adds 1.7–2 s | Measured: [persistence-latency-investigation.md](./persistence-latency-investigation.md) §8 — dark remainder is **727 ms median / 1639 ms p95** on accepts, and it **does not scale with write count** (727 ms at 5 writes ≈ 755 ms at 1 write). It is *tail* cost, not median, and half of it is inter-stage gap, not the writes. | **Real but overstated.** The fix is to move it *off the critical path*, not to optimize the writes. |
| "Feels unreliable despite individual fixes" | Each fix was correct in isolation; there is no layer that lets a known card *skip the unreliable parts entirely*. Reliability comes from **not depending on a flaky provider for a card we already know**. | Emergent — solved by the cache. |

**Two invariants we preserve (they are already right):**

1. AI is a sensor; the scorer decides. The cache must be a **candidate
   source**, never a decision authority.
2. A provider that goes quiet yields `provider_unavailable`, never a zero. The
   cache must never launder an outage into a false answer.

---

## 1. Recognition memory / cache layer

### The core idea

Insert a **Tier 0 local source** in front of the providers. It answers one
question with authority Aura already trusts: *"Have we authoritatively resolved
this printing before?"* The `Card` table is already that memory — `persistPrinting`
only ever writes **re-fetched, authoritative** printings (accept path and
user-selection path both re-fetch from source before persisting). So a `Card`
row's *existence* already means "a provider verified this printing." We are not
adding trust; we are reading trust we already stored.

### It is a source, not a shortcut

The cache does **not** decide. It returns `CandidatePrinting[]` into the **exact
same** `scorer.score(...)` → `gateDecision(...)` path a provider would. The OCR
evidence is scored against the cached printing identically. This keeps
`Evidence → Verification → Decision` intact: a cache hit still has to *win on the
evidence* to be accepted. A cache hit on the wrong card loses to the scorer just
as a provider hit on the wrong card does.

### Lookup keys (in priority order)

| Tier-0 key | When | Backed by |
| --- | --- | --- |
| `(game, setCode, collectorNumber)` | set/CN games (MTG, Pokémon) with a strip-verified strip | existing `@@index([game, setCode, collectorNumber])` |
| `(game, externalId)` | user re-scan of a saved card, or known art-variant id | existing `@unique(externalId)` |
| `(game, nameKey)` | fallback / Yu-Gi-Oh (no set-CN evidence) | new `@@index([game, nameKey])` (see §2) |

If Tier 0 returns candidates, it is recorded as a `completed` source in the
existing `SourceTracker` model — **the truth layer already understands it**. A
cache hit that produces candidates means `status: "found"`, and providers are
not consulted at all.

### Two things the cache serves, split by volatility

This split is the whole reason the cache is safe:

- **Identity + printing + image** (which card, which printing, what it looks
  like): **stable forever.** A Counterspell from MH2 #267 is that card
  permanently. Serve from cache with no freshness concern — this is what the
  scanner needs to *identify*.
- **Price**: **volatile, and not identification evidence.** Never gate a scan on
  price freshness. Serve identity instantly; refresh price **asynchronously**
  after the response using `CardPrice.lastUpdated` as a TTL (e.g. stale > 24 h →
  queue a background refresh). The collector's *identification* never waits on a
  price call.

### Negative cache (Phase 2, optional)

Remember **earned** `not_found` for `(game, nameKey)` with a short TTL, so a
genuinely-unknown card doesn't re-hammer providers on every retry. Store **only**
the `no_candidates` verdict (every source answered, none had it) — **never**
`provider_unavailable`. Caching an outage is caching a lie; that is the precise
anti-pattern Phase 5.13B removed and we do not reintroduce it.

---

## 2. Database schema changes

**All additive. No destructive change, no backfill required.** The cache reuses
`Card`/`CardPrice`; the only new columns support name-keyed hits and a background
price-refresh signal.

```prisma
model Card {
  // ... existing fields unchanged ...

  // Normalized identity key for cache lookups that survive OCR casing/
  // punctuation noise (e.g. "Charizard ex" vs "charizard ex"). Written on
  // persist; a nullable column so existing rows need no backfill (they simply
  // don't produce name-key hits until next re-scan re-persists them).
  nameKey        String?

  @@index([game, nameKey])   // new — name-fallback cache tier
  // existing: @@index([game, setCode, collectorNumber]) already backs Tier 0
}
```

`CardPrice.lastUpdated` **already exists** — reuse it as the async-refresh TTL.
No change to `CardPrice`.

`ScanHistory`: **no schema change.** Cache telemetry (`cacheHit`, `cacheTier`,
`cacheAgeMs`) rides inside the existing versioned `ocrText` JSON, exactly as
`timings` and candidate `sources` already do. Bump the telemetry version.

**Optional Phase 2 — negative cache:**

```prisma
model RecognitionMiss {
  id        String   @id @default(cuid())
  game      String
  nameKey   String
  createdAt DateTime @default(now())   // TTL enforced at query time
  @@unique([game, nameKey])
  @@index([createdAt])
}
```

**Migration mechanics:** add the nullable column, then build the index
`CONCURRENTLY` (no table lock on the serverless Postgres). `nameKey` is populated
going forward by `persistPrinting`; old rows self-heal on their next re-scan
(the upsert's `update` branch already refreshes metadata — extend it to write
`nameKey`). No migration downtime, fully reversible (drop column/index).

---

## 3. Provider usage strategy

Four changes, in descending order of impact:

1. **Cache-first (Tier 0).** Consult the local recognition cache before any
   provider. On a hit, providers are never called. This alone removes the
   provider from the critical path for every repeat scan of a known card — which
   is the common case for an active collector, and the case the deadline is
   about.

2. **Parallelize the unknown-game probe.** Today the three providers run
   sequentially, so an unknown-game Pokémon card pays `MTG + 8 s Pokémon` in
   series. Run the three provider paths **concurrently** and take the first
   `found`; a single timeout then bounds the wait at ~8 s instead of the *sum*.
   When OCR gives a confident `aiGame`, keep skipping straight to that one
   provider (already done via `effectiveGame`) — parallelism is only the
   unknown-game fallback.

3. **Circuit breaker on flaky providers (Pokémon first).** After *N* consecutive
   failures within a window, open the circuit and return `provider_unavailable`
   **immediately** for a cooldown instead of paying the 8 s timeout on every
   scan during an outage. In-memory, per-instance — the **same pattern already
   accepted** for `checkScanBurst` in [rate-limit.ts](../../src/lib/rate-limit.ts).
   The cache makes this cheap: known cards bypass the breaker entirely, so it
   only guards *first-time* scans during an outage.

4. **Keep the 8 s ceiling as the ceiling, not the norm.** Do **not** lower
   `PROVIDER_TIMEOUT_MS` to force speed — a shorter ceiling manufactures false
   `timeout` verdicts. The breaker + cache remove the timeout from the hot path
   without lying about a provider's health.

The truth layer is untouched: Tier 0 hit = `completed` source; open circuit =
`failed` source (`provider_unavailable`), never a zero.

---

## 4. Evidence preservation (the non-negotiable section)

Every rule here exists so the cache cannot become "AI guess → user."

- **Cache candidates flow through the scorer.** No `if (cacheHit) accept`. The
  cached printing is scored against OCR evidence by the same `scorer.score`, and
  must clear the same `gateDecision` thresholds. A cache hit is *evidence*, not a
  *verdict*.
- **Provenance is honest.** Cached candidates carry `EvidenceSource: "search"`
  (they originated from a provider lookup) with identical scoring weight — a
  cache hit and a live hit are the same *kind* of evidence and must not be
  weighted differently. Add a **telemetry-only** `cacheTier` tag so hit-rate and
  any accuracy delta are measurable, without touching `EVIDENCE_WEIGHTS` (which
  are still uncalibrated — see [[evidence-weights-provisional]]).
- **A provider failure never lowers confidence** — unchanged, already correct.
- **A provider failure never erases evidence we already hold** — *new guarantee
  from the cache.* A known card yields positive candidate evidence regardless of
  provider state, so `provider_unavailable` can no longer downgrade a
  previously-verified card. This is the honest fix for the reported "provider
  failure affects confidence" symptom.
- **The negative cache stores only earned zeros**, never outages (§1).
- **Everything is telemetered** (`cacheHit`, `cacheTier`, `cacheAgeMs`,
  hit/miss, and — in shadow mode — cache-vs-provider agreement) so the Phase 6
  calibration dataset ([[evidence-calibration-plan]]) stays real, not simulated.

---

## 5. Latency targets

Grounded in the measured baseline (OCR ~1763 ms median is the dominant,
irreducible sensor cost; dark remainder 727 ms median / 1639 ms p95; provider
tail up to 8 s / 12–13 s worst).

| Scenario | Today | Target | How |
| --- | --- | --- | --- |
| **Known card (cache hit)** | 3.8 s median, 12–13 s worst | **< 2.0 s** | OCR (~1.7 s, the floor) + cache lookup < 20 ms + persistence moved off critical path. The provider — and its timeout — are gone from the path entirely. |
| **Unknown card (cache miss, healthy providers)** | ~3.8 s median | **≤ 4 s p95** | parallel provider probe + async persistence. Full analysis preserved. |
| **Unknown card during a provider outage** | 12–13 s | **< 2 s to an honest "couldn't verify"** | circuit breaker returns `provider_unavailable` fast instead of hanging 8 s. |
| **Persistence** | 727 ms median / 1.6 s p95, on the critical path | **~0 ms perceived** | return the response after the decision; run `persistPrinting` + price refresh + archive **after** response via the platform's `waitUntil` (see §6 risk). |

The honest floor for a known-card scan is **OCR itself** (~1.7 s) — it is the
sensor of record and we are not removing it. The win is eliminating everything
*around* OCR: the provider round-trip, the timeout tail, and the synchronous
persist. That takes the *typical* known-card scan from ~3.8 s (and the bad tail
from 12–13 s) down to roughly OCR + overhead ≈ **1.8–2.0 s, reliably**.

---

## 6. Migration risk & rollout

Ordered least-to-most risky; each stage is independently shippable and
independently revertible.

1. **Schema (zero behavioral risk).** Add nullable `Card.nameKey` + index
   `CONCURRENTLY`. Nothing reads it yet. Fully reversible.

2. **Cache in shadow mode (zero behavioral risk).** Perform the Tier-0 lookup on
   every scan, **log** hit/miss and whether the cache candidate matches the
   provider's chosen candidate, but **still serve from the provider.** Run one
   window (≥100 scans). This is the codebase's "measure before you switch"
   discipline — it proves the cache *would have returned the same
   identification* before we trust it. If cache-vs-provider agreement isn't
   effectively 100% on set-CN-verified hits, we stop and investigate rather than
   ship.

3. **Cache-first serving (low risk).** Flip Tier 0 to serve. **Cache miss ==
   byte-identical to today's behavior** (falls straight through to the existing
   provider path), so the blast radius is exactly "known cards get faster." Behind
   a flag; revert = flip the flag.

4. **Parallel probe + circuit breaker (low-medium risk).** Changes only the
   *unknown-game* and *outage* paths. In-memory breaker mirrors the existing
   `checkScanBurst` pattern, so no new infra. Revert = flag.

5. **Async persistence (highest risk — do last, alone).** The response no longer
   waits for `persistPrinting`/archive. Risks and mitigations:
   - *Serverless kill:* a fire-and-forget promise can be frozen when the lambda
     returns. **Must** use the platform `waitUntil` (Vercel `after`/`waitUntil`),
     not a bare floating promise.
   - *`historyId` in the response:* keep the single fast `scanHistory.create`
     that mints `historyId` **on** the critical path (~200 ms insert); move only
     `persistPrinting` (Card/CardPrice upserts), archive context, and price
     refresh off-path.
   - *Rate-limit read:* `scansToday` counts committed rows; the daily-cap count
     already tolerates eventual consistency (it counts *prior* accepts). Verify
     no read-after-write dependency before shipping.
   - Note the measured reality: this saves ~700 ms median / up to 1.7 s tail of
     *perceived* latency — real, but the smallest lever here. Ship it last and
     only if stages 1–4 land clean.

**Explicitly out of scope / not doing:**
- Not lowering `PROVIDER_TIMEOUT_MS` (manufactures false timeouts).
- Not touching `EVIDENCE_WEIGHTS`, thresholds, ranking, or the scorer — the
  cache feeds them, it does not change them.
- Not batching or "optimizing" the persist writes — the data says they don't
  scale with write count; moving them off-path is the whole win.

---

## 7. Sequencing summary

```
Stage 1  schema: Card.nameKey + index (CONCURRENTLY)         ── safe, additive
Stage 2  cache lookup in SHADOW (log agreement, serve provider)
              └─ gate: ~100% agreement on set-CN hits before proceeding
Stage 3  cache-first SERVING (flag)   ── known cards get fast; miss == today
Stage 4  parallel unknown-game probe + Pokémon circuit breaker (flag)
Stage 5  async persistence via waitUntil (flag)   ── last, alone
Phase 2  negative cache (earned zeros only) + async price refresh
```

Each stage answers the deadline's actual question — *known card, fast and
reliable* — earlier than the last, and stage 3 alone delivers most of it.
</content>
</invoke>
