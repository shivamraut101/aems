import { describe, expect, it } from "vitest";

import { recordingMailer, resendMailer } from "./mailer.js";
import {
  accountCreatedEmail,
  collectionChangedEmail,
  deviceEnrolledEmail,
  nameOrEmail,
} from "./templates.js";

/**
 * These emails go to the people this product monitors, at the moment they learn
 * something changed about what is recorded on their own machine. The failures worth
 * testing are not layout ones — they are a message that says the wrong thing, leaks
 * something, or arrives unreadable.
 */

const context = {
  recipientName: "Sam Patel",
  companyName: "Acme Corp",
  dashboardUrl: "https://aems.example.com",
};

describe("collectionChangedEmail", () => {
  const message = collectionChangedEmail(context, {
    deviceLabel: "SAM-LAPTOP",
    changedByName: "Ada Admin",
    changes: [
      { label: "Screenshots", enabled: false },
      { label: "Location", enabled: true },
    ],
  });

  it("names the device in the subject", () => {
    // Somebody with a laptop and two phones has to know which one without opening it,
    // and a thread about one machine should not collect the others.
    expect(message.subject).toContain("SAM-LAPTOP");
  });

  it("names the person who decided, in both parts", () => {
    // An unattributed change to monitoring reads as the system doing it on its own.
    // There is always somebody to ask, and the mail has to say who.
    expect(message.html).toContain("Ada Admin");
    expect(message.text).toContain("Ada Admin");
  });

  it("separates what started from what stopped", () => {
    expect(message.text).toContain("Now recorded:");
    expect(message.text).toContain("  - Location");
    expect(message.text).toContain("No longer recorded:");
    expect(message.text).toContain("  - Screenshots");
  });

  it("links somewhere the reader can act", () => {
    expect(message.html).toContain("https://aems.example.com/my-devices");
    expect(message.text).toContain("https://aems.example.com/my-devices");
  });

  it("always writes a plain-text part", () => {
    // A mail with no text part lands in spam far more often and is unreadable to
    // anyone whose client blocks HTML - which in a corporate estate is not rare.
    expect(message.text.length).toBeGreaterThan(80);
  });

  it("omits the section that has nothing in it", () => {
    const only = collectionChangedEmail(context, {
      deviceLabel: "SAM-LAPTOP",
      changedByName: "Ada Admin",
      changes: [{ label: "Screenshots", enabled: false }],
    });

    expect(only.text).toContain("No longer recorded:");
    expect(only.text).not.toContain("Now recorded:");
  });
});

describe("accountCreatedEmail", () => {
  const message = accountCreatedEmail(context, {
    temporaryPassword: "K7p2-9wQx-4m",
    createdByName: "ada@acme.test",
  });

  it("carries the password in both parts", () => {
    // The whole point of the mail. If it renders in only one, half the recipients get
    // an email telling them to sign in and not saying how.
    expect(message.html).toContain("K7p2-9wQx-4m");
    expect(message.text).toContain("K7p2-9wQx-4m");
  });

  it("warns that it must be replaced", () => {
    // The middleware will hold them on /set-password regardless. Saying so first turns
    // a forced step into an expected one.
    expect(message.text.toLowerCase()).toContain("replace");
  });
});

describe("deviceEnrolledEmail", () => {
  it("lists exactly what that device records, and says nothing else is", () => {
    const message = deviceEnrolledEmail(context, {
      deviceLabel: "Pixel 8",
      platform: "Android",
      recordedLabels: ["Applications", "Location"],
    });

    expect(message.text).toContain("  - Applications");
    expect(message.text).toContain("  - Location");
    // Non-negotiable #1: consent is to a specific scope. "And nothing else" is the
    // half of that sentence a monitoring product is tempted to leave off.
    expect(message.text).toContain("Nothing else");
  });
});

describe("html safety", () => {
  it("escapes a name that contains markup", () => {
    // Names come from `profiles.full_name`, which an admin types. A device label comes
    // from the agent. Neither is trusted input in an HTML document.
    const message = collectionChangedEmail(
      { ...context, recipientName: '<script>alert(1)</script>' },
      { deviceLabel: '"><img src=x>', changedByName: "Ada", changes: [{ label: "Screenshots", enabled: false }] },
    );

    expect(message.html).not.toContain("<script>");
    expect(message.html).toContain("&lt;script&gt;");
    expect(message.html).not.toContain('"><img src=x>');
  });
});

describe("nameOrEmail", () => {
  it("prefers a real name", () => {
    expect(nameOrEmail("Sam Patel", "sam@acme.test")).toBe("Sam Patel");
  });

  it("falls back to the local part rather than greeting an address", () => {
    // "Hello sam@acme.test," reads as generated. A profile with no name still has to
    // be addressed as a person.
    expect(nameOrEmail(null, "sam@acme.test")).toBe("sam");
    expect(nameOrEmail("   ", "sam@acme.test")).toBe("sam");
  });
});

describe("recordingMailer", () => {
  it("reports not-configured rather than pretending to have sent", async () => {
    // The failure this prevents: a company discovering months later that nobody was
    // ever told anything, because an unconfigured mailer returned success.
    const result = await recordingMailer().send({
      to: "sam@acme.test",
      subject: "x",
      html: "<p>x</p>",
      text: "x",
    });

    expect(result).toEqual({
      ok: false,
      reason: "not-configured",
      detail: "RESEND_API_KEY is not set",
    });
  });

  it("is honest about not being configured", () => {
    expect(recordingMailer().configured).toBe(false);
  });
});

describe("resendMailer", () => {
  it("never throws, whatever the network does", async () => {
    // Every caller is doing something else - creating an employee, changing a policy.
    // A mailbox that bounces must not roll back an account that was created.
    const original = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(new Error("ECONNREFUSED"));

    try {
      const result = await resendMailer("key", "AEMS <n@a.test>").send({
        to: "sam@acme.test",
        subject: "x",
        html: "<p>x</p>",
        text: "x",
      });
      expect(result).toEqual({ ok: false, reason: "unreachable", detail: "ECONNREFUSED" });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("reports a refusal without raising it", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve(new Response("domain not verified", { status: 403 }));

    try {
      const result = await resendMailer("key", "AEMS <n@a.test>").send({
        to: "sam@acme.test",
        subject: "x",
        html: "<p>x</p>",
        text: "x",
      });
      expect(result.ok).toBe(false);
      // The commonest real failure by far, and the one no env var fixes.
      if (!result.ok) expect(result.detail).toContain("domain not verified");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("sends both parts and the configured From", async () => {
    const original = globalThis.fetch;
    let body: Record<string, unknown> = {};
    globalThis.fetch = (_url, init) => {
      body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
      return Promise.resolve(new Response(JSON.stringify({ id: "re_1" }), { status: 200 }));
    };

    try {
      const result = await resendMailer("key", "AEMS <n@a.test>").send({
        to: "sam@acme.test",
        subject: "Subject",
        html: "<p>html</p>",
        text: "text",
      });

      expect(result).toEqual({ ok: true, id: "re_1" });
      expect(body["from"]).toBe("AEMS <n@a.test>");
      expect(body["to"]).toEqual(["sam@acme.test"]);
      expect(body["html"]).toBe("<p>html</p>");
      expect(body["text"]).toBe("text");
    } finally {
      globalThis.fetch = original;
    }
  });
});
