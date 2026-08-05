/**
 * The popup: whether this browser is reporting, and under what policy.
 *
 * It has no state of its own. Everything comes from one message to the service worker,
 * which is the only part of the extension that holds a port to the agent.
 */

import type { PageAnswer } from "./background.js";
import { popupRows } from "./pages.js";
import { renderRows, setText } from "./render.js";

async function paint(): Promise<void> {
  const tone = document.getElementById("tone");
  const rows = document.getElementById("rows");

  let answer: PageAnswer | null = null;

  try {
    answer = (await chrome.runtime.sendMessage({ type: "aems:state" })) as PageAnswer;
  } catch {
    // The service worker could not be woken. Saying so beats leaving "Checking…" on
    // screen forever, which reads as a hung extension rather than a broken link.
    answer = null;
  }

  if (answer === null) {
    setText("headline", "Not connected");
    setText(
      "detail",
      "This extension could not reach its own background service. Website activity is not being reported.",
    );
    tone?.setAttribute("data-tone", "off");
    return;
  }

  setText("headline", answer.connection.headline);
  setText("detail", answer.connection.detail);
  tone?.setAttribute("data-tone", answer.connection.tone);

  if (rows !== null) renderRows(rows, popupRows(answer));
}

void paint();
