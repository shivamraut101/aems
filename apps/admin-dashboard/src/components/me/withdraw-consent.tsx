"use client";

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@aems/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Loader2 } from "lucide-react";
import { useState } from "react";

import { ApiError, apiFetch, describeError } from "@/lib/api";

import { consentKey, withdrawalConsequences, WITHDRAWAL_TAKES_EFFECT } from "./consent";

/**
 * Withdrawing consent for one device.
 *
 * `POST /api/auth/consent/:deviceId/revoke` has existed since the API was written and
 * nothing in the product called it. Non-negotiables 1 and 4 — no collection without
 * consent, and revocation is immediate — described a right the person could not
 * exercise, which makes this a compliance gap rather than a missing feature.
 *
 * ## What the confirmation has to do
 *
 * State the consequence before it is caused. "Are you sure?" is not a confirmation of
 * anything; the reader has to be able to predict what stops, what does not, when it
 * takes effect, and how to undo it. Those four are `withdrawalConsequences` and
 * `WITHDRAWAL_TAKES_EFFECT`, which are pure and asserted in `consent.test.ts`.
 *
 * The tone is deliberately flat. This is the employee's own right, so the dialog must
 * not read as a warning against using it — but nor may it hide that recorded data is
 * kept and that re-consent happens on the device, because both of those are what people
 * are surprised by afterwards.
 *
 * On Radix through `@aems/ui`, like `devices/add-device-dialog.tsx`: focus trap,
 * Escape, scroll lock and focus restoration come from the primitive rather than being
 * reimplemented per screen. `DialogContent` owns its own padding, so nothing here adds
 * any. Not `window.confirm`, which blocks the window, reads as a browser warning rather
 * than part of the product, and cannot state four paragraphs of consequence.
 */
export function WithdrawConsentDialog({
  deviceId,
  deviceTitle,
  platform,
  profileId,
  onClose,
}: {
  deviceId: string;
  deviceTitle: string;
  platform: string;
  profileId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [done, setDone] = useState(false);
  const consequences = withdrawalConsequences(platform);

  const withdraw = useMutation({
    mutationFn: () =>
      apiFetch<{ ok: true }>(`/api/auth/consent/${encodeURIComponent(deviceId)}/revoke`, {
        method: "POST",
      }),
    onSuccess: async () => {
      setDone(true);
      await refresh();
    },
    onError: async (error) => {
      // 404 is "no active consent for this device" — someone else got there first, or a
      // second click landed. The outcome the reader wanted is already true, so reporting
      // it as a failure would be wrong. Refresh and show the same success state.
      if (error instanceof ApiError && error.status === 404) {
        setDone(true);
        await refresh();
      }
    },
  });

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: consentKey(profileId) }),
      // Consent is what gates ingestion, so the device's own row and anything derived
      // from its collection are now describing a machine that has stopped.
      queryClient.invalidateQueries({ queryKey: ["devices"] }),
    ]);
  }

  const failed = withdraw.isError && !done;

  return (
    // Controlled and always open: the dialog exists only while the parent renders it,
    // so dismissing means unmounting rather than flipping a second piece of state.
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {done ? "Consent withdrawn" : `Withdraw consent for ${deviceTitle}`}
          </DialogTitle>
          <DialogDescription>
            {done
              ? "Collection from this device has stopped."
              : "Read what changes before you confirm. You can accept the policy again on the device itself."}
          </DialogDescription>
        </DialogHeader>

        {done ? (
          <>
            <p className="flex items-start gap-2 text-sm">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
              <span>
                Your consent for <span className="font-medium">{deviceTitle}</span> is withdrawn.{" "}
                {WITHDRAWAL_TAKES_EFFECT}
              </span>
            </p>
            <p className="text-sm text-muted-foreground">{consequences.resume}</p>
            <DialogFooter>
              <Button type="button" onClick={onClose}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <ConsequenceList
              title="What stops"
              tone="stops"
              items={consequences.stops}
              footnote={WITHDRAWAL_TAKES_EFFECT}
            />
            <ConsequenceList
              title="What does not change"
              tone="keeps"
              items={consequences.continues}
            />

            <p className="rounded-md border bg-secondary/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
              {consequences.resume}
            </p>

            {failed ? (
              <p
                role="alert"
                className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
                <span>{describeError(withdraw.error)}</span>
              </p>
            ) : null}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={onClose}
                disabled={withdraw.isPending}
              >
                Keep monitoring on
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={() => withdraw.mutate()}
                disabled={withdraw.isPending}
              >
                {withdraw.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                    Withdrawing
                  </>
                ) : (
                  "Withdraw consent"
                )}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ConsequenceList({
  title,
  tone,
  items,
  footnote,
}: {
  title: string;
  tone: "stops" | "keeps";
  items: readonly string[];
  footnote?: string;
}) {
  return (
    <div>
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
      <ul className="mt-1.5 space-y-1.5">
        {items.map((item) => (
          <li key={item} className="flex items-start gap-2 text-sm leading-relaxed">
            <span
              aria-hidden
              className={
                tone === "stops"
                  ? "mt-[0.45rem] h-1.5 w-1.5 shrink-0 rounded-full bg-destructive"
                  : "mt-[0.45rem] h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/60"
              }
            />
            <span>{item}</span>
          </li>
        ))}
      </ul>
      {footnote ? <p className="mt-1.5 text-xs text-muted-foreground">{footnote}</p> : null}
    </div>
  );
}
