// ─── Which scan failures reach the error tracker ─────────────────────────────
//
// The scanner already has a failure taxonomy (src/lib/scanner/failure.ts) and
// already writes an honest black-box row for every attempt that ends without a
// card. That work is not duplicated here. The only question this module answers
// is which of those outcomes an on-call human should be paged about.
//
// The split follows the taxonomy's OWN distinction between an ERROR and a
// VERDICT, which is the same distinction the persisted matchMethod encodes
// ("error:<stage>" vs a bare stage name):
//
//   ERROR    Aura broke. The reader threw, a provider connection died mid-call,
//            Prisma refused, something escaped unclassified. Nobody outside the
//            team will ever tell us this happened, and it is a bug until proven
//            otherwise. → captureException.
//
//   VERDICT  Aura worked and the answer was negative. The image held no card;
//            every source answered and none had this printing; the collector
//            hit the daily cap. These are the system behaving correctly, they
//            are already counted in ScanHistory, and sending them as errors
//            would bury the real ones under a permanent baseline of noise.
//            → not sent.
//
// `provider-unavailable` is the one outcome that is a verdict to the COLLECTOR
// (we could not ask, so we do not claim the card is missing — Phase 5.13B) but
// an operational event to US: an upstream card database is down. It is reported
// at warning level as a message, never as an exception, so it stays visibly
// separate from "Aura has a bug" while still being something we can see and
// alert on later without a tester writing in.
//
// Like failure.ts, this module is deliberately dependency-free — no Sentry, no
// Next, no Prisma — so the rule can be tested as the pure decision it is.

import type { FailureStage } from "@/lib/scanner/failure";

/** How a given failure stage should reach Sentry, if at all. */
export type ReportKind = "exception" | "warning" | "silent";

/**
 * The rule, as data. Every member of FailureStage is listed explicitly: adding
 * a stage to the taxonomy without deciding how it is reported is a type error,
 * not a silent default to "exception" (which would page us for a new verdict).
 */
const REPORT_KIND: Record<FailureStage, ReportKind> = {
  // Verdicts and refusals — expected outcomes, already persisted and logged.
  "rate-limit": "silent",            // a refusal we chose to make
  "no-card": "silent",               // the reader worked; there was no card
  "not-found": "silent",             // every source answered; none had it
  // A source went quiet. Not Aura's bug, but an outage we should be able to see.
  "provider-unavailable": "warning",
  "selection-provider": "warning",   // same outage, hit at save time
  // Genuine failures.
  parse: "exception",
  ocr: "exception",
  candidates: "exception",
  scoring: "exception",
  database: "exception",
  unknown: "exception",
};

export function reportKindForStage(stage: FailureStage): ReportKind {
  return REPORT_KIND[stage] ?? "exception";
}
