// ─── Smart Auto-Capture (Phase 4.5 · Commit 4) ───────────────────────────────
// A small, synchronous state machine that decides WHEN to auto-capture, driven
// by the shared evaluateReadiness() policy. It replaces the old fixed 4s timer:
// instead of firing on a clock, it fires when the frame has been "ready"
// (sharp / bright / low-glare / still — per evaluateReadiness) for a brief
// dwell, and it refuses to re-capture a card that's still sitting in frame.
//
// State flow (deliberately simple):
//     scanning → candidate → capturing → cooldown → scanning
//
// Duplicate prevention is an 8×8 average-hash (aHash) checked at the
// candidate→capturing edge: if the stable frame hashes ~identical to the last
// captured one, it's the SAME card still there — skip it, spend no OCR call.
// (This aHash approach is intentionally aligned with future Phase 7 artwork
// hashing.)
//
// This module owns NO readiness logic and NO capture/OCR — the React loop does
// the async capture and reports back via settle(). Manual capture never touches
// any of this.

// ─── Tunables (named + one place) ─────────────────────────────────────────

/** "Ready" must hold continuously this long before we capture — the
 *  "remained stable briefly" requirement. */
export const STABILITY_DWELL_MS = 500;

/** Quiet period after a capture settles before the machine re-arms. Prevents
 *  double-fires and gives the result/queue UI a beat. */
export const COOLDOWN_MS = 1200;

/** Max Hamming distance (of 64 bits) at which two frames are considered the
 *  same card still in frame. Higher = more aggressive dedup. */
export const DUP_HAMMING_MAX = 6;

/** Side length of the average-hash grid (8×8 = 64-bit hash). */
export const AHASH_DIM = 8;

/** Machine tick rate — a hair above the ~10Hz metrics loop. Ticks are cheap
 *  (state checks); dwell/cooldown are wall-clock, so the exact rate is
 *  correctness-irrelevant. */
export const SMART_TICK_MS = 66;

/** Samples older than this are ignored (camera warming up / loop paused). */
export const SMART_STALE_MS = 500;

// ─── Average hash (aHash) ─────────────────────────────────────────────────

/** A 64-bit average hash held as two unsigned 32-bit halves (avoids BigInt so
 *  it type-checks on the project's ES2017 target, and is faster anyway). */
export interface AHash {
  hi: number;
  lo: number;
}

/**
 * 64-bit average hash of the current video frame, using a caller-owned 8×8
 * canvas (reused across calls). Only invoked at a capture decision, so its tiny
 * per-call allocation is inconsequential. Returns null if the frame isn't ready.
 */
export function computeAverageHash(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement
): AHash | null {
  if (!video.videoWidth || !video.videoHeight) return null;
  const S = AHASH_DIM;
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, S, S);
  const { data } = ctx.getImageData(0, 0, S, S);

  const n = S * S; // 64
  const gray = new Float32Array(n);
  let sum = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    gray[p] = luma;
    sum += luma;
  }
  const mean = sum / n;

  // First 32 bits → hi, last 32 → lo.
  let hi = 0;
  let lo = 0;
  for (let p = 0; p < n; p++) {
    const bit = gray[p] >= mean ? 1 : 0;
    if (p < 32) hi = (hi << 1) | bit;
    else lo = (lo << 1) | bit;
  }
  return { hi: hi >>> 0, lo: lo >>> 0 };
}

/** Number of set bits in a 32-bit int (SWAR popcount). */
function popcount32(v: number): number {
  let n = v - ((v >>> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** Hamming distance (0–64) between two average hashes. */
export function hammingDistance(a: AHash, b: AHash): number {
  return popcount32((a.hi ^ b.hi) >>> 0) + popcount32((a.lo ^ b.lo) >>> 0);
}

// ─── State machine ─────────────────────────────────────────────────────────

export type SmartState = "scanning" | "candidate" | "capturing" | "cooldown";

export type StepResult =
  | { action: "none" }
  /** Caller should run the async capture, then call settle() with this hash. */
  | { action: "capture"; hash: AHash | null };

/**
 * Synchronous decision machine. One instance per scanning session; the React
 * loop calls step() each tick and settle() when an async capture finishes.
 */
export class SmartCaptureMachine {
  state: SmartState = "scanning";
  private readySince = 0;
  private cooldownUntil = 0;
  private lastHash: AHash | null = null;

  /** Full reset for a fresh scanning session (also clears dedup memory). */
  reset(): void {
    this.state = "scanning";
    this.readySince = 0;
    this.cooldownUntil = 0;
    this.lastHash = null;
  }

  /**
   * Advance one tick. `ready` is evaluateReadiness(latest).ready (or false for
   * stale/no sample). `getHash` is called at most once, only at the moment a
   * capture decision is made.
   */
  step(now: number, ready: boolean, getHash: () => AHash | null): StepResult {
    switch (this.state) {
      case "capturing":
        // Locked until the caller reports settle(); never overlap captures.
        return { action: "none" };

      case "cooldown":
        if (now >= this.cooldownUntil) {
          this.state = "scanning";
          this.readySince = 0;
        }
        return { action: "none" };

      case "scanning":
        if (ready) {
          this.state = "candidate";
          this.readySince = now;
        }
        return { action: "none" };

      case "candidate": {
        if (!ready) {
          // Lost readiness before the dwell completed — re-arm.
          this.state = "scanning";
          this.readySince = 0;
          return { action: "none" };
        }
        if (now - this.readySince < STABILITY_DWELL_MS) {
          return { action: "none" };
        }
        // Dwell satisfied. Duplicate gate: same card still in frame?
        const hash = getHash();
        if (
          this.lastHash !== null &&
          hash !== null &&
          hammingDistance(hash, this.lastHash) <= DUP_HAMMING_MAX
        ) {
          // Same card — skip the OCR call, take a cooldown, then re-scan.
          this.enterCooldown(now);
          return { action: "none" };
        }
        this.state = "capturing";
        return { action: "capture", hash };
      }
    }
  }

  /** Report an async capture finished. Records the captured frame's hash for
   *  dedup and enters cooldown. */
  settle(now: number, capturedHash: AHash | null): void {
    if (capturedHash !== null) this.lastHash = capturedHash;
    this.enterCooldown(now);
  }

  private enterCooldown(now: number): void {
    this.state = "cooldown";
    this.cooldownUntil = now + COOLDOWN_MS;
    this.readySince = 0;
  }
}
