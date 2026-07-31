"use client";

// ─── Root error boundary ─────────────────────────────────────────────────────
// The last boundary React has. It replaces the root layout entirely — including
// <html> and <body> — so it only fires for errors thrown by the root layout or
// its providers. That is precisely the blank-white-screen case: no server log,
// no UI, and nothing for a tester to describe beyond "it didn't load".
//
// src/app/error.tsx handles the far more common case (a page or component
// throwing under the root layout) and keeps the app chrome.

import { useEffect } from "react";
import { Sentry } from "@/lib/observability/sentry";

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0a0a0a",
          color: "#e5e5e5",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          padding: "2rem",
          textAlign: "center",
        }}
      >
        {/* Inline styles on purpose: a root-layout failure may mean the
            stylesheet never loaded, and this screen has to render regardless. */}
        <div style={{ maxWidth: "24rem" }}>
          <h1 style={{ fontSize: "1.25rem", fontWeight: 600, marginBottom: "0.75rem" }}>
            Aura failed to load
          </h1>
          <p style={{ fontSize: "0.875rem", lineHeight: 1.6, color: "#a3a3a3", margin: 0 }}>
            Something broke before the page could render. The error has been
            reported. Reloading usually clears it.
          </p>
          {/* The digest is the only handle that ties this screen to the server
              log for the same error — worth showing so a tester can quote it. */}
          {error.digest && (
            <p
              style={{
                fontFamily: "ui-monospace, monospace",
                fontSize: "0.6875rem",
                letterSpacing: "0.08em",
                color: "#525252",
                marginTop: "1.25rem",
              }}
            >
              ref: {error.digest}
            </p>
          )}
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              marginTop: "1.5rem",
              padding: "0.625rem 1.5rem",
              fontSize: "0.875rem",
              color: "#0a0a0a",
              background: "#d4af37",
              border: "none",
              borderRadius: "0.5rem",
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
