import { describe, expect, it } from "vitest";

import {
  DATA_TYPE_IDS,
  PLATFORM_DATA_TYPES,
  describeDataType,
  describeDataTypes,
  effectiveTypes,
  pendingTypes,
} from "./collection.js";

describe("effectiveTypes", () => {
  it("permits everything the platform supports when nothing has been decided", () => {
    // The whole deploy-safety argument rests on this: zero settings rows and a consent
    // row from before per-type consent must change no device's behaviour.
    expect(effectiveTypes("windows", [], null)).toEqual([
      ...PLATFORM_DATA_TYPES.windows,
    ]);
    expect(effectiveTypes("android", [], null)).toEqual([
      ...PLATFORM_DATA_TYPES.android,
    ]);
  });

  it("never permits location on a desktop, whatever anyone agreed to", () => {
    expect(effectiveTypes("macos", [], [...DATA_TYPE_IDS])).not.toContain(
      "location",
    );
    expect(effectiveTypes("android", [], [...DATA_TYPE_IDS])).toContain(
      "location",
    );
  });

  it("intersects — the most restrictive of the three sets wins", () => {
    expect(
      effectiveTypes(
        "windows",
        ["screenshots"],
        ["applications", "screenshots"],
      ),
    ).toEqual(["applications"]);
  });

  it("cannot be widened by consent beyond what the admin allows", () => {
    expect(
      effectiveTypes("macos", ["websites"], [...DATA_TYPE_IDS]),
    ).not.toContain("websites");
  });
});

describe("pendingTypes", () => {
  it("is empty when consent predates per-type consent", () => {
    expect(pendingTypes("windows", [], null)).toEqual([]);
  });

  it("names only what was switched on but never agreed to", () => {
    expect(pendingTypes("windows", ["idle"], ["applications"])).toEqual([
      "websites",
      "screenshots",
      "telemetry",
      "installed_apps",
    ]);
  });

  it("stays empty when the scope is narrowed — collecting less needs no new consent", () => {
    expect(
      pendingTypes(
        "windows",
        ["screenshots"],
        [...PLATFORM_DATA_TYPES.windows],
      ),
    ).toEqual([]);
  });
});

describe("copy", () => {
  it("states the Windows website limit as absent rather than dropping the line", () => {
    expect(
      describeDataType("websites", { readsBrowserAddress: false }),
    ).toMatchObject({
      absent: true,
    });
    expect(
      describeDataType("websites", { readsBrowserAddress: true }).absent,
    ).toBeUndefined();
  });

  it("hedges rather than printing a zero when no policy is published", () => {
    expect(describeDataType("screenshots").detail).toContain(
      "at regular intervals",
    );
    expect(
      describeDataType("screenshots", { screenshotInterval: "10 min" }).detail,
    ).toContain("about every 10 min");
  });

  it("describes exactly the permitted set, in vocabulary order", () => {
    expect(
      describeDataTypes(["screenshots", "applications"]).map((c) => c.id),
    ).toEqual(["applications", "screenshots"]);
  });
});
