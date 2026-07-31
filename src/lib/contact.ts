// ─── Contact form vocabulary and validation ──────────────────────────────────
// The contact form's shape in ONE place, shared by the page that produces a
// message and the route that sends it. Same structure as scan-feedback.ts: the
// client uses the vocabulary to render its options and to refuse an obviously
// bad submission before it costs a round trip, and the SERVER re-validates
// everything, because client-side validation is a courtesy and never a control.
//
// This module is deliberately dependency-free (no Resend, no Next, no Prisma)
// so both sides can import it and it can be tested as the pure parser it is.

/** The subject buckets a message can be filed under.
 *
 *  "billing" is accepted by the parser but NOT currently offered by the page —
 *  the option is commented out for the private beta (see contact/page.tsx).
 *  Accepting it here means restoring that option is a one-line UI change rather
 *  than a UI change plus a silently-rejecting server. */
export const CONTACT_SUBJECTS = ["general", "support", "billing", "feedback"] as const;

export type ContactSubject = (typeof CONTACT_SUBJECTS)[number];

export function isContactSubject(value: unknown): value is ContactSubject {
  return typeof value === "string" && (CONTACT_SUBJECTS as readonly string[]).includes(value);
}

/** Human labels, kept beside the vocabulary so a new subject cannot be added
 *  without deciding what a visitor will see. */
export const CONTACT_SUBJECT_LABELS: Record<ContactSubject, string> = {
  general: "General Inquiry",
  support: "Technical Support",
  billing: "Billing & Payments",
  feedback: "Feature Suggestion",
};

/** Where a real submission is delivered. One constant so the page's visible
 *  address, its mailto: link and the route's recipient cannot drift apart —
 *  they did before this existed (the page showed support@aurabeam.com in the
 *  link and jtorres160@yahoo.com in the text beside it). */
export const CONTACT_RECIPIENT = "jtorres160@yahoo.com";

export const CONTACT_NAME_MAX = 120;
export const CONTACT_EMAIL_MAX = 254; // RFC 5321 practical address ceiling
export const CONTACT_MESSAGE_MAX = 5000;
export const CONTACT_MESSAGE_MIN = 10;

/**
 * Email shape check.
 *
 * Deliberately permissive: this is not an attempt to decide whether an address
 * is deliverable — nothing short of sending to it can — only to catch the
 * typo'd and obviously-nonsense entries. A too-clever regex here rejects real
 * addresses, and the cost of that (a person who cannot reach us at all) is far
 * worse than the cost of accepting one that bounces.
 */
export function isEmailShaped(value: string): boolean {
  if (value.length > CONTACT_EMAIL_MAX) return false;
  // One @, non-empty local part, a dotted domain, no whitespace anywhere.
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value);
}

export interface ContactMessage {
  name: string;
  email: string;
  subject: ContactSubject;
  message: string;
}

export type ContactParseResult =
  | { ok: true; value: ContactMessage }
  /** `field` lets the client focus the offending input instead of making the
   *  visitor hunt for what was wrong. */
  | { ok: false; field: keyof ContactMessage; message: string };

/**
 * Validate and normalize a submission. Run by the route on every request and by
 * the page before it submits — one implementation, so the two cannot disagree
 * about what is acceptable and leave a visitor stuck on a form that passes
 * locally and 400s remotely.
 *
 * Every message is a rejection reason a person can act on. None of them is
 * "invalid input".
 */
export function parseContactMessage(body: unknown): ContactParseResult {
  const b = (body ?? {}) as Record<string, unknown>;

  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (name.length === 0) {
    return { ok: false, field: "name", message: "Please tell us your name." };
  }
  if (name.length > CONTACT_NAME_MAX) {
    return { ok: false, field: "name", message: `Name must be ${CONTACT_NAME_MAX} characters or fewer.` };
  }

  const email = typeof b.email === "string" ? b.email.trim() : "";
  if (email.length === 0) {
    return { ok: false, field: "email", message: "Please enter your email address." };
  }
  if (!isEmailShaped(email)) {
    return { ok: false, field: "email", message: "That email address doesn't look right — we'd have no way to reply." };
  }

  if (!isContactSubject(b.subject)) {
    return { ok: false, field: "subject", message: "Please choose a subject." };
  }

  const message = typeof b.message === "string" ? b.message.trim() : "";
  if (message.length < CONTACT_MESSAGE_MIN) {
    return {
      ok: false,
      field: "message",
      message: `Please add a little more detail (at least ${CONTACT_MESSAGE_MIN} characters).`,
    };
  }
  if (message.length > CONTACT_MESSAGE_MAX) {
    // Rejected, never truncated: sending a clipped message and reporting it as
    // delivered would misrepresent what the person actually wrote.
    return {
      ok: false,
      field: "message",
      message: `Message must be ${CONTACT_MESSAGE_MAX} characters or fewer.`,
    };
  }

  return { ok: true, value: { name, email, subject: b.subject, message } };
}
