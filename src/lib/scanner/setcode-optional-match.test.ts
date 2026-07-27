// ─── Set-code-optional matching (Scanner V2) ─────────────────────────────────
// The change under test: candidate generation no longer needs a correct OCR set
// code to name a printing. name + collector number + printed total ("Vulpix",
// "138/132") is the primary key; the set code is a tiebreaker, not a gate.
//
// The properties pinned down here, in order of how much they matter:
//
//   1. SAFETY (the reason this is shippable at all). A key that does not resolve
//      to exactly one real catalog row returns null and the caller continues to
//      the existing all-printings path. No match, an ambiguous match, a
//      hallucinated number, a name that disagrees — every one of them degrades
//      to today's behavior. This path can decline; it can never guess.
//   2. The set code corroborates but never vetoes. It breaks ties among 2+
//      candidates and does nothing else — a DISAGREEING set code must not be
//      able to reject an otherwise-unique match, because that is precisely the
//      gate this work removes (OCR's set-code read matched 3/14 against ground
//      truth).
//   3. The flag ships OFF, and with it off the Pokémon local path is unchanged.
//
// Run: node --import ./test/register.mjs --test src/lib/scanner/setcode-optional-match.test.ts

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  SETCODE_OPTIONAL_MATCH_ENABLED,
  printedTotalFromCollectorNumber,
  resolveByNameNumberTotal,
  fetchPokemonPrintingsLocal,
} from "@/lib/scanner/candidates";
import type { CatalogCardRow, CatalogDb } from "@/lib/services/pokemon-catalog";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function row(over: Partial<CatalogCardRow> & Pick<CatalogCardRow, "externalId" | "name">): CatalogCardRow {
  return {
    setName: "Mega Evolution",
    setCode: "MEG",
    setPrintedSize: 132,
    collectorNumber: "138",
    rarity: "Common",
    imageUrl: null,
    thumbnailUrl: null,
    marketPrice: null,
    lowPrice: null,
    midPrice: null,
    highPrice: null,
    ...over,
  };
}

/** The real scan that motivated this work: Vulpix 138/132, Mega Evolution. OCR
 *  read the set code as "ME01"; the catalog stores "MEG", so the set/CN gate
 *  missed and the collector got a 20-wide grid. */
const vulpix = row({ externalId: "me1-138", name: "Vulpix" });

/** A fake catalog that answers findMany from a fixed row set, applying the same
 *  predicates the real query uses so the filtering under test is genuine. */
function fakeDb(rows: CatalogCardRow[], opts: { throws?: boolean } = {}): CatalogDb & { calls: any[] } {
  const db: any = {
    calls: [],
    catalogCard: {
      findMany: async (args: any) => {
        db.calls.push(args?.where);
        if (opts.throws) throw new Error("simulated catalog DB error");
        const w = args?.where ?? {};
        return rows.filter((r) => {
          if (w.collectorNumber?.in && !w.collectorNumber.in.includes(r.collectorNumber)) return false;
          if (w.setPrintedSize !== undefined && r.setPrintedSize !== w.setPrintedSize) return false;
          if (w.setCode?.equals && r.setCode?.toLowerCase() !== String(w.setCode.equals).toLowerCase()) return false;
          if (w.name?.equals && r.name.toLowerCase() !== String(w.name.equals).toLowerCase()) return false;
          if (w.name?.contains && !r.name.toLowerCase().includes(String(w.name.contains).toLowerCase())) return false;
          return true;
        });
      },
      findUnique: async () => null,
    },
  };
  return db;
}

// ─── 1. Parsing the printed total ────────────────────────────────────────────

describe("printedTotalFromCollectorNumber", () => {
  test("reads the denominator of a printed collector number", () => {
    assert.equal(printedTotalFromCollectorNumber("138/132"), 132);
    assert.equal(printedTotalFromCollectorNumber("021/198"), 198);
    assert.equal(printedTotalFromCollectorNumber(" 172 / 165 "), 165);
  });

  test("returns null — never a guessed total — when there is no usable denominator", () => {
    // A bare number is the important case: no total read means no key, and the
    // whole match path must stand down rather than invent one.
    assert.equal(printedTotalFromCollectorNumber("138"), null);
    assert.equal(printedTotalFromCollectorNumber("SV40"), null);
    assert.equal(printedTotalFromCollectorNumber("138/"), null);
    assert.equal(printedTotalFromCollectorNumber("138/TG30"), null);
    assert.equal(printedTotalFromCollectorNumber("138/0"), null);
    assert.equal(printedTotalFromCollectorNumber(""), null);
  });
});

// ─── 2. Resolution, and the truth boundary ───────────────────────────────────

describe("resolveByNameNumberTotal — resolves or declines, never guesses", () => {
  test("resolves a unique name+CN+total match with NO set code at all", async () => {
    const db = fakeDb([vulpix]);
    const hit = await resolveByNameNumberTotal("Vulpix", "138/132", undefined, db);
    assert.equal(hit?.externalId, "me1-138");
  });

  test("resolves even when the OCR set code is WRONG — the point of the change", async () => {
    // "ME01" is what OCR actually read for this card; the catalog says "MEG".
    const db = fakeDb([vulpix]);
    const hit = await resolveByNameNumberTotal("Vulpix", "138/132", "ME01", db);
    assert.equal(hit?.externalId, "me1-138", "a disagreeing set code must not veto a unique match");
  });

  test("tolerates zero-padding and case/accent/punctuation noise in the name", async () => {
    const pokeBall = row({
      externalId: "me3-80", name: "Poké Ball", setName: "Perfect Order",
      setCode: "POR", setPrintedSize: 88, collectorNumber: "80",
    });
    const db = fakeDb([pokeBall]);
    assert.equal((await resolveByNameNumberTotal("Poke Ball", "080/088", undefined, db))?.externalId, "me3-80");
    assert.equal((await resolveByNameNumberTotal("POKE BALL", "80/88", undefined, db))?.externalId, "me3-80");
  });

  test("declines when no catalog row carries that number/total — the hallucination case", async () => {
    // Real production read: OCR reported "Diggersby 021/198". No Diggersby is
    // printed at 21 in a 198-card set; no such card exists. Must not resolve.
    const db = fakeDb([vulpix]);
    assert.equal(await resolveByNameNumberTotal("Diggersby", "021/198", "SV3", db), null);
  });

  test("declines when the number/total hits rows but NO name agrees", async () => {
    const db = fakeDb([vulpix]);
    assert.equal(await resolveByNameNumberTotal("Ninetales", "138/132", undefined, db), null);
  });

  test("declines when the name is close but not equal — no edit-distance widening", async () => {
    // The 99.8% uniqueness measurement was taken on exact folded equality.
    // Loosening the comparator here would silently invalidate it.
    const db = fakeDb([vulpix]);
    assert.equal(await resolveByNameNumberTotal("Vulpax", "138/132", undefined, db), null);
  });

  test("declines when the collector number carries no printed total", async () => {
    const db = fakeDb([vulpix]);
    assert.equal(await resolveByNameNumberTotal("Vulpix", "138", undefined, db), null);
    assert.equal(db.calls.length, 0, "no total ⇒ no query is even issued");
  });

  test("declines on an empty/unreadable name", async () => {
    const db = fakeDb([vulpix]);
    assert.equal(await resolveByNameNumberTotal("", "138/132", undefined, db), null);
    assert.equal(await resolveByNameNumberTotal("!!!", "138/132", undefined, db), null);
  });
});

// ─── 3. Ambiguity: the set code corroborates, it does not gate ───────────────

describe("resolveByNameNumberTotal — ambiguity handling", () => {
  // The real shape of catalog ambiguity: 41 keys in 20,479 rows, worst case 3.
  const twins = [
    row({ externalId: "sv1-25", name: "Pikachu", setName: "Scarlet & Violet", setCode: "SVI", setPrintedSize: 12, collectorNumber: "6" }),
    row({ externalId: "swsh-25", name: "Pikachu", setName: "Sword & Shield", setCode: "SSH", setPrintedSize: 12, collectorNumber: "6" }),
  ];

  test("declines a 2-way tie when no set code is available", async () => {
    assert.equal(await resolveByNameNumberTotal("Pikachu", "6/12", undefined, fakeDb(twins)), null);
  });

  test("a correct set code breaks the tie", async () => {
    const hit = await resolveByNameNumberTotal("Pikachu", "6/12", "SSH", fakeDb(twins));
    assert.equal(hit?.externalId, "swsh-25");
  });

  test("a set code matching NEITHER candidate declines rather than picking one", async () => {
    assert.equal(await resolveByNameNumberTotal("Pikachu", "6/12", "SV3", fakeDb(twins)), null);
  });

  test("a set code matching BOTH candidates declines — it broke no tie", async () => {
    const sameCode = twins.map((r) => ({ ...r, setCode: "SSH" }));
    assert.equal(await resolveByNameNumberTotal("Pikachu", "6/12", "SSH", fakeDb(sameCode)), null);
  });
});

// ─── 4. Wiring: tier order, flag, and fail-open ──────────────────────────────

describe("fetchPokemonPrintingsLocal — the new tier in context", () => {
  // Drive the wiring directly rather than through the module-level flag, which
  // is read at import time. These call resolveByNameNumberTotal's collaborators
  // through the same injected db seam the M4 tests use.

  test("with the flag OFF the tier is skipped and the grid path is unchanged", async () => {
    // The committed default. A Vulpix scan whose set code missed still produces
    // the all-printings outcome it produces today.
    const others = [
      vulpix,
      row({ externalId: "sv3pt5-58", name: "Vulpix", setName: "151", setCode: "MEW", setPrintedSize: 165, collectorNumber: "37" }),
    ];
    const outcome = await fetchPokemonPrintingsLocal("Vulpix", "ME01", "138/132", fakeDb(others));
    assert.equal(outcome?.status, "found");
    if (outcome?.status !== "found") return;
    if (SETCODE_OPTIONAL_MATCH_ENABLED) {
      assert.equal(outcome.fallbackMethod, "name-cn-total-verified");
    } else {
      // Flag off ⇒ no fallback method from this tier; candidates come as a grid.
      assert.notEqual(outcome.fallbackMethod, "name-cn-total-verified");
      assert.ok(outcome.printings.length > 0, "the existing all-printings path still answers");
    }
  });

  test("flag OFF ⇒ resolveByNameNumberTotal is never CALLED, not called-and-discarded", async () => {
    // The distinction is not pedantic. A call whose RESULT is discarded under a
    // flag check is still a live production query on every Pokémon scan, buying
    // nothing — that is materially different from "off", and it is not what
    // flag-off means anywhere else in this codebase.
    //
    // Proven by call log rather than by reading the `&&`: the new tier's query
    // is the only one that carries a setPrintedSize predicate, so its absence
    // from the log is proof the code path was never entered.
    const db = fakeDb([vulpix]);
    await fetchPokemonPrintingsLocal("Vulpix", "ME01", "138/132", db);
    const tierQueries = db.calls.filter((w: any) => w?.setPrintedSize !== undefined);

    if (SETCODE_OPTIONAL_MATCH_ENABLED) {
      assert.ok(tierQueries.length > 0, "flag on ⇒ the tier must actually query");
    } else {
      assert.equal(tierQueries.length, 0, "flag off ⇒ the tier must issue ZERO queries");
      assert.ok(db.calls.length > 0, "…while the existing path still queried as it does today");
    }
  });

  test("a set/CN direct hit still outranks the new tier", async () => {
    // set-cn-verified (0.97) is stronger and already trusted; the new tier must
    // not shadow it when the set code happened to be right.
    const outcome = await fetchPokemonPrintingsLocal("Vulpix", "MEG", "138/132", fakeDb([vulpix]));
    assert.equal(outcome?.status, "found");
    if (outcome?.status !== "found") return;
    assert.equal(outcome.fallbackMethod, "set-cn-verified");
    assert.equal(outcome.fallbackCard?.externalId, "me1-138");
  });

  test("a catalog error still fails OPEN to the live API (null), never to a verdict", async () => {
    assert.equal(await fetchPokemonPrintingsLocal("Vulpix", "MEG", "138/132", fakeDb([vulpix], { throws: true })), null);
  });

  test("resolveByNameNumberTotal propagates a DB error to its caller's try/catch", async () => {
    // It deliberately does NOT swallow: fetchPokemonPrintingsLocal's catch is
    // the one place that decides a local failure means "ask the live API".
    await assert.rejects(() => resolveByNameNumberTotal("Vulpix", "138/132", undefined, fakeDb([vulpix], { throws: true })));
  });
});

// ─── 5. The flag ships OFF ───────────────────────────────────────────────────

describe("SETCODE_OPTIONAL_MATCH_ENABLED — off unless explicitly enabled", () => {
  test("default (env unset) is OFF — turning it on is a separate, reviewed decision", () => {
    assert.equal(SETCODE_OPTIONAL_MATCH_ENABLED, process.env.SETCODE_OPTIONAL_MATCH_ENABLED === "1");
    assert.equal(SETCODE_OPTIONAL_MATCH_ENABLED, false);
  });
});
