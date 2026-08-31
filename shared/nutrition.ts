// Derived math. Nothing here is ever stored — totals are computed from items so
// they cannot drift out of sync with the breakdown the user can expand and see.

import type { DayLog, LogEntry } from "./types.js";

export interface Macros {
  protein: number;
  carbs: number;
  fat: number;
}

export interface DayTotals extends Macros {
  /** Net: consumed minus burned. The number the sidebar shows. */
  kcal: number;
  consumedKcal: number;
  /** Positive magnitude of the negative (activity) items. */
  burnedKcal: number;
}

export type TargetStatus = "under" | "over" | "none";

// Sums of floats accumulate dust (0.1 + 0.2); kcal and grams are never
// meaningful past a few decimals, so round it away at the boundary.
function tidy(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function num(n: number | undefined): number {
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

/** An entry's kcal is the sum of its items — never a separate stored field. */
export function entryKcal(entry: LogEntry): number {
  return tidy(entry.items.reduce((sum, it) => sum + num(it.kcal), 0));
}

export function entryMacros(entry: LogEntry): Macros {
  const m = { protein: 0, carbs: 0, fat: 0 };
  for (const it of entry.items) {
    m.protein += num(it.protein);
    m.carbs += num(it.carbs);
    m.fat += num(it.fat);
  }
  return { protein: tidy(m.protein), carbs: tidy(m.carbs), fat: tidy(m.fat) };
}

export function dayTotals(day: DayLog): DayTotals {
  const t = { kcal: 0, consumedKcal: 0, burnedKcal: 0, protein: 0, carbs: 0, fat: 0 };
  for (const entry of day.entries) {
    for (const it of entry.items) {
      // Split per item, not per entry: one entry may hold both a snack and a walk.
      const kcal = num(it.kcal);
      t.kcal += kcal;
      if (kcal >= 0) t.consumedKcal += kcal;
      else t.burnedKcal -= kcal;
      t.protein += num(it.protein);
      t.carbs += num(it.carbs);
      t.fat += num(it.fat);
    }
  }
  return {
    kcal: tidy(t.kcal),
    consumedKcal: tidy(t.consumedKcal),
    burnedKcal: tidy(t.burnedKcal),
    protein: tidy(t.protein),
    carbs: tidy(t.carbs),
    fat: tidy(t.fat),
  };
}

/** Budget left against the day's target, or undefined when no target is set. */
export function remainingKcal(day: DayLog): number | undefined {
  if (typeof day.targetKcal !== "number" || !Number.isFinite(day.targetKcal)) return undefined;
  return tidy(day.targetKcal - dayTotals(day).kcal);
}

export function targetStatus(day: DayLog): TargetStatus {
  const left = remainingKcal(day);
  if (left === undefined) return "none";
  return left < 0 ? "over" : "under";
}
