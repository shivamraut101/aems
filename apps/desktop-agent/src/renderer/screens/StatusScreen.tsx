import { describeDataTypes } from "@aems/types";
import { useEffect, useRef, useState, type ReactElement } from "react";

import type { AgentStatus } from "../../shared/types/index.js";
import { Notice } from "../components/Notice.js";
import { Readout, ReadoutRow, StatusValue } from "../components/Readout.js";
import { Shell } from "../components/Shell.js";
import { useNow } from "../hooks/useNow.js";
import { agentBridge } from "../lib/bridge.js";
import { formatDuration, formatRelative } from "../lib/format.js";
import {
  collectedTypes,
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

  // What this machine is actually recording, and what an administrator has changed
  // since the employee last agreed. Both are read off the same heartbeat, so the
  // sentence below and the gate the employee passed cannot describe different sets.
  const recording = describeDataTypes(collectedTypes(status)).filter((item) => item.absent !== true);
  const pending = describeDataTypes(status.pendingTypes);

  // Ending a break must stay available even though collection is paused during one —
  // otherwise a break started by mistake could never be closed. Not offered once the
  // day is over: pausing a finished day is not a state worth being able to reach.
  const breakAvailable = !status.dayEnded && (status.collecting || status.onBreak);

  // The day control is the one thing here an employee reaches for at a fixed time
  // every day, so it is present whenever they are enrolled — including while a break
  // is open, because "I am not coming back" is exactly the thing someone on a break
  // needs to be able to say.
  const dayAvailable = status.enrolled && !status.revoked;

  // Ending the day is the one control here that costs something to get wrong — it closes
  // the work session and records nothing further until tomorrow — so it asks first.
  const [confirmingEndDay, setConfirmingEndDay] = useState(false);
  const [endingDay, setEndingDay] = useState(false);
  const confirmRef = useRef<HTMLDialogElement>(null);

  // The tray's "End day…" raises this same dialog instead of a native message box, so the
  // employee is asked once and in one wording wherever they started from.
  useEffect(() => agentBridge()?.onEndDayRequested(() => setConfirmingEndDay(true)), []);

  // Not open once the day is already over: the forgotten-break guard can end it from
  // under an open dialog, and confirming a decision that has been taken is a way to
  // report success for something that never ran.
  const confirmOpen = confirmingEndDay && !status.dayEnded;

  useEffect(() => {
    const node = confirmRef.current;
    if (node === null) return;

    // Guarded both ways because `showModal` on an open dialog throws, and `close` on a
    // shut one fires a spurious `close` event that would loop back through the state.
    if (confirmOpen && !node.open) node.showModal();
    else if (!confirmOpen && node.open) node.close();
  }, [confirmOpen]);

  function endDay(): void {
    const bridge = agentBridge();
    if (bridge === null) return;

    // The handler drains the event queue and closes the session over the network before
    // it answers, which is not instant. Without a pending state the dialog would sit
    // there looking ignored, and a second click would close a second session.
    setEndingDay(true);
    void bridge
      .endDay()
      .finally(() => {
        setEndingDay(false);
        setConfirmingEndDay(false);
      })
      // A failure leaves the readout showing a day that is still running, which is the
      // truth — the alternative is a dialog that cannot be dismissed.
      .catch(() => undefined);
  }

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
                    if (status.dayEnded) void agentBridge()?.startDay();
                    else setConfirmingEndDay(true);
                  }}
                >
                  {status.dayEnded ? "Start working again" : "End day"}
                </button>
              )}
            </div>
          )}

          {dayAvailable && (
            // A `<dialog>` rather than a hand-built overlay: the element is what gives
            // Escape-to-dismiss, the focus trap and the backdrop, and none of the three
            // is optional on the control that stops someone's day being recorded.
            <dialog
              className="dialog"
              ref={confirmRef}
              aria-labelledby="end-day-title"
              onClose={() => {
                setConfirmingEndDay(false);
              }}
            >
              <h2 className="dialog__title" id="end-day-title">
                End your working day?
              </h2>
              <p className="dialog__body">
                Your work session will be closed and nothing further is recorded today.
                Monitoring starts again by itself tomorrow, and you can start working again from
                here or the tray icon if you carry on.
              </p>
              <div className="actions">
                <button
                  className="button button--quiet"
                  type="button"
                  disabled={endingDay}
                  onClick={() => {
                    setConfirmingEndDay(false);
                  }}
                >
                  Cancel
                </button>
                <button
                  className="button button--primary"
                  type="button"
                  disabled={endingDay}
                  onClick={endDay}
                >
                  {endingDay ? "Ending…" : "End day"}
                </button>
              </div>
            </dialog>
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

      {/* An administrator widening what is collected is the one change to this agreement
          the employee did not make, so it is stated here rather than left to be noticed
          from the dashboard. Nothing on this list is being recorded — the server enforces
          what was granted, so an added type stays off until it is agreed to. */}
      {pending.length > 0 && !status.revoked && (
        <Notice tone="warn" title="Your administrator has changed what is collected">
          {pending.map((item) => item.title).join(", ")} {pending.length === 1 ? "has" : "have"}{" "}
          been switched on for this computer. None of it is being recorded until you agree — the
          agent will ask the next time it needs to.
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

      {/* The standing answer to "what is it actually recording", which until now the
          employee could only get by re-reading a consent screen they cannot reach. It
          is a plain statement of fact, not a warning: a scope an administrator narrowed
          is a correctly recorded decision, not a fault. */}
      {status.enrolled && !status.revoked && recording.length > 0 && (
        <Notice tone="plain" title="What this computer records">
          {recording.map((item) => item.title).join(" · ")}. Nothing else is collected from this
          machine.
        </Notice>
      )}
    </Shell>
  );
}
