/// <reference types="vite/client" />

import type { AgentApi } from "../shared/types/index.js";

declare global {
  interface Window {
    /** Injected by the preload bridge. The only channel out of the renderer. */
    aems: AgentApi;
  }
}

export {};
