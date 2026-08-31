import { describe, it, expect } from "vitest";
import type { DayLog, LogEntry, LogItem } from "./types.js";
import { entryKcal, entryMacros, dayTotals, remainingKcal, targetStatus } from "./nutrition.js";

function item(name: string, kcal: number, extra: Partial<LogItem> = {}): LogItem {
  return { name, kcal, ...extra };
}

function entry(id: string, items: LogItem[], over: Partial<LogEntry> = {}): LogEntry {
  return {
    id,
    kind: "meal",
    at: "2026-08-30T12:00:00.000Z",
    label: "Lunch",
    items,
    source: "test",
    createdAt: "2026-08-30T12:00:00.000Z",
    updatedAt: "2026-08-30T12:00:00.000Z",
    ...over,
  };
}

function day(entries: LogEntry[], targetKcal?: number): DayLog {
  return targetKcal === undefined
    ? { date: "2026-08-30", entries }
    : { date: "2026-08-30", entries, targetKcal };
}

describe("entryKcal", () => {
  it("sums its items — never a stored field that can drift", () => {
    expect(entryKcal(entry("a", [item("hot dog", 290), item("ketchup", 20), item("mayo", 40)]))).toBe(350);
  });

  it("is zero for an entry with no items", () => {
    expect(entryKcal(entry("a", []))).toBe(0);
  });

  it("is negative for an activity", () => {
    expect(entryKcal(entry("a", [item("15min walk", -60)], { kind: "activity" }))).toBe(-60);
  });
});

describe("entryMacros", () => {
  it("sums the macros that are present", () => {
    const e = entry("a", [
      item("chicken", 200, { protein: 30, carbs: 0, fat: 8 }),
      item("rice", 150, { protein: 3, carbs: 33, fat: 1 }),
    ]);
    expect(entryMacros(e)).toEqual({ protein: 33, carbs: 33, fat: 9 });
  });

  it("treats absent macros as zero rather than NaN", () => {
    const e = entry("a", [item("chicken", 200, { protein: 30 }), item("mystery", 100)]);
    expect(entryMacros(e)).toEqual({ protein: 30, carbs: 0, fat: 0 });
  });
});

describe("dayTotals", () => {
  it("nets activities against meals in one sum — one timeline", () => {
    const d = day([
      entry("a", [item("hot dog", 290), item("bun", 120)]),
      entry("b", [item("walk", -60)], { kind: "activity" }),
    ]);
    expect(dayTotals(d).kcal).toBe(350);
  });

  it("splits consumed from burned for display", () => {
    const d = day([
      entry("a", [item("lunch", 600)]),
      entry("b", [item("run", -400)], { kind: "activity" }),
    ]);
    const t = dayTotals(d);
    expect(t).toMatchObject({ kcal: 200, consumedKcal: 600, burnedKcal: 400 });
  });

  it("splits per item, not per entry, so a mixed entry still nets correctly", () => {
    const d = day([entry("a", [item("snack", 200), item("walk", -50)])]);
    expect(dayTotals(d)).toMatchObject({ kcal: 150, consumedKcal: 200, burnedKcal: 50 });
  });

  it("ignores note and weight entries' lack of items", () => {
    const d = day([
      entry("a", [item("lunch", 500)]),
      entry("b", [], { kind: "note" }),
      entry("c", [], { kind: "weight" }),
    ]);
    expect(dayTotals(d).kcal).toBe(500);
  });

  it("is zero for an empty day", () => {
    expect(dayTotals(day([]))).toMatchObject({ kcal: 0, consumedKcal: 0, burnedKcal: 0 });
  });

  it("sums macros across the day", () => {
    const d = day([
      entry("a", [item("chicken", 200, { protein: 30, fat: 8 })]),
      entry("b", [item("rice", 150, { protein: 3, carbs: 33 })]),
    ]);
    expect(dayTotals(d)).toMatchObject({ protein: 33, carbs: 33, fat: 8 });
  });

  it("does not accumulate floating-point dust", () => {
    const d = day([entry("a", [item("a", 0.1), item("b", 0.2)])]);
    expect(dayTotals(d).kcal).toBe(0.3);
  });
});

describe("remainingKcal", () => {
  it("counts down from the target", () => {
    expect(remainingKcal(day([entry("a", [item("lunch", 600)])], 2000))).toBe(1400);
  });

  it("goes negative when over target", () => {
    expect(remainingKcal(day([entry("a", [item("feast", 2500)])], 2000))).toBe(-500);
  });

  it("gives back budget for an activity", () => {
    const d = day([entry("a", [item("lunch", 600)]), entry("b", [item("run", -400)], { kind: "activity" })], 2000);
    expect(remainingKcal(d)).toBe(1800);
  });

  it("is undefined without a target — no target means no judgement", () => {
    expect(remainingKcal(day([entry("a", [item("lunch", 600)])]))).toBeUndefined();
  });
});

describe("targetStatus", () => {
  it("reports under/over/none", () => {
    expect(targetStatus(day([entry("a", [item("lunch", 600)])], 2000))).toBe("under");
    expect(targetStatus(day([entry("a", [item("feast", 2500)])], 2000))).toBe("over");
    expect(targetStatus(day([entry("a", [item("lunch", 600)])]))).toBe("none");
  });

  it("counts exactly hitting the target as under, not over", () => {
    expect(targetStatus(day([entry("a", [item("exact", 2000)])], 2000))).toBe("under");
  });
});
