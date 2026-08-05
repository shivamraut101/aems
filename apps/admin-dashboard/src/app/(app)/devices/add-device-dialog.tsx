"use client";

import { Check, Copy, Loader2, MonitorSmartphone, RefreshCw } from "lucide-react";
import { useEffect, useId, useState } from "react";

import {
  Dialog,
  Field,
  FormError,
  controlClass,
  primaryButtonClass,
  secondaryButtonClass,
} from "@/components/dialog";
import { describeError, useEmployees, useSession } from "@/lib/api";
import { isDeactivated } from "@/lib/queries/employees-form";
import { expiryLabel, useCreateEnrollmentCode } from "@/lib/queries/enrollment";

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
  const { data: employees } = useEmployees();
  const mint = useCreateEnrollmentCode();

  const selectId = useId();
  // Managers and admins pick a person; an employee can only ever enrol their own
  // machine, so they are not asked a question with one answer.
  const canChoose = session?.role === "manager" || session?.role === "super_admin";
  const [profileId, setProfileId] = useState("");

  const code = mint.data ?? null;

  return (
    <Dialog
      title={code ? "Sign-in code" : "Add a device"}
      description={
        code
          ? "Type this into the AEMS agent on the machine you are setting up."
          : "Generates a one-time code that binds a computer to an employee. Nothing is collected until the person accepts the monitoring policy on that machine."
      }
      onClose={onClose}
    >
      {code ? (
        <CodeStep code={code.code} expiresAt={code.expiresAt} who={code.fullName || code.email} onClose={onClose} />
      ) : (
        <>
          {canChoose ? (
            <Field label="Employee" htmlFor={selectId}>
              <select
                id={selectId}
                className={controlClass}
                value={profileId}
                onChange={(event) => setProfileId(event.target.value)}
              >
                <option value="">Myself</option>
                {/* Off-boarded people are excluded: the API refuses a code for them,
                    so offering the name would only produce a 409 after a click. */}
                {(employees ?? [])
                  .filter((person) => !isDeactivated(person))
                  .map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.full_name || person.email}
                    </option>
                  ))}
              </select>
            </Field>
          ) : (
            <p className="text-sm text-muted-foreground">
              The code will bind the machine to your own account.
            </p>
          )}

          {mint.isError ? <FormError message={describeError(mint.error)} /> : null}

          <div className="mt-5 flex justify-end gap-2">
            <button type="button" className={secondaryButtonClass} onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className={primaryButtonClass}
              disabled={mint.isPending}
              onClick={() => mint.mutate(profileId ? { profileId } : {})}
            >
              {mint.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <MonitorSmartphone className="h-4 w-4" aria-hidden />
              )}
              Generate code
            </button>
          </div>
        </>
      )}
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
    <div>
      <p className="text-sm text-muted-foreground">
        For <span className="font-medium text-foreground">{who}</span>
      </p>

      <div className="mt-3 rounded-lg border bg-secondary/40 p-5 text-center">
        <p className="tabular select-all text-[30px] font-semibold tracking-[0.12em]">{code}</p>
        <p className={`mt-2 text-xs ${expired ? "text-destructive" : "text-muted-foreground"}`}>
          {expiryLabel(expiresAt, now)}
        </p>
      </div>

      <ol className="mt-4 space-y-1.5 text-sm text-muted-foreground">
        <li>1. Open the AEMS agent on the employee's computer.</li>
        <li>2. Type the code above into the sign-in box.</li>
        <li>3. They read the monitoring policy and accept it there.</li>
      </ol>

      <p className="mt-3 text-xs text-muted-foreground">
        The code works once. It is not stored and cannot be shown again — generate
        another if it is lost or expires.
      </p>

      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className={secondaryButtonClass} onClick={copy}>
          {copied ? (
            <Check className="h-4 w-4 text-[hsl(var(--success))]" aria-hidden />
          ) : (
            <Copy className="h-4 w-4" aria-hidden />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
        <button type="button" className={primaryButtonClass} onClick={onClose}>
          {expired ? <RefreshCw className="h-4 w-4" aria-hidden /> : null}
          Done
        </button>
      </div>
    </div>
  );
}
