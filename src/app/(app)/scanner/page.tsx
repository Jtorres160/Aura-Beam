"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useSession } from "next-auth/react";
import {
  Camera, X, RotateCcw, Zap, Check, AlertCircle,
  Sparkles, Loader2, Scan, RefreshCw, Layers, Trash2, CheckCircle2
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  captureSharpestFrame,
  MANUAL_FRAME_COUNT,
  AUTO_FRAME_COUNT,
  PREFERRED_CAMERA_WIDTH,
  PREFERRED_CAMERA_HEIGHT,
  type CaptureResult,
} from "@/lib/scanner/capture";

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
  const [state, setState] = useState<ScanState>("idle");
  const [scanResult, setScanResult] = useState<any>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [addSuccess, setAddSuccess] = useState(false);
  const [selectedGame, setSelectedGame] = useState<string>("All");
  const [loadingStatusIndex, setLoadingStatusIndex] = useState(0);
  const [disambiguationCandidates, setDisambiguationCandidates] = useState<any[]>([]);
  const [disambiguationCardName, setDisambiguationCardName] = useState("");
  
  // Auto-scan feature — use REF not state for the scanning lock to avoid re-render loops
  const [isAutoScan, setIsAutoScan] = useState(false);
  const [isBulkMode, setIsBulkMode] = useState(false);
  const [bulkQueue, setBulkQueue] = useState<any[]>([]);

  const [autoScanBusy, setAutoScanBusy] = useState(false); // only for UI spinner
  const isAutoScanningRef = useRef(false); // true lock — prevents overlapping scans
  const lastBulkAddRef = useRef<{ id: string; at: number } | null>(null); // bulk dedup window
  const autoScanIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [cameraReady, setCameraReady] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // ─── Camera Management ────────────────────────────────────────────────
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
  }, []);

  // Callback ref: fires the instant the <video> element mounts into the DOM.
  // This avoids the race condition where AnimatePresence mode="wait" delays
  // mounting while the useEffect already fired and found videoRef === null.
  const videoRefCallback = useCallback(
    (video: HTMLVideoElement | null) => {
      // Store in the persistent ref so other code (canvas capture) can use it
      videoRef.current = video;

      if (!video || !streamRef.current) return;

      // Attach the live stream to the freshly-mounted video element
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
    },
    [] // streamRef is a ref — stable across renders, no dependency needed
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
  const captureBestFrame = useCallback(
    (frameCount: number): Promise<CaptureResult> =>
      captureSharpestFrame(videoRef.current, canvasRef.current, { frameCount }),
    []
  );

  // ─── Scan Request ─────────────────────────────────────────────────────
  const processScanRequest = useCallback(async (base64Image: string, isBackground: boolean = false) => {
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
        if (isBackground) {
          console.log("[AutoScan] Background scan failed:", msg);
          return; // silently continue auto-scanning
        }
        throw new Error(msg);
      }
      
      const json = await res.json();

      // Log exactly what the AI OCR read for debugging purposes
      if (json.ocrData) {
        console.log("=========================================");
        console.log("[AI OCR DEBUG] Raw Extractions from Card:");
        console.log(json.ocrData);
        console.log("=========================================");
      }

      // AI is uncertain — show disambiguation grid for user to pick
      if (json.requiresDisambiguation) {
        setDisambiguationCandidates(json.candidates || []);
        setDisambiguationCardName(json.cardName || "");
        // Stop auto-scan loop while user picks
        if (autoScanIntervalRef.current) {
          clearInterval(autoScanIntervalRef.current);
          autoScanIntervalRef.current = null;
        }
        isAutoScanningRef.current = false;
        setState("disambiguation");
        return;
      }

      const card = json.data;
      
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

    } catch (error: any) {
      if (!isBackground) {
        // Just set the error state, no need to print scary red console errors
        setErrorMessage(error.message || "Failed to identify card.");
        setState("error");
      }
    }
  }, [selectedGame, isBulkMode]);

  // ─── Manual Scan ──────────────────────────────────────────────────────
  const captureCard = useCallback(async () => {
    if (!session?.user?.id) return;

    // Multi-frame capture + quality gate. A poor frame (blurry / too dark /
    // overexposed) is rejected HERE with a friendly message, so we never spend
    // an OCR request on an unreadable image.
    const capture = await captureBestFrame(MANUAL_FRAME_COUNT);
    if (!capture.ok) {
      setErrorMessage(capture.message);
      setState("error");
      return;
    }

    setState("processing");
    await processScanRequest(capture.dataUrl, false);
  }, [session, captureBestFrame, processScanRequest]);

  // ─── Auto Scan Loop ───────────────────────────────────────────────────
  useEffect(() => {
    if (state === "scanning" && isAutoScan && cameraReady) {
      console.log("[AutoScan] Starting auto-scan loop...");
      
      autoScanIntervalRef.current = setInterval(async () => {
        // Use ref-based lock (not state) to prevent overlapping scans
        if (isAutoScanningRef.current) return;
        isAutoScanningRef.current = true;
        setAutoScanBusy(true);
        
        // Background scans silently skip poor frames (existing behavior): the
        // loop just tries again on the next tick rather than surfacing an error.
        const capture = await captureBestFrame(AUTO_FRAME_COUNT);
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
  }, [state, isAutoScan, cameraReady, captureBestFrame, processScanRequest]);

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
    setAddSuccess(false);
    setBulkQueue([]);
    setDisambiguationCandidates([]);
    setDisambiguationCardName("");
    startCamera();
  }, [startCamera]);

  // ─── Handle user selecting a specific variant from disambiguation ─────
  const handleSelectCandidate = async (candidate: any) => {
    setIsAdding(true);
    try {
      const res = await fetch("/api/scanner/save-selection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidate }),
      });
      if (!res.ok) throw new Error("Failed to save selection");
      const json = await res.json();
      const card = json.data;

      if (isBulkMode) {
        setBulkQueue((prev) => {
          if (prev.length > 0 && prev[prev.length - 1].id === card.id) return prev;
          return [...prev, card];
        });
        setDisambiguationCandidates([]);
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

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (autoScanIntervalRef.current) clearInterval(autoScanIntervalRef.current);
    };
  }, []);

  // ─── Render ───────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full">
      <canvas ref={canvasRef} className="hidden" />

      {/* Header — hidden while the camera is live so the scan view is immersive
          and the capture controls always fit within the visible viewport. */}
      {state !== "scanning" && (
        <div className="p-4 sm:p-6 border-b border-border flex justify-between items-center">
          <div>
            <h1 className="text-xl sm:text-2xl font-bold flex items-center gap-2">
              <Zap className="h-5 w-5 text-aura-purple" />
              Card Scanner
            </h1>
            <p className="text-sm text-muted-foreground mt-1">AI-powered instant card identification.</p>
          </div>
        </div>
      )}

      <div className="flex-1 p-2 sm:p-6 flex flex-col min-h-0">
        <div className="max-w-2xl w-full mx-auto flex-1 flex flex-col h-full">
          <AnimatePresence mode="wait">
            
            {/* ── IDLE STATE ── */}
            {state === "idle" && (
              <motion.div key="idle" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} className="flex flex-col items-center justify-center py-16">
                <div className="w-32 h-32 rounded-3xl glass flex items-center justify-center mb-6 aura-glow-sm">
                  <Camera className="h-12 w-12 text-aura-purple" />
                </div>
                <h2 className="text-xl font-semibold mb-2">Ready to Scan</h2>
                <div className="flex flex-wrap items-center justify-center gap-2 mb-8 mt-4">
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
                            ? "bg-aura-purple/20 text-aura-purple border-aura-purple/30 font-semibold"
                            : "text-muted-foreground border-border hover:bg-muted"
                        )}
                      >
                        {label}
                      </Button>
                    );
                  })}
                </div>
                <Button onClick={startCamera} className="gradient-bg text-white border-0 h-12 px-8 rounded-xl font-medium text-base w-full max-w-xs shadow-lg shadow-aura-purple/20">
                  <Camera className="h-5 w-5 mr-2" /> Open Camera
                </Button>
              </motion.div>
            )}

            {/* ── SCANNING STATE ── */}
            {state === "scanning" && (
              <motion.div key="scanning" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} className="flex-1 flex flex-col h-full min-h-0">
                <div className="relative rounded-2xl overflow-hidden glass border-border/50 flex-1 flex flex-col h-full min-h-0">
                  
                  {/* Status Indicators */}
                  <div className="absolute top-4 left-4 z-10 flex flex-col gap-2">
                    {isAutoScan && !isBulkMode && (
                      <div className="flex items-center gap-2 bg-black/60 backdrop-blur-sm text-white px-3 py-1.5 rounded-full text-xs font-medium border border-white/10">
                        <div className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" /> Auto-Scan Active
                      </div>
                    )}
                    {isBulkMode && (
                      <div className="flex items-center gap-2 bg-aura-purple/80 backdrop-blur-sm text-white px-3 py-1.5 rounded-full text-xs font-medium shadow-[0_0_15px_rgba(139,92,246,0.5)] border border-white/20">
                        <Layers className="h-3 w-3" /> Bulk Mode ({bulkQueue.length})
                      </div>
                    )}
                  </div>

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
                            className="w-12 h-16 rounded-md overflow-hidden border-2 border-aura-purple shadow-lg bg-black/50"
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={card.thumbnailUrl || card.imageUrl} alt="Card" className="w-full h-full object-cover" />
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
                      <div className={cn(
                        "relative w-[70%] max-w-[280px] aspect-[2.5/3.5] border-2 rounded-xl transition-all duration-1000",
                        isAutoScan ? "border-aura-purple/60 shadow-[0_0_30px_rgba(139,92,246,0.2)]" : "border-aura-purple/60"
                      )}>
                        <div className="absolute -top-0.5 -left-0.5 w-8 h-8 border-t-3 border-l-3 rounded-tl-xl border-aura-purple" />
                        <div className="absolute -top-0.5 -right-0.5 w-8 h-8 border-t-3 border-r-3 rounded-tr-xl border-aura-purple" />
                        <div className="absolute -bottom-0.5 -left-0.5 w-8 h-8 border-b-3 border-l-3 rounded-bl-xl border-aura-purple" />
                        <div className="absolute -bottom-0.5 -right-0.5 w-8 h-8 border-b-3 border-r-3 rounded-br-xl border-aura-purple" />

                        {isAutoScan && (
                          <div className="absolute left-0 right-0 h-1 bg-gradient-to-r from-transparent via-aura-purple to-transparent animate-scan-line opacity-80" />
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="px-4 pt-3 pb-1 bg-background/50 backdrop-blur-md flex items-center justify-center gap-2">
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
                              ? g === "Pokemon" ? "bg-yellow-500/20 text-yellow-400 border-yellow-500/30"
                              : g === "MTG" ? "bg-purple-500/20 text-purple-400 border-purple-500/30"
                              : g === "Yugioh" ? "bg-blue-500/20 text-blue-400 border-blue-500/30"
                              : "bg-white/10 text-white border-white/20"
                              : "text-muted-foreground border-transparent hover:bg-white/5"
                          )}
                        >
                          {label}
                        </Button>
                      );
                    })}
                  </div>

                  {/* Camera Controls */}
                  <div className="p-4 pt-2 flex items-center justify-between gap-4 bg-background/50 backdrop-blur-md">
                    <Button variant="outline" size="icon" onClick={stopCamera} className="rounded-full h-12 w-12 shrink-0 bg-background/80 hover:bg-destructive hover:text-white hover:border-destructive transition-colors">
                      {isBulkMode && bulkQueue.length > 0 ? <Check className="h-5 w-5" /> : <X className="h-5 w-5" />}
                    </Button>
                    
                    <div className="flex bg-background/60 backdrop-blur-md rounded-full p-1 border border-border/50 shadow-inner overflow-hidden">
                      <Button
                        onClick={() => toggleScanMode("manual")}
                        variant="ghost"
                        className={cn("rounded-full h-10 px-4 text-xs font-semibold transition-all", !isAutoScan && !isBulkMode ? "bg-white text-black shadow-sm" : "text-muted-foreground hover:text-foreground")}
                      >
                        Single
                      </Button>
                      <Button
                        onClick={() => toggleScanMode("auto")}
                        variant="ghost"
                        className={cn("rounded-full h-10 px-4 text-xs font-semibold transition-all", isAutoScan && !isBulkMode ? "bg-emerald-500 text-white shadow-sm" : "text-muted-foreground hover:text-foreground")}
                      >
                        Auto
                      </Button>
                      <Button
                        onClick={() => toggleScanMode("bulk")}
                        variant="ghost"
                        className={cn("rounded-full h-10 px-4 text-xs font-semibold transition-all", isBulkMode ? "bg-aura-purple text-white shadow-sm" : "text-muted-foreground hover:text-foreground")}
                      >
                        Bulk
                      </Button>
                    </div>

                    {!isAutoScan ? (
                      <Button onClick={captureCard} disabled={!cameraReady} className="h-12 w-12 rounded-full gradient-bg text-white border-0 shadow-lg shrink-0 disabled:opacity-40">
                        <Camera className="h-5 w-5" />
                      </Button>
                    ) : (
                      <div className="h-12 w-12 flex items-center justify-center shrink-0">
                        {autoScanBusy && <RefreshCw className="h-5 w-5 text-emerald-400 animate-spin" />}
                      </div>
                    )}
                  </div>
                </div>
                
                {isBulkMode && (
                  <div className="mt-4 text-center">
                    <Button 
                      onClick={stopCamera} 
                      className="w-full sm:w-auto min-w-[200px] h-12 rounded-xl gradient-bg border-0 text-white shadow-lg shadow-aura-purple/20"
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
                {/* Holographic Card Scanner Mockup */}
                <div className="relative w-36 h-52 rounded-2xl border border-white/20 bg-gradient-to-br from-aura-purple/20 via-pink-500/10 to-blue-500/20 backdrop-blur-md shadow-[0_0_40px_rgba(139,92,246,0.25)] flex flex-col items-center justify-center overflow-hidden mb-8 group">
                  {/* Glowing background meshes */}
                  <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_120%,rgba(139,92,246,0.4),transparent)] animate-pulse" />
                  <div className="absolute top-4 w-28 h-32 rounded-lg border border-white/10 bg-black/40 flex items-center justify-center overflow-hidden">
                    <Sparkles className="h-10 w-10 text-aura-purple animate-pulse" />
                    {/* Tiny floating particle elements */}
                    <div className="absolute inset-0 bg-gradient-to-t from-aura-purple/10 to-transparent" />
                  </div>
                  
                  {/* Futuristic Scanning Laser Bar */}
                  <div className="absolute left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-aura-purple to-transparent animate-scan-line shadow-[0_0_12px_#8b5cf6]" />
                  
                  {/* Decorative card elements */}
                  <div className="w-20 h-1.5 bg-white/10 rounded-full mt-3" />
                  <div className="w-12 h-1 bg-white/5 rounded-full mt-1.5" />
                </div>

                <div className="space-y-2 text-center">
                  <h2 className="text-xl font-bold tracking-tight text-foreground flex items-center justify-center gap-2">
                    <Loader2 className="h-5 w-5 animate-spin text-aura-purple" />
                    Analyzing Card
                  </h2>
                  <AnimatePresence mode="wait">
                    <motion.p
                      key={loadingStatusIndex}
                      initial={{ opacity: 0, y: 5 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -5 }}
                      transition={{ duration: 0.2 }}
                      className="text-sm font-medium text-aura-purple/90 min-h-[20px]"
                    >
                      {LOADING_STATUSES[loadingStatusIndex]}
                    </motion.p>
                  </AnimatePresence>
                  <p className="text-xs text-muted-foreground pt-1">
                    Identifying details and pulling live market pricing.
                  </p>
                </div>
              </motion.div>
            )}

            {/* ── ERROR STATE ── */}
            {state === "error" && (
              <motion.div key="error" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} className="flex flex-col items-center justify-center py-16">
                <div className="w-24 h-24 rounded-2xl bg-red-500/10 flex items-center justify-center mb-8 border border-red-500/20">
                  <AlertCircle className="h-10 w-10 text-red-500" />
                </div>
                <h2 className="text-lg font-semibold mb-2">Scan Failed</h2>
                <p className="text-sm text-muted-foreground mb-6 max-w-xs text-center">{errorMessage}</p>
                <Button variant="outline" className="h-11 px-8 rounded-xl font-medium" onClick={resetScan}>
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
                <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-start gap-3">
                  <div className="shrink-0 mt-0.5">
                    <Scan className="h-4 w-4 text-amber-400" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-amber-400">Which printing is this?</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      The AI identified &ldquo;<span className="font-medium text-foreground">{disambiguationCardName}</span>&rdquo; but couldn&apos;t determine the exact set. Tap the correct version below.
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
                        "group relative rounded-xl overflow-hidden border bg-background/50 text-left transition-all duration-200",
                        "hover:border-aura-purple/60 hover:shadow-lg hover:shadow-aura-purple/10 hover:scale-[1.02]",
                        "focus:outline-none focus:ring-2 focus:ring-aura-purple/50",
                        candidate.isBestMatch
                          ? "border-aura-purple ring-2 ring-aura-purple/50 shadow-lg shadow-aura-purple/20"
                          : "border-border/50",
                        isAdding && "opacity-50 cursor-not-allowed"
                      )}
                    >
                      {/* Best-match badge — vision's top pick */}
                      {candidate.isBestMatch && (
                        <div className="absolute top-1.5 left-1.5 z-10 flex items-center gap-1 rounded-full bg-aura-purple px-2 py-0.5 shadow-lg">
                          <Sparkles className="h-3 w-3 text-white" />
                          <span className="text-[10px] font-semibold text-white">Best match</span>
                        </div>
                      )}
                      {/* Card Image */}
                      <div className="aspect-[2.5/3.5] w-full bg-black/30 overflow-hidden">
                        {candidate.thumbnailUrl || candidate.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={candidate.thumbnailUrl || candidate.imageUrl}
                            alt={candidate.setName}
                            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center">
                            <Sparkles className="h-8 w-8 text-aura-purple/30" />
                          </div>
                        )}
                        {/* Hover overlay */}
                        <div className="absolute inset-0 bg-aura-purple/0 group-hover:bg-aura-purple/10 transition-colors duration-200 flex items-center justify-center">
                          <div className="opacity-0 group-hover:opacity-100 transition-opacity bg-aura-purple rounded-full p-2 shadow-lg">
                            <Check className="h-4 w-4 text-white" />
                          </div>
                        </div>
                      </div>

                      {/* Card Info */}
                      <div className="p-2">
                        <p className="text-[11px] font-semibold leading-tight line-clamp-2 text-foreground">{candidate.setName}</p>
                        {(candidate.setCode || candidate.collectorNumber) && (
                          <p className="text-[10px] font-medium text-muted-foreground mt-0.5 truncate">
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
                          <span className="text-[11px] font-bold text-aura-purple shrink-0">
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
                  className="w-full h-11 rounded-xl"
                  onClick={resetScan}
                  disabled={isAdding}
                >
                  <RotateCcw className="h-4 w-4 mr-2" /> None of these — Scan Again
                </Button>
              </motion.div>
            )}

            {/* ── RESULT STATE (Single Card) ── */}
            {state === "result" && scanResult && !isBulkMode && (
              <motion.div key="result" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="space-y-4">
                <div className="flex items-center gap-2 p-3 rounded-xl bg-emerald-400/10 border border-emerald-400/20">
                  <Check className="h-4 w-4 text-emerald-400" />
                  <span className="text-sm font-medium text-emerald-400">Card identified successfully by AI</span>
                </div>

                <Card className="glass border-border/50 overflow-hidden relative">
                  {(scanResult.rarity === "SECRET_RARE" || scanResult.rarity === "MYTHIC") && (
                    <div className="absolute top-0 right-0 w-32 h-32 bg-yellow-400/20 rounded-full blur-[50px] -z-10" />
                  )}
                  <div className="h-1 gradient-bg" />
                  <CardContent className="p-6">
                    <div className="flex items-start gap-4">
                      {scanResult.imageUrl && (
                        <div className="w-24 sm:w-32 shrink-0 rounded-lg overflow-hidden border border-border/50 shadow-md">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={scanResult.imageUrl} alt={scanResult.name} className="w-full h-auto object-cover" />
                        </div>
                      )}
                      
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between mb-2">
                          <div>
                            <h3 className="text-lg sm:text-xl font-bold truncate">{scanResult.name}</h3>
                            <p className="text-sm text-muted-foreground truncate">{scanResult.set}</p>
                          </div>
                        </div>
                        
                        <div className="flex flex-wrap gap-2 mb-4">
                          <Badge variant="secondary" className="bg-background/50">{scanResult.game}</Badge>
                          {scanResult.rarity && <Badge variant="outline" className="border-aura-purple/30 text-aura-purple">{scanResult.rarity}</Badge>}
                        </div>

                        <div className="grid grid-cols-2 gap-3 mt-4">
                          <div className="p-3 rounded-xl bg-background/50 border border-border/50">
                            <p className="text-xs text-muted-foreground mb-1">Market Price</p>
                            <p className="text-lg font-bold text-aura-purple">${scanResult.prices?.marketPrice?.toFixed(2) || "0.00"}</p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <div className="flex gap-3">
                  <Button variant="outline" className="flex-1 h-12 rounded-xl" onClick={resetScan}>
                    <RotateCcw className="h-4 w-4 mr-2" /> Scan Next
                  </Button>
                  <Button className="flex-1 h-12 rounded-xl gradient-bg text-white border-0" onClick={handleAddToCollection} disabled={isAdding || addSuccess}>
                    {addSuccess ? (
                      <><Check className="h-4 w-4 mr-2" /> Added</>
                    ) : isAdding ? (
                      <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Adding...</>
                    ) : (
                      <><Sparkles className="h-4 w-4 mr-2" /> Add to Collection</>
                    )}
                  </Button>
                </div>
              </motion.div>
            )}

            {/* ── BULK REVIEW STATE ── */}
            {state === "bulk-review" && (
              <motion.div key="bulk-review" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="space-y-4">
                <div className="flex items-center justify-between p-4 rounded-xl glass border border-border/50">
                  <div>
                    <h3 className="font-bold text-lg flex items-center gap-2">
                      <Layers className="h-5 w-5 text-aura-purple" /> Bulk Scan Complete
                    </h3>
                    <p className="text-sm text-muted-foreground">{bulkQueue.length} cards identified</p>
                  </div>
                  <Button variant="outline" size="sm" onClick={resetScan}>
                    <RotateCcw className="h-4 w-4 mr-2" /> Discard All
                  </Button>
                </div>

                <div className="space-y-3 max-h-[50vh] overflow-y-auto pr-2 custom-scrollbar">
                  {bulkQueue.map((card, i) => (
                    <Card key={`${card.id}-${i}`} className="glass border-border/50 overflow-hidden">
                      <CardContent className="p-3 flex items-center gap-4">
                        {(card.thumbnailUrl || card.imageUrl) ? (
                          <div className="w-12 h-16 shrink-0 rounded border border-border/50 overflow-hidden">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={card.thumbnailUrl || card.imageUrl} alt={card.name} className="w-full h-full object-cover" />
                          </div>
                        ) : (
                          <div className="w-12 h-16 shrink-0 rounded border border-border/50 bg-black/20 flex items-center justify-center">
                            <Sparkles className="h-4 w-4 text-aura-purple/50" />
                          </div>
                        )}
                        
                        <div className="flex-1 min-w-0">
                          <h4 className="font-bold text-sm truncate">{card.name}</h4>
                          <p className="text-xs text-muted-foreground truncate">{card.set} • {card.game}</p>
                          <p className="text-xs font-semibold text-aura-purple mt-1">${card.prices?.marketPrice?.toFixed(2) || "0.00"}</p>
                        </div>

                        <Button variant="ghost" size="icon" onClick={() => removeFromBulkQueue(i)} className="shrink-0 text-muted-foreground hover:text-red-400 hover:bg-red-400/10">
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </CardContent>
                    </Card>
                  ))}
                </div>

                <div className="pt-4 border-t border-border/50">
                  <Button 
                    className="w-full h-12 rounded-xl gradient-bg text-white border-0 shadow-lg shadow-aura-purple/20" 
                    onClick={handleAddBulkToCollection} 
                    disabled={isAdding || addSuccess || bulkQueue.length === 0}
                  >
                    {addSuccess ? (
                      <><CheckCircle2 className="h-5 w-5 mr-2" /> Successfully Added</>
                    ) : isAdding ? (
                      <><Loader2 className="h-5 w-5 mr-2 animate-spin" /> Adding {bulkQueue.length} Cards...</>
                    ) : (
                      <><Sparkles className="h-5 w-5 mr-2" /> Add All {bulkQueue.length} to Collection</>
                    )}
                  </Button>
                  
                  {addSuccess && (
                    <Button variant="outline" className="w-full h-12 rounded-xl mt-3" onClick={resetScan}>
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
