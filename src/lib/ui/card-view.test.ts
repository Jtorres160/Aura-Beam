// Card view preference — the storage layer must never turn junk into a choice.
//
// The React binding (@/hooks/use-card-view) is a thin wrapper over these four
// functions, so everything with a failure mode lives here and is testable
// without a DOM. Two properties are pinned:
//
//   1. A stored value is UNTRUSTED input. Another tab, an older build, or a
//      user editing devtools can put anything under the key. Only "grid" and
//      "list" may become a view; everything else reads as "no preference", and
//      the caller's own default stands.
//
//   2. Storage can THROW, not just miss. Safari private mode and blocked
//      third-party storage reject getItem/setItem outright. Neither call may
//      propagate — a preference that can't be saved costs one click, but an
//      exception out of a render or a click handler breaks the page.
//
// Run: node --import ./test/register.mjs --test src/lib/ui/card-view.test.ts

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  CARD_VIEW_KEYS,
  parseCardView,
  readCardView,
  writeCardView,
  type CardViewStorage,
} from "@/lib/ui/card-view";

/** A minimal in-memory Storage stand-in. */
function fakeStorage(initial: Record<string, string> = {}): CardViewStorage & {
  data: Record<string, string>;
} {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

/** Storage that rejects every access, as a blocked browser does. */
const hostileStorage: CardViewStorage = {
  getItem() {
    throw new DOMException("The operation is insecure.", "SecurityError");
  },
  setItem() {
    throw new DOMException("QuotaExceededError", "QuotaExceededError");
  },
};

describe("parseCardView — only a real view is a view", () => {
  test("the two valid layouts pass through", () => {
    assert.equal(parseCardView("grid"), "grid");
    assert.equal(parseCardView("list"), "list");
  });

  test("absence is null, not a default", () => {
    assert.equal(parseCardView(null), null);
    assert.equal(parseCardView(undefined), null);
    assert.equal(parseCardView(""), null);
  });

  test("junk never becomes a choice", () => {
    // A wrong-case or near-miss string is the shape a hand-edited or
    // older-build value actually takes; it must not be coerced.
    assert.equal(parseCardView("Grid"), null);
    assert.equal(parseCardView("GRID"), null);
    assert.equal(parseCardView("gallery"), null);
    assert.equal(parseCardView(" grid "), null);
    assert.equal(parseCardView(0), null);
    assert.equal(parseCardView(true), null);
    assert.equal(parseCardView({}), null);
    assert.equal(parseCardView(["grid"]), null);
  });
});

describe("readCardView", () => {
  test("returns the stored preference", () => {
    const storage = fakeStorage({ [CARD_VIEW_KEYS.search]: "grid" });
    assert.equal(readCardView(storage, CARD_VIEW_KEYS.search), "grid");
  });

  test("an unset key is null, so the caller's default stands", () => {
    assert.equal(readCardView(fakeStorage(), CARD_VIEW_KEYS.search), null);
  });

  test("a corrupt stored value is null, not a crash and not a coercion", () => {
    const storage = fakeStorage({ [CARD_VIEW_KEYS.collection]: "{\"view\":\"grid\"}" });
    assert.equal(readCardView(storage, CARD_VIEW_KEYS.collection), null);
  });

  test("no storage at all (server render) is null", () => {
    assert.equal(readCardView(null, CARD_VIEW_KEYS.search), null);
    assert.equal(readCardView(undefined, CARD_VIEW_KEYS.search), null);
  });

  test("storage that throws is null, and the throw does not escape", () => {
    assert.equal(readCardView(hostileStorage, CARD_VIEW_KEYS.search), null);
  });
});

describe("writeCardView", () => {
  test("persists under the given key and reads back", () => {
    const storage = fakeStorage();
    assert.equal(writeCardView(storage, CARD_VIEW_KEYS.collection, "list"), true);
    assert.equal(storage.data[CARD_VIEW_KEYS.collection], "list");
    assert.equal(readCardView(storage, CARD_VIEW_KEYS.collection), "list");
  });

  test("overwrites a previous choice rather than accumulating", () => {
    const storage = fakeStorage({ [CARD_VIEW_KEYS.search]: "list" });
    writeCardView(storage, CARD_VIEW_KEYS.search, "grid");
    assert.equal(readCardView(storage, CARD_VIEW_KEYS.search), "grid");
    assert.equal(Object.keys(storage.data).length, 1);
  });

  test("a failed write reports false instead of throwing", () => {
    assert.equal(writeCardView(hostileStorage, CARD_VIEW_KEYS.search, "grid"), false);
    assert.equal(writeCardView(null, CARD_VIEW_KEYS.search, "grid"), false);
  });
});

describe("per-surface keys", () => {
  test("collection and search do not share a preference", () => {
    // Deliberate: a binder page of owned cards and a page of search results are
    // read differently, so one screen's layout must not silently change the
    // other's. If these keys are ever fused, this test is the decision record.
    assert.notEqual(CARD_VIEW_KEYS.collection, CARD_VIEW_KEYS.search);

    const storage = fakeStorage();
    writeCardView(storage, CARD_VIEW_KEYS.collection, "grid");
    writeCardView(storage, CARD_VIEW_KEYS.search, "list");

    assert.equal(readCardView(storage, CARD_VIEW_KEYS.collection), "grid");
    assert.equal(readCardView(storage, CARD_VIEW_KEYS.search), "list");
  });

  test("keys stay inside the existing aura.* preference namespace", () => {
    // Matches aura.roiCapture / aura.legacyTimedAuto already written by the
    // scanner, so all of Aura's client preferences remain greppable as one set.
    for (const key of Object.values(CARD_VIEW_KEYS)) {
      assert.ok(key.startsWith("aura."), `${key} should be namespaced`);
    }
  });
});
