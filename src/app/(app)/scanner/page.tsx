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

type ScanState = "idle" | "scanning" | "processing" | "result" | "bulk-review" | "error";

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
  
  // Auto-scan feature — use REF not state for the scanning lock to avoid re-render loops
  const [isAutoScan, setIsAutoScan] = useState(false);
  const [isBulkMode, setIsBulkMode] = useState(false);
  const [bulkQueue, setBulkQueue] = useState<any[]>([]);

  const [autoScanBusy, setAutoScanBusy] = useState(false); // only for UI spinner
  const isAutoScanningRef = useRef(false); // true lock — prevents overlapping scans
  const autoScanIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // ─── Camera Management ────────────────────────────────────────────────
  const startCamera = useCallback(async () => {
    try {
      // Stop any existing stream first
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
      
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { 
          facingMode: { ideal: "environment" }, 
          width: { ideal: 1280 }, 
          height: { ideal: 720 } 
        },
      });
      streamRef.current = mediaStream;
      setStream(mediaStream);
      setCameraReady(false);
      setState("scanning");
    } catch (err) {
      console.error("Camera error:", err);
      alert("Camera access is required to scan cards. Please allow camera permissions.");
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
    setStream(null);
    
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

  // ─── Image Capture ────────────────────────────────────────────────────
  const getCompressedImageBase64 = useCallback(() => {
    if (!videoRef.current || !canvasRef.current) return null;
    const canvas = canvasRef.current;
    const video = videoRef.current;
    
    const width = video.videoWidth;
    const height = video.videoHeight;
    
    // Video not loaded yet or camera not producing frames
    if (!width || !height || width < 10 || height < 10) {
      console.warn("[Scanner] Video not ready yet:", width, "x", height);
      return null;
    }

    // Scale down to 1024px max to ensure text is highly legible for AI OCR
    const maxDim = 1024;
    let w = width;
    let h = height;
    if (w > maxDim || h > maxDim) {
      if (w > h) {
        h = Math.round((h * maxDim) / w);
        w = maxDim;
      } else {
        w = Math.round((w * maxDim) / h);
        h = maxDim;
      }
    }

    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    
    ctx.drawImage(video, 0, 0, w, h);
    
    // Quick brightness check — skip pure black frames (camera not ready)
    const sample = ctx.getImageData(Math.floor(w / 2), Math.floor(h / 2), 20, 20);
    let totalBrightness = 0;
    for (let i = 0; i < sample.data.length; i += 4) {
      totalBrightness += sample.data[i] + sample.data[i + 1] + sample.data[i + 2];
    }
    const avgBrightness = totalBrightness / (sample.data.length / 4) / 3;
    if (avgBrightness < 5) {
      console.warn("[Scanner] Frame too dark (brightness:", avgBrightness.toFixed(1), ") — skipping");
      return null;
    }

    return canvas.toDataURL("image/jpeg", 0.85);
  }, []);

  // ─── Scan Request ─────────────────────────────────────────────────────
  const processScanRequest = useCallback(async (base64Image: string, isBackground: boolean = false) => {
    try {
      const res = await fetch(`/api/scanner/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image: base64Image,
          game: selectedGame === "All" ? undefined : selectedGame,
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
      const card = json.data;
      
      if (isBulkMode) {
        // Bulk Mode logic: Add to queue, do not stop camera
        setBulkQueue((prev) => {
          // Debounce: don't add the exact same card twice in a row
          if (prev.length > 0 && prev[prev.length - 1].id === card.id) {
            console.log("[BulkScan] Ignored duplicate consecutive card:", card.name);
            return prev;
          }
          console.log("[BulkScan] Added to queue:", card.name);
          return [...prev, card];
        });
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
        console.error("[Scanner] Error:", error);
        setErrorMessage(error.message || "Failed to identify card.");
        setState("error");
      }
    }
  }, [selectedGame, isBulkMode]);

  // ─── Manual Scan ──────────────────────────────────────────────────────
  const captureCard = useCallback(async () => {
    if (!session?.user?.id) return;
    
    const base64Image = getCompressedImageBase64();
    if (!base64Image) {
      setErrorMessage("Camera is not ready. Please wait a moment and try again.");
      setState("error");
      return;
    }
    
    setState("processing");
    await processScanRequest(base64Image, false);
  }, [session, getCompressedImageBase64, processScanRequest]);

  // ─── Auto Scan Loop ───────────────────────────────────────────────────
  useEffect(() => {
    if (state === "scanning" && isAutoScan && cameraReady) {
      console.log("[AutoScan] Starting auto-scan loop...");
      
      autoScanIntervalRef.current = setInterval(async () => {
        // Use ref-based lock (not state) to prevent overlapping scans
        if (isAutoScanningRef.current) return;
        isAutoScanningRef.current = true;
        setAutoScanBusy(true);
        
        const base64Image = getCompressedImageBase64();
        if (base64Image) {
          await processScanRequest(base64Image, true);
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
  }, [state, isAutoScan, cameraReady, getCompressedImageBase64, processScanRequest]);

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
    startCamera();
  }, [startCamera]);

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

      {/* Header */}
      <div className="p-4 sm:p-6 border-b border-border flex justify-between items-center">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold flex items-center gap-2">
            <Zap className="h-5 w-5 text-aura-purple" />
            Card Scanner
          </h1>
          <p className="text-sm text-muted-foreground mt-1">AI-powered instant card identification.</p>
        </div>
      </div>

      <div className="flex-1 p-4 sm:p-6 overflow-y-auto">
        <div className="max-w-2xl mx-auto space-y-6">
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
              <motion.div key="scanning" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }}>
                <div className="relative rounded-2xl overflow-hidden glass border-border/50">
                  
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

                  <div className="aspect-[3/4] sm:aspect-[4/3] bg-black relative">
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
                        isAutoScan ? "border-emerald-400/60 shadow-[0_0_30px_rgba(52,211,153,0.2)]" : "border-aura-purple/60"
                      )}>
                        <div className={cn("absolute -top-0.5 -left-0.5 w-8 h-8 border-t-3 border-l-3 rounded-tl-xl", isAutoScan ? "border-emerald-400" : "border-aura-purple")} />
                        <div className={cn("absolute -top-0.5 -right-0.5 w-8 h-8 border-t-3 border-r-3 rounded-tr-xl", isAutoScan ? "border-emerald-400" : "border-aura-purple")} />
                        <div className={cn("absolute -bottom-0.5 -left-0.5 w-8 h-8 border-b-3 border-l-3 rounded-bl-xl", isAutoScan ? "border-emerald-400" : "border-aura-purple")} />
                        <div className={cn("absolute -bottom-0.5 -right-0.5 w-8 h-8 border-b-3 border-r-3 rounded-br-xl", isAutoScan ? "border-emerald-400" : "border-aura-purple")} />
                        
                        {isAutoScan && (
                          <div className="absolute left-0 right-0 h-1 bg-gradient-to-r from-transparent via-emerald-400 to-transparent animate-scan-line opacity-80" />
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
