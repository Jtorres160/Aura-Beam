// A failed add must never look like a successful one — and must never look like
// nothing at all.
//
// Regression suite for the user-reported "adding to my collection isn't
// working". The backend was sound the whole time; the client swallowed every
// failure into console.error, so a click that failed and a click that no-opped
// were indistinguishable to a collector. These tests pin the property that
// matters: every non-success path returns ok:false WITH a message to show.
//
// Run: node --import ./test/register.mjs --test src/lib/collections/add-to-collection.test.ts

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { addCardToCollection } from "@/lib/collections/add-to-collection";

/** A fetch stand-in that returns one canned response. */
function respond(status: number, body: unknown, opts: { json?: boolean } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (opts.json === false) throw new SyntaxError("not JSON");
        return body;
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("addCardToCollection — the success path", () => {
  test("a 201 reports success and carries the archive delta through", async () => {
    const { impl } = respond(201, {
      success: true,
      message: "Card added to collection",
      archive: { totalCards: 12, quantity: 1 },
    });
    const result = await addCardToCollection({ cardId: "hgss3-10", game: "POKEMON" }, impl);

    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.archive, { totalCards: 12, quantity: 1 });
    assert.equal(result.message, "Card added to collection");
  });

  test("cardId, game and scanId are sent as the route expects", async () => {
    const { impl, calls } = respond(201, { success: true });
    await addCardToCollection({ cardId: "abc", game: "MTG", scanId: "scan-1" }, impl);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/api/collections/add");
    assert.equal(calls[0].init?.method, "POST");
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
      cardId: "abc",
      game: "MTG",
      scanId: "scan-1",
    });
  });

  test("a success with no archive block is still a success", async () => {
    // The server's archive aggregation is deliberately failure-safe.
    const { impl } = respond(201, { success: true, message: "Card quantity updated" });
    const result = await addCardToCollection({ cardId: "abc" }, impl);

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.archive, null);
  });
});

describe("addCardToCollection — every failure is visible and specific", () => {
  test("a quiet source database keeps the server's own honest wording", async () => {
    // The 503 copy is the one place the server knows more than we do: it can
    // NAME the source that went silent. We must not overwrite it with generic
    // text, and it must not say the card doesn't exist.
    const serverMessage =
      "We couldn't reach Pokémon TCG API to look this card up, so it hasn't been added. Try again in a moment.";
    const { impl } = respond(503, {
      success: false,
      stage: "provider-unavailable",
      message: serverMessage,
    });
    const result = await addCardToCollection({ cardId: "basep-1", game: "POKEMON" }, impl);

    assert.equal(result.ok, false);
    assert.equal(result.message, serverMessage);
    assert.ok(!/not found|doesn't exist/i.test(result.message));
  });

  test("401 tells the collector they're signed out rather than failing silently", async () => {
    const { impl } = respond(401, { success: false, message: "Unauthorized" });
    const result = await addCardToCollection({ cardId: "abc" }, impl);

    assert.equal(result.ok, false);
    // The server's "Unauthorized" is technically true but useless to a
    // collector; it is still shown rather than swallowed.
    assert.ok(result.message.length > 0);
  });

  test("a bare 401 with no body falls back to actionable copy", async () => {
    const { impl } = respond(401, null);
    const result = await addCardToCollection({ cardId: "abc" }, impl);

    assert.equal(result.ok, false);
    assert.match(result.message, /signed out/i);
    assert.match(result.message, /wasn't added/i);
  });

  test("a 404 is reported as a real negative, not as an error", async () => {
    const { impl } = respond(404, null);
    const result = await addCardToCollection({ cardId: "nope-1" }, impl);

    assert.equal(result.ok, false);
    assert.match(result.message, /isn't in any of our card databases/i);
  });

  test("a 500 with an unparseable body still yields a message", async () => {
    const { impl } = respond(500, null, { json: false });
    const result = await addCardToCollection({ cardId: "abc" }, impl);

    assert.equal(result.ok, false);
    assert.equal(result.message.length > 0, true);
  });

  test("a network failure never throws and never claims a save", async () => {
    const impl = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const result = await addCardToCollection({ cardId: "abc" }, impl);

    assert.equal(result.ok, false);
    assert.match(result.message, /nothing was saved/i);
  });

  test("a 200 carrying success:false is a failure, not a success", async () => {
    // Defensive: an intermediary or a future handler could return 200 with a
    // failed body. The status code alone must not decide this.
    const { impl } = respond(200, { success: false, message: "Something went wrong" });
    const result = await addCardToCollection({ cardId: "abc" }, impl);

    assert.equal(result.ok, false);
    assert.equal(result.message, "Something went wrong");
  });
});
