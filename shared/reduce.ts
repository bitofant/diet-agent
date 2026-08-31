// The pure reducer. The LLM never touches the database: it emits actions, they
// are validated, and this folds them into a day. Same code runs server-side
// (authoritative) and client-side (optimistic), so it must stay deterministic.

import type { DayLog, Instant, LogEntry, LogItem } from "./types.js";
import type { LogAction } from "./actions.js";

export interface ReduceContext {
  /** The turn's timestamp — supplied, never read from the ambient clock. */
  now: Instant;
  /** Server-assigned ids; injectable so tests (and optimistic UI) stay deterministic. */
  newId: () => string;
  /** The raw user message that produced this turn, stamped onto new entries. */
  source: string;
}

// Ties broken by createdAt then id so server and client land on the same order.
function byTime(a: LogEntry, b: LogEntry): number {
  return (
    Date.parse(a.at) - Date.parse(b.at) ||
    Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

function withEntries(day: DayLog, entries: LogEntry[]): DayLog {
  return { ...day, entries };
}

/** Replace one entry by id; returns the day untouched when the id is unknown. */
function mapEntry(day: DayLog, id: string, fn: (e: LogEntry) => LogEntry): DayLog {
  const i = day.entries.findIndex((e) => e.id === id);
  if (i === -1) return day;
  const entries = day.entries.slice();
  entries[i] = fn(entries[i]);
  return withEntries(day, entries.sort(byTime));
}

function mapItems(day: DayLog, entryId: string, now: Instant, fn: (items: LogItem[]) => LogItem[] | null): DayLog {
  return mapEntry(day, entryId, (e) => {
    const items = fn(e.items.slice());
    return items === null ? e : { ...e, items, updatedAt: now };
  });
}

function inRange(index: number, length: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < length;
}

/**
 * Fold one action into a day.
 *
 * Total by design: an unknown id or out-of-range index is a no-op rather than a
 * throw. Rejecting those is `validateActions`' job, and it runs first — keeping
 * the reducer total means an optimistic client that is briefly behind the server
 * degrades to "no visible change", never to a crash mid-render.
 */
export function applyAction(day: DayLog, action: LogAction, ctx: ReduceContext): DayLog {
  switch (action.type) {
    case "add_entry": {
      const entry: LogEntry = {
        ...action.entry,
        items: action.entry.items.map((it) => ({ ...it })),
        id: ctx.newId(),
        source: ctx.source,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      };
      return withEntries(day, [...day.entries, entry].sort(byTime));
    }

    case "update_entry":
      return mapEntry(day, action.id, (e) => ({
        ...e,
        ...action.patch,
        items: action.patch.items ? action.patch.items.map((it) => ({ ...it })) : e.items,
        // Identity and provenance are never patchable.
        id: e.id,
        source: e.source,
        createdAt: e.createdAt,
        updatedAt: ctx.now,
      }));

    case "delete_entry": {
      const entries = day.entries.filter((e) => e.id !== action.id);
      return entries.length === day.entries.length ? day : withEntries(day, entries);
    }

    case "add_item":
      return mapItems(day, action.entryId, ctx.now, (items) => [...items, { ...action.item }]);

    case "update_item":
      return mapItems(day, action.entryId, ctx.now, (items) => {
        if (!inRange(action.index, items.length)) return null;
        items[action.index] = { ...items[action.index], ...action.patch };
        return items;
      });

    case "remove_item":
      return mapItems(day, action.entryId, ctx.now, (items) => {
        if (!inRange(action.index, items.length)) return null;
        items.splice(action.index, 1);
        return items;
      });

    // Conversation, not mutation.
    case "answer":
    case "clarify":
      return day;
  }
}

/** Fold a batch left to right, so a later action sees the earlier one's result. */
export function applyActions(day: DayLog, actions: LogAction[], ctx: ReduceContext): DayLog {
  return actions.reduce((d, a) => applyAction(d, a, ctx), day);
}
