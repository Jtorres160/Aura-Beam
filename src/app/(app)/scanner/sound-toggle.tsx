"use client";

import { Volume2, VolumeX } from "lucide-react";

import { primeScanAudio } from "@/lib/audio/scan-chime";
import { cn } from "@/lib/utils";
import type { ScanSound } from "@/lib/ui/scan-sound";

/**
 * Mute control for the success chime.
 *
 * Doubles as an audio-unlock gesture: tapping it is a real user gesture, so a
 * collector who turns sound ON mid-session has primed the AudioContext by the
 * very act of turning it on, and doesn't have to reopen the camera to hear
 * anything.
 *
 * `overlay` styles it for the dark live-camera view, where it sits alongside
 * the restart button; the default styling is for the paper/ink page chrome.
 */
export function SoundToggle({
  sound,
  onChange,
  overlay = false,
  className,
}: {
  sound: ScanSound;
  onChange: (next: ScanSound) => void;
  overlay?: boolean;
  className?: string;
}) {
  const on = sound === "on";
  const Icon = on ? Volume2 : VolumeX;

  return (
    <button
      type="button"
      onClick={() => {
        if (!on) primeScanAudio();
        onChange(on ? "off" : "on");
      }}
      aria-pressed={on}
      title={on ? "Mute scan sound" : "Unmute scan sound"}
      aria-label={on ? "Mute scan sound" : "Unmute scan sound"}
      className={cn(
        "inline-flex h-9 w-9 items-center justify-center rounded-full border transition-colors",
        overlay
          ? "border-white/10 bg-black/60 text-white backdrop-blur-sm hover:bg-white/20"
          : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
        className,
      )}
    >
      <Icon className={cn("h-4 w-4", on && !overlay && "text-brass")} />
    </button>
  );
}
