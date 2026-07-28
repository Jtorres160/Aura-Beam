import { useCallback, useEffect, useState } from "react";

import { setScanSoundEnabled } from "@/lib/audio/scan-chime";
import {
  readScanSound,
  writeScanSound,
  SCAN_SOUND_DEFAULT,
  type ScanSound,
} from "@/lib/ui/scan-sound";

/**
 * Success-chime preference, persisted across visits.
 *
 * Hydration note, same as useCardView: the stored value is read in an effect
 * rather than a lazy initializer because this tree is server-rendered, where
 * there is no localStorage. Seeding from storage during the first client render
 * would make client and server markup disagree and React would discard the
 * tree. First paint is always the default; a stored preference applies
 * immediately after mount.
 *
 * The effect also mirrors the value into the audio engine, which keeps its own
 * module-level flag so the scan callback can't fire a chime through a stale
 * closure mid-bulk-run.
 */
export function useScanSound(): [ScanSound, (next: ScanSound) => void] {
  const [sound, setSoundState] = useState<ScanSound>(SCAN_SOUND_DEFAULT);

  useEffect(() => {
    const stored = readScanSound(
      typeof window === "undefined" ? null : window.localStorage,
    );
    const effective = stored ?? SCAN_SOUND_DEFAULT;
    setSoundState(effective);
    setScanSoundEnabled(effective === "on");
  }, []);

  const setSound = useCallback((next: ScanSound) => {
    setSoundState(next);
    setScanSoundEnabled(next === "on");
    writeScanSound(
      typeof window === "undefined" ? null : window.localStorage,
      next,
    );
  }, []);

  return [sound, setSound];
}

export type { ScanSound };
