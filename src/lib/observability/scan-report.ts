// ─── Sending scan pipeline failures to Sentry ────────────────────────────────
// The transport half. The DECISION half — which stages are errors, which are
// verdicts, and which are upstream outages — lives in report-kind.ts, which is
// dependency-free and unit-tested. This module only does what that rule says.

import type * as SentryTypes from "@sentry/nextjs";
import { Sentry } from "@/lib/observability/sentry";
import type { FailureStage } from "@/lib/scanner/failure";
import { reportKindForStage } from "@/lib/observability/report-kind";

/** Non-identifying context attached to every scan report. */
export interface ScanReportContext {
  /** The requested game filter or the identified game — never the card image. */
  game?: string | null;
  /** Whether this came from auto-scan (a different confidence threshold). */
  isAutoScan?: boolean;
  /** Per-stage wall-clock, the same map the route logs. */
  timings?: Record<string, number>;
  /** The ScanHistory row for this attempt, when one was written. */
  scanId?: string | null;
  /** Sources that failed to answer, for the unavailable outcomes. */
  unavailableSources?: string[];
  /** The OCR'd name, when the pipeline got that far. Not user-supplied text. */
  cardName?: string | null;
}

function applyContext(scope: SentryTypes.Scope, stage: FailureStage, ctx: ScanReportContext) {
  // Tags are the queryable axes: "show me every ocr failure on Pokémon".
  scope.setTag("scan.stage", stage);
  if (ctx.game) scope.setTag("scan.game", ctx.game);
  if (ctx.isAutoScan !== undefined) scope.setTag("scan.autoScan", String(ctx.isAutoScan));
  scope.setContext("scan", {
    stage,
    game: ctx.game ?? null,
    isAutoScan: ctx.isAutoScan ?? null,
    cardName: ctx.cardName ?? null,
    scanId: ctx.scanId ?? null,
    unavailableSources: ctx.unavailableSources ?? null,
    timings: ctx.timings ?? null,
  });
  // Group by stage rather than by the upstream message, which for a provider
  // error is often a URL or a timeout value and would shatter one real problem
  // into hundreds of distinct issues.
  scope.setFingerprint(["scan-pipeline", stage]);
}

/**
 * Report a scan pipeline failure. Silent for verdicts, a warning for an
 * upstream outage, an exception for a genuine break.
 *
 * Never throws: observability must not be able to fail a scan. The caller has
 * already decided what to tell the collector and does not branch on this.
 */
export function reportScanFailure(
  stage: FailureStage,
  error: unknown,
  ctx: ScanReportContext = {},
): void {
  try {
    const kind = reportKindForStage(stage);
    if (kind === "silent") return;

    Sentry.withScope((scope) => {
      applyContext(scope, stage, ctx);
      if (kind === "warning") {
        scope.setLevel("warning");
        const sources = ctx.unavailableSources?.length
          ? ctx.unavailableSources.join(", ")
          : "unknown source";
        Sentry.captureMessage(`Card source unavailable (${stage}): ${sources}`);
        return;
      }
      scope.setLevel("error");
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)));
    });
  } catch (err) {
    // A broken error reporter must never become a broken scanner — but it must
    // not hide either, or the pipeline goes quiet and reads as healthy.
    console.warn("[Observability] Could not report scan failure:", (err as Error)?.message);
  }
}
