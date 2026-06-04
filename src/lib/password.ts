import { pbkdf2Sync, randomBytes, timingSafeEqual } from "crypto";

const ITERATIONS = 10000;
const KEYLEN = 64;
const ALGORITHM = "sha512";

/**
 * Hash a password using PBKDF2 with SHA-512.
 * Returns a string formatted as "salt:iterations:hash" for storage.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = pbkdf2Sync(password, salt, ITERATIONS, KEYLEN, ALGORITHM).toString("hex");
  return `${salt}:${ITERATIONS}:${hash}`;
}

/**
 * Verify a password against a stored hash string.
 */
export function verifyPassword(password: string, storedHash: string): boolean {
  try {
    const parts = storedHash.split(":");
    if (parts.length !== 3) {
      return false;
    }
    const [salt, iterationsStr, hash] = parts;
    const iterations = parseInt(iterationsStr, 10);
    if (isNaN(iterations)) {
      return false;
    }
    const testHash = pbkdf2Sync(password, salt, iterations, KEYLEN, ALGORITHM).toString("hex");
    return timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(testHash, "hex"));
  } catch (error) {
    console.error("Password verification error:", error);
    return false;
  }
}
