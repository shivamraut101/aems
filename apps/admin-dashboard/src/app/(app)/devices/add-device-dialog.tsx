"use client";

import { Check, Copy, Loader2, MonitorSmartphone, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@aems/ui";

import { describeError, useApiQuery, useSession } from "@/lib/api";
import { isDeactivated } from "@/lib/queries/employees-form";
import { expiryLabel, useCreateEnrollmentCode } from "@/lib/queries/enrollment";

import { employeesQuery } from "./queries";

/**
 * "Bind this to my own account".
 *
 * A named default rather than `""`: Radix refuses an empty `SelectItem` value, and the
 * empty string previously left the trigger showing its placeholder while the request it
 * would send was already decided — a control whose displayed state and its meaning are
 * only accidentally the same.
 */
const SELF = "self";

/**
 * Add device — the screen the agent has always told people to open.
 *
 * Until this existed, enrolling meant pasting a Supabase access token into the agent:
 * 800 characters of JWT, granting the account's full rights for an hour, that no
 * screen in the product ever displayed. There was no answer to "where do I get this",
 * because there was nowhere to get it.
 *
 * A code is the answer. Eight characters, one enrolment, ten minutes, and it can be
 * read down a phone line to someone setting up their own laptop.
 */
export function AddDeviceDialog({ onClose }: { onClose: () => void }) {
  const { data: session } = useSession();
  // The same spec the devices page prefetches, so opening this dialog costs no request.
  const { data: employees } = useApiQuery(employeesQuery);
  const mint = useCreateEnrollmentCode();

  // Managers and admins pick a person; an employee can only ever enrol their own
  // machine, so they are not asked a question with one answer.
  const canChoose = session?.role === "manager" || session?.role === "super_admin";
  const [profileId, setProfileId] = useState(SELF);

  const code = mint.data ?? null;

  return (
    // Controlled and always open: the dialog only exists while the parent renders it,
    // so dismissing it means unmounting rather than flipping a second piece of state.
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{code ? "Sign-in code" : "Add a device"}</DialogTitle>
          <DialogDescription>
            {code
              ? "Type this into the AEMS agent on the machine you are setting up."
              : "Generates a one-time code that binds a computer to an employee. Nothing is collected until the person accepts the monitoring policy on that machine."}
          </DialogDescription>
        </DialogHeader>

        {code ? (
          <CodeStep code={code.code} expiresAt={code.expiresAt} who={code.fullName || code.email} onClose={onClose} />
        ) : (
          <>
            {canChoose ? (
              <Field label="Employee">
                {(field) => (
                  <Select value={profileId} onValueChange={setProfileId}>
                    <SelectTrigger {...field}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={SELF}>Myself</SelectItem>
                      {/* Off-boarded people are excluded: the API refuses a code for
                          them, so offering the name would only produce a 409. */}
                      {(employees ?? [])
                        .filter((person) => !isDeactivated(person))
                        .map((person) => (
                          <SelectItem key={person.id} value={person.id}>
                            {person.full_name || person.email}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                )}
              </Field>
            ) : (
              <p className="text-sm text-muted-foreground">
                The code will bind the machine to your own account.
              </p>
            )}

            {mint.isError ? (
              <p
                role="alert"
                className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm"
              >
                {describeError(mint.error)}
              </p>
            ) : null}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="button"
                disabled={mint.isPending}
                onClick={() => mint.mutate(profileId === SELF ? {} : { profileId })}
              >
                {mint.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <MonitorSmartphone className="h-4 w-4" aria-hidden />
                )}
                Generate code
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CodeStep({
  code,
  expiresAt,
  who,
  onClose,
}: {
  code: string;
  expiresAt: string;
  who: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  // Ticks the countdown. Without it the dialog would keep claiming "expires in 10
  // minutes" for the whole ten, and be confidently wrong for the last nine of them.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const expired = Date.parse(expiresAt) <= now;

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused; the code is on screen to be typed anyway,
      // and a failed copy is not worth an error banner over.
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        For <span className="font-medium text-foreground">{who}</span>
      </p>

      <div className="rounded-lg border bg-secondary/40 p-4 text-center sm:p-5">
        <p className="tabular select-all break-all text-[clamp(22px,7vw,30px)] font-semibold tracking-[0.12em]">{code}</p>
        <p className={`mt-2 text-xs ${expired ? "text-destructive" : "text-muted-foreground"}`}>
          {expiryLabel(expiresAt, now)}
        </p>
      </div>

      <ol className="space-y-1.5 text-sm text-muted-foreground">
        <li>1. Open the AEMS agent on the employee's computer.</li>
        <li>2. Type the code above into the sign-in box.</li>
        <li>3. They read the monitoring policy and accept it there.</li>
      </ol>

      <p className="text-xs text-muted-foreground">
        The code works once. It is not stored and cannot be shown again — generate
        another if it is lost or expires.
      </p>

      <DialogFooter className="mt-2">
        <Button type="button" variant="outline" onClick={() => void copy()}>
          {copied ? (
            <Check className="h-4 w-4 text-[hsl(var(--success))]" aria-hidden />
          ) : (
            <Copy className="h-4 w-4" aria-hidden />
          )}
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button type="button" onClick={onClose}>
          {expired ? <RefreshCw className="h-4 w-4" aria-hidden /> : null}
          Done
        </Button>
      </DialogFooter>
    </div>
  );
}
