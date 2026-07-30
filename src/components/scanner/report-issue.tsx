"use client";

// ─── Report an issue (scanner) ───────────────────────────────────────────────
// A compact, inline reporting affordance that sits directly beside a scan
// result or a scan failure — the two moments a collector actually knows
// something is wrong.
//
// Why it lives here and not on the contact page: by the time a tester navigates
// to a contact form, the state that would make the report actionable (which
// scan, which candidate, what confidence, which failure stage) is gone, and no
// one is going to transcribe it by hand. Everything technical is attached from
// props the scanner already holds. The tester only says WHAT was wrong.
//
// ─── THE ONE RULE THIS COMPONENT ENFORCES ────────────────────────────────────
//
// The confirmation is shown if and only if the server confirmed the write. A
// failed POST renders as a failure, with the typed message preserved so the
// retry costs nothing. This codebase does not tell people their data was saved
// when it was not (see the ScanHistory / CaptureRejection comments in
// prisma/schema.prisma), and a feedback form is the worst possible place to
// start: the person is already reporting that something did not work.

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, Loader2, MessageSquareWarning, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  SCAN_FEEDBACK_CATEGORIES,
  SCAN_FEEDBACK_LABELS,
  SCAN_FEEDBACK_MESSAGE_MAX,
  type ScanFeedbackCategory,
  type ScanFeedbackSurface,
} from "@/lib/scanner/scan-feedback";

/** The scan state the report is filed against. Every field is optional because
 *  every field is genuinely unknown in some real case — an early parse failure
 *  has no scanId, a failed scan has no card, a memory-served scan has no
 *  scorer confidence. Absent stays absent; nothing is defaulted. */
export interface ReportIssueContext {
  scanId?: string | null;
  cardId?: string | null;
  cardName?: string | null;
  confidence?: number | null;
  matchMethod?: string | null;
  failureStage?: string | null;
  game?: string | null;
}

type Status = "idle" | "open" | "sending" | "sent" | "failed";

export function ReportIssue({
  surface,
  context,
  className,
}: {
  surface: ScanFeedbackSurface;
  context: ReportIssueContext;
  className?: string;
}) {
  const [status, setStatus] = useState<Status>("idle");
  // Pre-select the category that matches the surface. A failure view is almost
  // always "scan failed"; a result view is almost always "wrong card". This is a
  // default the tester can change, not an assumption recorded on their behalf.
  const [category, setCategory] = useState<ScanFeedbackCategory>(
    surface === "error" ? "scan-failed" : "wrong-card",
  );
  const [message, setMessage] = useState("");
  const [errorText, setErrorText] = useState<string | null>(null);

  const submit = async () => {
    setStatus("sending");
    setErrorText(null);
    try {
      const res = await fetch("/api/scanner/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, surface, message, ...context }),
      });
      const json = await res.json().catch(() => null);
      // `res.ok` alone is not enough — the route answers 200-shaped JSON with
      // success:false nowhere, but a proxy or an auth redirect can. Both halves
      // must agree before we claim the report exists.
      if (!res.ok || !json?.success) {
        setErrorText(json?.message || "We couldn't save your report — it wasn't received.");
        setStatus("failed");
        return;
      }
      setStatus("sent");
    } catch {
      // Network failure. The request may never have left the device; either way
      // we did not see it land, so we do not say it did.
      setErrorText("Your report didn't send — check your connection and try again.");
      setStatus("failed");
    }
  };

  if (status === "sent") {
    return (
      <motion.p
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        className={cn(
          "flex items-center justify-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-emerald-400",
          className,
        )}
      >
        <Check className="h-3.5 w-3.5" /> Report received
      </motion.p>
    );
  }

  if (status === "idle") {
    return (
      <button
        type="button"
        onClick={() => setStatus("open")}
        className={cn(
          "flex w-full items-center justify-center gap-1.5 text-center font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground underline underline-offset-4 transition-colors hover:text-foreground",
          className,
        )}
      >
        <MessageSquareWarning className="h-3.5 w-3.5" /> Report an issue
      </button>
    );
  }

  const sending = status === "sending";

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, height: 0 }}
        animate={{ opacity: 1, height: "auto" }}
        className={cn("overflow-hidden rounded-xl border border-border bg-card/60 p-4 text-left", className)}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <p className="font-serif text-base leading-tight">Report an issue</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {/* Says exactly what is attached. A tester should never have to
                  wonder what they just sent us. */}
              This scan&apos;s details are attached automatically.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setStatus("idle")}
            disabled={sending}
            aria-label="Close report form"
            className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mb-3 flex flex-wrap gap-1.5">
          {SCAN_FEEDBACK_CATEGORIES.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCategory(c)}
              disabled={sending}
              aria-pressed={category === c}
              className={cn(
                "rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.1em] transition-colors disabled:opacity-50",
                category === c
                  ? "border-brass bg-brass/10 text-foreground"
                  : "border-border text-muted-foreground hover:border-brass/50 hover:text-foreground",
              )}
            >
              {SCAN_FEEDBACK_LABELS[c]}
            </button>
          ))}
        </div>

        <textarea
          rows={3}
          maxLength={SCAN_FEEDBACK_MESSAGE_MAX}
          disabled={sending}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="What happened? (optional)"
          className="w-full resize-none rounded-lg border border-border bg-background/50 px-3 py-2 text-sm transition-all placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring/50 disabled:opacity-50"
        />

        {/* A failed send is stated plainly and the form stays filled. The one
            thing this must never do is clear itself and look successful. */}
        {status === "failed" && errorText && (
          <p className="mt-2 text-xs text-destructive">{errorText}</p>
        )}

        <Button
          type="button"
          onClick={submit}
          disabled={sending}
          className="mt-3 h-10 w-full text-sm font-medium"
        >
          {sending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Sending…
            </>
          ) : status === "failed" ? (
            "Try sending again"
          ) : (
            "Send report"
          )}
        </Button>
      </motion.div>
    </AnimatePresence>
  );
}
