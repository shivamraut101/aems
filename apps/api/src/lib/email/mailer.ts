import type { FastifyBaseLogger } from "fastify";

/**
 * Sending mail, behind one interface.
 *
 * Same shape as the AI layer and for the same reason: the provider is a detail, and
 * every call site should be able to stay ignorant of it. Resend today because it is an
 * HTTP API and needs no SMTP configuration anywhere; swapping it means writing one more
 * `Mailer` and changing the factory.
 *
 * ## Two rules the call sites depend on
 *
 * **Sending never throws.** Every caller here is doing something else — creating an
 * employee, changing a device policy — and the mail is a courtesy attached to it. A
 * mailbox that bounces must not roll back an account that was created, and a Resend
 * outage must not turn a working PATCH into a 500. Failures are logged and returned,
 * never raised.
 *
 * **Sending never blocks the answer.** See `sendInBackground`.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  /**
   * Required, not optional. A mail with no text part lands in spam far more often, and
   * is unreadable to anyone whose client blocks HTML — which in a corporate estate is
   * not the rare case. Every template in `templates.ts` writes both.
   */
  text: string;
}

export type SendResult =
  | { ok: true; id: string | null }
  | { ok: false; reason: "not-configured" | "rejected" | "unreachable"; detail: string };

export interface Mailer {
  send(message: EmailMessage): Promise<SendResult>;
  /** True when a real provider is behind this. Lets a route say "we have emailed them". */
  readonly configured: boolean;
}

/**
 * What runs when `RESEND_API_KEY` is unset.
 *
 * Deliberately not a silent no-op. An unconfigured mailer that returns success is how a
 * company discovers months later that nobody was ever told anything — so this logs the
 * full message at info level and reports `not-configured`, which the caller can surface.
 * It is also what makes the templates reviewable before a key exists: the rendered
 * subject and body land in the API log.
 */
export function recordingMailer(log?: FastifyBaseLogger): Mailer {
  return {
    configured: false,
    send(message) {
      log?.info(
        { to: message.to, subject: message.subject, chars: message.html.length },
        "[email] not sent - RESEND_API_KEY is unset",
      );
      return Promise.resolve({
        ok: false,
        reason: "not-configured",
        detail: "RESEND_API_KEY is not set",
      });
    },
  };
}

/**
 * Resend over its REST API rather than the `resend` npm package.
 *
 * One `fetch` against a documented endpoint, versus a dependency in a service that
 * already holds the service-role key. The package adds retry and typing this does not
 * need — sends here are fire-and-forget and already logged — and every dependency in
 * this process is one more thing with access to that key.
 */
export function resendMailer(
  apiKey: string,
  from: string,
  log?: FastifyBaseLogger,
): Mailer {
  return {
    configured: true,
    async send(message) {
      try {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from,
            to: [message.to],
            subject: message.subject,
            html: message.html,
            text: message.text,
          }),
          // A hung mail provider must not hold a request open. The caller has already
          // done the thing that mattered.
          signal: AbortSignal.timeout(10_000),
        });

        if (!response.ok) {
          const detail = (await response.text().catch(() => "")).slice(0, 300);
          log?.warn(
            { to: message.to, status: response.status, detail },
            "[email] resend refused the message",
          );
          return { ok: false, reason: "rejected", detail: `${String(response.status)} ${detail}` };
        }

        const body = (await response.json().catch(() => ({}))) as { id?: string };
        log?.info({ to: message.to, id: body.id }, "[email] sent");
        return { ok: true, id: body.id ?? null };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        log?.warn({ to: message.to, detail }, "[email] could not reach resend");
        return { ok: false, reason: "unreachable", detail };
      }
    },
  };
}

export function createMailer(
  env: { RESEND_API_KEY?: string | undefined; EMAIL_FROM: string },
  log?: FastifyBaseLogger,
): Mailer {
  return env.RESEND_API_KEY
    ? resendMailer(env.RESEND_API_KEY, env.EMAIL_FROM, log)
    : recordingMailer(log);
}

/**
 * Send without making the caller wait, and without letting a rejection escape.
 *
 * A PATCH that changes what a device collects should answer as soon as the database
 * agrees. Waiting on a mail provider would add its latency to every such request and
 * its outages to their error rate — for a notification whose value does not depend on
 * arriving within the request.
 *
 * The `void` and the `catch` are both load-bearing: an un-awaited promise that rejects
 * is an unhandled rejection, which in Node is a process-level event and, under some
 * configurations, a crash. `Mailer.send` already resolves rather than throwing; this is
 * the belt to that braces.
 */
export function sendInBackground(mailer: Mailer, message: EmailMessage, log?: FastifyBaseLogger): void {
  void mailer.send(message).catch((error: unknown) => {
    log?.warn({ to: message.to, error }, "[email] send threw, which Mailer should never do");
  });
}
