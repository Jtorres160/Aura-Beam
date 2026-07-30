// ─── The one place Aura imports the Sentry SDK ───────────────────────────────
//
// @sentry/nextjs ships CommonJS. Inside a Next build the bundler resolves
// `import * as Sentry from "@sentry/nextjs"` to the named exports and the
// documented usage works exactly as written. In plain Node ESM — a script, a
// `node --test` run, anything that imports app code outside the bundle — Node's
// static named-export detection misses them, and the namespace object exposes
// only `default`. Every `Sentry.*` call is then `undefined`.
//
// For most libraries that is a loud crash. For an error reporter wrapped in the
// defensive try/catch it has to have, it is a SILENT no-op: reporting appears
// wired, nothing is ever sent, and the absence of errors reads as health. That
// is the precise failure this whole task exists to eliminate, so it is resolved
// once here — by capability, not by guessing the environment — and everything
// else imports the SDK from this module.

import * as SentryNS from "@sentry/nextjs";

const resolved = (
  typeof (SentryNS as { withScope?: unknown }).withScope === "function"
    ? SentryNS
    : ((SentryNS as unknown as { default?: typeof SentryNS }).default ?? SentryNS)
) as typeof SentryNS;

export const Sentry = resolved;
export default resolved;
