import { describe, it, expect } from "vitest";
import type { DayLog, LogEntry } from "./types.js";
import { emptyDay } from "./types.js";
import { validateActions, isMutation, type LogAction } from "./actions.js";
import { applyActions } from "./reduce.js";

function entry(id: string, over: Partial<LogEntry> = {}): LogEntry {
  return {
    id,
    kind: "meal",
    at: "2026-08-30T12:00:00.000Z",
    label: "Lunch",
    items: [
      { name: "hot dog", kcal: 290 },
      { name: "bun", kcal: 120 },
    ],
    source: "src",
    createdAt: "2026-08-30T12:00:00.000Z",
    updatedAt: "2026-08-30T12:00:00.000Z",
    ...over,
  };
}

const day: DayLog = { date: "2026-08-30", entries: [entry("a")] };

function expectOk(actions: unknown[], d: DayLog = day) {
  const r = validateActions(d, actions);
  expect(r.ok, r.ok ? "" : (r as { errors: string[] }).errors.join("; ")).toBe(true);
  return r;
}

function expectRejected(actions: unknown[], d: DayLog = day) {
  const r = validateActions(d, actions);
  expect(r.ok).toBe(false);
  return r as { ok: false; errors: string[] };
}

const validDraft = {
  kind: "meal",
  at: "2026-08-30T14:10:00.000Z",
  label: "Lunch",
  items: [{ name: "hot dog", qty: 2, kcal: 290 }],
};

describe("shape", () => {
  it("accepts an empty batch and a well-formed one", () => {
    expectOk([]);
    expectOk([{ type: "add_entry", entry: validDraft }]);
  });

  it("rejects a non-array, non-object actions or an unknown type", () => {
    expect(validateActions(day, { type: "add_entry" }).ok).toBe(false);
    expect(validateActions(day, null).ok).toBe(false);
    expect(validateActions(day, "add_entry").ok).toBe(false);
    expectRejected([null]);
    expectRejected(["add_entry"]);
    expectRejected([{ type: "drop_table" }]);
    expectRejected([{ type: "add_entry" }]); // missing entry
  });
});

describe("tenant validation — ids must resolve in this user's own day", () => {
  it("rejects an id the model invented", () => {
    const r = expectRejected([{ type: "update_entry", id: "borrowed-from-somewhere", patch: { label: "X" } }]);
    expect(r.errors[0]).toMatch(/does not name an entry in this day/);
  });

  it("rejects unknown ids on every id-carrying action", () => {
    expectRejected([{ type: "update_entry", id: "nope", patch: { label: "X" } }]);
    expectRejected([{ type: "delete_entry", id: "nope" }]);
    expectRejected([{ type: "add_item", entryId: "nope", item: { name: "x", kcal: 1 } }]);
    expectRejected([{ type: "update_item", entryId: "nope", index: 0, patch: { kcal: 1 } }]);
    expectRejected([{ type: "remove_item", entryId: "nope", index: 0 }]);
  });

  it("rejects an id that exists only in another user's day", () => {
    const mine: DayLog = { date: "2026-08-30", entries: [entry("mine")] };
    const theirs: DayLog = { date: "2026-08-30", entries: [entry("theirs")] };
    expectOk([{ type: "delete_entry", id: "theirs" }], theirs);
    expectRejected([{ type: "delete_entry", id: "theirs" }], mine);
  });

  it("rejects a non-string id", () => {
    expectRejected([{ type: "delete_entry", id: 1 }]);
    expectRejected([{ type: "delete_entry" }]);
  });

  it("refuses a model-supplied id on a new entry — the server assigns those", () => {
    const r = expectRejected([{ type: "add_entry", entry: { ...validDraft, id: "a" } }]);
    expect(r.errors[0]).toMatch(/assigned by the server/);
  });
});

describe("all-or-nothing", () => {
  it("rejects the whole batch when any one action fails", () => {
    const r = expectRejected([
      { type: "add_entry", entry: validDraft },
      { type: "delete_entry", id: "nope" },
    ]);
    expect(r.errors).toHaveLength(1);
  });

  it("reports every failure, tagged with its index", () => {
    const r = expectRejected([
      { type: "delete_entry", id: "nope" },
      { type: "add_entry", entry: { ...validDraft, items: [{ name: "x", kcal: NaN }] } },
    ]);
    expect(r.errors.join("\n")).toMatch(/actions\[0\]/);
    expect(r.errors.join("\n")).toMatch(/actions\[1\]/);
  });

  it("a rejected batch never reaches the reducer, so the day is untouched", () => {
    const result = validateActions(day, [
      { type: "add_entry", entry: validDraft },
      { type: "delete_entry", id: "nope" },
    ]);
    const after = result.ok ? applyActions(day, result.actions, { now: "x", newId: () => "e1", source: "s" }) : day;
    expect(after).toEqual(day);
  });
});

describe("entry validation", () => {
  it("rejects a bad kind", () => {
    expectRejected([{ type: "add_entry", entry: { ...validDraft, kind: "snack" } }]);
    expectRejected([{ type: "add_entry", entry: { ...validDraft, kind: undefined } }]);
  });

  it("accepts every legitimate kind", () => {
    for (const kind of ["meal", "activity", "note", "weight"]) {
      expectOk([{ type: "add_entry", entry: { ...validDraft, kind } }]);
    }
  });

  it("rejects an implausible or unparseable timestamp", () => {
    for (const at of ["tomorrow", "", "1823-01-01T00:00:00.000Z", "9999-01-01T00:00:00.000Z", 1756555000000, undefined]) {
      expectRejected([{ type: "add_entry", entry: { ...validDraft, at } }]);
    }
  });

  it("rejects an empty or missing label", () => {
    expectRejected([{ type: "add_entry", entry: { ...validDraft, label: "" } }]);
    expectRejected([{ type: "add_entry", entry: { ...validDraft, label: "   " } }]);
    expectRejected([{ type: "add_entry", entry: { ...validDraft, label: undefined } }]);
  });

  it("accepts an entry with no items — a note or a weight has none", () => {
    expectOk([{ type: "add_entry", entry: { kind: "note", at: validDraft.at, label: "Felt sluggish", items: [] } }]);
  });

  it("rejects items that are not an array", () => {
    expectRejected([{ type: "add_entry", entry: { ...validDraft, items: "hot dog" } }]);
    expectRejected([{ type: "add_entry", entry: { ...validDraft, items: undefined } }]);
  });
});

describe("item validation", () => {
  const withItem = (item: unknown) => [{ type: "add_entry", entry: { ...validDraft, items: [item] } }];

  it("rejects NaN, Infinity and non-numeric kcal", () => {
    for (const kcal of [NaN, Infinity, -Infinity, "290", null, undefined]) {
      expectRejected(withItem({ name: "hot dog", kcal }));
    }
  });

  it("accepts a negative kcal — that is how an activity is recorded", () => {
    expectOk(withItem({ name: "15min walk", kcal: -60 }));
  });

  it("rejects an absurd kcal magnitude", () => {
    expectRejected(withItem({ name: "hot dog", kcal: 1e9 }));
    expectRejected(withItem({ name: "hot dog", kcal: -1e9 }));
  });

  it("rejects a nameless item", () => {
    expectRejected(withItem({ name: "", kcal: 100 }));
    expectRejected(withItem({ kcal: 100 }));
  });

  it("rejects a non-positive or non-finite qty", () => {
    for (const qty of [0, -1, NaN, Infinity, "2"]) expectRejected(withItem({ name: "x", kcal: 1, qty }));
    expectOk(withItem({ name: "x", kcal: 1, qty: 0.5 }));
  });

  it("rejects negative macros", () => {
    expectRejected(withItem({ name: "x", kcal: 1, protein: -5 }));
    expectRejected(withItem({ name: "x", kcal: 1, carbs: NaN }));
    expectOk(withItem({ name: "x", kcal: 1, protein: 30, carbs: 0, fat: 8 }));
  });
});

describe("patch validation", () => {
  it("accepts a timestamp patch — 'it was an hour ago'", () => {
    expectOk([{ type: "update_entry", id: "a", patch: { at: "2026-08-30T11:00:00.000Z" } }]);
  });

  it("rejects an empty patch", () => {
    expectRejected([{ type: "update_entry", id: "a", patch: {} }]);
    expectRejected([{ type: "update_entry", id: "a" }]);
  });

  it("refuses to patch identity fields", () => {
    expectRejected([{ type: "update_entry", id: "a", patch: { id: "b" } }]);
    expectRejected([{ type: "update_entry", id: "a", patch: { createdAt: "2020-01-01T00:00:00.000Z" } }]);
  });

  it("validates patched items the same way as new ones", () => {
    expectRejected([{ type: "update_entry", id: "a", patch: { items: [{ name: "x", kcal: NaN }] } }]);
    expectOk([{ type: "update_entry", id: "a", patch: { items: [{ name: "salad", kcal: 120 }] } }]);
  });
});

describe("item index validation", () => {
  it("accepts an in-range index", () => {
    expectOk([{ type: "remove_item", entryId: "a", index: 0 }]);
    expectOk([{ type: "update_item", entryId: "a", index: 1, patch: { kcal: 150 } }]);
  });

  it("rejects an index past the end of that entry's items", () => {
    expectRejected([{ type: "remove_item", entryId: "a", index: 2 }]);
    expectRejected([{ type: "update_item", entryId: "a", index: 99, patch: { kcal: 1 } }]);
  });

  it("rejects a negative or fractional index", () => {
    for (const index of [-1, 1.5, "0", undefined]) {
      expectRejected([{ type: "remove_item", entryId: "a", index }]);
    }
  });

  it("rejects an empty item patch", () => {
    expectRejected([{ type: "update_item", entryId: "a", index: 0, patch: {} }]);
  });
});

describe("answer / clarify", () => {
  it("accepts non-empty text", () => {
    expectOk([{ type: "answer", text: "You have 1400 kcal left." }]);
    expectOk([{ type: "clarify", question: "How big was the bowl?" }]);
  });

  it("rejects empty text", () => {
    expectRejected([{ type: "answer", text: "" }]);
    expectRejected([{ type: "clarify", question: "   " }]);
  });

  it("may accompany mutations in one batch", () => {
    expectOk([
      { type: "add_entry", entry: validDraft },
      { type: "answer", text: "Logged. 1650 kcal left." },
    ]);
  });

  it("is allowed against an empty day, where no id would resolve", () => {
    expectOk([{ type: "clarify", question: "What did you have?" }], emptyDay("2026-08-30"));
  });
});

describe("isMutation", () => {
  it("separates the talking actions from the writing ones", () => {
    const mutations: LogAction[] = [
      { type: "add_entry", entry: { kind: "meal", at: validDraft.at, label: "Lunch", items: [] } },
      { type: "update_entry", id: "a", patch: { label: "Brunch" } },
      { type: "delete_entry", id: "a" },
      { type: "add_item", entryId: "a", item: { name: "x", kcal: 1 } },
      { type: "update_item", entryId: "a", index: 0, patch: { kcal: 1 } },
      { type: "remove_item", entryId: "a", index: 0 },
    ];
    for (const a of mutations) expect(isMutation(a)).toBe(true);
    expect(isMutation({ type: "answer", text: "hi" })).toBe(false);
    expect(isMutation({ type: "clarify", question: "hm?" })).toBe(false);
  });
});
