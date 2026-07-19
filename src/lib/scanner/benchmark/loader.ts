// ─── Recognition Benchmark Dataset — loader & validator (V2 · M0) ────────────
// Parses and VALIDATES the benchmark manifest. A regression suite is only worth
// as much as its integrity: a silently malformed entry (wrong id, unknown
// category, missing identity) would corrupt every future recognizer score. So
// validation is strict and total — it returns typed errors rather than throwing
// on the first problem, and a future CI check fails the build if the manifest
// is dirty.

import {
  DIFFICULTY_CATEGORIES,
  type BenchmarkEntry,
  type BenchmarkManifest,
  type DifficultyCategory,
} from "@/lib/scanner/benchmark/types";

const GAMES = new Set(["MTG", "POKEMON", "YUGIOH"]);
const CATEGORIES = new Set<string>(DIFFICULTY_CATEGORIES);

export interface ValidationError {
  /** Entry id (or "<manifest>" / index) the problem belongs to. */
  where: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
  /** The parsed manifest when the top-level shape is valid (entries may still
   *  carry per-entry errors — check `ok`). Null when the shape is unusable. */
  manifest: BenchmarkManifest | null;
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

/**
 * Validate a parsed manifest object. Pure — takes already-parsed JSON so it is
 * trivially unit-testable without touching the filesystem.
 */
export function validateManifest(raw: unknown): ValidationResult {
  const errors: ValidationError[] = [];

  if (!isObject(raw)) {
    return { ok: false, errors: [{ where: "<manifest>", message: "manifest is not an object" }], manifest: null };
  }
  if (raw.v !== 1) {
    errors.push({ where: "<manifest>", message: `unsupported manifest version: ${String(raw.v)}` });
  }
  if (typeof raw.description !== "string") {
    errors.push({ where: "<manifest>", message: "description must be a string" });
  }
  if (!Array.isArray(raw.entries)) {
    return {
      ok: false,
      errors: [...errors, { where: "<manifest>", message: "entries must be an array" }],
      manifest: null,
    };
  }

  const seenIds = new Set<string>();
  const seenImages = new Set<string>();

  raw.entries.forEach((entry, i) => {
    const where = isObject(entry) && typeof entry.id === "string" ? entry.id : `entries[${i}]`;
    if (!isObject(entry)) {
      errors.push({ where, message: "entry is not an object" });
      return;
    }
    if (typeof entry.id !== "string" || entry.id.trim() === "") {
      errors.push({ where, message: "id is required and must be a non-empty string" });
    } else if (seenIds.has(entry.id)) {
      errors.push({ where, message: `duplicate id "${entry.id}"` });
    } else {
      seenIds.add(entry.id);
    }

    if (typeof entry.image !== "string" || entry.image.trim() === "") {
      errors.push({ where, message: "image (filename) is required" });
    } else if (entry.image.includes("/") || entry.image.includes("\\")) {
      errors.push({ where, message: "image must be a bare filename, not a path" });
    } else if (seenImages.has(entry.image)) {
      errors.push({ where, message: `duplicate image "${entry.image}"` });
    } else {
      seenImages.add(entry.image);
    }

    if (typeof entry.game !== "string" || !GAMES.has(entry.game)) {
      errors.push({ where, message: `game must be one of MTG|POKEMON|YUGIOH (got ${String(entry.game)})` });
    }
    if (typeof entry.expectedName !== "string" || entry.expectedName.trim() === "") {
      errors.push({ where, message: "expectedName is required (identity-level truth)" });
    }
    if (entry.expectedExternalId !== undefined && typeof entry.expectedExternalId !== "string") {
      errors.push({ where, message: "expectedExternalId, when present, must be a string" });
    }
    if (!Array.isArray(entry.categories) || entry.categories.length === 0) {
      errors.push({ where, message: "categories must be a non-empty array" });
    } else {
      for (const c of entry.categories) {
        if (typeof c !== "string" || !CATEGORIES.has(c)) {
          errors.push({ where, message: `unknown difficulty category "${String(c)}"` });
        }
      }
    }
  });

  return { ok: errors.length === 0, errors, manifest: raw as unknown as BenchmarkManifest };
}

/** Entries grouped by difficulty category (an entry appears under each of its
 *  categories) — the shape a per-category recognizer score is computed over. */
export function entriesByCategory(
  manifest: BenchmarkManifest,
): Record<DifficultyCategory, BenchmarkEntry[]> {
  const out = Object.fromEntries(DIFFICULTY_CATEGORIES.map((c) => [c, [] as BenchmarkEntry[]])) as Record<
    DifficultyCategory,
    BenchmarkEntry[]
  >;
  for (const entry of manifest.entries) {
    for (const c of entry.categories) {
      if (out[c]) out[c].push(entry);
    }
  }
  return out;
}
