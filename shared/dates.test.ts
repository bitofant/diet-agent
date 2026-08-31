import { describe, it, expect } from "vitest";
import {
  localDayKey,
  isDayKey,
  shiftDayKey,
  daysBetween,
  recentDayKeys,
  dayLabel,
  formatLocalTime,
  isSaneInstant,
} from "./dates.js";

describe("localDayKey", () => {
  it("keys by the user's timezone, not UTC", () => {
    // 01:30 UTC is still the 29th in New York, already the 30th in UTC.
    const at = "2026-08-30T01:30:00.000Z";
    expect(localDayKey(at, "UTC")).toBe("2026-08-30");
    expect(localDayKey(at, "America/New_York")).toBe("2026-08-29");
    expect(localDayKey(at, "Europe/Amsterdam")).toBe("2026-08-30");
  });

  it("keys the far side of the date line correctly", () => {
    const at = "2026-08-30T22:00:00.000Z";
    expect(localDayKey(at, "Pacific/Auckland")).toBe("2026-08-31");
    expect(localDayKey(at, "America/Los_Angeles")).toBe("2026-08-30");
  });

  it("zero-pads single-digit months and days", () => {
    expect(localDayKey("2026-01-05T12:00:00.000Z", "UTC")).toBe("2026-01-05");
  });

  it("accepts a Date as well as an ISO string", () => {
    expect(localDayKey(new Date("2026-08-30T12:00:00.000Z"), "UTC")).toBe("2026-08-30");
  });

  it("throws on an unparseable instant rather than yielding a bogus key", () => {
    expect(() => localDayKey("not a date", "UTC")).toThrow();
  });
});

describe("localDayKey across DST", () => {
  it("keeps the day stable across a spring-forward boundary", () => {
    // Amsterdam springs forward 2026-03-29 02:00 -> 03:00 local.
    expect(localDayKey("2026-03-29T00:30:00.000Z", "Europe/Amsterdam")).toBe("2026-03-29");
    expect(localDayKey("2026-03-29T01:30:00.000Z", "Europe/Amsterdam")).toBe("2026-03-29");
  });

  it("handles the repeated hour of a fall-back day", () => {
    // Amsterdam falls back 2026-10-25 03:00 -> 02:00 local; 00:30 and 01:30 UTC
    // are both 02:30 local on the same date.
    expect(localDayKey("2026-10-25T00:30:00.000Z", "Europe/Amsterdam")).toBe("2026-10-25");
    expect(localDayKey("2026-10-25T01:30:00.000Z", "Europe/Amsterdam")).toBe("2026-10-25");
  });

  it("puts a late-evening instant on the right day either side of DST", () => {
    // 23:30 local on the day before each transition.
    expect(localDayKey("2026-03-28T22:30:00.000Z", "Europe/Amsterdam")).toBe("2026-03-28");
    expect(localDayKey("2026-10-24T21:30:00.000Z", "Europe/Amsterdam")).toBe("2026-10-24");
  });
});

describe("isDayKey", () => {
  it("accepts well-formed keys", () => {
    expect(isDayKey("2026-08-30")).toBe(true);
    expect(isDayKey("2026-02-29")).toBe(false); // 2026 is not a leap year
    expect(isDayKey("2024-02-29")).toBe(true);
  });

  it("rejects malformed or out-of-range keys", () => {
    for (const bad of ["", "2026-8-30", "2026-08-30T00:00:00Z", "2026-13-01", "2026-00-10", "2026-08-32", "abcd-ef-gh"]) {
      expect(isDayKey(bad), bad).toBe(false);
    }
  });
});

describe("shiftDayKey / daysBetween", () => {
  it("shifts within a month", () => {
    expect(shiftDayKey("2026-08-30", -1)).toBe("2026-08-29");
    expect(shiftDayKey("2026-08-30", 1)).toBe("2026-08-31");
  });

  it("shifts across month and year boundaries", () => {
    expect(shiftDayKey("2026-09-01", -1)).toBe("2026-08-31");
    expect(shiftDayKey("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftDayKey("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("shifts across a leap day", () => {
    expect(shiftDayKey("2024-02-28", 1)).toBe("2024-02-29");
    expect(shiftDayKey("2024-03-01", -1)).toBe("2024-02-29");
  });

  it("is unaffected by DST — day keys are calendar math, not clock math", () => {
    expect(shiftDayKey("2026-03-30", -1)).toBe("2026-03-29");
    expect(shiftDayKey("2026-10-26", -1)).toBe("2026-10-25");
  });

  it("counts signed days between keys", () => {
    expect(daysBetween("2026-08-30", "2026-08-30")).toBe(0);
    expect(daysBetween("2026-08-29", "2026-08-30")).toBe(1);
    expect(daysBetween("2026-08-30", "2026-08-29")).toBe(-1);
    expect(daysBetween("2025-12-31", "2026-01-01")).toBe(1);
  });
});

describe("recentDayKeys", () => {
  it("returns today first, then backwards, from the client's local now", () => {
    const keys = recentDayKeys("2026-08-30T01:30:00.000Z", "America/New_York", 3);
    expect(keys).toEqual(["2026-08-29", "2026-08-28", "2026-08-27"]);
  });

  it("defaults to three days — the sidebar's day rows", () => {
    expect(recentDayKeys("2026-08-30T12:00:00.000Z", "UTC")).toEqual([
      "2026-08-30",
      "2026-08-29",
      "2026-08-28",
    ]);
  });
});

describe("dayLabel", () => {
  const today = "2026-08-30";

  it("names the three recent days relative to the client's today", () => {
    expect(dayLabel("2026-08-30", today)).toBe("Today");
    expect(dayLabel("2026-08-29", today)).toBe("Yesterday");
    expect(dayLabel("2026-08-28", today)).toBe("Day before yesterday");
  });

  it("falls back to a written date for anything older", () => {
    expect(dayLabel("2026-08-27", today)).toBe("Thursday 27 August 2026");
    expect(dayLabel("2025-01-02", today)).toBe("Thursday 2 January 2025");
  });

  it("labels a future day rather than mislabelling it as past", () => {
    expect(dayLabel("2026-08-31", today)).toBe("Tomorrow");
  });
});

describe("formatLocalTime", () => {
  it("renders the wall clock in the user's timezone", () => {
    expect(formatLocalTime("2026-08-30T18:10:00.000Z", "UTC")).toBe("6:10pm");
    expect(formatLocalTime("2026-08-30T18:10:00.000Z", "America/New_York")).toBe("2:10pm");
  });

  it("renders midnight and noon unambiguously", () => {
    expect(formatLocalTime("2026-08-30T00:00:00.000Z", "UTC")).toBe("12:00am");
    expect(formatLocalTime("2026-08-30T12:00:00.000Z", "UTC")).toBe("12:00pm");
  });
});

describe("isSaneInstant", () => {
  it("accepts real ISO instants", () => {
    expect(isSaneInstant("2026-08-30T12:00:00.000Z")).toBe(true);
    expect(isSaneInstant("2026-08-30T12:00:00+02:00")).toBe(true);
  });

  it("rejects junk, NaN dates and absurd years", () => {
    for (const bad of ["", "tomorrow", "not a date", "1823-01-01T00:00:00.000Z", "9999-01-01T00:00:00.000Z"]) {
      expect(isSaneInstant(bad), bad).toBe(false);
    }
  });

  it("rejects non-strings", () => {
    expect(isSaneInstant(undefined)).toBe(false);
    expect(isSaneInstant(12345)).toBe(false);
  });
});
