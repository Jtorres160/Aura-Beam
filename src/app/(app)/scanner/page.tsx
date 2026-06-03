"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useSession } from "next-auth/react";
import Tesseract from "tesseract.js";
import {
  Camera, X, RotateCcw, Zap, Check, AlertCircle,
  TrendingUp, TrendingDown, ArrowUpRight, Sparkles, Loader2
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

type ScanState = "idle" | "scanning" | "processing" | "result" | "error";

export default function ScannerPage() {
  const { data: session } = useSession();
  const [state, setState] = useState<ScanState>("idle");
  const [processingProgress, setProcessingProgress] = useState(0);
  const [scanResult, setScanResult] = useState<any>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [addSuccess, setAddSuccess] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const startCamera = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        streamRef.current = stream;
      }
      setState("scanning");
    } catch {
      alert("Camera access is required to scan cards. Please allow camera permissions.");
    }
  }, []);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setState("idle");
  }, []);

  const captureCard = useCallback(async () => {
    if (!videoRef.current || !canvasRef.current || !session?.user?.id || !(session as any).accessToken) return;

    setState("processing");
    setProcessingProgress(20);

    // Draw the current video frame to the hidden canvas
    const canvas = canvasRef.current;
    const video = videoRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    
    // Extract base64 image (JPEG, 0.8 quality to save bandwidth)
    const base64Image = canvas.toDataURL("image/jpeg", 0.8);
    setProcessingProgress(40);

    try {
      // Run local OCR
      const { data: { text } } = await Tesseract.recognize(base64Image, 'eng', {
        logger: m => {
          if (m.status === "recognizing text") {
            setProcessingProgress(40 + Math.floor(m.progress * 30));
          }
        }
      });
      
      if (!text || text.trim() === '') {
        throw new Error("Could not read any text from the card. Please try again with better lighting.");
      }

      setProcessingProgress(80);
      
      const res = await fetch("http://localhost:4000/scanner/scan", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${(session as any).accessToken}`,
        },
        body: JSON.stringify({
          image: base64Image,
          text: text,
        }),
      });

      if (!res.ok) throw new Error("Failed to identify card on the backend.");
      
      const json = await res.json();
      setProcessingProgress(100);
      
      setScanResult(json.data);
      setTimeout(() => setState("result"), 500);

    } catch (error: any) {
      console.error(error);
      setErrorMessage(error.message || "Failed to identify card.");
      setState("error");
    }
  }, [session]);

  const resetScan = useCallback(() => {
    setScanResult(null);
    setErrorMessage("");
    setProcessingProgress(0);
    setAddSuccess(false);
    startCamera();
  }, [startCamera]);

  const handleAddToCollection = async () => {
    if (!session?.user?.id || !(session as any).accessToken || !scanResult?.id) return;
    
    setIsAdding(true);
    try {
      const res = await fetch(`http://localhost:4000/collections/add`, {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          Authorization: `Bearer ${(session as any).accessToken}`,
        },
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

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <div className="flex flex-col h-full">
      {/* Hidden canvas for image capture */}
      <canvas ref={canvasRef} className="hidden" />

      {/* Header */}
      <div className="p-4 sm:p-6 border-b border-border">
        <h1 className="text-xl sm:text-2xl font-bold flex items-center gap-2">
          <Zap className="h-5 w-5 text-aura-purple" />
          Card Scanner
        </h1>
        <p className="text-sm text-muted-foreground mt-1">Point your camera at any trading card to identify it instantly.</p>
      </div>

      <div className="flex-1 p-4 sm:p-6 overflow-y-auto">
        <div className="max-w-2xl mx-auto space-y-6">
          <AnimatePresence mode="wait">
            {/* IDLE STATE */}
            {state === "idle" && (
              <motion.div
                key="idle"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="flex flex-col items-center justify-center py-16"
              >
                <div className="w-32 h-32 rounded-3xl glass flex items-center justify-center mb-8 aura-glow-sm">
                  <Camera className="h-12 w-12 text-aura-purple" />
                </div>
                <h2 className="text-xl font-semibold mb-2">Ready to Scan</h2>
                <p className="text-sm text-muted-foreground text-center max-w-xs mb-8">
                  Open your camera and point it at a Pokémon, Magic, or Yu-Gi-Oh! card.
                </p>
                <Button onClick={startCamera} className="gradient-bg text-white border-0 h-12 px-8 rounded-xl font-medium text-base">
                  <Camera className="h-5 w-5 mr-2" />
                  Open Camera
                </Button>
              </motion.div>
            )}

            {/* SCANNING STATE */}
            {state === "scanning" && (
              <motion.div
                key="scanning"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
              >
                <div className="relative rounded-2xl overflow-hidden glass border-border/50">
                  {/* Video preview */}
                  <div className="aspect-[3/4] sm:aspect-[4/3] bg-black relative">
                    <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />

                    {/* Scanner overlay */}
                    <div className="absolute inset-0 flex items-center justify-center">
                      <div className="relative w-[70%] max-w-[280px] aspect-[2.5/3.5] border-2 border-aura-purple/60 rounded-xl">
                        <div className="absolute -top-0.5 -left-0.5 w-8 h-8 border-t-3 border-l-3 border-aura-purple rounded-tl-xl" />
                        <div className="absolute -top-0.5 -right-0.5 w-8 h-8 border-t-3 border-r-3 border-aura-purple rounded-tr-xl" />
                        <div className="absolute -bottom-0.5 -left-0.5 w-8 h-8 border-b-3 border-l-3 border-aura-purple rounded-bl-xl" />
                        <div className="absolute -bottom-0.5 -right-0.5 w-8 h-8 border-b-3 border-r-3 border-aura-purple rounded-br-xl" />
                        <div className="absolute left-4 right-4 h-0.5 bg-gradient-to-r from-transparent via-aura-purple to-transparent animate-scan-line opacity-60" />
                      </div>
                    </div>
                  </div>

                  {/* Controls */}
                  <div className="p-4 flex items-center justify-center gap-4">
                    <Button variant="outline" size="icon" onClick={stopCamera} className="rounded-full h-12 w-12">
                      <X className="h-5 w-5" />
                    </Button>
                    <Button
                      onClick={captureCard}
                      className="h-16 w-16 rounded-full gradient-bg text-white border-0 shadow-lg animate-pulse-glow"
                    >
                      <Camera className="h-7 w-7" />
                    </Button>
                    <Button variant="outline" size="icon" className="rounded-full h-12 w-12" onClick={startCamera}>
                      <RotateCcw className="h-5 w-5" />
                    </Button>
                  </div>
                </div>
              </motion.div>
            )}

            {/* PROCESSING STATE */}
            {state === "processing" && (
              <motion.div
                key="processing"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="flex flex-col items-center justify-center py-16"
              >
                <div className="w-24 h-24 rounded-2xl glass flex items-center justify-center mb-8 animate-pulse-glow">
                  <Sparkles className="h-10 w-10 text-aura-purple animate-spin" style={{ animationDuration: "3s" }} />
                </div>
                <h2 className="text-lg font-semibold mb-2">Identifying card...</h2>
                <p className="text-sm text-muted-foreground mb-6">
                  {processingProgress < 30 ? "Extracting frame..." :
                   processingProgress < 75 ? "Running local OCR..." :
                   processingProgress < 90 ? "Querying global database..." :
                   "Matching card..."}
                </p>
                <div className="w-64">
                  <Progress value={processingProgress} className="h-2 bg-accent [&>div]:gradient-bg" />
                </div>
              </motion.div>
            )}

            {/* ERROR STATE */}
            {state === "error" && (
              <motion.div
                key="error"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="flex flex-col items-center justify-center py-16"
              >
                <div className="w-24 h-24 rounded-2xl bg-red-500/10 flex items-center justify-center mb-8 border border-red-500/20">
                  <AlertCircle className="h-10 w-10 text-red-500" />
                </div>
                <h2 className="text-lg font-semibold mb-2">Scan Failed</h2>
                <p className="text-sm text-muted-foreground mb-6 max-w-xs text-center">
                  {errorMessage}
                </p>
                <Button variant="outline" className="h-11 px-8 rounded-xl font-medium" onClick={resetScan}>
                  <RotateCcw className="h-4 w-4 mr-2" />
                  Try Again
                </Button>
              </motion.div>
            )}

            {/* RESULT STATE */}
            {state === "result" && scanResult && (
              <motion.div
                key="result"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="space-y-4"
              >
                {/* Confidence banner */}
                <div className="flex items-center gap-2 p-3 rounded-xl bg-emerald-400/10 border border-emerald-400/20">
                  <Check className="h-4 w-4 text-emerald-400" />
                  <span className="text-sm font-medium text-emerald-400">
                    Card identified with {scanResult.confidence}% confidence
                  </span>
                </div>

                {/* Card result */}
                <Card className="glass border-border/50 overflow-hidden relative">
                  {/* Visual flourish for mythic/rare cards */}
                  {(scanResult.rarity === "SECRET_RARE" || scanResult.rarity === "MYTHIC") && (
                    <div className="absolute top-0 right-0 w-32 h-32 bg-yellow-400/20 rounded-full blur-[50px] -z-10" />
                  )}

                  <div className="h-1 gradient-bg" />
                  <CardContent className="p-6">
                    <div className="flex items-start gap-4">
                      {/* Thumbnail if available */}
                      {scanResult.thumbnailUrl && (
                        <div className="w-20 sm:w-24 shrink-0 rounded-lg overflow-hidden border border-border/50">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={scanResult.thumbnailUrl} alt={scanResult.name} className="w-full object-contain" />
                        </div>
                      )}
                      
                      <div className="flex-1">
                        <div className="flex items-start justify-between mb-2">
                          <div>
                            <h2 className="text-xl font-bold leading-tight">{scanResult.name}</h2>
                            <p className="text-sm text-muted-foreground mt-0.5">
                              {scanResult.setName} {scanResult.collectorNumber && `· ${scanResult.collectorNumber}`}
                            </p>
                          </div>
                          <Badge className="gradient-bg text-white border-0 ml-2 shrink-0">{scanResult.game}</Badge>
                        </div>
                        
                        <div className="flex flex-wrap gap-2 mt-3">
                          {scanResult.types?.split(',').map((t: string) => (
                            <Badge key={t} variant="secondary" className="text-xs bg-accent/50">{t}</Badge>
                          ))}
                          <Badge variant="outline" className="text-xs text-aura-purple border-aura-purple/30">{scanResult.rarity?.replace('_', ' ')}</Badge>
                        </div>
                      </div>
                    </div>

                    <div className="my-5 border-t border-border/50" />

                    {/* Price grid */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
                      {[
                        { label: "Market", value: scanResult.prices?.marketPrice },
                        { label: "Low", value: scanResult.prices?.lowPrice },
                        { label: "Mid", value: scanResult.prices?.midPrice },
                        { label: "High", value: scanResult.prices?.highPrice },
                      ].map((p) => (
                        <div key={p.label} className="p-3 rounded-xl bg-accent/50">
                          <p className="text-xs text-muted-foreground mb-1">{p.label}</p>
                          <p className="text-lg font-bold">${(p.value || 0).toFixed(2)}</p>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>

                {/* Actions */}
                <div className="flex gap-3">
                  <Button 
                    className={cn(
                      "flex-1 border-0 h-11 rounded-xl font-medium shadow-lg transition-all",
                      addSuccess 
                        ? "bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20" 
                        : "gradient-bg text-white shadow-aura-purple/20"
                    )}
                    onClick={handleAddToCollection}
                    disabled={isAdding || addSuccess}
                  >
                    {isAdding ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                    {addSuccess ? <Check className="h-4 w-4 mr-2" /> : null}
                    {addSuccess ? "Added to Collection!" : "Add to Collection"}
                  </Button>
                  <Button variant="outline" className="flex-1 h-11 rounded-xl font-medium bg-card/50" onClick={resetScan}>
                    Scan Another
                  </Button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
