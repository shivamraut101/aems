import * as BackgroundFetch from "expo-background-fetch";
import * as TaskManager from "expo-task-manager";

import { runSyncCycle } from "./sync";

export const BACKGROUND_SYNC_TASK = "aems-background-sync";

/**
 * Must run at module scope, not inside a function — a headless background-fetch
 * launch re-evaluates this file from scratch before invoking the task, so
 * `defineTask` has to be unconditional top-level code or the task is undefined
 * by the time the OS calls it.
 */
TaskManager.defineTask(BACKGROUND_SYNC_TASK, async () => {
  try {
    const outcome = await runSyncCycle();
    return outcome === "no-device"
      ? BackgroundFetch.BackgroundFetchResult.NoData
      : BackgroundFetch.BackgroundFetchResult.NewData;
  } catch {
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});

/**
 * Registers the sync cycle to run while the app is backgrounded or closed (scope
 * §3.1/§3.3's "background operation" / "secure sync"), on top of the foreground
 * interval `App.tsx` runs while the app is open.
 *
 * `minimumInterval` states Android's own floor for background-fetch alarms — the
 * OS enforces roughly 15 minutes regardless of what's requested, best-effort and
 * subject to battery-optimisation delay.
 */
export async function registerBackgroundSync(): Promise<void> {
  const alreadyRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK);
  if (alreadyRegistered) return;

  await BackgroundFetch.registerTaskAsync(BACKGROUND_SYNC_TASK, {
    minimumInterval: 15 * 60,
    stopOnTerminate: false,
    startOnBoot: true,
  });
}
