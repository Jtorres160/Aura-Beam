import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONTACT_MESSAGE_MAX,
  CONTACT_MESSAGE_MIN,
  CONTACT_NAME_MAX,
  CONTACT_RECIPIENT,
  CONTACT_SUBJECTS,
  CONTACT_SUBJECT_LABELS,
  isEmailShaped,
  parseContactMessage,
} from "@/lib/contact";

const valid = {
  name: "Josie Torres",
  email: "collector@example.com",
  subject: "support",
  message: "The scanner keeps failing on my Pokémon cards.",
};

const ok = (body: unknown) => {
  const r = parseContactMessage(body);
  assert.ok(r.ok, `expected success, got: ${r.ok ? "" : r.message}`);
  return r.value;
};

const rejects = (body: unknown, field: string) => {
  const r = parseContactMessage(body);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.field, field, `expected rejection on "${field}", got "${r.field}"`);
    assert.ok(r.message.length > 0, "a rejection must say what to do about it");
  }
};

test("a complete submission parses", () => {
  const v = ok(valid);
  assert.equal(v.name, "Josie Torres");
  assert.equal(v.email, "collector@example.com");
  assert.equal(v.subject, "support");
});

test("whitespace is trimmed off every field", () => {
  const v = ok({ ...valid, name: "  Josie  ", email: "  a@b.co  ", message: `  ${valid.message}  ` });
  assert.equal(v.name, "Josie");
  assert.equal(v.email, "a@b.co");
  assert.equal(v.message, valid.message);
});

test("a missing or blank name is rejected", () => {
  rejects({ ...valid, name: "" }, "name");
  rejects({ ...valid, name: "   " }, "name");
  rejects({ ...valid, name: undefined }, "name");
  rejects({ ...valid, name: "x".repeat(CONTACT_NAME_MAX + 1) }, "name");
});

test("a malformed email is rejected — we would have no way to reply", () => {
  for (const bad of ["", "   ", "nope", "no@domain", "two@@at.com", "spaces in@mail.com", "@nolocal.com"]) {
    rejects({ ...valid, email: bad }, "email");
  }
});

test("ordinary real-world addresses are accepted", () => {
  // The check exists to catch typos, not to adjudicate deliverability. Being
  // too clever here locks real people out of the only way to reach us.
  for (const good of [
    "jtorres160@yahoo.com",
    "first.last@sub.domain.co.uk",
    "user+tag@example.org",
    "a_b-c@example.io",
    "'quoted@example.com",
  ]) {
    assert.ok(isEmailShaped(good), `${good} should be accepted`);
  }
});

test("an unrecognized subject is rejected, never coerced to a default", () => {
  rejects({ ...valid, subject: "refunds" }, "subject");
  rejects({ ...valid, subject: undefined }, "subject");
  rejects({ ...valid, subject: 7 }, "subject");
});

test("every subject in the vocabulary parses and has a label", () => {
  for (const s of CONTACT_SUBJECTS) {
    assert.equal(ok({ ...valid, subject: s }).subject, s);
    assert.ok(CONTACT_SUBJECT_LABELS[s]?.length > 0, `${s} has no label`);
  }
});

test("billing parses even though the page currently hides it", () => {
  // Restoring the commented-out option after the beta must be a UI change only,
  // not a UI change plus a server that silently 400s it.
  assert.equal(ok({ ...valid, subject: "billing" }).subject, "billing");
});

test("a too-short message is rejected", () => {
  rejects({ ...valid, message: "" }, "message");
  rejects({ ...valid, message: "x".repeat(CONTACT_MESSAGE_MIN - 1) }, "message");
  assert.ok(ok({ ...valid, message: "x".repeat(CONTACT_MESSAGE_MIN) }));
});

test("an over-long message is rejected rather than silently truncated", () => {
  // Sending a clipped message and reporting it delivered would misrepresent
  // what the person actually wrote.
  rejects({ ...valid, message: "x".repeat(CONTACT_MESSAGE_MAX + 1) }, "message");
  assert.ok(ok({ ...valid, message: "x".repeat(CONTACT_MESSAGE_MAX) }));
});

test("a null or non-object body is rejected, not treated as empty", () => {
  for (const body of [null, undefined, "string", 42, []]) {
    assert.equal(parseContactMessage(body).ok, false, `${JSON.stringify(body)} should be rejected`);
  }
});

test("the recipient is a single source of truth", () => {
  // The page's mailto:, its visible label and the route's `to:` all read this.
  // Pinned to the Resend account address, not jtorres160@yahoo.com — see the
  // comment on CONTACT_RECIPIENT for why (no verified sending domain yet).
  assert.equal(CONTACT_RECIPIENT, "knockoutjosie@gmail.com");
});
