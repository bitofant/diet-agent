// The contract shared by server and client. Both sides fold the same actions
// over the same types, so anything here must stay serializable and model-agnostic.

/** Local calendar day, `YYYY-MM-DD`. Never a UTC timestamp — see dates.ts. */
export type DayKey = string;

/** ISO-8601 instant, e.g. `2026-08-30T12:10:00.000Z`. */
export type Instant = string;

export type EntryKind = "meal" | "activity" | "note" | "weight";

export interface LogItem {
  name: string;
  qty?: number;
  unit?: string;
  /** Negative for activities. Per-item so the expanded card can show a breakdown. */
  kcal: number;
  protein?: number;
  carbs?: number;
  fat?: number;
}

export interface LogEntry {
  id: string;
  kind: EntryKind;
  at: Instant;
  /** Display text ("Lunch", "Morning walk") — free-form, chosen by the model. */
  label: string;
  items: LogItem[];
  note?: string;
  /** The raw user message that created this, kept for debugging bad parses. */
  source: string;
  createdAt: Instant;
  updatedAt: Instant;
}

/**
 * What the model is allowed to emit for a new entry. It never supplies `id`,
 * `source` or the timestamps — the server owns those, so a hallucinated or
 * colliding id can't enter the log.
 */
export type EntryDraft = Pick<LogEntry, "kind" | "at" | "label" | "items"> &
  Partial<Pick<LogEntry, "note">>;

/** Fields of an existing entry the model may patch. */
export type EntryPatch = Partial<Pick<LogEntry, "kind" | "at" | "label" | "note" | "items">>;

export type ItemPatch = Partial<LogItem>;

export interface DayLog {
  date: DayKey;
  /** Sorted by `at` ascending; ties broken by `createdAt`, then `id`. */
  entries: LogEntry[];
  targetKcal?: number;
}

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  at: Instant;
  /** Entries this turn created or edited, so the UI can highlight them. */
  entryIds?: string[];
}

export function emptyDay(date: DayKey, targetKcal?: number): DayLog {
  return targetKcal === undefined ? { date, entries: [] } : { date, entries: [], targetKcal };
}
