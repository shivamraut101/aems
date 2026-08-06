import type { ReactElement } from "react";

import type { AgentStatus } from "../../shared/types/index.js";
import { Notice } from "../components/Notice.js";
import { Readout, ReadoutRow, StatusValue } from "../components/Readout.js";
import { Shell } from "../components/Shell.js";
import { useNow } from "../hooks/useNow.js";
import { agentBridge } from "../lib/bridge.js";
import { formatDuration, formatRelative } from "../lib/format.js";
import {
  connectionLabel,
  permissionGaps,
  trackedSecondsToday,
  websiteTrackingNote,
} from "../lib/view.js";

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
  const websiteNote = websiteTrackingNote(status.permissions);
  const connection = connectionLabel(status, gaps);
  const tracked = trackedSecondsToday(status);
  const lastSync = status.lastSyncAt === null ? null : formatRelative(status.lastSyncAt, now);

  // Ending a break must stay available even though collection is paused during one —
  // otherwise a break started by mistake could never be closed. Not offered once the
  // day is over: pausing a finished day is not a state worth being able to reach.
  const breakAvailable = !status.dayEnded && (status.collecting || status.onBreak);

  // The day control is the one thing here an employee reaches for at a fixed time
  // every day, so it is present whenever they are enrolled — including while a break
  // is open, because "I am not coming back" is exactly the thing someone on a break
  // needs to be able to say.
  const dayAvailable = status.enrolled && !status.revoked;

  return (
    <Shell
      footer={
        <>
          {(breakAvailable || dayAvailable) && (
            <div className="actions">
              {breakAvailable && (
                <button
                  className="button button--quiet button--block"
                  type="button"
                  onClick={() => {
                    const bridge = agentBridge();
                    void (status.onBreak ? bridge?.endBreak() : bridge?.startBreak());
                  }}
                >
                  {status.onBreak ? "End break" : "Take a break"}
                </button>
              )}

              {dayAvailable && (
                <button
                  className="button button--primary button--block"
                  type="button"
                  onClick={() => {
                    const bridge = agentBridge();
                    void (status.dayEnded ? bridge?.startDay() : bridge?.endDay());
                  }}
                >
                  {status.dayEnded ? "Start working again" : "End day"}
                </button>
              )}
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
      {status.dayEnded && !status.revoked && (
        // Said plainly and at the top, because the readout below it goes still: an
        // employee who clocked out and then saw a frozen timer with no explanation
        // would reasonably conclude the agent had crashed.
        <Notice tone="plain" title="You have finished for today">
          Nothing further is being recorded. Monitoring starts again by itself tomorrow, or
          you can start working again below.
        </Notice>
      )}

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

      {/* `plain`, not `warn`, and deliberately outside the gap list: this is a platform
          limit nobody can grant their way out of, so offering no button is the point.
          Colouring it as a warning would train people to ignore the badge that means a
          real, fixable block. */}
      {websiteNote !== null && (
        <Notice tone="plain" title="Websites are not recorded on this computer">
          {websiteNote}
        </Notice>
      )}
    </Shell>
  );
}
