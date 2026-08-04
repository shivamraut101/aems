import { store } from "./config.js";

async function post(path: string, body: unknown) {
  const res = await fetch(`${store.get("apiUrl")}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`AEMS API ${path} failed: ${res.status}`);
  }

  return res.json();
}

export const apiClient = {
  logActivityEvent: (input: Record<string, unknown>) => post("/activity/events", input),
  logIdleEvent: (input: Record<string, unknown>) => post("/activity/idle", input),
  logScreenshot: (input: Record<string, unknown>) => post("/activity/screenshots", input),
};
