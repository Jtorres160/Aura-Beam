// ─── Scan confirmation chime ────────────────────────────────────────────────
// A short two-note pop synthesised with WebAudio. Synthesised rather than
// shipped as a file so there's no asset to host, no CDN dependency, and no
// extra request on a screen whose whole job is to feel immediate.
//
// Module-level state (rather than React state) is deliberate: the chime fires
// from inside the scan callback, which closes over its props. A ref-free module
// flag can't go stale mid-bulk-run the way a captured `enabled` value can.

type Ctor = typeof AudioContext;

let ctx: AudioContext | null = null;
let enabled = true;
/** Gain of the chime currently sounding, if any — used to retrigger cleanly. */
let activeGain: GainNode | null = null;
let lastPlayedAt = 0;

/**
 * Floor between chimes. Bulk mode can queue cards faster than the tail of the
 * previous tone decays; below this gap a second chime reads as a stutter rather
 * than a second catch, so it's dropped instead.
 */
const MIN_GAP_MS = 90;

/** Peak gain. Low on purpose — a confirmation, not an alert. */
const PEAK_GAIN = 0.09;

function resolveCtor(): Ctor | null {
  if (typeof window === "undefined") return null;
  // webkitAudioContext is still the only constructor on older iOS Safari.
  const w = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/**
 * Prime audio from inside a user gesture.
 *
 * Mobile browsers refuse to start an AudioContext outside a gesture, and iOS
 * Safari is the strictest: a context constructed outside one is born
 * "suspended" and stays that way, so a chime scheduled later is silently
 * dropped. Two things are needed and both must happen synchronously in the
 * gesture's call stack:
 *
 *   1. construct/resume the context, and
 *   2. actually run a buffer through it — iOS historically does not consider a
 *      context unlocked until something has played, so a zero-length silent
 *      source is started here.
 *
 * Called from the "Open Camera" tap and from the sound toggle, both of which
 * are real taps. Safe to call repeatedly.
 */
export function primeScanAudio(): void {
  const Ctor = resolveCtor();
  if (!Ctor) return;
  try {
    ctx ??= new Ctor();
    // A context can also fall back to suspended/interrupted after a phone call
    // or a tab backgrounding, so resume every time rather than only on create.
    if (ctx.state !== "running") void ctx.resume();
    const buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(0);
  } catch {
    // Audio is a garnish. If the platform refuses, scanning still works.
    ctx = null;
  }
}

/** Mirror the stored preference into the engine. */
export function setScanSoundEnabled(next: boolean): void {
  enabled = next;
}

/**
 * Play the confirmation chime, if sound is on and audio has been primed.
 *
 * Never throws and never awaits — call sites are in the success path and must
 * not be slowed or broken by an audio failure.
 */
export function playScanChime(): void {
  if (!enabled || !ctx) return;

  const now = Date.now();
  if (now - lastPlayedAt < MIN_GAP_MS) return;
  lastPlayedAt = now;

  try {
    if (ctx.state !== "running") void ctx.resume();
    const t = ctx.currentTime;

    // Retrigger rather than layer: a rapid bulk run should sound like a series
    // of distinct catches, not an accumulating chord.
    if (activeGain) {
      try {
        activeGain.gain.cancelScheduledValues(t);
        activeGain.gain.setTargetAtTime(0, t, 0.01);
      } catch {
        /* the old node may already be finished — nothing to fade */
      }
    }

    const master = ctx.createGain();
    master.gain.setValueAtTime(0, t);
    master.connect(ctx.destination);
    activeGain = master;

    // Two sine partials a fifth-and-a-bit apart (A5 → E6): a soft "pop-ting"
    // that reads as confirmation rather than notification.
    const notes = [
      { freq: 880, at: 0, dur: 0.18, level: 1 },
      { freq: 1318.5, at: 0.055, dur: 0.26, level: 0.75 },
    ];

    for (const note of notes) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(note.freq, t + note.at);
      // Fast attack, exponential decay — a struck-object envelope. Ramping to
      // a small non-zero value because exponentialRampToValueAtTime cannot
      // reach exactly 0.
      g.gain.setValueAtTime(0.0001, t + note.at);
      g.gain.exponentialRampToValueAtTime(PEAK_GAIN * note.level, t + note.at + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + note.at + note.dur);
      osc.connect(g);
      g.connect(master);
      osc.start(t + note.at);
      osc.stop(t + note.at + note.dur + 0.02);
    }

    master.gain.setValueAtTime(1, t);
    // Release the reference once the tail is done so we don't fade a dead node.
    window.setTimeout(() => {
      if (activeGain === master) activeGain = null;
    }, 400);
  } catch {
    /* never let audio break the success path */
  }
}
