"use client";

import { Button } from "@aems/ui";
import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * Light and dark, and the switch between them.
 *
 * The dark palette has been in `globals.css` since the first commit and nothing in the
 * product could reach it — every token below `.dark` was dead code, including the
 * re-tuned indigo that keeps AI surfaces legible on a near-black ground. This is the
 * control that makes that work real.
 *
 * Tailwind is configured `darkMode: ["class"]`, so the switch is a class on <html>
 * rather than a data attribute or a media query. A media query alone would not do: a
 * monitoring product gets read at 2am and on a projector in a meeting, and the reader
 * has to be able to overrule their operating system.
 */
const STORAGE_KEY = "aems-theme";

export type Theme = "light" | "dark";

/**
 * Applied before paint by the inline script in `app/layout.tsx`, and again here on
 * every change. Exported so the two cannot drift: one function, one class name.
 */
export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

export function ThemeToggle() {
  // `null` until mounted, deliberately. The server has no localStorage and no
  // `prefers-color-scheme`, so any guess it made would be wrong half the time and
  // React would throw the tree away at hydration — the exact defect `RelativeTime`
  // exists to avoid. The button renders its frame immediately and its icon a tick
  // later, which costs nothing because the frame is what holds the layout.
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    setTheme(readStoredTheme() ?? systemTheme());
  }, []);

  function choose(next: Theme) {
    setTheme(next);
    applyTheme(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Private mode, or storage disabled by policy on a managed machine. The theme
      // still applies for this page; it simply will not be remembered, which is a
      // better outcome than refusing to switch at all.
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      // Announced rather than inferred from an icon, and it names the destination —
      // "Switch to dark" says what pressing it does, where "Dark" alone could equally
      // be read as the current state.
      aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      /*
       * Reads the class, not the state.
       *
       * `theme` is null for the first tick after mount, and inverting a null read as
       * "not dark" — so the very first click on a dark page chose dark again and did
       * nothing. The <html> class is already correct by then, because the inline
       * script in the layout set it before paint, so it is the reliable answer to
       * "what is on screen right now".
       */
      onClick={() => choose(document.documentElement.classList.contains("dark") ? "light" : "dark")}
    >
      {theme === null ? null : theme === "dark" ? (
        <Sun className="h-4 w-4" aria-hidden />
      ) : (
        <Moon className="h-4 w-4" aria-hidden />
      )}
    </Button>
  );
}

/**
 * What the operating system asks for, when it can be asked.
 *
 * `matchMedia` is absent in jsdom and in a few embedded browsers, and calling it
 * unguarded threw before the toggle could render — which took the whole app shell down
 * with it, since this sits inside the account card. Light is the documented default in
 * docs/design.md, so it is the right answer when the question cannot be put.
 */
function systemTheme(): Theme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function readStoredTheme(): Theme | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === "dark" || value === "light" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Runs before the first paint, from `app/layout.tsx`.
 *
 * Without it the page paints light, then the effect above switches it — a white flash
 * on every load for anyone who chose dark, which is precisely the class of flash this
 * codebase has spent so long removing. It is a string because it has to execute in
 * `<head>`, before React exists.
 */
export const THEME_INIT_SCRIPT = `
try {
  var s = localStorage.getItem(${JSON.stringify(STORAGE_KEY)});
  var m = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
  if (s === "dark" || (!s && m)) document.documentElement.classList.add("dark");
} catch (e) {}
`.trim();
