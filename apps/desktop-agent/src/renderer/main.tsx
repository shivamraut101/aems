import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { isIndicatorRoute } from "../shared/types/index.js";
import { App } from "./App.js";
import { IndicatorWindow } from "./screens/IndicatorWindow.js";
import "./styles.css";

const container = document.getElementById("root");
if (container === null) throw new Error("Renderer root element is missing");

// Both windows load this one entry — the renderer has a single Vite input — so the
// fragment main appended is what tells the 184x32 always-on-top pill apart from the
// 460px agent window. Without this branch the indicator would render the whole agent UI
// inside a window the size of a tooltip.
createRoot(container).render(
  <StrictMode>{isIndicatorRoute(window.location.hash) ? <IndicatorWindow /> : <App />}</StrictMode>,
);
