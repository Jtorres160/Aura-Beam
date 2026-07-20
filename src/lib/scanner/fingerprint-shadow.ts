// ─── Fingerprint Shadow Wiring (Scanner V2 · M2-B) ──────────────────────────
// The glue that runs matchFingerprint as a SHADOW sensor alongside a live scan
// and records what it saw onto that scan's ScanHistory row — with ZERO effect on
// the response. The scan route schedules this via `after()`, so by the time any
// of it runs the decision, confidence, candidates and status code are already
// fixed and the response is being (or has been) sent.
//
// Why its own module (not just inline in route.ts): the gate (shouldRun…) and
// the run (runFingerprintShadow) are the only parts with real logic, and both
// are unit-testable here with injected dependencies — no Next `after()`, no real
// model, no real DB. route.ts keeps a thin wrapper that wires the production
// deps. This mirrors how the rest of the scanner keeps decision logic out of the
// route handler.

import { FINGERPRINT_SHADOW_ENABLED, type FingerprintMatch } from "@/lib/scanner/fingerprint-match";
import { canonicalGame } from "@/lib/scanner/recognition-memory";
import { withFingerprintShadow, type FingerprintShadow } from "@/lib/scanner/telemetry";

/**
 * Decode the scan's data-URI image (`data:image/…;base64,<payload>` — the exact
 * value the OCR calls embedded) into the raw Buffer matchFingerprint expects.
 * Bare base64 without a header is tolerated (POST normalizes to a data URI, but
 * this stays robust to either).
 */
export function base64ImageToBuffer(imageUrl: string): Buffer {
  const comma = imageUrl.indexOf(",");
  const payload = comma >= 0 ? imageUrl.slice(comma + 1) : imageUrl;
  return Buffer.from(payload, "base64");
}

/**
 * Whether a shadow match should run for this scan. The single decision point for
 * the flag + game gating, so "off ⇒ provably nothing happens" is one testable
 * predicate rather than scattered guards:
 *
 *   • flag OFF                → false (no model load, no DB query, no schedule)
 *   • game is not Pokémon      → false (only game with a fingerprint index)
 *   • no row to attach to      → false (a best-effort telemetry write failed;
 *                                nothing to append the block to)
 *
 * `enabled` defaults to the env flag but is injectable so a test can prove both
 * branches without mutating process.env.
 */
export function shouldRunFingerprintShadow(
  game: string,
  rowId: string | null,
  enabled: boolean = FINGERPRINT_SHADOW_ENABLED,
): rowId is string {
  if (!enabled) return false;
  if (canonicalGame(game) !== "POKEMON") return false;
  if (!rowId) return false;
  return true;
}

/** What the pipeline decided, threaded into the shadow block for later
 *  agreement analysis. `rowId` is the ScanHistory row this attempt already
 *  wrote; `pipelineExternalId` is the identity the pipeline chose (the accepted
 *  printing, or the disambiguation best-match), or null when it chose nothing. */
export interface ShadowMatchInput {
  rowId: string;
  imageUrl: string;
  pipelineExternalId: string | null;
  pipelinePickSource: FingerprintShadow["pipelinePickSource"];
}

/** Injected side-effecting dependencies, so the run logic is testable with
 *  spies. Production wiring (route.ts) supplies matchFingerprint + prisma. */
export interface ShadowDeps {
  matcher: (buffer: Buffer, game: string) => Promise<FingerprintMatch[] | null>;
  /** Read the current ocrText of the row, so the block merges onto (not over)
   *  whatever the scan already wrote. */
  loadOcrText: (rowId: string) => Promise<string | null>;
  saveOcrText: (rowId: string, ocrText: string) => Promise<void>;
  now?: () => string;
  warn?: (message: string, err: unknown) => void;
}

function defaultWarn(message: string, err: unknown): void {
  console.warn(message, (err as Error)?.message ?? err);
}

/**
 * Run the shadow match and append the block to the row. FULLY isolated: any
 * throw from the matcher or either DB call is caught and logged at warn level —
 * a shadow sensor going dark is never a user-facing failure (the response is
 * already sent) and must never page anyone or pollute error tracking. Always
 * resolves; never rejects.
 *
 * A null/empty match result is still recorded (a block with null top match) —
 * that the sensor was consulted and saw nothing is itself the observation.
 */
export async function runFingerprintShadow(input: ShadowMatchInput, deps: ShadowDeps): Promise<void> {
  const warn = deps.warn ?? defaultWarn;
  try {
    const buffer = base64ImageToBuffer(input.imageUrl);
    const matches = await deps.matcher(buffer, "POKEMON");
    const top = matches && matches.length > 0 ? matches[0] : null;
    const shadow: FingerprintShadow = {
      topMatchExternalId: top?.externalId ?? null,
      topMatchDistance: top?.distance ?? null,
      matches: matches ?? undefined,
      pipelineExternalId: input.pipelineExternalId,
      pipelinePickSource: input.pipelinePickSource,
      at: (deps.now ?? (() => new Date().toISOString()))(),
    };
    const current = await deps.loadOcrText(input.rowId);
    await deps.saveOcrText(input.rowId, withFingerprintShadow(current, shadow));
  } catch (err) {
    warn("[fingerprint-shadow] shadow sensor failed (non-fatal):", err);
  }
}
