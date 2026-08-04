import type { ReactElement } from "react";

import type { AgentStatus } from "../../shared/types/index.js";
import { Notice } from "../components/Notice.js";
import { Readout, ReadoutRow, StatusValue } from "../components/Readout.js";
import { Shell } from "../components/Shell.js";
import { useNow } from "../hooks/useNow.js";
import { agentBridge } from "../lib/bridge.js";
import { formatDuration, formatRelative } from "../lib/format.js";
import { connectionLabel, permissionGaps, trackedSecondsToday } from "../lib/view.js";

interface StatusScreenProps {
  status: AgentStatus;
}

/**
 * The readout docs/design.md specifies, and nothing more.
 *
 * Deliberately not a dashboard. Timelines, screenshots and app breakdowns live on the
 * web, where an employee can see their own data next to everyone else's context; here
 * the only questions worth answering are whether monitoring is running, how much time
 * it has recorded, and whether it is still reaching the server.
 */
export function StatusScreen({ status }: StatusScreenProps): ReactElement {
  const now = useNow(1000);

  const gaps = permissionGaps(status.permissions);
  const connection = connectionLabel(status, gaps);
  const tracked = trackedSecondsToday(status);
  const lastSync = status.lastSyncAt === null ? null : formatRelative(status.lastSyncAt, now);

  // Ending a break must stay available even though collection is paused during one —
  // otherwise a break started by mistake could never be closed.
  const breakAvailable = status.collecting || status.onBreak;

  return (
    <Shell
      footer={
        <>
          {breakAvailable && (
            <div className="actions">
              <button
                className="button button--quiet button--block"
                type="button"
                onClick={() => {
                  const bridge = agentBridge();
                  void (status.onBreak ? bridge?.endBreak() : bridge?.startBreak());
                }}
              >
                {status.onBreak ? "End break" : "Start a break"}
              </button>
            </div>
          )}

          <p className="app__note">
            {status.revoked
              ? "This device is no longer sending data."
              : "The tray icon stays visible while the agent runs. You can withdraw your consent at any time from the AEMS web dashboard."}
          </p>
        </>
      }
    >
      {status.revoked && (
        <Notice tone="warn" title="Monitoring has been stopped">
          An administrator revoked this device, so nothing is being recorded or sent. Contact them
          if you think this is a mistake.
        </Notice>
      )}

      <Readout>
        <ReadoutRow label="Status">
          <StatusValue tone={connection.tone} text={connection.text} />
        </ReadoutRow>

        <ReadoutRow label="Today's Time" muted={tracked === null}>
          {tracked === null ? "Not tracked yet" : formatDuration(tracked)}
        </ReadoutRow>

        {/* Scope §2.2's breakdown, shown only once there is a day to break down.
            Zeroes next to a total of nothing say less than no rows at all. */}
        {tracked !== null && (
          <>
            <ReadoutRow label="Active">{formatDuration(status.totals.activeSeconds)}</ReadoutRow>
            <ReadoutRow label="Idle">{formatDuration(status.totals.idleSeconds)}</ReadoutRow>
            {status.totals.breakSeconds > 0 && (
              <ReadoutRow label="Break">{formatDuration(status.totals.breakSeconds)}</ReadoutRow>
            )}
          </>
        )}

        <ReadoutRow label="Last Sync" muted={lastSync === null}>
          {lastSync ?? "No sync yet"}
        </ReadoutRow>

        {/* Only worth a row when there is something to say. A permanent "0 waiting"
            trains the employee to ignore the line that matters during an outage. */}
        {status.pendingEvents > 0 && (
          <ReadoutRow label="Waiting to sync">
            {status.pendingEvents === 1 ? "1 event" : `${status.pendingEvents} events`}
          </ReadoutRow>
        )}

        {status.policyVersion !== null && (
          <ReadoutRow label="Policy" muted>
            Version {status.policyVersion}
          </ReadoutRow>
        )}
      </Readout>

      {gaps.length > 0 && (
        <div className="stack">
          {gaps.map((gap) => (
            <Notice
              key={gap.target}
              tone="warn"
              title={gap.title}
              action={
                <button
                  className="button button--quiet button--small"
                  type="button"
                  onClick={() => void agentBridge()?.openPermissionSettings(gap.target)}
                >
                  Open System Settings
                </button>
              }
            >
              {gap.detail}
            </Notice>
          ))}
        </div>
      )}
    </Shell>
  );
}
