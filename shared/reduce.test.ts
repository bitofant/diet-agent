import { describe, it, expect } from "vitest";
import type { DayLog, LogEntry } from "./types.js";
import { emptyDay } from "./types.js";
import { applyAction, applyActions, type ReduceContext } from "./reduce.js";

const NOW = "2026-08-30T14:00:00.000Z";

function ctx(over: Partial<ReduceContext> = {}): ReduceContext {
  let n = 0;
  return { now: NOW, newId: () => `e${++n}`, source: "raw user message", ...over };
}

function entry(id: string, at: string, over: Partial<LogEntry> = {}): LogEntry {
  return {
    id,
    kind: "meal",
    at,
    label: "Lunch",
    items: [{ name: "hot dog", kcal: 290 }],
    source: "src",
    createdAt: "2026-08-30T10:00:00.000Z",
    updatedAt: "2026-08-30T10:00:00.000Z",
    ...over,
  };
}

function day(entries: LogEntry[]): DayLog {
  return { date: "2026-08-30", entries };
}

describe("add_entry", () => {
  it("folds a meal into the day, filling in the fields the model never supplies", () => {
    const d = applyAction(
      emptyDay("2026-08-30"),
      {
        type: "add_entry",
        entry: {
          kind: "meal",
          at: "2026-08-30T14:10:00.000Z",
          label: "Lunch",
          items: [
            { name: "hot dog", qty: 2, kcal: 290 },
            { name: "ketchup", kcal: 20 },
          ],
        },
      },
      ctx(),
    );

    expect(d.entries).toHaveLength(1);
    expect(d.entries[0]).toMatchObject({
      id: "e1",
      kind: "meal",
      label: "Lunch",
      at: "2026-08-30T14:10:00.000Z",
      source: "raw user message",
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(d.entries[0].items).toHaveLength(2);
  });

  it("keeps entries sorted by time, not insertion order", () => {
    const d = applyActions(
      emptyDay("2026-08-30"),
      [
        { type: "add_entry", entry: { kind: "meal", at: "2026-08-30T18:00:00.000Z", label: "Dinner", items: [] } },
        { type: "add_entry", entry: { kind: "meal", at: "2026-08-30T08:00:00.000Z", label: "Breakfast", items: [] } },
        { type: "add_entry", entry: { kind: "meal", at: "2026-08-30T13:00:00.000Z", label: "Lunch", items: [] } },
      ],
      ctx(),
    );
    expect(d.entries.map((e) => e.label)).toEqual(["Breakfast", "Lunch", "Dinner"]);
  });

  it("breaks ties deterministically so both sides fold to the same order", () => {
    const at = "2026-08-30T12:00:00.000Z";
    const d = applyActions(
      emptyDay("2026-08-30"),
      [
        { type: "add_entry", entry: { kind: "meal", at, label: "First", items: [] } },
        { type: "add_entry", entry: { kind: "meal", at, label: "Second", items: [] } },
      ],
      ctx(),
    );
    expect(d.entries.map((e) => e.label)).toEqual(["First", "Second"]);
  });

  it("records an activity as an entry with negative items, not a parallel concept", () => {
    const d = applyAction(
      emptyDay("2026-08-30"),
      {
        type: "add_entry",
        entry: {
          kind: "activity",
          at: "2026-08-30T09:00:00.000Z",
          label: "Morning walk",
          items: [{ name: "15min walk", kcal: -60 }],
        },
      },
      ctx(),
    );
    expect(d.entries[0].kind).toBe("activity");
    expect(d.entries[0].items[0].kcal).toBe(-60);
  });

  it("carries an optional note through", () => {
    const d = applyAction(
      emptyDay("2026-08-30"),
      { type: "add_entry", entry: { kind: "note", at: NOW, label: "Felt sluggish", items: [], note: "poor sleep" } },
      ctx(),
    );
    expect(d.entries[0].note).toBe("poor sleep");
  });
});

describe("update_entry", () => {
  it("patches the timestamp in place, keeping the id — 'it was an hour ago'", () => {
    const before = day([entry("a", "2026-08-30T14:00:00.000Z")]);
    const after = applyAction(
      before,
      { type: "update_entry", id: "a", patch: { at: "2026-08-30T13:00:00.000Z" } },
      ctx(),
    );
    expect(after.entries[0].id).toBe("a");
    expect(after.entries[0].at).toBe("2026-08-30T13:00:00.000Z");
    expect(after.entries[0].createdAt).toBe("2026-08-30T10:00:00.000Z");
    expect(after.entries[0].updatedAt).toBe(NOW);
  });

  it("leaves untouched fields alone", () => {
    const before = day([entry("a", NOW, { note: "keep me" })]);
    const after = applyAction(before, { type: "update_entry", id: "a", patch: { label: "Brunch" } }, ctx());
    expect(after.entries[0]).toMatchObject({ label: "Brunch", note: "keep me", kind: "meal" });
    expect(after.entries[0].items).toEqual(before.entries[0].items);
  });

  it("re-sorts when the patched time moves the entry", () => {
    const before = day([
      entry("a", "2026-08-30T08:00:00.000Z", { label: "Breakfast" }),
      entry("b", "2026-08-30T13:00:00.000Z", { label: "Lunch" }),
    ]);
    const after = applyAction(
      before,
      { type: "update_entry", id: "a", patch: { at: "2026-08-30T20:00:00.000Z" } },
      ctx(),
    );
    expect(after.entries.map((e) => e.label)).toEqual(["Lunch", "Breakfast"]);
  });

  it("replaces items wholesale when the patch carries them", () => {
    const before = day([entry("a", NOW)]);
    const after = applyAction(
      before,
      { type: "update_entry", id: "a", patch: { items: [{ name: "salad", kcal: 120 }] } },
      ctx(),
    );
    expect(after.entries[0].items).toEqual([{ name: "salad", kcal: 120 }]);
  });

  it("ignores an unknown id — validation is the gate, the reducer stays total", () => {
    const before = day([entry("a", NOW)]);
    const after = applyAction(before, { type: "update_entry", id: "nope", patch: { label: "X" } }, ctx());
    expect(after).toEqual(before);
  });
});

describe("delete_entry", () => {
  it("removes just that entry", () => {
    const before = day([entry("a", "2026-08-30T08:00:00.000Z"), entry("b", "2026-08-30T13:00:00.000Z")]);
    const after = applyAction(before, { type: "delete_entry", id: "a" }, ctx());
    expect(after.entries.map((e) => e.id)).toEqual(["b"]);
  });

  it("is a no-op for an unknown id", () => {
    const before = day([entry("a", NOW)]);
    expect(applyAction(before, { type: "delete_entry", id: "nope" }, ctx())).toEqual(before);
  });
});

describe("item actions", () => {
  const before = () =>
    day([
      entry("a", NOW, {
        items: [
          { name: "hot dog", kcal: 290 },
          { name: "bun", kcal: 120 },
        ],
      }),
    ]);

  it("appends an item and bumps the entry's updatedAt", () => {
    const after = applyAction(before(), { type: "add_item", entryId: "a", item: { name: "mayo", kcal: 40 } }, ctx());
    expect(after.entries[0].items.map((i) => i.name)).toEqual(["hot dog", "bun", "mayo"]);
    expect(after.entries[0].updatedAt).toBe(NOW);
  });

  it("patches one item by index, leaving its siblings alone", () => {
    const after = applyAction(before(), { type: "update_item", entryId: "a", index: 1, patch: { kcal: 150 } }, ctx());
    expect(after.entries[0].items).toEqual([
      { name: "hot dog", kcal: 290 },
      { name: "bun", kcal: 150 },
    ]);
  });

  it("removes one item by index", () => {
    const after = applyAction(before(), { type: "remove_item", entryId: "a", index: 0 }, ctx());
    expect(after.entries[0].items).toEqual([{ name: "bun", kcal: 120 }]);
  });

  it("ignores an out-of-range index instead of corrupting the entry", () => {
    for (const index of [-1, 2, 99]) {
      expect(applyAction(before(), { type: "remove_item", entryId: "a", index }, ctx())).toEqual(before());
      expect(applyAction(before(), { type: "update_item", entryId: "a", index, patch: { kcal: 1 } }, ctx())).toEqual(before());
    }
  });

  it("ignores an unknown entry id", () => {
    expect(applyAction(before(), { type: "add_item", entryId: "nope", item: { name: "x", kcal: 1 } }, ctx())).toEqual(before());
  });
});

describe("answer / clarify", () => {
  it("change nothing — they are conversation, not mutation", () => {
    const before = day([entry("a", NOW)]);
    expect(applyAction(before, { type: "answer", text: "You have 1400 kcal left." }, ctx())).toEqual(before);
    expect(applyAction(before, { type: "clarify", question: "How big was the bowl?" }, ctx())).toEqual(before);
  });
});

describe("purity", () => {
  it("never mutates the day it was given", () => {
    const before = day([entry("a", NOW)]);
    const snapshot = structuredClone(before);

    applyActions(
      before,
      [
        { type: "add_entry", entry: { kind: "meal", at: NOW, label: "Snack", items: [{ name: "apple", kcal: 95 }] } },
        { type: "update_entry", id: "a", patch: { label: "Brunch" } },
        { type: "add_item", entryId: "a", item: { name: "mayo", kcal: 40 } },
        { type: "update_item", entryId: "a", index: 0, patch: { kcal: 300 } },
        { type: "remove_item", entryId: "a", index: 0 },
        { type: "delete_entry", id: "a" },
      ],
      ctx(),
    );

    expect(before).toEqual(snapshot);
  });

  it("does not share item objects between the input and the result", () => {
    const before = day([entry("a", NOW)]);
    const after = applyAction(before, { type: "add_item", entryId: "a", item: { name: "mayo", kcal: 40 } }, ctx());
    expect(after.entries[0].items).not.toBe(before.entries[0].items);
  });

  it("preserves the day's date and target", () => {
    const before: DayLog = { date: "2026-08-30", entries: [], targetKcal: 2000 };
    const after = applyAction(before, { type: "add_entry", entry: { kind: "meal", at: NOW, label: "L", items: [] } }, ctx());
    expect(after).toMatchObject({ date: "2026-08-30", targetKcal: 2000 });
  });
});

describe("applyActions", () => {
  it("folds a batch left to right, so a later action sees the earlier one's result", () => {
    const d = applyActions(
      emptyDay("2026-08-30"),
      [
        { type: "add_entry", entry: { kind: "meal", at: NOW, label: "Lunch", items: [{ name: "hot dog", kcal: 290 }] } },
        { type: "add_item", entryId: "e1", item: { name: "bun", kcal: 120 } },
      ],
      ctx(),
    );
    expect(d.entries[0].items.map((i) => i.name)).toEqual(["hot dog", "bun"]);
  });

  it("returns the day untouched for an empty batch", () => {
    const before = day([entry("a", NOW)]);
    expect(applyActions(before, [], ctx())).toEqual(before);
  });
});
