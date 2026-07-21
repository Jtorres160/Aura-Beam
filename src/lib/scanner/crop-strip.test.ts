// cropBottomStrip tests (Scanner V2 · M3-B).
//
// The whole point of this helper is that it can only ever SHRINK the strip-read
// payload, never break it. So the tests that matter are the failure modes: any
// input the crop can't handle must return the ORIGINAL string byte-for-byte, so
// extractBottomStrip falls back to sending the full image exactly as before.
//
// Run: node --import ./test/register.mjs --test src/lib/scanner/crop-strip.test.ts

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";

import { cropBottomStrip, STRIP_BAND_FRACTION } from "@/lib/scanner/crop-strip";

/** A real, valid PNG data URI of the given size, so we can exercise the happy path. */
async function makePngDataUri(width: number, height: number): Promise<string> {
  const png = await sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 120, b: 40 } },
  })
    .png()
    .toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

describe("cropBottomStrip — fallback contract (must return the ORIGINAL input)", () => {
  test("non-data-URI input (http URL) is returned unchanged", async () => {
    const url = "https://images.pokemontcg.io/base1/6_hires.png";
    assert.equal(await cropBottomStrip(url), url);
  });

  test("data URI with no comma is returned unchanged", async () => {
    const malformed = "data:image/png;base64";
    assert.equal(await cropBottomStrip(malformed), malformed);
  });

  test("empty base64 payload is returned unchanged", async () => {
    const empty = "data:image/png;base64,";
    assert.equal(await cropBottomStrip(empty), empty);
  });

  test("corrupt / undecodable image bytes are returned unchanged", async () => {
    const corrupt = "data:image/png;base64," + Buffer.from("not a real image at all").toString("base64");
    assert.equal(await cropBottomStrip(corrupt), corrupt);
  });

  test("plain empty string is returned unchanged", async () => {
    assert.equal(await cropBottomStrip(""), "");
  });
});

describe("cropBottomStrip — happy path", () => {
  test("a valid card-shaped PNG is cropped to a shorter, new JPEG data URI", async () => {
    const original = await makePngDataUri(734, 1024);
    const out = await cropBottomStrip(original);

    // It changed (crop happened) and is a JPEG data URI.
    assert.notEqual(out, original);
    assert.match(out, /^data:image\/jpeg;base64,/);

    // The output really is the bottom band: ~STRIP_BAND_FRACTION of the height,
    // full width.
    const buf = Buffer.from(out.slice(out.indexOf(",") + 1), "base64");
    const meta = await sharp(buf).metadata();
    assert.equal(meta.width, 734, "full width preserved");
    const expectedH = 1024 - Math.round(1024 * (1 - STRIP_BAND_FRACTION));
    assert.equal(meta.height, expectedH, "band height ≈ bottom fraction of the card");
  });

  test("a degenerate 1px-tall image is returned unchanged (nothing sane to crop)", async () => {
    const tiny = await makePngDataUri(100, 1);
    assert.equal(await cropBottomStrip(tiny), tiny);
  });
});
