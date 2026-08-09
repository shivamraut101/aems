import { describe, expect, it } from "vitest";

import {
  browserLabel,
  connectionView,
  findRule,
  mayEnforce,
  mayReport,
  normaliseDomain,
  reportableUrl,
  toDynamicRules,
} from "./core.js";
import type { BridgeStateMessage, MonitoringState } from "./protocol.js";

function state(patch: Partial<BridgeStateMessage> = {}): BridgeStateMessage {
  return {
    v: 1,
    type: "state",
    monitoring: "collecting",
    policy: { version: "2026.08.01", name: "Standard" },
    rules: [],
    contact: null,
    websites: true,
    ...patch,
  };
}

describe("reportableUrl", () => {
  it("reports http and https, which are the only things anybody calls a website", () => {
    expect(reportableUrl("https://github.com/aems")).toBe("https://github.com/aems");
    expect(reportableUrl("http://intranet.local/wiki")).toBe("http://intranet.local/wiki");
  });

  it("reports nothing for a page that is not on the web", () => {
    // A local filename in a company activity record is collection nobody consented to.
    expect(reportableUrl("file:///C:/Users/x/salary.xlsx")).toBeNull();
    expect(reportableUrl("chrome://settings/passwords")).toBeNull();
    expect(reportableUrl("about:blank")).toBeNull();
    expect(reportableUrl("chrome-extension://abc/popup.html")).toBeNull();
    expect(reportableUrl("view-source:https://a.test/")).toBeNull();
  });

  it("reports nothing for an absent or unparseable address", () => {
    expect(reportableUrl(undefined)).toBeNull();
    expect(reportableUrl("")).toBeNull();
    expect(reportableUrl("not a url")).toBeNull();
  });

  it("drops an address past the length the agent will accept, rather than truncating one", () => {
    expect(reportableUrl(`https://a.test/${"x".repeat(2100)}`)).toBeNull();
  });
});

describe("the two gates", () => {
  const states: MonitoringState[] = ["collecting", "consent-required", "not-enrolled", "revoked"];

  it("reports only while consent is on file for the policy in force", () => {
    expect(states.filter((monitoring) => mayReport(state({ monitoring })))).toEqual(["collecting"]);
    // Nothing to report to.
    expect(mayReport(null)).toBe(false);
  });

  /**
   * The device's `websites` scope is one process further out than consent but the
   * argument is identical: the host discards every address, so continuing to transmit
   * them reads every URL for no permitted purpose — and the popup, which is the only
   * surface this extension has, would be telling the employee they are recorded.
   */
  it("stops reporting when the device's website scope is switched off", () => {
    expect(mayReport(state({ websites: false }))).toBe(false);
    expect(mayReport(state({ websites: true }))).toBe(true);
    // An agent too old to say permits, the same direction an absent scope takes on the
    // host side — over-reporting to a server that refuses it beats a silent blank day.
    expect(mayReport(state({ websites: undefined }))).toBe(true);
  });

  it("enforces wherever a policy exists to point at, and nowhere else", () => {
    // Restriction is a property of the device's policy rather than of consent to be
    // observed — but a machine with no enrolment, or a revoked one, has no policy the
    // blocked page could name, so it enforces nothing.
    expect(states.filter(mayEnforce)).toEqual(["collecting", "consent-required"]);
  });
});

describe("normaliseDomain", () => {
  it("takes the host out of whatever an administrator pasted in", () => {
    expect(normaliseDomain("https://www.example.com/some/path?q=1")).toBe("example.com");
    expect(normaliseDomain("  Example.COM  ")).toBe("example.com");
    expect(normaliseDomain("example.com:8443")).toBe("example.com");
    expect(normaliseDomain("http://user:pw@example.com/")).toBe("example.com");
  });

  it("folds www away, because Chrome already matches subdomains of what it is given", () => {
    // Left on, the rule would restrict www.example.com and quietly permit example.com.
    expect(normaliseDomain("www.example.com")).toBe("example.com");
  });

  it("refuses anything that is not a host, because one bad rule fails the whole set", () => {
    expect(normaliseDomain("*.example.com")).toBeNull();
    expect(normaliseDomain("localhost")).toBeNull();
    expect(normaliseDomain("")).toBeNull();
    expect(normaliseDomain("   ")).toBeNull();
    expect(normaliseDomain(`${"a".repeat(300)}.com`)).toBeNull();
    expect(normaliseDomain("-bad.example.com")).toBeNull();
  });
});

describe("toDynamicRules", () => {
  it("redirects the main frame to a page that can explain itself", () => {
    expect(toDynamicRules([{ id: 3, domain: "example.com", reason: null }], "blocked.html")).toEqual(
      [
        {
          id: 3,
          priority: 1,
          action: { type: "redirect", redirect: { extensionPath: "/blocked.html?rule=3" } },
          condition: { requestDomains: ["example.com"], resourceTypes: ["main_frame"] },
        },
      ],
    );
  });

  it("never blocks a subresource, which would break unrelated pages", () => {
    const [rule] = toDynamicRules([{ id: 1, domain: "cdn.test", reason: null }], "blocked.html");

    expect(rule?.condition.resourceTypes).toEqual(["main_frame"]);
  });

  it("drops a rule Chrome would reject rather than losing the whole rule set with it", () => {
    const rules = toDynamicRules(
      [
        { id: 1, domain: "*.bad", reason: null },
        { id: 2, domain: "good.test", reason: null },
      ],
      "blocked.html",
    );

    expect(rules.map((rule) => rule.id)).toEqual([2]);
  });

  it("drops a duplicate id, which updateDynamicRules refuses outright", () => {
    const rules = toDynamicRules(
      [
        { id: 5, domain: "a.test", reason: null },
        { id: 5, domain: "b.test", reason: null },
      ],
      "blocked.html",
    );

    expect(rules).toHaveLength(1);
    expect(rules[0]?.condition.requestDomains).toEqual(["a.test"]);
  });
});

describe("connectionView", () => {
  it("says not connected, and why, when the agent was never reached", () => {
    const view = connectionView(null, "Specified native messaging host not found.");

    expect(view.connected).toBe(false);
    expect(view.tone).toBe("off");
    // A failed registration must never read as "everything is fine but quiet".
    expect(view.detail).toContain("Specified native messaging host not found.");
    expect(view.detail).toContain("not being reported");
  });

  it("still says not connected when there is no error to quote", () => {
    expect(connectionView(null, null).headline).toBe("Not connected");
  });

  it("distinguishes the three reasons a connected agent is not collecting", () => {
    expect(connectionView(state({ monitoring: "revoked" }), null).headline).toBe(
      "Monitoring stopped",
    );
    expect(connectionView(state({ monitoring: "not-enrolled" }), null).headline).toBe(
      "Not signed in",
    );
    expect(connectionView(state({ monitoring: "consent-required" }), null).headline).toBe(
      "Waiting for your agreement",
    );
  });

  /**
   * The state the popup used to describe wrongly: collecting everything else, recording
   * no addresses. `monitoring` cannot carry it — borrowing `consent-required` would send
   * the employee off to accept a policy they already accepted — so the host says it in a
   * field of its own, and this is the assertion that the popup reads it.
   */
  it("says nothing is recorded when the device's website scope is off", () => {
    const view = connectionView(state({ websites: false }), null);

    expect(view.connected).toBe(true);
    expect(view.tone).toBe("off");
    expect(view.headline).toBe("Website addresses are not recorded");
    expect(view.detail).toContain("not sent anywhere");
    expect(view.detail).not.toContain("recorded against your work device");
  });

  it("uses no surveillance language in any state", () => {
    const wording = ["collecting", "consent-required", "not-enrolled", "revoked"]
      .map((monitoring) =>
        connectionView(state({ monitoring: monitoring as MonitoringState }), null),
      )
      .concat(connectionView(state({ websites: false }), null))
      .concat(connectionView(null, "x"))
      .flatMap((view) => [view.headline, view.detail])
      .join(" ")
      .toLowerCase();

    for (const banned of ["spy", "surveil", "catch", "watch you"]) {
      expect(wording).not.toContain(banned);
    }
  });

  it("reports plainly when everything is working", () => {
    const view = connectionView(state(), null);

    expect(view.connected).toBe(true);
    expect(view.tone).toBe("ok");
  });

  it("says out loud, while collecting, what is reported and where it lands", () => {
    // Non-negotiable #2 in a test rather than in a diff: this popup is the only surface
    // the extension has, and copy is exactly the thing a review reads past.
    const detail = connectionView(state(), null).detail;

    expect(detail).toContain("reported");
    expect(detail).toContain("work device");
    // And the limit, so the promise is not wider than the collection.
    expect(detail).toContain("never what is on the page");
  });
});

describe("browserLabel", () => {
  it("tells the two browsers this is force-installed into apart", () => {
    expect(
      browserLabel(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
      ),
    ).toBe("Edge");
    expect(
      browserLabel(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      ),
    ).toBe("Chrome");
  });

  it("puts an unrecognised Chromium in Chrome's slot rather than inventing one", () => {
    expect(browserLabel("Mozilla/5.0 Chrome/126.0.0.0 Brave/126")).toBe("Chrome");
  });
});

describe("findRule", () => {
  it("finds the rule the blocked page has to name", () => {
    const rules = [{ id: 9, domain: "a.test", reason: "Not work related" }];

    expect(findRule(state({ rules }), 9)?.reason).toBe("Not work related");
    expect(findRule(state({ rules }), 10)).toBeNull();
    expect(findRule(null, 9)).toBeNull();
  });
});
