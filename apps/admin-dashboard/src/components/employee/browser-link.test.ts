import { describe, expect, it } from "vitest";

import { browserLinkNote } from "./browser-link";
import type { DeviceRow } from "@/lib/api";

const NOW = Date.parse("2026-08-10T09:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const DAY = 24 * 60 * 60 * 1000;

/**
 * Only the fields the note reads are real; the rest of `DeviceRow` is inventory the
 * copy never looks at, and spelling out forty columns per case would bury the one
 * that changes.
 *
 * `browser_extension_seen_at` defaults to a minute ago because every positive claim is
 * now conditioned on freshness, and a fixture with no stamp would silently exercise the
 * stale branch in every case that meant to exercise the live one.
 */
function device(overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    platform: "windows",
    status: "active",
    browser_extension_linked: null,
    browser_extension_version: null,
    browser_extension_seen_at: ago(60_000),
    browser_extension_count: null,
    website_addresses_recorded: null,
    ...overrides,
  } as DeviceRow;
}

const note = (row: DeviceRow) => browserLinkNote(row, NOW);
const text = (row: DeviceRow) => (note(row)?.lines ?? []).join(" ");

describe("browserLinkNote", () => {
  it("says nothing about a phone or a revoked machine", () => {
    // A phone has no browser extension and never will, and advice to install one on a
    // revoked laptop cannot be taken.
    expect(note(device({ platform: "android", browser_extension_linked: null }))).toBeNull();
    expect(note(device({ status: "revoked" }))).toBeNull();
  });

  /**
   * The failure this whole feature exists to prevent: a Windows Websites tab that is
   * empty because nothing could read it, rendered as though the person browsed nothing.
   */
  it("ambers a Windows computer with no extension, and says why the tab is empty", () => {
    expect(note(device({ browser_extension_linked: false }))?.tone).toBe("warning");
    expect(text(device({ browser_extension_linked: false }))).toContain(
      "no way to read a browser's address bar",
    );
  });

  /** Null is "never reported", which is a weaker claim than false and a different one. */
  it("ambers a Windows computer that has not reported either way", () => {
    expect(note(device({ browser_extension_linked: null }))?.tone).toBe("warning");
    expect(text(device({ browser_extension_linked: null }))).toContain("incomplete rather than empty");
    expect(note(device({ browser_extension_linked: null }))?.lines[0]).not.toBe(
      note(device({ browser_extension_linked: false }))?.lines[0],
    );
  });

  it("states the plain fact when one browser is connected", () => {
    const live = note(device({ browser_extension_linked: true, browser_extension_count: 1 }));

    expect(live?.tone).toBe("neutral");
    expect(live?.lines[0]).toBe(
      "Website addresses from this computer are reported by the AEMS browser extension.",
    );
  });

  /**
   * The count answers "was it installed twice", not "which one counts" — so the second
   * sentence has to close that question rather than leave a reader guessing which
   * browser is the real one. It says "has connected" rather than "is connected" because
   * that is all anybody knows: nothing reports an uninstall.
   */
  it("names the number of browsers, and that all of them are recorded alike", () => {
    const two = note(device({ browser_extension_linked: true, browser_extension_count: 2 }));

    expect(two?.tone).toBe("neutral");
    expect(two?.lines[0]).toContain("connected from 2 browsers in the last day");
    expect(two?.lines[0]).toContain("All of them are recorded the same way.");
  });

  it("quotes the extension version when the agent reported one", () => {
    expect(
      text(device({ browser_extension_linked: true, browser_extension_version: "0.1.0" })),
    ).toContain("Extension version 0.1.0.");
    // A blank string is not a version, and "Extension version ." helps nobody.
    expect(
      text(device({ browser_extension_linked: true, browser_extension_version: "  " })),
    ).not.toContain("Extension version");
  });

  /**
   * The critical one. `browser_extension_linked` is stored and nothing ages it out, so a
   * retired laptop's last `true` would go on asserting a complete Websites tab for ever.
   * A stale link is also not grounds to accuse anybody of removing an extension — a
   * machine shut for a fortnight looks exactly the same.
   */
  it("hedges rather than promising completeness once the link has gone quiet", () => {
    const stale = device({
      browser_extension_linked: true,
      browser_extension_seen_at: ago(3 * DAY),
    });

    expect(text(stale)).toContain("nothing has connected since");
    expect(text(stale)).not.toContain("are reported by the AEMS browser extension");
    expect(note(stale)?.tone).toBe("warning");
    // The date, not "3 days ago": by this point the question is how long it has been.
    expect(text(stale)).toMatch(/on \d+ Aug 2026/);
  });

  it("does not take a link with no timestamp behind it at face value", () => {
    expect(
      text(device({ browser_extension_linked: true, browser_extension_seen_at: null })),
    ).toContain("nothing has connected since");
  });

  /**
   * The channel being open is not the same fact as an address being recorded. Withdrawn
   * consent and a switched-off `websites` scope both stop the recording without closing
   * anything, and this strip sits directly above the employee's own withdrawn-consent
   * notice on /my-devices.
   */
  it("does not claim a recording that is switched off, however live the channel is", () => {
    const off = device({ browser_extension_linked: true, website_addresses_recorded: false });

    expect(text(off)).toContain("no website addresses are being recorded from it");
    expect(text(off)).not.toContain("are reported by the AEMS browser extension.");
  });

  it("says the same of a Mac, where the extension was never the reason", () => {
    const off = device({ platform: "macos", website_addresses_recorded: false });

    expect(text(off)).toContain("switched off for this device");
    expect(text(off)).not.toContain("website activity is still recorded");
  });

  it("does not amber macOS, where the agent reads addresses without an extension", () => {
    const mac = note(device({ platform: "macos", browser_extension_linked: false }));

    expect(mac?.tone).toBe("neutral");
    expect(mac?.lines[0]).toContain("website activity is still recorded");
  });

  /** docs/design.md forbids surveillance framing, and this copy is read by the monitored. */
  it("uses no surveillance vocabulary", () => {
    const corpus = [
      text(device({ browser_extension_linked: false })),
      text(device({ browser_extension_linked: null })),
      text(device({ browser_extension_linked: true, browser_extension_count: 2 })),
      text(device({ browser_extension_linked: true, browser_extension_seen_at: ago(3 * DAY) })),
      text(device({ browser_extension_linked: true, website_addresses_recorded: false })),
      text(device({ platform: "macos", browser_extension_linked: false })),
    ]
      .join(" ")
      .toLowerCase();

    for (const word of ["spy", "surveil", "catch", "watch you", "secretly"]) {
      expect(corpus).not.toContain(word);
    }
  });
});
