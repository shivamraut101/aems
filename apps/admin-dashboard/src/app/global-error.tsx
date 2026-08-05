"use client";

import { useEffect } from "react";

/**
 * The last boundary: a failure in the root layout itself.
 *
 * This one replaces the whole document, so it has to supply `<html>` and `<body>` —
 * and it cannot rely on the app's stylesheet, because the layout that imports it is
 * the thing that just failed. Hence inline styles rather than Tailwind classes: a
 * fallback that depends on the broken half of the app is not a fallback.
 *
 * Colours are the navy/light pair from `docs/design.md`, written out literally for
 * the same reason.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Fatal error in the dashboard root layout", error);
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
          padding: "2rem",
          backgroundColor: "#F8FAFC",
          color: "#0F172A",
          fontFamily:
            "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
        }}
      >
        <main
          role="alert"
          style={{
            maxWidth: "34rem",
            width: "100%",
            border: "1px solid rgba(15,23,42,0.12)",
            borderRadius: "8px",
            backgroundColor: "#FFFFFF",
            padding: "1.5rem",
          }}
        >
          <h1 style={{ margin: 0, fontSize: "1rem", fontWeight: 600, letterSpacing: "-0.01em" }}>
            AEMS could not start
          </h1>
          <p style={{ marginTop: "0.5rem", fontSize: "0.875rem", lineHeight: 1.6, color: "#475569" }}>
            The dashboard failed before any screen could be drawn. No data was changed.
            Reload to try again; if it keeps happening, the API or the browser session is
            the place to look.
          </p>

          {error.digest ? (
            <p style={{ marginTop: "0.75rem", fontSize: "0.75rem", color: "#64748B" }}>
              Reference <strong>{error.digest}</strong>
            </p>
          ) : null}

          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: "1.25rem",
              height: "2.25rem",
              padding: "0 0.875rem",
              borderRadius: "6px",
              border: "1px solid rgba(15,23,42,0.14)",
              backgroundColor: "#0F172A",
              color: "#F8FAFC",
              fontSize: "0.875rem",
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Reload the dashboard
          </button>
        </main>
      </body>
    </html>
  );
}
