// Scan sound preference — same two properties as the card-view storage layer,
// for the same reasons:
//
//   1. A stored value is UNTRUSTED input. Only "on" and "off" may become a
//      preference; anything else reads as "no preference recorded" and the
//      caller's default stands.
//
//   2. Storage can THROW, not just miss (Safari private mode, blocked
//      third-party storage). Neither read nor write may propagate — an
//      exception out of a click handler breaks the scanner, and the worst a
//      failed sound preference should ever cost is one click next visit.
//
// Run: node --import ./test/register.mjs --test src/lib/ui/scan-sound.test.ts

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  SCAN_SOUND_KEY,
  SCAN_SOUND_DEFAULT,
  parseScanSound,
  readScanSound,
  writeScanSound,
  type ScanSoundStorage,
} from "@/lib/ui/scan-sound";

/** A minimal in-memory Storage stand-in. */
function fakeStorage(initial: Record<string, string> = {}): ScanSoundStorage & {
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

/** Storage that rejects everything, like Safari private mode. */
const hostileStorage: ScanSoundStorage = {
  getItem() {
    throw new DOMException("blocked");
  },
  setItem() {
    throw new DOMException("blocked");
  },
};

describe("parseScanSound", () => {
  test("accepts exactly the two real values", () => {
    assert.equal(parseScanSound("on"), "on");
    assert.equal(parseScanSound("off"), "off");
  });

  test("junk is 'no preference', never a choice", () => {
    for (const junk of [
      null,
      undefined,
      "",
      "ON",
      "true",
      "1",
      "enabled",
      0,
      1,
      true,
      {},
      [],
    ]) {
      assert.equal(parseScanSound(junk), null, `${JSON.stringify(junk)} must not parse`);
    }
  });
});

describe("readScanSound", () => {
  test("reads a stored preference", () => {
    assert.equal(readScanSound(fakeStorage({ [SCAN_SOUND_KEY]: "off" })), "off");
  });

  test("absent key reads as no preference", () => {
    assert.equal(readScanSound(fakeStorage()), null);
  });

  test("a corrupt value does not become a preference", () => {
    assert.equal(readScanSound(fakeStorage({ [SCAN_SOUND_KEY]: "loud" })), null);
  });

  test("missing storage is survivable", () => {
    assert.equal(readScanSound(null), null);
    assert.equal(readScanSound(undefined), null);
  });

  test("throwing storage does not propagate", () => {
    assert.doesNotThrow(() => readScanSound(hostileStorage));
    assert.equal(readScanSound(hostileStorage), null);
  });
});

describe("writeScanSound", () => {
  test("persists under the namespaced key and reports success", () => {
    const storage = fakeStorage();
    assert.equal(writeScanSound(storage, "off"), true);
    assert.equal(storage.data[SCAN_SOUND_KEY], "off");
  });

  test("round-trips through read", () => {
    const storage = fakeStorage();
    writeScanSound(storage, "off");
    assert.equal(readScanSound(storage), "off");
    writeScanSound(storage, "on");
    assert.equal(readScanSound(storage), "on");
  });

  test("throwing storage reports failure instead of exploding", () => {
    assert.doesNotThrow(() => writeScanSound(hostileStorage, "on"));
    assert.equal(writeScanSound(hostileStorage, "on"), false);
    assert.equal(writeScanSound(null, "on"), false);
  });
});

describe("conventions", () => {
  test("key stays inside the existing aura.* preference namespace", () => {
    // Matches aura.roiCapture / aura.legacyTimedAuto written by the scanner and
    // aura.collectionView / aura.searchView written by the card views.
    assert.ok(SCAN_SOUND_KEY.startsWith("aura."), `${SCAN_SOUND_KEY} should be namespaced`);
  });

  test("the default is itself a valid value", () => {
    assert.equal(parseScanSound(SCAN_SOUND_DEFAULT), SCAN_SOUND_DEFAULT);
  });
});
