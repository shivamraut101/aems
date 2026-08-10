import { describe, expect, it } from "vitest";

import {
  distanceCoveredMetres,
  formatDistance,
  groupIntoStops,
  mapHref,
  metresBetween,
  SAME_PLACE_METRES,
} from "./location-stops";
import type { LocationPoint } from "@/app/(app)/people/[profileId]/devices/device-queries";

/**
 * Collapsing a ping log into places.
 *
 * The failure that matters here is not a wrong pixel — it is merging two places a
 * person actually visited into one, or splitting one desk into four. Both are claims
 * about where somebody was, on the most sensitive screen in the product.
 */

const BASE = { latitude: 26.6399, longitude: 88.16722 };

let nextId = 1;
function point(overrides: Partial<LocationPoint> & { recordedAt: string }): LocationPoint {
  return {
    id: nextId++,
    deviceId: "d1",
    latitude: BASE.latitude,
    longitude: BASE.longitude,
    accuracyM: 100,
    ...overrides,
  };
}

/** Roughly `metres` due north. 1 degree of latitude is about 111.32 km. */
function north(metres: number): number {
  return BASE.latitude + metres / 111_320;
}

describe("metresBetween", () => {
  it("measures a known northward offset", () => {
    // Haversine against a hand-computed degree offset; 2% tolerance is far tighter
    // than the +-100m the phones themselves report.
    expect(metresBetween(BASE.latitude, BASE.longitude, north(500), BASE.longitude)).toBeGreaterThan(
      490,
    );
    expect(metresBetween(BASE.latitude, BASE.longitude, north(500), BASE.longitude)).toBeLessThan(
      510,
    );
  });

  it("is zero for the same coordinate", () => {
    expect(metresBetween(BASE.latitude, BASE.longitude, BASE.latitude, BASE.longitude)).toBe(0);
  });
});

describe("groupIntoStops", () => {
  it("collapses a stationary phone's samples into one stop", () => {
    // The real case: nine identical fixes a minute apart while somebody sat still.
    const points = Array.from({ length: 9 }, (_, i) =>
      point({ recordedAt: `2026-08-08T02:${String(43 + i).padStart(2, "0")}:00.000Z` }),
    );

    const stops = groupIntoStops(points);

    expect(stops).toHaveLength(1);
    expect(stops[0]?.points).toBe(9);
    expect(stops[0]?.fromIso).toBe("2026-08-08T02:43:00.000Z");
    expect(stops[0]?.toIso).toBe("2026-08-08T02:51:00.000Z");
  });

  it("keeps two genuinely different places apart", () => {
    const stops = groupIntoStops([
      point({ recordedAt: "2026-08-08T09:00:00.000Z" }),
      point({ recordedAt: "2026-08-08T10:00:00.000Z", latitude: north(4_000) }),
    ]);

    expect(stops).toHaveLength(2);
  });

  it("treats jitter within the accuracy of a fix as the same place", () => {
    // These phones report +-100m on network positioning. Two readings 60m apart from a
    // phone on a desk is that, not a walk, and splitting them would invent movement.
    const stops = groupIntoStops([
      point({ recordedAt: "2026-08-08T09:00:00.000Z" }),
      point({ recordedAt: "2026-08-08T09:01:00.000Z", latitude: north(60) }),
    ]);

    expect(stops).toHaveLength(1);
    expect(stops[0]?.points).toBe(2);
  });

  it("does not let a slow walk drift into one endless stop", () => {
    // The reason grouping compares against the stop's FIRST point rather than the
    // previous one. Chained, these six 100m steps are each "the same place" as the one
    // before and the whole 600m walk collapses to a single stop.
    const stops = groupIntoStops(
      Array.from({ length: 6 }, (_, i) =>
        point({
          recordedAt: `2026-08-08T09:0${String(i)}:00.000Z`,
          latitude: north(i * 100),
        }),
      ),
    );

    expect(stops.length).toBeGreaterThan(1);
  });

  it("reports the vaguest fix in a group, not the best one", () => {
    // A stop containing one +-500m reading is not known to +-19m because another
    // reading was, and a manager deciding where somebody was reads this number.
    const stops = groupIntoStops([
      point({ recordedAt: "2026-08-08T09:00:00.000Z", accuracyM: 19 }),
      point({ recordedAt: "2026-08-08T09:01:00.000Z", accuracyM: 500 }),
    ]);

    expect(stops[0]?.accuracyM).toBe(500);
  });

  it("reports a position the device actually sent, never an average", () => {
    // Averaging invents a coordinate nothing reported. On a screen where someone may
    // have to answer for where they were, every point shown must be a real one.
    const stops = groupIntoStops([
      point({ recordedAt: "2026-08-08T09:00:00.000Z" }),
      point({ recordedAt: "2026-08-08T09:01:00.000Z", latitude: north(60) }),
    ]);

    expect(stops[0]?.latitude).toBe(BASE.latitude);
  });

  it("returns newest first, matching every other list on the page", () => {
    const stops = groupIntoStops([
      point({ recordedAt: "2026-08-08T09:00:00.000Z" }),
      point({ recordedAt: "2026-08-08T11:00:00.000Z", latitude: north(4_000) }),
    ]);

    expect(stops[0]?.fromIso).toBe("2026-08-08T11:00:00.000Z");
  });

  it("has nothing to group when nothing was recorded", () => {
    expect(groupIntoStops([])).toEqual([]);
  });
});

describe("distanceCoveredMetres", () => {
  it("is zero for a phone that never left one place", () => {
    // The case that made this necessary: raw fixes jitter by +-100m once a minute, so
    // summing them turns eight hours at a desk into kilometres of imaginary travel.
    const stops = groupIntoStops(
      Array.from({ length: 20 }, (_, i) =>
        point({
          recordedAt: `2026-08-08T09:${String(i).padStart(2, "0")}:00.000Z`,
          latitude: north(i % 2 === 0 ? 0 : 60),
        }),
      ),
    );

    expect(distanceCoveredMetres(stops)).toBe(0);
  });

  it("measures the hops between places actually visited", () => {
    const stops = groupIntoStops([
      point({ recordedAt: "2026-08-08T09:00:00.000Z" }),
      point({ recordedAt: "2026-08-08T10:00:00.000Z", latitude: north(1_000) }),
      point({ recordedAt: "2026-08-08T11:00:00.000Z", latitude: north(2_000) }),
    ]);

    const covered = distanceCoveredMetres(stops);
    expect(covered).toBeGreaterThan(1_950);
    expect(covered).toBeLessThan(2_050);
  });

  it("counts a return trip in both directions", () => {
    // Out and back is two kilometres travelled, not zero. Comparing first to last
    // would report nothing at all for a delivery round that ends where it began.
    const stops = groupIntoStops([
      point({ recordedAt: "2026-08-08T09:00:00.000Z" }),
      point({ recordedAt: "2026-08-08T10:00:00.000Z", latitude: north(1_000) }),
      point({ recordedAt: "2026-08-08T11:00:00.000Z", latitude: north(0) }),
    ]);

    expect(distanceCoveredMetres(stops)).toBeGreaterThan(1_950);
  });

  it("is zero when nothing was recorded", () => {
    expect(distanceCoveredMetres([])).toBe(0);
  });
});

describe("formatDistance", () => {
  it("uses metres below a kilometre and one decimal above", () => {
    expect(formatDistance(320)).toBe("320 m");
    expect(formatDistance(1_420)).toBe("1.4 km");
  });
});

describe("mapHref", () => {
  it("points at the coordinate with no key and no account", () => {
    const href = mapHref(26.6399, 88.16722);
    expect(href).toContain("openstreetmap.org");
    expect(href).toContain("mlat=26.639900");
    expect(href).toContain("mlon=88.167220");
  });
});

describe("SAME_PLACE_METRES", () => {
  it("sits above the accuracy the phones actually report", () => {
    // The threshold is chosen against +-100m network fixes. Below that, a stationary
    // phone's jitter reads as movement; the constant and that reasoning have to stay
    // together or the next person tightening it reintroduces the split.
    expect(SAME_PLACE_METRES).toBeGreaterThan(100);
  });
});
