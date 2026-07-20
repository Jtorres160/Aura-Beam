import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native-binary / large server-only deps pulled in transitively by the
  // fingerprint shadow sensor (src/lib/scanner/fingerprint-match.ts →
  // @huggingface/transformers → onnxruntime-node; sharp is used by the index
  // builder and shares the native-binary concern). Opting them out of Server
  // Component bundling makes Next `require()` them at runtime instead of trying
  // to bundle their native `.node` addons and the 136MB model, which the bundler
  // cannot trace correctly. All three are on Next's built-in auto-external list
  // today, but M1-C's investigation flagged that once server code under src/
  // imports them (which M2-B did) this should be declared explicitly rather than
  // relying on that default.
  serverExternalPackages: ["onnxruntime-node", "@huggingface/transformers", "sharp"],
};

export default nextConfig;
