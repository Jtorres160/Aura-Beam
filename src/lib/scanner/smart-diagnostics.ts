// ─── TEMPORARY · FLAG-GATED · SmartCapture Diagnostics Collector ─────────────
// Phase 4.5 real-device debugging aid for the Auto/Bulk scanner stall. It
// buffers structured diagnostic events IN MEMORY during a scan session and can
// serialize them to a JSON file the tester downloads from their phone.
//
// Hard boundaries (by design):
//   • NOTHING here runs unless the scanner's SMART_DIAG path calls it (all
//     record() calls in page.tsx are behind isSmartDiagEnabled(), which is
//     false in production unless explicitly opted in — see below).
//   • NO Prisma, NO network, NO ScanHistory — purely local, purely temporary.
//   • It makes NO decisions and changes NO scanner behavior.
//
// TO REMOVE: delete this file and its imports/usages in scanner/page.tsx.

/**
 * TEMPORARY runtime opt-in for the diagnostics, so they can run on a real
 * phone against an HTTPS deployment (Vercel Preview) where NODE_ENV is
 * "production". True when any of:
 *   • local dev (`next dev`) — unchanged behavior;
 *   • the deployment was built with NEXT_PUBLIC_SMART_DIAG=true (set it on
 *     Vercel's Preview environment only — it is inlined at build time);
 *   • the page URL carries ?diag=1 (evaluated per page load, no rebuild).
 * Window-dependent, so call it only on the client after mount; page.tsx keeps
 * the result in state to stay hydration-safe.
 */
export function isSmartDiagEnabled(): boolean {
  if (process.env.NODE_ENV === "development") return true;
  if (process.env.NEXT_PUBLIC_SMART_DIAG === "true") return true;
  if (typeof window !== "undefined") {
    try {
      return new URLSearchParams(window.location.search).get("diag") === "1";
    } catch {
      /* malformed URL — treat as opted out */
    }
  }
  return false;
}

export interface DiagMetrics {
  sharpness: number | null;
  brightness: number | null;
  glare: number | null;
  motion: number | null;
}

export interface DiagThresholds {
  /** evaluateReadiness maxMotion (LIVE_THRESHOLDS.maxMotion). */
  motion: number;
  /** SmartCaptureMachine STABILITY_DWELL_MS. */
  dwellMs: number;
}

export interface DiagEvent {
  /** ISO 8601 wall-clock time of the event. */
  timestamp: string;
  /** performance.now() at record time — precise monotonic ordering. */
  tMs: number;
  /** Event kind, e.g. "candidate_reset", "capture_result". */
  event: string;
  /** Scan mode when the event fired: "auto" | "bulk". */
  mode: string;
  /** Readiness code / failure reason where relevant (e.g. "hold-steady"). */
  reason?: string;
  /** Readiness verdict where relevant. */
  ready?: boolean;
  metrics?: DiagMetrics;
  thresholds?: DiagThresholds;
  /** Elapsed stability dwell (ms) at the moment of the event. */
  dwellMs?: number;
  /** Required dwell (ms) for a capture to fire. */
  requiredDwellMs?: number;
  /** Free-form extra context (capture reason, ok/failure, etc.). */
  detail?: string;
}

/** In-memory ring buffer of diagnostic events. One module-level singleton so it
 *  survives React re-renders and effect re-subscribes within a session. */
class SmartCaptureDiagnostics {
  private events: DiagEvent[] = [];
  private sessionStartedAt: string | null = null;
  /** Safety cap so a very long session can't grow memory without bound. */
  private readonly cap = 8000;

  /** Mark the (re)start of a scan session; does not clear prior events so a full
   *  test run across several sessions still exports together. */
  startSession(): void {
    if (!this.sessionStartedAt) this.sessionStartedAt = new Date().toISOString();
  }

  record(event: Omit<DiagEvent, "timestamp" | "tMs"> & Partial<Pick<DiagEvent, "timestamp" | "tMs">>): void {
    if (this.events.length >= this.cap) this.events.shift();
    this.events.push({
      timestamp: event.timestamp ?? new Date().toISOString(),
      tMs: event.tMs ?? (typeof performance !== "undefined" ? performance.now() : 0),
      ...event,
    });
  }

  count(): number {
    return this.events.length;
  }

  clear(): void {
    this.events = [];
    this.sessionStartedAt = null;
  }

  /** The full export payload (also used by tests / manual inspection). */
  snapshot() {
    return {
      tool: "aura-smartcapture-debug",
      version: 1,
      exportedAt: new Date().toISOString(),
      sessionStartedAt: this.sessionStartedAt,
      eventCount: this.events.length,
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : null,
      viewport:
        typeof window !== "undefined"
          ? { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio }
          : null,
      events: this.events,
    };
  }

  /** Trigger a client-side download of the buffered events as JSON. Browser-only;
   *  a no-op with a warning off-DOM. */
  export(filename = "aura-smartcapture-debug.json"): void {
    if (typeof window === "undefined" || typeof document === "undefined") {
      console.warn("[SmartDiag] export() called off-DOM — ignored.");
      return;
    }
    const json = JSON.stringify(this.snapshot(), null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke on the next tick so the download has grabbed the blob first.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    console.log(`[SmartDiag] Exported ${this.events.length} event(s) → ${filename}`);
  }
}

/** Temporary dev-only singleton. Safe to import anywhere; inert until fed. */
export const smartDiag = new SmartCaptureDiagnostics();
