"use client";

import { Check, Copy, Loader2, MonitorSmartphone, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import {
  Button,
  CheckboxField,
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
import { PLATFORM_DATA_TYPES, type DataTypeId, type DevicePlatform } from "@aems/types";

import { describeError, useApiQuery, useSession } from "@/lib/api";
import { DATA_TYPE_LABEL } from "@/lib/queries/collection";
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

  /*
   * Held as the DENIED set, not the allowed one, so the empty default means "everything
   * this machine can do" — the same shape as the column it is written to and the same
   * rule as a missing settings row. An allowed set would have to be complete at mint
   * time, and this code does not know yet whether a laptop or a phone will redeem it.
   */
  // Windows first: it is the commonest enrolment and the one an admin reaches for
  // without thinking, so the default should not be the answer they have to change.
  const [platform, setPlatform] = useState<DevicePlatform>("windows");
  const [denied, setDenied] = useState<ReadonlySet<DataTypeId>>(() => new Set());

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
          <CodeStep
            code={code.code}
            expiresAt={code.expiresAt}
            who={code.fullName || code.email}
            // Back to the picker rather than straight to a second mint: `mutate` leaves
            // the dead code on screen while the new one is in flight, and the person a
            // code is being reissued for is exactly the thing worth re-confirming.
            onRegenerate={() => mint.reset()}
            onClose={onClose}
          />
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

            {/* Asked before the scope, because it decides what the scope can contain.
                A code is now bound to a kind of machine: redeeming a Windows code on a
                phone is refused, which is what stops a laptop's deny list being applied
                to a device with different capabilities. */}
            <Field label="Kind of device">
              {(field) => (
                <Select
                  value={platform}
                  onValueChange={(next) => {
                    setPlatform(next as DevicePlatform);
                    // Start clean. A type denied while "Windows" was selected is
                    // meaningless once the answer is "Android", and carrying it over
                    // would silently deny something the admin can no longer see.
                    setDenied(new Set());
                  }}
                >
                  <SelectTrigger {...field}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="windows">Windows laptop or desktop</SelectItem>
                    <SelectItem value="macos">Mac</SelectItem>
                    <SelectItem value="android">Android phone</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </Field>

            <CollectionScope platform={platform} denied={denied} onChange={setDenied} />

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
                onClick={() =>
                  mint.mutate({
                    ...(profileId === SELF ? {} : { profileId }),
                    deniedTypes: [...denied],
                  })
                }
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

/**
 * What the new machine may record — chosen here, and read by the employee there.
 *
 * Everything starts on. The default has to be "whatever this platform supports"
 * because that is what the database means by a missing row, and a dialog whose default
 * differed from the system's would make the two answers to "what does an untouched
 * device collect" disagree.
 *
 * The copy states, without hedging, that this exact list is what the person reads on
 * their own screen before they accept. That is not a nicety: the consent screen renders
 * from the same vocabulary in `@aems/types`, filtered to the permitted set, so a type
 * unticked here never appears in the promise the employee is asked to agree to — and a
 * promise wider than the collection, or narrower, is the defect this whole feature is
 * for.
 */
function CollectionScope({
  platform,
  denied,
  onChange,
}: {
  platform: DevicePlatform;
  denied: ReadonlySet<DataTypeId>;
  onChange: (next: ReadonlySet<DataTypeId>) => void;
}) {
  /*
   * Only what this kind of machine can actually report.
   *
   * This list used to be all seven types with a paragraph underneath apologising for
   * it — "a laptop takes no location, and a phone captures no screenshots or idle
   * time. Ticking those here does not make them happen." That is a UI admitting it
   * offers choices that do nothing, and it put the burden of knowing each platform's
   * limits on the admin. Asking which platform first turns seven checkboxes into the
   * three or four that are real, and the apology can go.
   */
  const offered = PLATFORM_DATA_TYPES[platform];

  function toggle(id: DataTypeId, on: boolean) {
    const next = new Set(denied);
    if (on) next.delete(id);
    else next.add(id);
    onChange(next);
  }

  return (
    <fieldset className="rounded-lg border px-4 py-3">
      <legend className="px-1 text-sm font-medium">What this device may collect</legend>
      <p className="text-xs text-muted-foreground">
        The employee reads this exact list on the machine before they accept the
        monitoring policy, and nothing outside it is collected. You can change it later
        from their Devices tab — switching something on afterwards asks them again.
      </p>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {offered.map((id) => (
          <CheckboxField
            key={id}
            label={DATA_TYPE_LABEL[id]}
            checked={!denied.has(id)}
            onCheckedChange={(state) => toggle(id, state === true)}
          />
        ))}
      </div>
    </fieldset>
  );
}

function CodeStep({
  code,
  expiresAt,
  who,
  onRegenerate,
  onClose,
}: {
  code: string;
  expiresAt: string;
  who: string;
  onRegenerate: () => void;
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
      <p className="break-words text-sm text-muted-foreground">
        For <span className="font-medium text-foreground">{who}</span>
      </p>

      <div className="rounded-lg border bg-secondary/40 p-4 text-center sm:p-5">
        {/* `select-all` so one click takes the whole code, `break-all` so a 390px phone
            wraps it rather than widening the dialog, and the clamp so it stays large
            enough to read aloud down a phone line at either width. */}
        <p className="tabular select-all break-all text-[clamp(22px,7vw,30px)] font-semibold tracking-[0.12em]">{code}</p>
        <p className={`mt-2 text-xs ${expired ? "text-destructive" : "text-muted-foreground"}`}>
          {expiryLabel(expiresAt, now)}
        </p>
      </div>

      <ol className="space-y-1.5 text-sm text-muted-foreground">
        <li>1. Open the AEMS agent on the employee&apos;s computer.</li>
        <li>2. Type the code above into the sign-in box.</li>
        <li>3. They read the monitoring policy and accept it there.</li>
      </ol>

      <p className="text-xs text-muted-foreground">
        The code works once. It is not stored and cannot be shown again — generate
        another if it is lost or expires.
      </p>

      {/* An expired code is offered neither Copy nor Done: copying a dead credential is
          a trap, and closing the dialog was the only way back to a live one — the
          refresh icon on "Done" promised a reissue the button never performed. */}
      <DialogFooter className="mt-2">
        {expired ? (
          <>
            <Button type="button" variant="outline" onClick={onClose}>
              Close
            </Button>
            <Button type="button" onClick={onRegenerate}>
              <RefreshCw className="h-4 w-4" aria-hidden />
              Generate another
            </Button>
          </>
        ) : (
          <>
            <Button type="button" variant="outline" onClick={() => void copy()}>
              {copied ? (
                <Check className="h-4 w-4 text-success" aria-hidden />
              ) : (
                <Copy className="h-4 w-4" aria-hidden />
              )}
              {copied ? "Copied" : "Copy"}
            </Button>
            <Button type="button" onClick={onClose}>
              Done
            </Button>
          </>
        )}
      </DialogFooter>
    </div>
  );
}
