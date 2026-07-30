"use client";

// ─── App error boundary ──────────────────────────────────────────────────────
// Catches anything a page or component throws below the root layout — the
// common case, and the one global-error.tsx does NOT cover. Without this, an
// uncaught render error during the tester window produces a blank region and
// no report of any kind.
//
// It does not attempt to explain WHAT broke. It has an Error object whose
// message is minified in production, and inventing a cause would be the same
// mistake the scanner's failure taxonomy exists to prevent.

import { useEffect } from "react";
import { Sentry } from "@/lib/observability/sentry";
import { AlertCircle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center py-24 px-6 text-center">
      <div className="w-16 h-16 rounded-xl bg-destructive/10 border border-destructive/20 flex items-center justify-center mb-6">
        <AlertCircle className="h-7 w-7 text-destructive" />
      </div>
      <h2 className="font-serif text-2xl mb-2">Something went wrong</h2>
      <p className="text-sm text-muted-foreground max-w-sm mb-2">
        This page hit an error and stopped rendering. It has been reported —
        nothing in your collection was changed.
      </p>
      {/* `digest` is the server-side hash of the real error; in production it is
          the only thing linking this screen to the logged stack trace. */}
      {error.digest && (
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/60 mb-6">
          ref: {error.digest}
        </p>
      )}
      {!error.digest && <div className="mb-4" />}
      <Button variant="outline" className="h-11 px-8 font-medium" onClick={reset}>
        <RotateCcw className="h-4 w-4 mr-2" /> Try again
      </Button>
    </div>
  );
}
