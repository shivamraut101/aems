import type { EmailMessage } from "./mailer.js";

/**
 * Every email this product sends, and the words in them.
 *
 * ## Why the copy is part of the code review
 *
 * These are read by the people being monitored, usually at the moment they learn
 * something changed about what is recorded on their own laptop. `docs/design.md` rules
 * out surveillance framing, and an email is where that rule is hardest to keep and
 * easiest to break — "your device has been updated" is the sentence that turns a
 * workforce tool into something people warn each other about.
 *
 * Three rules, applied to all of them:
 *
 * - **Say what changed, specifically.** "Screenshots are no longer recorded" is a fact
 *   somebody can check. "Your settings were updated" is an invitation to assume the
 *   worst, and people do.
 * - **Name the person.** Every one of these is the result of a human decision, and an
 *   unattributed change to monitoring reads as the system doing it on its own. There is
 *   always somebody to ask.
 * - **Never ask them to act on something they cannot act on.** No "contact support" for
 *   a decision their own manager made.
 *
 * ## Why the HTML is hand-written and inline-styled
 *
 * No template engine and no CSS classes. Mail clients strip `<style>` blocks — Gmail
 * removes them in some contexts and keeps them in others — so inline attributes are the
 * only styling that survives everywhere. A table-based layout for the same reason:
 * Outlook renders with Word's engine, which does not do flexbox.
 *
 * Colours are `docs/design.md`'s: navy #0F172A, slate for secondary text. Indigo is
 * absent, as everywhere — it is reserved for AI surfaces and none of these are one.
 */

/** Everything a template needs about who it is writing to and where to send them. */
export interface EmailContext {
  /** The employee's own name. Falls back to the local part of their address. */
  recipientName: string;
  companyName: string;
  /** The dashboard origin, no trailing slash. Links are absolute — email has no base. */
  dashboardUrl: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The chrome every message shares: wordmark, white card, footer.
 *
 * `max-width: 560px` because a line of body text longer than about 75 characters is
 * measurably harder to read, and mail clients will happily render 1200px wide.
 */
function layout(heading: string, bodyHtml: string, context: EmailContext): string {
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f8fafc;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
        <tr><td style="padding-bottom:20px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
          <span style="font-size:15px;font-weight:600;color:#0f172a;letter-spacing:-0.01em;">AEMS</span>
          <span style="font-size:11px;color:#64748b;letter-spacing:0.08em;text-transform:uppercase;margin-left:8px;">Workforce Intelligence</span>
        </td></tr>
        <tr><td style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:28px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
          <h1 style="margin:0 0 14px;font-size:18px;font-weight:600;color:#0f172a;line-height:1.35;">${escapeHtml(heading)}</h1>
          ${bodyHtml}
        </td></tr>
        <tr><td style="padding-top:18px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:12px;color:#64748b;line-height:1.6;">
          Sent by AEMS for ${escapeHtml(context.companyName)}. You can see everything recorded about you, and withdraw your consent at any time, from
          <a href="${context.dashboardUrl}/my-devices" style="color:#0f172a;">your own devices page</a>.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

const P = 'style="margin:0 0 12px;font-size:14px;color:#334155;line-height:1.6;"';

function button(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0 4px;"><tr><td style="background:#0f172a;border-radius:6px;">
    <a href="${href}" style="display:inline-block;padding:10px 18px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;font-weight:500;color:#ffffff;text-decoration:none;">${escapeHtml(label)}</a>
  </td></tr></table>`;
}

/** One data type that changed, as the employee should read it. */
export interface CollectionChange {
  /** The employee-facing label — "Screenshots", not "screenshots". */
  label: string;
  enabled: boolean;
}

/**
 * An administrator changed what a device records.
 *
 * The one email the client asked for by name. It exists because a change to monitoring
 * that the monitored person learns about by accident is the thing that destroys trust
 * in a product like this — and because non-negotiable #1 makes consent the basis of
 * collection, so a change to its scope is a change to what they agreed to.
 *
 * Additions are listed before removals, deliberately. Somebody skimming this needs to
 * see what is *newly* recorded first; what stopped being recorded is welcome news and
 * can wait three lines.
 */
export function collectionChangedEmail(
  context: EmailContext,
  input: {
    deviceLabel: string;
    changedByName: string;
    changes: readonly CollectionChange[];
  },
): EmailMessage {
  const turnedOn = input.changes.filter((c) => c.enabled).map((c) => c.label);
  const turnedOff = input.changes.filter((c) => !c.enabled).map((c) => c.label);

  const list = (items: readonly string[]) =>
    `<ul style="margin:0 0 12px;padding-left:20px;font-size:14px;color:#334155;line-height:1.7;">${items
      .map((i) => `<li>${escapeHtml(i)}</li>`)
      .join("")}</ul>`;

  const html = layout(
    `What ${input.deviceLabel} records has changed`,
    `<p ${P}>Hello ${escapeHtml(context.recipientName)},</p>
     <p ${P}><strong style="color:#0f172a;">${escapeHtml(input.changedByName)}</strong> changed what is recorded on <strong style="color:#0f172a;">${escapeHtml(input.deviceLabel)}</strong>.</p>
     ${turnedOn.length > 0 ? `<p ${P}>Now recorded:</p>${list(turnedOn)}` : ""}
     ${turnedOff.length > 0 ? `<p ${P}>No longer recorded:</p>${list(turnedOff)}` : ""}
     <p ${P}>Everything else stays as it was. You can see the full list for every device assigned to you, and withdraw your consent, at any time.</p>
     ${button(`${context.dashboardUrl}/my-devices`, "See what is recorded")}
     <p style="margin:16px 0 0;font-size:13px;color:#64748b;line-height:1.6;">If this is unexpected, ${escapeHtml(input.changedByName)} is the person to ask.</p>`,
    context,
  );

  const text = [
    `Hello ${context.recipientName},`,
    ``,
    `${input.changedByName} changed what is recorded on ${input.deviceLabel}.`,
    ...(turnedOn.length > 0 ? ["", "Now recorded:", ...turnedOn.map((i) => `  - ${i}`)] : []),
    ...(turnedOff.length > 0
      ? ["", "No longer recorded:", ...turnedOff.map((i) => `  - ${i}`)]
      : []),
    ``,
    `Everything else stays as it was. See the full list for every device assigned to you,`,
    `and withdraw your consent at any time:`,
    `${context.dashboardUrl}/my-devices`,
    ``,
    `If this is unexpected, ${input.changedByName} is the person to ask.`,
  ].join("\n");

  return {
    to: "",
    // Names the device, so somebody with a laptop and two phones knows which without
    // opening it — and so a thread about one machine does not collect the others.
    subject: `What ${input.deviceLabel} records has changed`,
    html,
    text,
  };
}

/**
 * A Windows computer started being able to report the addresses of pages opened in a
 * browser.
 *
 * The one change to collection that nobody signs off. Windows exposes no supported way
 * to read a browser's address bar, so the consent an employee accepted on a Windows
 * laptop says in as many words that no website activity is recorded from it — and a
 * managed browser extension arriving makes that sentence false without changing the
 * policy version, so nothing re-opens the consent gate. They can find it on their own
 * devices page afterwards, but discovery is not disclosure.
 *
 * No actor is named, unlike every other template here, and that is not an oversight: an
 * extension is force-installed by browser policy rather than by somebody pressing a
 * button, so there is no name to put in and inventing one would be worse than pointing
 * at the two people who can answer for it.
 */
export function browserExtensionLinkedEmail(
  context: EmailContext,
  input: { deviceLabel: string },
): EmailMessage {
  const html = layout(
    `${input.deviceLabel} now records the websites you visit`,
    `<p ${P}>Hello ${escapeHtml(context.recipientName)},</p>
     <p ${P}>Until now, <strong style="color:#0f172a;">${escapeHtml(input.deviceLabel)}</strong> could not report the addresses of pages you opened in a browser — Windows gives the AEMS agent no way to read them. The managed AEMS browser extension is now installed there, and it can.</p>
     <p ${P}>From now on, that computer records the domain of the page in your active tab — github.com, for example — and how long you spend there. It does not record what is on the page, what you type, or anything you open in a browser the extension is not installed in.</p>
     <p ${P}>Nothing else about what is recorded has changed, and you can withdraw your consent for this device at any time.</p>
     ${button(`${context.dashboardUrl}/my-devices`, "See what is recorded")}
     <p style="margin:16px 0 0;font-size:13px;color:#64748b;line-height:1.6;">If this is unexpected, your IT administrator or your manager installed it and is the person to ask.</p>`,
    context,
  );

  const text = [
    `Hello ${context.recipientName},`,
    ``,
    `Until now, ${input.deviceLabel} could not report the addresses of pages you opened in a`,
    `browser - Windows gives the AEMS agent no way to read them. The managed AEMS browser`,
    `extension is now installed there, and it can.`,
    ``,
    `From now on, that computer records the domain of the page in your active tab -`,
    `github.com, for example - and how long you spend there. It does not record what is on`,
    `the page, what you type, or anything you open in a browser the extension is not`,
    `installed in.`,
    ``,
    `Nothing else about what is recorded has changed, and you can withdraw your consent for`,
    `this device at any time:`,
    `${context.dashboardUrl}/my-devices`,
    ``,
    `If this is unexpected, your IT administrator or your manager installed it and is the`,
    `person to ask.`,
  ].join("\n");

  return {
    to: "",
    subject: `${input.deviceLabel} now records the websites you visit`,
    html,
    text,
  };
}

/**
 * A new account, with the password that opens it.
 *
 * This exists to close a gap the role walkthrough found: `POST /api/employees` mints a
 * temporary password and shows it to the admin exactly once, who then reads it out or
 * pastes it into a chat. The credential reaches the employee through a third party and
 * a channel nobody controls, and that is the status quo this replaces.
 *
 * It says the password must be changed because it will be — the middleware holds the
 * account on /set-password until it is. Telling them beforehand turns a forced step
 * into an expected one.
 */
export function accountCreatedEmail(
  context: EmailContext,
  input: { temporaryPassword: string; createdByName: string },
): EmailMessage {
  const html = layout(
    `Your ${context.companyName} monitoring account`,
    `<p ${P}>Hello ${escapeHtml(context.recipientName)},</p>
     <p ${P}><strong style="color:#0f172a;">${escapeHtml(input.createdByName)}</strong> created an AEMS account for you. AEMS records activity on company devices, and you can always read everything it holds about you.</p>
     <p ${P}>Sign in with this temporary password:</p>
     <p style="margin:0 0 14px;padding:12px 14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:16px;color:#0f172a;letter-spacing:0.03em;">${escapeHtml(input.temporaryPassword)}</p>
     <p ${P}>You will be asked to replace it the moment you sign in — this one was created for you, so it is not private.</p>
     ${button(`${context.dashboardUrl}/login`, "Sign in")}`,
    context,
  );

  const text = [
    `Hello ${context.recipientName},`,
    ``,
    `${input.createdByName} created an AEMS account for you. AEMS records activity on`,
    `company devices, and you can always read everything it holds about you.`,
    ``,
    `Sign in with this temporary password:`,
    ``,
    `    ${input.temporaryPassword}`,
    ``,
    `You will be asked to replace it the moment you sign in - this one was created for`,
    `you, so it is not private.`,
    ``,
    `${context.dashboardUrl}/login`,
  ].join("\n");

  return {
    to: "",
    subject: `Your ${context.companyName} monitoring account`,
    html,
    text,
  };
}

/**
 * A device was enrolled under this person's name.
 *
 * Not asked for, and included because non-negotiable #2 is that monitoring is never
 * silent. A machine beginning to record under somebody's name is the single most
 * important thing they could be told, and until now the only signal was a tray icon on
 * a computer they might not be holding.
 */
export function deviceEnrolledEmail(
  context: EmailContext,
  input: { deviceLabel: string; platform: string; recordedLabels: readonly string[] },
): EmailMessage {
  const list = `<ul style="margin:0 0 12px;padding-left:20px;font-size:14px;color:#334155;line-height:1.7;">${input.recordedLabels
    .map((i) => `<li>${escapeHtml(i)}</li>`)
    .join("")}</ul>`;

  const html = layout(
    `${input.deviceLabel} is now enrolled`,
    `<p ${P}>Hello ${escapeHtml(context.recipientName)},</p>
     <p ${P}><strong style="color:#0f172a;">${escapeHtml(input.deviceLabel)}</strong> (${escapeHtml(input.platform)}) has been enrolled under your name and has started recording.</p>
     <p ${P}>On this device, AEMS records:</p>
     ${list}
     <p ${P}>Nothing else. You can see what has been recorded, and withdraw your consent for this device, at any time.</p>
     ${button(`${context.dashboardUrl}/my-devices`, "See what is recorded")}`,
    context,
  );

  const text = [
    `Hello ${context.recipientName},`,
    ``,
    `${input.deviceLabel} (${input.platform}) has been enrolled under your name and has`,
    `started recording.`,
    ``,
    `On this device, AEMS records:`,
    ...input.recordedLabels.map((i) => `  - ${i}`),
    ``,
    `Nothing else. See what has been recorded, and withdraw your consent for this device,`,
    `at any time:`,
    `${context.dashboardUrl}/my-devices`,
  ].join("\n");

  return { to: "", subject: `${input.deviceLabel} is now enrolled`, html, text };
}

/** The local part of an address, for when a profile has no name on it. */
export function nameOrEmail(fullName: string | null | undefined, email: string): string {
  const trimmed = fullName?.trim();
  if (trimmed) return trimmed;
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}
