"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useSession } from "next-auth/react";
import { useScannerState } from "@/components/providers/scanning-context";
import {
  Camera, X, RotateCcw, Check, AlertCircle,
  Sparkles, Loader2, Scan, RefreshCw, Layers, Trash2, CheckCircle2
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  captureSharpestFrame,
  computeCaptureRoi,
  MANUAL_FRAME_COUNT,
  AUTO_FRAME_COUNT,
  PREFERRED_CAMERA_WIDTH,
  PREFERRED_CAMERA_HEIGHT,
  ROI_CAPTURE_DEFAULT,
  ROI_CAPTURE_PAD,
  type CaptureRegion,
  type CaptureResult,
} from "@/lib/scanner/capture";
import { LiveMetricsController } from "@/lib/scanner/live-metrics";
import { evaluateReadiness, LIVE_THRESHOLDS } from "@/lib/scanner/readiness";
// TEMPORARY flag-gated diagnostics collector (Phase 4.5 auto/bulk stall debug).
import { smartDiag, isSmartDiagEnabled } from "@/lib/scanner/smart-diagnostics";
import {
  SmartCaptureMachine,
  computeAverageHash,
  DUP_HAMMING_MAX,
  SMART_TICK_MS,
  SMART_STALE_MS,
  STABILITY_DWELL_MS,
  type AHash,
} from "@/lib/scanner/smart-capture";
import { CaptureGuidance } from "./capture-guidance";
// TEMPORARY dev-only calibration overlay — remove with Phase 4.5 cleanup.
import { LiveMetricsDebugOverlay } from "./live-metrics-debug-overlay";
import type { SavedCard, DisambiguationCandidate, PostAddArchive } from "@/types/card";
import type { ArchiveContext } from "@/types";

type ScanState = "idle" | "scanning" | "processing" | "result" | "bulk-review" | "disambiguation" | "error";

/** Same card re-identified within this window = the card is still sitting in
 *  front of the camera, not a deliberate duplicate. After the window a repeat
 *  of the same card IS queued — collectors scan playsets of one card. */
const BULK_DUPLICATE_WINDOW_MS = 10_000;

// Acquire a camera stream, retrying once with relaxed constraints when the
// first attempt fails in a way a lighter request usually clears:
//   - AbortError "Timeout starting video source": the high-res negotiation
//     stalled (common on Windows webcams) or the device was mid-release.
//   - NotReadableError: a transient lock that cleared as another consumer let go.
//   - OverconstrainedError: no camera matched the ideal resolution.
// The retry drops the resolution hints entirely and lets the browser pick.
async function acquireCameraStream(): Promise<MediaStream> {
  const preferred: MediaStreamConstraints = {
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: PREFERRED_CAMERA_WIDTH },
      height: { ideal: PREFERRED_CAMERA_HEIGHT },
    },
  };
  try {
    return await navigator.mediaDevices.getUserMedia(preferred);
  } catch (err) {
    const name = (err as DOMException)?.name;
    if (name === "AbortError" || name === "NotReadableError" || name === "OverconstrainedError") {
      console.warn(`[Scanner] Camera start failed (${name}); retrying with relaxed constraints...`);
      return await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } } });
    }
    throw err;
  }
}

/** "Jun 28" / "Jun 28, 2025" — the register a catalog card would use. */
function formatFiledDate(iso: string): string {
  const d = new Date(iso);
  const opts: Intl.DateTimeFormatOptions =
    d.getFullYear() === new Date().getFullYear()
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" };
  return d.toLocaleDateString("en-US", opts);
}

/** One quiet line describing what this card means in the user's archive. */
function archiveCaption(archive: ArchiveContext | null): string | null {
  if (!archive) return null;
  if (archive.inCollection) {
    const copies = archive.quantity > 1 ? ` · ×${archive.quantity}` : "";
    const filed = archive.addedAt ? ` · filed ${formatFiledDate(archive.addedAt)}` : "";
    return `Already in your archive${copies}${filed}`;
  }
  if (archive.setOwnedCount > 0) {
    return `New to your archive · ${archive.setOwnedCount} from this set already held`;
  }
  return "New to your archive · first from this set";
}

const LOADING_STATUSES = [
  "Detecting card borders...",
  "Analyzing card artwork...",
  "Extracting text with AI OCR...",
  "Querying database records...",
  "Comparing card variants...",
  "Calculating market prices..."
];

export default function ScannerPage() {
  const { data: session } = useSession();
  const { setIsActivelyScanningOrProcessing } = useScannerState();
  const [state, setState] = useState<ScanState>("idle");
  const [scanResult, setScanResult] = useState<SavedCard | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  // Pipeline stage the server blamed for a failed scan (Phase 5.2.5) — shown
  // as a small caption in the error state so field reports say WHERE it broke.
  const [errorStage, setErrorStage] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [addSuccess, setAddSuccess] = useState(false);
  // Post-add archive totals (Phase 5 · Batch 2) — returned by the add routes.
  const [postAddArchive, setPostAddArchive] = useState<PostAddArchive | null>(null);
  const [selectedGame, setSelectedGame] = useState<string>("All");
  const [loadingStatusIndex, setLoadingStatusIndex] = useState(0);
  const [disambiguationCandidates, setDisambiguationCandidates] = useState<DisambiguationCandidate[]>([]);
  const [disambiguationCardName, setDisambiguationCardName] = useState("");
  // ScanHistory row of the attempt that triggered disambiguation — echoed to
  // save-selection so the user's pick lands on that row as ground truth.
  const [disambiguationScanId, setDisambiguationScanId] = useState<string | null>(null);
  
  // Auto-scan feature — use REF not state for the scanning lock to avoid re-render loops
  const [isAutoScan, setIsAutoScan] = useState(false);
  const [isBulkMode, setIsBulkMode] = useState(false);
  const [bulkQueue, setBulkQueue] = useState<SavedCard[]>([]);

  const [autoScanBusy, setAutoScanBusy] = useState(false); // only for UI spinner
  // Why the last auto/bulk attempt didn't queue a card (Phase 5.2.5). Silent
  // retry loops made bulk look dead; this quiet, auto-fading chip keeps the
  // instrument honest without interrupting the loop.
  const [autoSkipNotice, setAutoSkipNotice] = useState<{ message: string; count: number } | null>(null);
  const autoSkipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isAutoScanningRef = useRef(false); // true lock — prevents overlapping scans
  const lastBulkAddRef = useRef<{ id: string; at: number } | null>(null); // bulk dedup window
  const autoScanIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [cameraReady, setCameraReady] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // Guide overlay box — source of truth for ROI capture (Phase 4.5 · Commit 2).
  const guideRef = useRef<HTMLDivElement>(null);

  // ROI capture toggle. Defaults to ROI_CAPTURE_DEFAULT; a dev-only button (in
  // the debug overlay) flips it so ROI can be A/B'd against full-frame capture.
  // Read from a ref at capture time so toggling never re-subscribes the loops.
  const [roiCaptureEnabled, setRoiCaptureEnabled] = useState(ROI_CAPTURE_DEFAULT);
  const roiCaptureEnabledRef = useRef(ROI_CAPTURE_DEFAULT);

  // ─── Live Capture Metrics (Phase 4.5 · Commit 1) ──────────────────────
  // Allocation-conscious ~10Hz analysis loop over the live preview. Consumed by
  // the live guidance chip (Commit 3) and smart auto-capture (Commit 4) via
  // getLatest(). Does not alter manual scan behavior.
  const liveMetricsRef = useRef<LiveMetricsController | null>(null);

  // ─── Smart Auto-Capture (Phase 4.5 · Commit 4) ────────────────────────
  // Machine + a reused 8×8 canvas for duplicate-frame aHashing.
  const smartMachineRef = useRef<SmartCaptureMachine | null>(null);
  const aHashCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // Dev-only A/B flag: when true, the OLD fixed-4s timer drives auto-scan
  // instead of smart capture. Defaults to smart. Never shown in production.
  const [legacyTimedAuto, setLegacyTimedAuto] = useState(false);
  const legacyTimedAutoRef = useRef(false);

  // TEMPORARY runtime opt-in for the SmartCapture diagnostics (Phase 4.5
  // auto/bulk stall debug), so they can run on a phone against an HTTPS
  // Preview deployment. False on the server and on the client's first paint
  // (the flag reads window.location), then resolved once after mount — keeping
  // server and client HTML identical. Off in production unless opted in.
  const [smartDiagEnabled, setSmartDiagEnabled] = useState(false);
  useEffect(() => {
    setSmartDiagEnabled(isSmartDiagEnabled());
  }, []);

  // Sync active scanning state to context so mobile nav can hide during active scans
  useEffect(() => {
    const isActive = ["scanning", "processing", "bulk-review"].includes(state);
    setIsActivelyScanningOrProcessing(isActive);
  }, [state, setIsActivelyScanningOrProcessing]);

  // ─── Camera Management ────────────────────────────────────────────────
  // Attach the current stream to a <video> and (re)start playback. Shared by
  // the mount-time callback ref AND mid-session restarts (Phase 5.2.5): the
  // callback ref only fires on mount, so "Restart Camera" while scanning must
  // re-attach explicitly or the preview freezes on the stopped old stream with
  // cameraReady stuck false — a dead scanner until the page was left.
  const attachStreamToVideo = useCallback((video: HTMLVideoElement) => {
    if (!streamRef.current) return;
    video.srcObject = streamRef.current;

    const playVideo = () => {
      video.play()
        .then(() => {
          console.log("[Scanner] Camera stream playing");
        })
        .catch((err) => {
          console.warn("[Scanner] Failed to autoplay, retrying:", err);
          setTimeout(playVideo, 300);
        });
    };

    playVideo();
  }, []);

  const startCamera = useCallback(async () => {
    // Pre-flight: getUserMedia only exists in a secure context (HTTPS or
    // localhost). Opening the dev server's Network URL (http://192.168.x.x)
    // leaves navigator.mediaDevices undefined — which otherwise surfaces as a
    // misleading "permission denied" message even though nothing was denied.
    if (!navigator.mediaDevices?.getUserMedia) {
      const insecure =
        typeof window !== "undefined" &&
        !window.isSecureContext &&
        !["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
      alert(
        insecure
          ? `Camera needs a secure connection. Open the app at http://localhost:${window.location.port || "3000"} (not the network IP ${window.location.hostname}) or use HTTPS.`
          : "This browser doesn't expose camera access (navigator.mediaDevices is unavailable). Try Chrome, Edge, or Safari."
      );
      return;
    }

    try {
      // Stop any existing stream first — a lingering handle is itself a common
      // cause of "Timeout starting video source" on the next request.
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }

      // Request QHD (~2560×1440) as `ideal`, retrying with relaxed constraints
      // if the high-res start times out or the device is briefly locked.
      const mediaStream = await acquireCameraStream();
      streamRef.current = mediaStream;
      setCameraReady(false);
      // Mid-session restart: the <video> is already mounted, so the callback
      // ref won't fire — attach the fresh stream here. onCanPlay then re-fires
      // and restores cameraReady.
      if (videoRef.current) attachStreamToVideo(videoRef.current);
      setState("scanning");
    } catch (err) {
      // Surface the ACTUAL failure — a single generic message hides whether
      // permission was denied, the camera is busy, or no camera exists.
      const e = err as DOMException;
      console.error("Camera error:", e?.name, e?.message, err);
      let message: string;
      switch (e?.name) {
        case "NotAllowedError":
        case "SecurityError":
          message = "Camera permission is blocked for this site. Click the camera icon in the address bar, set it to Allow, then reload.";
          break;
        case "NotReadableError":
        case "TrackStartError":
          message = "Your camera is already in use by another app (Zoom, Teams, OBS, another tab). Close it and try again.";
          break;
        case "AbortError":
          message = "The camera timed out while starting — usually another app is holding it, or it's still initializing. Close other camera apps and try again.";
          break;
        case "NotFoundError":
        case "DevicesNotFoundError":
          message = "No camera was found on this device.";
          break;
        case "OverconstrainedError":
          message = "No camera matched the requested settings. Try a different camera.";
          break;
        default:
          message = `Could not start the camera${e?.name ? ` (${e.name})` : ""}. ${e?.message || "Please try again."}`;
      }
      alert(message);
    }
  }, [attachStreamToVideo]);

  // Callback ref: fires the instant the <video> element mounts into the DOM.
  // This avoids the race condition where AnimatePresence mode="wait" delays
  // mounting while the useEffect already fired and found videoRef === null.
  const videoRefCallback = useCallback(
    (video: HTMLVideoElement | null) => {
      // Store in the persistent ref so other code (canvas capture) can use it
      videoRef.current = video;
      if (!video) return;
      // Attach the live stream to the freshly-mounted video element
      attachStreamToVideo(video);
    },
    [attachStreamToVideo]
  );

  const stopCamera = useCallback(() => {
    // Clean up auto-scan
    if (autoScanIntervalRef.current) {
      clearInterval(autoScanIntervalRef.current);
      autoScanIntervalRef.current = null;
    }
    isAutoScanningRef.current = false;
    setIsAutoScan(false);
    setIsBulkMode(false);
    setAutoScanBusy(false);
    setCameraReady(false);
    
    // Stop camera stream
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }

    // If in bulk mode and have queue, go to review. Otherwise idle.
    if (bulkQueue.length > 0) {
      setState("bulk-review");
    } else {
      setState("idle");
    }
  }, [bulkQueue.length]);

  const toggleScanMode = useCallback((mode: "manual" | "auto" | "bulk") => {
    if (mode === "manual") {
      setIsAutoScan(false);
      setIsBulkMode(false);
    } else if (mode === "auto") {
      setIsAutoScan(true);
      setIsBulkMode(false);
    } else if (mode === "bulk") {
      setIsAutoScan(true); // Bulk is essentially auto-scan that queues
      setIsBulkMode(true);
    }
  }, []);

  // ─── Image Capture (Phase 4) ──────────────────────────────────────────
  // Multi-frame capture + sharpness selection + quality gate all live in
  // src/lib/scanner/capture.ts. This is a thin wrapper: `frameCount` is the
  // only per-caller knob (manual can afford more frames than the auto loop).
  // Map the on-screen guide box to a source-pixel crop. Returns null (→ full
  // frame) when ROI is disabled or any measurement is invalid, so ROI can never
  // make capture worse than before.
  const computeRoiForCapture = useCallback((): CaptureRegion | null => {
    if (!roiCaptureEnabledRef.current) return null;
    const video = videoRef.current;
    const guide = guideRef.current;
    if (!video || !guide || !video.videoWidth || !video.videoHeight) return null;

    const vRect = video.getBoundingClientRect();
    const gRect = guide.getBoundingClientRect();
    if (!vRect.width || !vRect.height || !gRect.width || !gRect.height) return null;

    return computeCaptureRoi({
      sourceW: video.videoWidth,
      sourceH: video.videoHeight,
      elemW: vRect.width,
      elemH: vRect.height,
      guideX: gRect.left - vRect.left,
      guideY: gRect.top - vRect.top,
      guideW: gRect.width,
      guideH: gRect.height,
      pad: ROI_CAPTURE_PAD,
    });
  }, []);

  const captureBestFrame = useCallback(
    (frameCount: number, debugLabel?: string): Promise<CaptureResult> =>
      captureSharpestFrame(videoRef.current, canvasRef.current, {
        frameCount,
        roi: computeRoiForCapture() ?? undefined,
        debugLabel,
      }),
    [computeRoiForCapture]
  );

  // Surface (and coalesce) one skip reason at a time; fades after a beat.
  const reportAutoSkip = useCallback((message: string) => {
    setAutoSkipNotice((prev) =>
      prev && prev.message === message ? { message, count: prev.count + 1 } : { message, count: 1 }
    );
    if (autoSkipTimerRef.current) clearTimeout(autoSkipTimerRef.current);
    autoSkipTimerRef.current = setTimeout(() => setAutoSkipNotice(null), 4000);
  }, []);

  // ─── Scan Request ─────────────────────────────────────────────────────
  // Returns true when the server actually identified a card (saved, queued,
  // recognized-but-still-in-frame, or sent to disambiguation) and false on any
  // failure. Smart capture commits its dedup hash only on true — a failed
  // attempt must stay retryable (Phase 5.2.5 bulk dead-stall fix).
  const processScanRequest = useCallback(async (base64Image: string, isBackground: boolean = false): Promise<boolean> => {
    const requestedAt = performance.now();
    const diagMode = isBackground ? (isBulkMode ? "bulk" : "auto") : "manual";
    try {
      const res = await fetch(`/api/scanner/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image: base64Image,
          game: selectedGame === "All" ? undefined : selectedGame,
          // Background (auto/bulk) scans save with no review screen, so the
          // server holds them to a stricter confidence threshold.
          isAutoScan: isBackground,
        }),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => null);
        const msg = errJson?.message || "Failed to identify card.";
        const stage = errJson?.stage || "unknown";
        if (smartDiagEnabled) {
          smartDiag.record({
            event: "scan_response",
            mode: diagMode,
            reason: stage,
            detail: `http ${res.status} · ${Math.round(performance.now() - requestedAt)}ms · ${msg}`,
          });
        }
        if (isBackground) {
          console.log(`[AutoScan] Background scan failed [${stage}]:`, msg);
          reportAutoSkip(msg);
          return false; // continue auto-scanning; dedup hash must NOT commit
        }
        const err = new Error(msg) as Error & { stage?: string };
        err.stage = stage;
        throw err;
      }

      const json = await res.json();

      if (smartDiagEnabled) {
        smartDiag.record({
          event: "scan_response",
          mode: diagMode,
          detail: `http 200 · ${Math.round(performance.now() - requestedAt)}ms · ${
            json.requiresDisambiguation ? `disambiguation (${json.candidates?.length ?? 0} candidates)` : `accepted: ${json.data?.name ?? "?"}`
          }`,
        });
      }

      // Log exactly what the AI OCR read for debugging purposes
      if (json.ocrData) {
        console.log("=========================================");
        console.log("[AI OCR DEBUG] Raw Extractions from Card:");
        console.log(json.ocrData);
        console.log("=========================================");
      }

      // AI is uncertain — show disambiguation grid for user to pick
      if (json.requiresDisambiguation) {
        setDisambiguationCandidates((json.candidates as DisambiguationCandidate[]) || []);
        setDisambiguationCardName(json.cardName || "");
        setDisambiguationScanId(json.scanId || null);
        // Stop auto-scan loop while user picks
        if (autoScanIntervalRef.current) {
          clearInterval(autoScanIntervalRef.current);
          autoScanIntervalRef.current = null;
        }
        isAutoScanningRef.current = false;
        setState("disambiguation");
        return true;
      }

      const card = json.data as SavedCard;

      if (isBulkMode) {
        // Bulk Mode logic: Add to queue, do not stop camera.
        // Time-based debounce (not consecutive-id): the same card still in
        // frame across auto-scan ticks is skipped, but a deliberate duplicate
        // scanned later (playsets!) queues normally.
        const now = Date.now();
        const last = lastBulkAddRef.current;
        if (last && last.id === card.id && now - last.at < BULK_DUPLICATE_WINDOW_MS) {
          console.log("[BulkScan] Ignored same card still in frame:", card.name);
        } else {
          lastBulkAddRef.current = { id: card.id, at: now };
          console.log("[BulkScan] Added to queue:", card.name);
          setBulkQueue((prev) => [...prev, card]);
        }
      } else {
        // Normal Mode logic: Stop auto-scan and show result
        if (autoScanIntervalRef.current) {
          clearInterval(autoScanIntervalRef.current);
          autoScanIntervalRef.current = null;
        }
        isAutoScanningRef.current = false;
        
        setScanResult(card);
        setState("result");
      }
      return true;

    } catch (error: any) {
      if (!isBackground) {
        // Just set the error state, no need to print scary red console errors
        setErrorMessage(error.message || "Failed to identify card.");
        setErrorStage(error.stage ?? null);
        setState("error");
      }
      return false;
    }
  }, [selectedGame, isBulkMode, reportAutoSkip, smartDiagEnabled]);

  // ─── Manual Scan ──────────────────────────────────────────────────────
  const captureCard = useCallback(async () => {
    if (!session?.user?.id) return;

    // Multi-frame capture + quality gate. A poor frame (blurry / too dark /
    // overexposed) is rejected HERE with a friendly message, so we never spend
    // an OCR request on an unreadable image.
    const capture = await captureBestFrame(MANUAL_FRAME_COUNT, "manual");
    if (!capture.ok) {
      setErrorMessage(capture.message);
      // Client-side stage: the frame never left the device.
      setErrorStage(`capture:${capture.reason}`);
      setState("error");
      return;
    }

    setState("processing");
    await processScanRequest(capture.dataUrl, false);
  }, [session, captureBestFrame, processScanRequest]);

  // ─── Live Metrics Loop (Phase 4.5 · Commit 1) ─────────────────────────
  // Runs the analysis engine while the camera is live; tears it down when
  // scanning stops, the camera isn't ready, or the component unmounts. The
  // engine itself also self-pauses when the tab is hidden. Inert for now.
  useEffect(() => {
    if (state !== "scanning" || !cameraReady) return;
    const video = videoRef.current;
    if (!video) return;
    const engine = (liveMetricsRef.current ??= new LiveMetricsController());
    // Analyse the guide-box ROI (Phase 5.2.5) so readiness judges the same
    // pixels the capture gate will — full frame only when ROI is unavailable.
    engine.start(video, computeRoiForCapture);
    return () => engine.stop();
  }, [state, cameraReady, computeRoiForCapture]);

  // ─── ROI Capture Toggle (Phase 4.5 · Commit 2, dev calibration) ───────
  // Load any persisted preference once, then mirror state → ref so capture
  // reads the current value without re-subscribing the scan loops.
  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    const saved = window.localStorage.getItem("aura.roiCapture");
    if (saved === "on" || saved === "off") setRoiCaptureEnabled(saved === "on");
  }, []);

  useEffect(() => {
    roiCaptureEnabledRef.current = roiCaptureEnabled;
  }, [roiCaptureEnabled]);

  const toggleRoiCapture = useCallback(() => {
    setRoiCaptureEnabled((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem("aura.roiCapture", next ? "on" : "off");
      } catch {
        /* ignore storage failures — calibration convenience only */
      }
      return next;
    });
  }, []);

  // ─── Legacy Timed Auto-Scan Toggle (Phase 4.5 · Commit 4, dev A/B) ─────
  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    const saved = window.localStorage.getItem("aura.legacyTimedAuto");
    if (saved === "on" || saved === "off") setLegacyTimedAuto(saved === "on");
  }, []);

  useEffect(() => {
    legacyTimedAutoRef.current = legacyTimedAuto;
  }, [legacyTimedAuto]);

  const toggleLegacyTimedAuto = useCallback(() => {
    setLegacyTimedAuto((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem("aura.legacyTimedAuto", next ? "on" : "off");
      } catch {
        /* ignore storage failures — calibration convenience only */
      }
      return next;
    });
  }, []);

  // ─── Smart Auto-Capture Loop (Phase 4.5 · Commit 4) ───────────────────
  // Replaces the fixed 4s timer for auto-scan (both Auto and Bulk). Fires only
  // when a frame has been "ready" (evaluateReadiness — the SAME policy the
  // guidance chip uses) for a short dwell, and skips a card still in frame via
  // 8×8 aHash dedup. The old timer lives on below, gated behind a dev flag.
  useEffect(() => {
    if (state !== "scanning" || !isAutoScan || !cameraReady || legacyTimedAuto) return;

    const machine = (smartMachineRef.current ??= new SmartCaptureMachine());
    machine.reset();
    const hashCanvas = (aHashCanvasRef.current ??= document.createElement("canvas"));

    let raf = 0;
    let lastTick = 0;
    let cancelled = false;

    // ─── TEMP DIAG (Phase 4.5 auto/bulk stall debug) ──────────────────────
    // Flag-gated (dev, NEXT_PUBLIC_SMART_DIAG, or ?diag=1 — see
    // isSmartDiagEnabled), behavior-preserving. Traces exactly where the
    // auto/bulk pipeline stops: readiness state + reason, raw metric values,
    // the stability timer (start/reset/complete), every SmartCapture state
    // transition, duplicate-detection skips, the captureBestFrame() call, and
    // whether processScanRequest() is reached. Remove once root-caused.
    const SMART_DIAG = smartDiagEnabled;
    let lastDiagAt = 0;      // throttle for the idle ~1Hz state line
    let lastDwellLogAt = 0;  // throttle for candidate-state dwell progress
    let dwellStartAt = 0;    // wall-clock when the stability dwell began
    let prevReadyCode = "";  // last readiness code, to log only on change

    // TEMP DIAG — structured event collector for phone export. Dev-only: every
    // rec() call sits behind SMART_DIAG, so nothing is buffered in production.
    const diagMode = isBulkMode ? "bulk" : "auto";
    const diagThresholds = { motion: LIVE_THRESHOLDS.maxMotion, dwellMs: STABILITY_DWELL_MS };
    const metricsOf = (
      mm: { sharpness: number; brightness: number; glare: number; motion: number } | null
    ) =>
      mm
        ? { sharpness: mm.sharpness, brightness: mm.brightness, glare: mm.glare, motion: mm.motion }
        : { sharpness: null, brightness: null, glare: null, motion: null };
    const rec = (event: string, extra: Record<string, unknown> = {}) =>
      smartDiag.record({ event, mode: diagMode, thresholds: diagThresholds, ...extra });

    if (SMART_DIAG) {
      smartDiag.startSession();
      rec("session_start", { detail: `mode=${diagMode}` });
      console.log(
        `[SmartCapture] loop initialized (mode=${diagMode}) — waiting for readiness`
      );
    }

    const runCapture = async (decisionHash: AHash | null) => {
      setAutoScanBusy(true);
      // Whether this attempt actually identified a card. Drives the dedup-hash
      // commit in settle(): a failed attempt (rejected frame, server error, no
      // card found) leaves dedup memory untouched so the SAME scene can retry —
      // committing on failure was the bulk-mode dead stall (Phase 5.2.5).
      let identified = false;
      try {
        if (SMART_DIAG) {
          console.log("[SmartCapture] → captureBestFrame() called");
          rec("capture_best_frame_called");
        }
        const capture = await captureBestFrame(AUTO_FRAME_COUNT, "smart");
        if (SMART_DIAG) {
          console.log(
            capture.ok
              ? "[SmartCapture] capture OK → processScanRequest() (OCR dispatch)"
              : `[SmartCapture] capture REJECTED by quality gate: ${capture.reason} — retrying`
          );
          rec("capture_result", {
            detail: capture.ok ? "ok" : `rejected:${capture.reason}`,
            reason: capture.ok ? undefined : capture.reason,
          });
        }
        if (capture.ok) {
          if (SMART_DIAG) rec("ocr_dispatch", { detail: "processScanRequest reached" });
          identified = await processScanRequest(capture.dataUrl, true);
        } else {
          reportAutoSkip(capture.message);
        }
        if (SMART_DIAG) rec("attempt_outcome", { detail: identified ? "identified" : "not-identified" });
      } finally {
        // Release the persistent lock BEFORE settling so a re-subscribed loop
        // can resume cleanly.
        isAutoScanningRef.current = false;
        setAutoScanBusy(false);
        machine.settle(performance.now(), decisionHash, identified);
      }
    };

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (now - lastTick < SMART_TICK_MS) return;
      lastTick = now;
      // isAutoScanningRef is a PERSISTENT lock (survives effect re-subscribes,
      // unlike machine.state which reset() clears) — it's what prevents a
      // second, overlapping OCR call if the effect re-runs mid-capture (e.g.
      // the user taps a game filter while a scan is in flight).
      if (cancelled || isAutoScanningRef.current || machine.state === "capturing") return;

      const m = liveMetricsRef.current?.getLatest() ?? null;
      const fresh = !!m && now - m.at <= SMART_STALE_MS;
      // Motion hysteresis: if a dwell is already counting down (state
      // "candidate"), evaluate motion against the relaxed EXIT ceiling so
      // handheld-webcam jitter in the 10–16 band can't reset it. This only
      // READS the machine's existing state — it doesn't alter the state flow.
      const holding = machine.state === "candidate";
      const rd = fresh ? evaluateReadiness(m!, LIVE_THRESHOLDS, holding) : null;
      const ready = !!rd && rd.ready;

      // Widened to string so the diag transition compare below isn't narrowed
      // away by the "capturing" guard above (machine.step may advance state).
      const before: string = machine.state;
      // Hash the guide-box ROI, not the full frame — the static background
      // otherwise dominates the 64 cells and different cards hash near-alike.
      const result = machine.step(now, ready, () =>
        videoRef.current
          ? computeAverageHash(videoRef.current, hashCanvas, computeRoiForCapture())
          : null
      );

      // Duplicate gate fired: same card judged still in frame, capture skipped.
      // Made visible regardless of the diag flag — silence here is what used to
      // read as "bulk scanner died".
      if (before === "candidate" && machine.state === "cooldown") {
        reportAutoSkip("Card already scanned — swap in the next card");
      }

      // TEMP DIAG — narrate readiness, the stability dwell, and transitions.
      if (SMART_DIAG) {
        const after: string = machine.state;
        const readyCode = !m ? "no-metrics" : !fresh ? "stale-metrics" : rd!.code;
        const metrics = m
          ? `sharp=${m.sharpness.toFixed(1)} bright=${m.brightness.toFixed(1)} glare=${(m.glare * 100).toFixed(1)}% motion=${m.motion.toFixed(2)}`
          : "sharp=— bright=— glare=— motion=—";

        const metricsObj = metricsOf(m);

        // (1) Full readiness evaluation — logged only when the state CHANGES.
        if (readyCode !== prevReadyCode) {
          prevReadyCode = readyCode;
          const detail =
            rd && !rd.ready ? `${rd.debug.metric}=${rd.debug.value.toFixed(2)} (thr ${rd.debug.threshold})`
            : !m ? "no sample yet"
            : !fresh ? `sample age=${Math.round(now - m.at)}ms > ${SMART_STALE_MS}ms`
            : "all checks passed";
          console.log(
            `[Readiness] ready=${ready} reason=${readyCode} · ${detail} · ${metrics}`
          );
          rec("readiness_change", {
            ready,
            reason: readyCode,
            detail,
            metrics: metricsObj,
          });
        }

        // (2) State transitions — interpreted in stability-timer terms.
        if (after !== before) {
          if (before === "scanning" && after === "candidate") dwellStartAt = now;
          const elapsed = Math.round(now - dwellStartAt);
          const note =
            before === "scanning" && after === "candidate" ? "stability timer STARTED"
            : before === "candidate" && after === "scanning" ? `stability timer RESET after ${elapsed}ms/${STABILITY_DWELL_MS}ms (lost readiness)`
            : before === "candidate" && after === "capturing" ? `stability timer COMPLETE ${elapsed}ms/${STABILITY_DWELL_MS}ms → capture`
            : before === "candidate" && after === "cooldown" ? "DUPLICATE detected (aHash) → capture BLOCKED, cooldown"
            : before === "cooldown" && after === "scanning" ? "cooldown ended → re-armed"
            : "";
          console.log(`[SmartCapture] ${before} → ${after}${note ? ` · ${note}` : ""}`);

          // Map each transition to a named diagnostic event.
          const transitionEvent =
            before === "scanning" && after === "candidate" ? "candidate_started"
            : before === "candidate" && after === "scanning" ? "candidate_reset"
            : before === "candidate" && after === "capturing" ? "dwell_complete"
            : before === "candidate" && after === "cooldown" ? "duplicate_blocked"
            : before === "cooldown" && after === "scanning" ? "cooldown_end"
            : "state_change";
          rec(transitionEvent, {
            reason: after === "scanning" && before === "candidate" ? rd?.debug.metric ?? readyCode : readyCode,
            ready,
            metrics: metricsObj,
            dwellMs: before === "candidate" ? elapsed : undefined,
            requiredDwellMs: STABILITY_DWELL_MS,
            detail:
              transitionEvent === "duplicate_blocked"
                ? `${before} -> ${after} · hamming=${machine.lastDuplicateDistance ?? "?"} (max ${DUP_HAMMING_MAX})`
                : `${before} -> ${after}`,
          });
        }
        // (3) Dwell progress while waiting out the stability timer (~8Hz).
        else if (machine.state === "candidate" && now - lastDwellLogAt >= 120) {
          lastDwellLogAt = now;
          const elapsed = Math.round(now - dwellStartAt);
          console.log(
            `[SmartCapture] candidate · elapsed=${elapsed}ms / ${STABILITY_DWELL_MS}ms · ${metrics}`
          );
          rec("dwell_progress", {
            ready,
            reason: readyCode,
            metrics: metricsObj,
            dwellMs: elapsed,
            requiredDwellMs: STABILITY_DWELL_MS,
          });
        }
        // (4) Idle heartbeat (~1Hz) while not yet armed — shows why not ready.
        else if (machine.state !== "candidate" && now - lastDiagAt >= 1000) {
          lastDiagAt = now;
          console.log(`[SmartCapture] state=${machine.state} · reason=${readyCode} · ${metrics}`);
          rec("heartbeat", {
            ready,
            reason: readyCode,
            metrics: metricsObj,
            detail: `state=${machine.state}`,
          });
        }
      }

      if (result.action === "capture") {
        if (SMART_DIAG) rec("capture_triggered", { detail: "machine action=capture" });
        isAutoScanningRef.current = true;
        void runCapture(result.hash);
      }
    };

    raf = requestAnimationFrame(loop);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
    // smartDiagEnabled resolves once right after mount (while the scanner is
    // still idle), so including it never re-subscribes a live scanning loop.
  }, [state, isAutoScan, cameraReady, legacyTimedAuto, smartDiagEnabled, captureBestFrame, processScanRequest, computeRoiForCapture, reportAutoSkip, isBulkMode]);

  // ─── Legacy Timed Auto Scan Loop (dev A/B only) ───────────────────────
  // The original fixed-4s auto-scan. Kept behind the dev `legacyTimedAuto` flag
  // so smart capture can be compared against it. Not reachable in production.
  useEffect(() => {
    if (state === "scanning" && isAutoScan && cameraReady && legacyTimedAuto) {
      console.log("[AutoScan] Starting LEGACY timed auto-scan loop...");

      autoScanIntervalRef.current = setInterval(async () => {
        // Use ref-based lock (not state) to prevent overlapping scans
        if (isAutoScanningRef.current) return;
        isAutoScanningRef.current = true;
        setAutoScanBusy(true);

        // Background scans silently skip poor frames (existing behavior): the
        // loop just tries again on the next tick rather than surfacing an error.
        const capture = await captureBestFrame(AUTO_FRAME_COUNT, "auto");
        if (capture.ok) {
          await processScanRequest(capture.dataUrl, true);
        }

        isAutoScanningRef.current = false;
        setAutoScanBusy(false);
      }, 4000); // Check every 4 seconds

    } else {
      if (autoScanIntervalRef.current) {
        clearInterval(autoScanIntervalRef.current);
        autoScanIntervalRef.current = null;
      }
    }

    return () => {
      if (autoScanIntervalRef.current) {
        clearInterval(autoScanIntervalRef.current);
        autoScanIntervalRef.current = null;
      }
    };
  }, [state, isAutoScan, cameraReady, legacyTimedAuto, captureBestFrame, processScanRequest]);

  // Cycling loading message effect
  useEffect(() => {
    if (state !== "processing") {
      setLoadingStatusIndex(0);
      return;
    }
    const interval = setInterval(() => {
      setLoadingStatusIndex((prev) => (prev + 1) % LOADING_STATUSES.length);
    }, 1500);
    return () => clearInterval(interval);
  }, [state]);

  // ─── Reset / Add to Collection ────────────────────────────────────────
  const resetScan = useCallback(() => {
    setScanResult(null);
    setErrorMessage("");
    setErrorStage(null);
    setAddSuccess(false);
    setPostAddArchive(null);
    setBulkQueue([]);
    setDisambiguationCandidates([]);
    setDisambiguationCardName("");
    setDisambiguationScanId(null);
    startCamera();
  }, [startCamera]);

  // ─── Handle user selecting a specific variant from disambiguation ─────
  const handleSelectCandidate = async (candidate: DisambiguationCandidate) => {
    setIsAdding(true);
    try {
      // Identifiers only — the server re-fetches the card from its source
      // database; nothing else in the candidate object is trusted or needed.
      const res = await fetch("/api/scanner/save-selection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          externalId: candidate.externalId,
          game: candidate.game,
          scanId: disambiguationScanId ?? undefined,
        }),
      });
      if (!res.ok) throw new Error("Failed to save selection");
      const json = await res.json();
      const card = json.data as SavedCard;

      if (isBulkMode) {
        setBulkQueue((prev) => {
          if (prev.length > 0 && prev[prev.length - 1].id === card.id) return prev;
          return [...prev, card];
        });
        setDisambiguationCandidates([]);
        setDisambiguationScanId(null);
        startCamera();
      } else {
        setScanResult(card);
        setState("result");
      }
    } catch (error: any) {
      alert("Failed to save your selection. Please try again.");
    } finally {
      setIsAdding(false);
    }
  };

  const handleAddToCollection = async () => {
    if (!session?.user?.id || !scanResult?.id) return;
    setIsAdding(true);
    try {
      const res = await fetch(`/api/collections/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardId: scanResult.id }),
      });
      if (!res.ok) throw new Error("Failed to add to collection");
      const json = await res.json().catch(() => null);
      setPostAddArchive(json?.archive ?? null);
      setAddSuccess(true);
    } catch (error) {
      console.error(error);
      alert("Failed to add card to collection.");
    } finally {
      setIsAdding(false);
    }
  };

  const handleAddBulkToCollection = async () => {
    if (!session?.user?.id || bulkQueue.length === 0) return;
    setIsAdding(true);
    try {
      const cardIds = bulkQueue.map((c) => c.id);
      const res = await fetch(`/api/collections/add/bulk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardIds }),
      });
      if (!res.ok) throw new Error("Failed to add bulk to collection");
      const json = await res.json().catch(() => null);
      setPostAddArchive(json?.archive ?? null);
      setAddSuccess(true);
    } catch (error) {
      console.error(error);
      alert("Failed to add cards to collection.");
    } finally {
      setIsAdding(false);
    }
  };

  const removeFromBulkQueue = (index: number) => {
    setBulkQueue((prev) => prev.filter((_, i) => i !== index));
    if (bulkQueue.length <= 1) {
      resetScan();
    }
  };

  // Skip notices only make sense over a live viewfinder.
  useEffect(() => {
    if (state !== "scanning") setAutoSkipNotice(null);
  }, [state]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (autoScanIntervalRef.current) clearInterval(autoScanIntervalRef.current);
      if (autoSkipTimerRef.current) clearTimeout(autoSkipTimerRef.current);
    };
  }, []);

  // ─── Render ───────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full">
      <canvas ref={canvasRef} className="hidden" />

      {/* TEMPORARY flag-gated diagnostics export (Phase 4.5 auto/bulk debug):
          dev, NEXT_PUBLIC_SMART_DIAG=true, or ?diag=1. Fixed so it's tappable
          from the phone in any scan state. Remove with the SmartCapture
          diagnostics cleanup. */}
      {smartDiagEnabled && (
        <button
          type="button"
          onClick={() => smartDiag.export()}
          className="fixed bottom-3 right-3 z-50 rounded-full border border-emerald-400/40 bg-black/80 px-3 py-1.5 font-mono text-[11px] font-semibold text-emerald-300 shadow-lg backdrop-blur active:scale-95"
          title="Download aura-smartcapture-debug.json"
        >
          ⤓ Export SmartCapture Diag
        </button>
      )}

      {/* Header — hidden while the camera is live so the scan view is immersive
          and the capture controls always fit within the visible viewport. */}
      {state !== "scanning" && (
        <div className="p-4 sm:p-6 border-b border-border flex justify-between items-center">
          <div>
            <h1 className="font-serif text-2xl sm:text-3xl tracking-tight">Scanner</h1>
            <p className="text-sm text-muted-foreground mt-1">Identify a card and enter it into your archive.</p>
          </div>
        </div>
      )}

      <div className="flex-1 p-2 sm:p-6 flex flex-col min-h-0">
        <div className="max-w-2xl w-full mx-auto flex-1 flex flex-col h-full">
          <AnimatePresence mode="wait">
            
            {/* ── IDLE STATE ── */}
            {state === "idle" && (
              <motion.div key="idle" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -12 }} className="flex-1 min-h-0 overflow-y-auto no-scrollbar">
                {/* min-h-full centers this intro when it fits and lets it scroll
                    WITHIN this bounded region (which sits above the bottom nav)
                    on very short viewports — so the "Open Camera" button is
                    always reachable without dragging the whole page, which also
                    avoids the mobile-Safari toolbar collapse/relayout on release. */}
                <div className="min-h-full flex flex-col items-center justify-center py-6">
                {/* Empty archive slot — the card is the object being captured */}
                <div className="card-frame w-32 sm:w-40 border border-border bg-card shadow-[0_16px_32px_-24px_rgba(19,18,16,0.5)] mb-5 relative">
                  <div className="absolute inset-2 rounded-[inherit] border border-dashed border-border flex flex-col items-center justify-center gap-3">
                    <Camera className="h-7 w-7 text-muted-foreground" />
                    <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Empty slot</span>
                  </div>
                </div>
                <h2 className="font-serif text-2xl mb-1">Ready to scan</h2>
                <p className="text-sm text-muted-foreground">Place a card in the viewfinder to identify it.</p>
                <div className="flex flex-wrap items-center justify-center gap-2 mb-6 mt-4">
                  {["All", "Pokemon", "MTG", "Yugioh"].map((g) => {
                    const label = g === "Pokemon" ? "Pokémon" : g === "MTG" ? "Magic (MTG)" : g === "Yugioh" ? "Yu-Gi-Oh!" : g;
                    const isActive = selectedGame === g;
                    return (
                      <Button
                        key={g}
                        variant={isActive ? "secondary" : "outline"}
                        size="sm"
                        onClick={() => setSelectedGame(g)}
                        className={cn(
                          "rounded-full px-4 font-medium transition-all border",
                          isActive
                            ? "bg-secondary text-foreground border-brass/50 font-semibold"
                            : "text-muted-foreground border-border hover:bg-muted"
                        )}
                      >
                        {label}
                      </Button>
                    );
                  })}
                </div>
                <Button onClick={startCamera} className="h-12 px-8 font-medium text-base w-full max-w-xs">
                  <Camera className="h-5 w-5 mr-2" /> Open Camera
                </Button>
                </div>
              </motion.div>
            )}

            {/* ── SCANNING STATE ── */}
            {state === "scanning" && (
              <motion.div key="scanning" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} className="flex-1 flex flex-col h-full min-h-0">
                <div className="relative rounded-xl overflow-hidden border border-border bg-card flex-1 flex flex-col h-full min-h-0">

                  {/* Status Indicators */}
                  <div className="absolute top-4 left-4 z-10 flex flex-col gap-2">
                    {isAutoScan && !isBulkMode && (
                      <div className="flex items-center gap-2 bg-black/70 text-white px-3 py-1.5 rounded-full font-mono text-[11px] uppercase tracking-wide border border-white/15">
                        <div className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" /> Auto
                      </div>
                    )}
                    {isBulkMode && (
                      <div className="flex items-center gap-2 bg-black/70 text-white px-3 py-1.5 rounded-full font-mono text-[11px] uppercase tracking-wide border border-white/15">
                        <Layers className="h-3 w-3 text-brass" /> Bulk · {bulkQueue.length}
                      </div>
                    )}
                  </div>

                  {/* Live capture guidance (Phase 4.5 · Commit 3) — one chip,
                      isolated so live updates don't re-render this page. */}
                  <CaptureGuidance controllerRef={liveMetricsRef} />

                  {/* Skip notice (Phase 5.2.5) — why the last auto/bulk attempt
                      didn't queue a card. Quiet and self-fading; the loop keeps
                      running. Auto modes only — manual failures use the full
                      error state. */}
                  {isAutoScan && autoSkipNotice && (
                    <div className="pointer-events-none absolute left-1/2 top-14 z-10 -translate-x-1/2">
                      <div className="flex items-center gap-1.5 rounded-full border border-white/15 bg-black/70 px-3 py-1 text-[11px] font-medium text-amber-200/90 shadow-lg backdrop-blur-sm">
                        {autoSkipNotice.message}
                        {autoSkipNotice.count > 1 && <span className="font-mono text-amber-200/60">×{autoSkipNotice.count}</span>}
                      </div>
                    </div>
                  )}

                  {/* TEMPORARY dev-only live-metrics HUD (Phase 4.5 calibration). */}
                  {process.env.NODE_ENV === "development" && (
                    <LiveMetricsDebugOverlay
                      controllerRef={liveMetricsRef}
                      roiEnabled={roiCaptureEnabled}
                      onToggleRoi={toggleRoiCapture}
                      legacyTimedAuto={legacyTimedAuto}
                      onToggleLegacyTimedAuto={toggleLegacyTimedAuto}
                    />
                  )}

                  {/* Camera Quick Restart */}
                  <div className="absolute top-4 right-4 z-10">
                    <Button 
                      variant="outline" 
                      size="icon" 
                      onClick={startCamera} 
                      className="rounded-full h-10 w-10 bg-black/60 backdrop-blur-sm border-white/10 hover:bg-white/20 text-white transition-all shadow-md shrink-0 flex items-center justify-center"
                      title="Restart Camera"
                    >
                      <RotateCcw className="h-4 w-4" />
                    </Button>
                  </div>

                  {/* Recently Scanned Mini-tray (Bulk Mode) */}
                  {isBulkMode && bulkQueue.length > 0 && (
                    <div className="absolute right-4 top-4 bottom-24 w-16 z-10 flex flex-col items-center gap-2 overflow-hidden justify-end pb-2 pointer-events-none">
                      <AnimatePresence>
                        {bulkQueue.slice(-3).map((card, i) => (
                          <motion.div 
                            key={`${card.id}-${i}`}
                            initial={{ opacity: 0, x: 20, scale: 0.8 }}
                            animate={{ opacity: 1, x: 0, scale: 1 }}
                            exit={{ opacity: 0, x: 20 }}
                            className="w-12 h-16 rounded-md overflow-hidden border border-brass shadow-md bg-black/50"
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={card.thumbnailUrl || card.imageUrl || undefined} alt="Card" className="w-full h-full object-cover" />
                          </motion.div>
                        ))}
                      </AnimatePresence>
                    </div>
                  )}

                  <div className="flex-1 min-h-0 bg-black relative">
                    <video 
                      ref={videoRefCallback} 
                      autoPlay 
                      playsInline 
                      muted
                      onCanPlay={() => {
                        setCameraReady(true);
                        console.log("[Scanner] Camera feed is ready!");
                      }}
                      onLoadedMetadata={(e) => {
                        const v = e.target as HTMLVideoElement;
                        v.play().catch(console.error);
                      }}
                      className="w-full h-full object-cover" 
                    />

                    <div className="absolute inset-0 flex items-center justify-center">
                      {/* Guide frame at true trading-card proportions. Aspect kept
                          identical to before — this box drives ROI capture. */}
                      <div ref={guideRef} className="relative w-[70%] max-w-[280px] aspect-[2.5/3.5] border border-white/25 rounded-lg transition-all duration-1000">
                        <div className="absolute -top-px -left-px w-8 h-8 border-t-2 border-l-2 rounded-tl-lg border-brass" />
                        <div className="absolute -top-px -right-px w-8 h-8 border-t-2 border-r-2 rounded-tr-lg border-brass" />
                        <div className="absolute -bottom-px -left-px w-8 h-8 border-b-2 border-l-2 rounded-bl-lg border-brass" />
                        <div className="absolute -bottom-px -right-px w-8 h-8 border-b-2 border-r-2 rounded-br-lg border-brass" />

                        {isAutoScan && (
                          <div className="absolute left-0 right-0 h-px bg-gradient-to-r from-transparent via-brass to-transparent animate-scan-line opacity-90" />
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="px-4 pt-3 pb-1 bg-card border-t border-border flex items-center justify-center gap-2">
                    {["All", "Pokemon", "MTG", "Yugioh"].map((g) => {
                      const label = g === "Pokemon" ? "Pokémon" : g === "MTG" ? "Magic" : g === "Yugioh" ? "Yu-Gi-Oh!" : g;
                      return (
                        <Button
                          key={g}
                          variant="ghost"
                          size="sm"
                          onClick={() => setSelectedGame(g)}
                          className={cn(
                            "rounded-full h-8 px-4 text-xs font-semibold transition-all border",
                            selectedGame === g
                              ? "bg-secondary text-foreground border-brass/50"
                              : "text-muted-foreground border-transparent hover:bg-muted"
                          )}
                        >
                          {label}
                        </Button>
                      );
                    })}
                  </div>

                  {/* Camera Controls */}
                  <div className="p-4 pt-2 flex items-center justify-between gap-4 bg-card">
                    <Button variant="outline" size="icon" onClick={stopCamera} className="rounded-full h-12 w-12 shrink-0 hover:bg-destructive hover:text-white hover:border-destructive transition-colors">
                      {isBulkMode && bulkQueue.length > 0 ? <Check className="h-5 w-5" /> : <X className="h-5 w-5" />}
                    </Button>

                    <div className="flex bg-secondary rounded-full p-1 border border-border overflow-hidden">
                      <Button
                        onClick={() => toggleScanMode("manual")}
                        variant="ghost"
                        className={cn("rounded-full h-10 px-4 text-xs font-semibold transition-all", !isAutoScan && !isBulkMode ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
                      >
                        Single
                      </Button>
                      <Button
                        onClick={() => toggleScanMode("auto")}
                        variant="ghost"
                        className={cn("rounded-full h-10 px-4 text-xs font-semibold transition-all", isAutoScan && !isBulkMode ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
                      >
                        Auto
                      </Button>
                      <Button
                        onClick={() => toggleScanMode("bulk")}
                        variant="ghost"
                        className={cn("rounded-full h-10 px-4 text-xs font-semibold transition-all", isBulkMode ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
                      >
                        Bulk
                      </Button>
                    </div>

                    {!isAutoScan ? (
                      <Button onClick={captureCard} disabled={!cameraReady} className="h-12 w-12 rounded-full shrink-0 ring-1 ring-border ring-offset-2 ring-offset-card disabled:opacity-40">
                        <Camera className="h-5 w-5" />
                      </Button>
                    ) : (
                      <div className="h-12 w-12 flex items-center justify-center shrink-0">
                        {autoScanBusy && <RefreshCw className="h-5 w-5 text-brass animate-spin" />}
                      </div>
                    )}
                  </div>
                </div>

                {isBulkMode && (
                  <div className="mt-4 text-center">
                    <Button
                      onClick={stopCamera}
                      className="w-full sm:w-auto min-w-[200px] h-12"
                      disabled={bulkQueue.length === 0}
                    >
                      Finish Bulk Scan ({bulkQueue.length} cards)
                    </Button>
                  </div>
                )}
              </motion.div>
            )}

            {/* ── PROCESSING STATE ── */}
            {state === "processing" && (
              <motion.div 
                key="processing" 
                initial={{ opacity: 0, y: 15 }} 
                animate={{ opacity: 1, y: 0 }} 
                exit={{ opacity: 0, y: -15 }} 
                className="flex flex-col items-center justify-center py-12"
              >
                {/* Card under examination — flat card-frame with a brass read line */}
                <div className="relative card-frame w-36 sm:w-40 border border-border bg-card shadow-[0_16px_32px_-24px_rgba(19,18,16,0.5)] mb-8">
                  <div className="absolute inset-2 rounded-[inherit] border border-dashed border-border" />
                  <div className="absolute left-0 right-0 h-px bg-gradient-to-r from-transparent via-brass to-transparent animate-scan-line" />
                </div>

                <div className="space-y-2 text-center">
                  <h2 className="font-serif text-2xl tracking-tight text-foreground flex items-center justify-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin text-brass" />
                    Examining card
                  </h2>
                  <AnimatePresence mode="wait">
                    <motion.p
                      key={loadingStatusIndex}
                      initial={{ opacity: 0, y: 5 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -5 }}
                      transition={{ duration: 0.2 }}
                      className="font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground min-h-[20px]"
                    >
                      {LOADING_STATUSES[loadingStatusIndex]}
                    </motion.p>
                  </AnimatePresence>
                  <p className="text-xs text-muted-foreground pt-1">
                    Identifying the printing and pulling live market pricing.
                  </p>
                </div>
              </motion.div>
            )}

            {/* ── ERROR STATE ── */}
            {state === "error" && (
              <motion.div key="error" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} className="flex flex-col items-center justify-center py-16">
                <div className="w-20 h-20 rounded-xl bg-destructive/10 flex items-center justify-center mb-8 border border-destructive/20">
                  <AlertCircle className="h-8 w-8 text-destructive" />
                </div>
                <h2 className="font-serif text-2xl mb-2">Scan failed</h2>
                <p className="text-sm text-muted-foreground mb-2 max-w-xs text-center">{errorMessage}</p>
                {/* Failure stage (Phase 5.2.5) — names WHERE it failed, so a
                    field report is actionable instead of "it failed". */}
                {errorStage && (
                  <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/60 mb-6">
                    stage: {errorStage}
                  </p>
                )}
                {!errorStage && <div className="mb-4" />}
                <Button variant="outline" className="h-11 px-8 font-medium" onClick={resetScan}>
                  <RotateCcw className="h-4 w-4 mr-2" /> Try Again
                </Button>
              </motion.div>
            )}

            {/* ── DISAMBIGUATION STATE ── */}
            {state === "disambiguation" && disambiguationCandidates.length > 0 && (
              <motion.div
                key="disambiguation"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="space-y-4"
              >
                {/* Header */}
                <div className="p-4 rounded-lg bg-card border border-border flex items-start gap-3">
                  <div className="shrink-0 mt-0.5">
                    <Scan className="h-4 w-4 text-brass" />
                  </div>
                  <div>
                    <p className="font-serif text-lg leading-snug">Which printing is this?</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      We identified &ldquo;<span className="font-medium text-foreground">{disambiguationCardName}</span>&rdquo; but not the exact set. Tap the correct version below.
                    </p>
                  </div>
                </div>

                {/* Candidate Grid */}
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 max-h-[60vh] overflow-y-auto pr-1 custom-scrollbar">
                  {disambiguationCandidates.map((candidate, idx) => (
                    <motion.button
                      key={`${candidate.externalId}-${idx}`}
                      initial={{ opacity: 0, scale: 0.9 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ delay: idx * 0.04 }}
                      onClick={() => !isAdding && handleSelectCandidate(candidate)}
                      disabled={isAdding}
                      className={cn(
                        "group relative rounded-lg overflow-hidden border bg-card text-left transition-all duration-200",
                        "hover:border-brass/60 hover:shadow-md hover:-translate-y-0.5",
                        "focus:outline-none focus:ring-2 focus:ring-ring/50",
                        candidate.isBestMatch
                          ? "border-brass ring-1 ring-brass/40"
                          : "border-border",
                        isAdding && "opacity-50 cursor-not-allowed"
                      )}
                    >
                      {/* Best-match badge — vision's top pick */}
                      {candidate.isBestMatch && (
                        <div className="absolute top-1.5 left-1.5 z-10 flex items-center gap-1 rounded-full bg-brass px-2 py-0.5 shadow-sm">
                          <span className="font-mono text-[9px] font-semibold uppercase tracking-wide text-white">Best match</span>
                        </div>
                      )}
                      {/* Card Image */}
                      <div className="aspect-[2.5/3.5] w-full bg-muted overflow-hidden">
                        {candidate.thumbnailUrl || candidate.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={candidate.thumbnailUrl || candidate.imageUrl || undefined}
                            alt={candidate.setName}
                            className="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-300"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center">
                            <Sparkles className="h-8 w-8 text-muted-foreground/40" />
                          </div>
                        )}
                        {/* Hover overlay */}
                        <div className="absolute inset-0 bg-transparent group-hover:bg-black/10 transition-colors duration-200 flex items-center justify-center">
                          <div className="opacity-0 group-hover:opacity-100 transition-opacity bg-brass rounded-full p-2 shadow-md">
                            <Check className="h-4 w-4 text-white" />
                          </div>
                        </div>
                      </div>

                      {/* Card Info */}
                      <div className="p-2">
                        <p className="text-[11px] font-semibold leading-tight line-clamp-2 text-foreground">{candidate.setName}</p>
                        {(candidate.setCode || candidate.collectorNumber) && (
                          <p className="font-mono text-[10px] text-muted-foreground mt-0.5 truncate">
                            {[
                              candidate.setCode ? candidate.setCode.toUpperCase() : null,
                              candidate.collectorNumber ? `#${candidate.collectorNumber}` : null,
                            ].filter(Boolean).join(" · ")}
                          </p>
                        )}
                        <div className="flex items-center justify-between mt-1 gap-1">
                          {candidate.rarity && (
                            <span className="text-[10px] text-muted-foreground truncate">{candidate.rarity}</span>
                          )}
                          <span className="font-mono text-[11px] font-semibold text-foreground shrink-0">
                            ${candidate.price?.marketPrice?.toFixed(2) || "0.00"}
                          </span>
                        </div>
                      </div>
                    </motion.button>
                  ))}
                </div>

                {/* Actions */}
                <Button
                  variant="outline"
                  className="w-full h-11"
                  onClick={resetScan}
                  disabled={isAdding}
                >
                  <RotateCcw className="h-4 w-4 mr-2" /> None of these — Scan Again
                </Button>
              </motion.div>
            )}

            {/* ── RESULT STATE (Single Card) ── */}
            {state === "result" && scanResult && !isBulkMode && (
              <motion.div key="result" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, y: -12 }} className="py-4 space-y-5">
                {/* Catalog entry caption */}
                <p className="text-center font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                  Identified · New entry
                </p>

                {/* The card itself, entering the archive */}
                <motion.div
                  initial={{ opacity: 0, y: 18, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
                  className="mx-auto w-44 sm:w-52"
                >
                  <div className="card-frame border border-border bg-muted shadow-[0_24px_48px_-24px_rgba(19,18,16,0.5)]">
                    {scanResult.imageUrl ? (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img src={scanResult.imageUrl} alt={scanResult.name} className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <Sparkles className="h-8 w-8 text-muted-foreground/40" />
                      </div>
                    )}
                  </div>
                </motion.div>

                {/* Foil rule — the screen's single foil moment */}
                <div className="foil-edge h-px w-24 mx-auto" />

                {/* Catalog details */}
                <div className="text-center space-y-1">
                  <h3 className="font-serif text-2xl sm:text-3xl leading-tight">{scanResult.name}</h3>
                  <p className="text-sm text-muted-foreground">{scanResult.set}</p>
                  <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                    {[scanResult.game, scanResult.rarity?.replace(/_/g, " ")].filter(Boolean).join(" · ")}
                  </p>
                </div>

                <div className="flex items-baseline justify-center gap-2">
                  <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">Market</span>
                  <span className="font-mono text-xl text-foreground">${scanResult.prices?.marketPrice?.toFixed(2) || "0.00"}</span>
                </div>

                {/* Archive context (Phase 5 · Batch 2) — what this card means
                    in the user's own collection. One quiet catalog line. */}
                {archiveCaption(scanResult.archive) && (
                  <p className="text-center font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                    {archiveCaption(scanResult.archive)}
                  </p>
                )}

                <div className="flex gap-3 pt-2">
                  <Button variant="outline" className="flex-1 h-12" onClick={resetScan}>
                    <RotateCcw className="h-4 w-4 mr-2" /> Scan Next
                  </Button>
                  <Button className="flex-1 h-12" onClick={handleAddToCollection} disabled={isAdding || addSuccess}>
                    {addSuccess ? (
                      <><Check className="h-4 w-4 mr-2" /> Added</>
                    ) : isAdding ? (
                      <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Adding...</>
                    ) : (
                      <>Add to Collection</>
                    )}
                  </Button>
                </div>

                {/* Post-add archive delta — the add banked into the archive. */}
                {addSuccess && postAddArchive?.totalCards != null && (
                  <motion.p
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="text-center font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground"
                  >
                    Archive · {postAddArchive.totalCards} {postAddArchive.totalCards === 1 ? "card" : "cards"}
                    {(scanResult.prices?.marketPrice ?? 0) > 0 &&
                      ` · +$${scanResult.prices.marketPrice.toFixed(2)}`}
                  </motion.p>
                )}
              </motion.div>
            )}

            {/* ── BULK REVIEW STATE ── */}
            {state === "bulk-review" && (
              <motion.div key="bulk-review" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="space-y-4">
                <div className="flex items-center justify-between p-4 rounded-lg bg-card border border-border">
                  <div>
                    <h3 className="font-serif text-xl">Bulk scan complete</h3>
                    <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground mt-0.5">{bulkQueue.length} cards identified</p>
                  </div>
                  <Button variant="outline" size="sm" onClick={resetScan}>
                    <RotateCcw className="h-4 w-4 mr-2" /> Discard All
                  </Button>
                </div>

                {/* Intake ledger */}
                <div className="rounded-lg border border-border bg-card divide-y divide-border max-h-[50vh] overflow-y-auto custom-scrollbar">
                  {bulkQueue.map((card, i) => (
                    <div key={`${card.id}-${i}`} className="p-3 flex items-center gap-4">
                      <span className="font-mono text-[10px] text-muted-foreground w-6 text-right shrink-0">{String(i + 1).padStart(2, "0")}</span>
                      {(card.thumbnailUrl || card.imageUrl) ? (
                        <div className="w-11 shrink-0 card-frame border border-border">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={card.thumbnailUrl || card.imageUrl || undefined} alt={card.name} className="w-full h-full object-cover" />
                        </div>
                      ) : (
                        <div className="w-11 shrink-0 card-frame border border-border bg-muted flex items-center justify-center">
                          <Sparkles className="h-4 w-4 text-muted-foreground/40" />
                        </div>
                      )}

                      <div className="flex-1 min-w-0">
                        <h4 className="font-medium text-sm truncate">{card.name}</h4>
                        <p className="text-xs text-muted-foreground truncate">
                          {card.set} · {card.game}
                          {/* Quiet ownership chip — the card was already held
                              before this bulk session (Phase 5 · Batch 2). */}
                          {card.archive?.inCollection && (
                            <span className="font-mono text-[10px] text-brass"> · ×{card.archive.quantity} owned</span>
                          )}
                        </p>
                      </div>

                      <span className="font-mono text-sm shrink-0">${card.prices?.marketPrice?.toFixed(2) || "0.00"}</span>

                      <Button variant="ghost" size="icon" onClick={() => removeFromBulkQueue(i)} className="shrink-0 text-muted-foreground hover:text-destructive hover:bg-destructive/10">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>

                <div className="pt-4 border-t border-border">
                  <Button
                    className="w-full h-12"
                    onClick={handleAddBulkToCollection}
                    disabled={isAdding || addSuccess || bulkQueue.length === 0}
                  >
                    {addSuccess ? (
                      <><CheckCircle2 className="h-5 w-5 mr-2" /> Successfully Added</>
                    ) : isAdding ? (
                      <><Loader2 className="h-5 w-5 mr-2 animate-spin" /> Adding {bulkQueue.length} Cards...</>
                    ) : (
                      <>Add All {bulkQueue.length} to Collection</>
                    )}
                  </Button>

                  {/* Post-add archive delta (Phase 5 · Batch 2) */}
                  {addSuccess && postAddArchive?.totalCards != null && (
                    <p className="mt-3 text-center font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                      Archive · {postAddArchive.totalCards} {postAddArchive.totalCards === 1 ? "card" : "cards"}
                    </p>
                  )}

                  {addSuccess && (
                    <Button variant="outline" className="w-full h-12 mt-3" onClick={resetScan}>
                      <RotateCcw className="h-4 w-4 mr-2" /> Start New Scan
                    </Button>
                  )}
                </div>
              </motion.div>
            )}

          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
