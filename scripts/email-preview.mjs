#!/usr/bin/env node
/**
 * Render every email to `.tmp-email/` and open them in a browser.
 *
 *   node scripts/email-preview.mjs
 *
 * Copy is not something you can review in a code diff. These messages go to the people
 * this product monitors — usually at the moment they learn something changed about what
 * is recorded on their own laptop — and the difference between a sentence that reads as
 * a notification and one that reads as a warning is not visible in a template literal.
 *
 * Needs no RESEND_API_KEY and sends nothing. It imports the same template functions the
 * API calls, so what you see here is byte-identical to what would arrive.
 *
 * `.tmp-*` is already gitignored.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "apps/api/dist/lib/email/templates.js");

let templates;
try {
  templates = await import(`file://${dist}`);
} catch {
  console.error(
    "Build the API first so the templates are compiled:\n\n  pnpm --filter @aems/api... build\n",
  );
  process.exit(1);
}

const context = {
  recipientName: "Sam Patel",
  companyName: "Acme Corp",
  dashboardUrl: "http://localhost:3000",
};

// Deliberately unflattering samples: a long device label, a change in both directions,
// and a password with the characters that break naive HTML. If the copy survives these
// it survives the real ones.
const messages = [
  [
    "collection-changed",
    templates.collectionChangedEmail(context, {
      deviceLabel: "SAM-THINKPAD-X1-FIELD",
      changedByName: "Ada Admin",
      changes: [
        { label: "Location", enabled: true },
        { label: "Screenshots", enabled: false },
        { label: "Websites", enabled: false },
      ],
    }),
  ],
  [
    "collection-changed-single",
    templates.collectionChangedEmail(context, {
      deviceLabel: "Pixel 8",
      changedByName: "Marcus Manager",
      changes: [{ label: "Screenshots", enabled: false }],
    }),
  ],
  [
    "account-created",
    templates.accountCreatedEmail(context, {
      temporaryPassword: "K7p2-9wQx-4m<>&",
      createdByName: "ada@acme.test",
    }),
  ],
  [
    "device-enrolled",
    templates.deviceEnrolledEmail(context, {
      deviceLabel: "SAM-THINKPAD-X1-FIELD",
      platform: "Windows",
      recordedLabels: ["Applications", "Screenshots", "Idle time", "Battery, network and storage"],
    }),
  ],
  [
    "browser-extension-linked",
    templates.browserExtensionLinkedEmail(context, {
      deviceLabel: "SAM-THINKPAD-X1-FIELD",
    }),
  ],
];

const out = path.join(root, ".tmp-email");
mkdirSync(out, { recursive: true });

const index = [];
for (const [name, message] of messages) {
  writeFileSync(path.join(out, `${name}.html`), message.html, "utf8");
  writeFileSync(path.join(out, `${name}.txt`), `Subject: ${message.subject}\n\n${message.text}`, "utf8");
  index.push({ name, subject: message.subject });
  console.log(`  ${name}`);
  console.log(`    subject: ${message.subject}`);
}

// One page linking the rest, because reviewing four files is four times the friction of
// reviewing one — and the plain-text part is the half that usually goes unread.
writeFileSync(
  path.join(out, "index.html"),
  `<!doctype html><meta charset="utf-8"><title>AEMS emails</title>
<body style="font-family:system-ui;max-width:760px;margin:40px auto;padding:0 20px;color:#0f172a">
<h1 style="font-size:20px">AEMS emails</h1>
<p style="color:#475569;font-size:14px">Rendered from the same functions the API calls. Nothing was sent.</p>
${index
  .map(
    (m) =>
      `<p style="margin:18px 0"><strong>${m.subject}</strong><br>
       <a href="./${m.name}.html">HTML</a> &middot; <a href="./${m.name}.txt">plain text</a></p>`,
  )
  .join("")}
</body>`,
  "utf8",
);

console.log(`\nOpen: ${path.join(out, "index.html")}`);
