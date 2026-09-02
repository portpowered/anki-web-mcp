import { describe, expect, test } from "bun:test";

import { getLocalDayBoundary } from "../../lib/domain/local-day";

describe("getLocalDayBoundary", () => {
  test("calculates the next calendar midnight in UTC", () => {
    const boundary = getLocalDayBoundary(
      Date.parse("2026-09-01T23:30:00.000Z"),
      "UTC",
    );

    expect(boundary).toEqual({
      dayKey: "2026-09-01",
      nextDayAt: Date.parse("2026-09-02T00:00:00.000Z"),
      timeZone: "UTC",
    });
  });

  test("uses a 23-hour local day across spring-forward DST", () => {
    const boundary = getLocalDayBoundary(
      Date.parse("2026-03-08T09:00:00.000Z"),
      "America/Los_Angeles",
    );

    expect(boundary.dayKey).toBe("2026-03-08");
    expect(boundary.nextDayAt).toBe(Date.parse("2026-03-09T07:00:00.000Z"));
  });

  test("uses a 25-hour local day across fall-back DST", () => {
    const boundary = getLocalDayBoundary(
      Date.parse("2026-11-01T08:00:00.000Z"),
      "America/Los_Angeles",
    );

    expect(boundary.dayKey).toBe("2026-11-01");
    expect(boundary.nextDayAt).toBe(Date.parse("2026-11-02T08:00:00.000Z"));
  });
});
