// Local-day math. The client supplies `now` + its IANA timezone with every turn;
// nothing here ever reads the ambient clock or the host's timezone.

import type { DayKey, Instant } from "./types.js";

const DAY_MS = 86_400_000;
const DAY_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const dayKeyFmt = new Map<string, Intl.DateTimeFormat>();
const timeFmt = new Map<string, Intl.DateTimeFormat>();

function fmt(cache: Map<string, Intl.DateTimeFormat>, tz: string, opts: Intl.DateTimeFormatOptions) {
  let f = cache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, ...opts });
    cache.set(tz, f);
  }
  return f;
}

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((p) => p.type === type)?.value ?? "";
}

function toDate(at: Instant | Date): Date {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) throw new Error(`Unparseable instant: ${String(at)}`);
  return d;
}

/** The `YYYY-MM-DD` calendar day an instant falls on *in `tz`*. */
export function localDayKey(at: Instant | Date, tz: string): DayKey {
  const parts = fmt(dayKeyFmt, tz, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(toDate(at));
  return `${part(parts, "year")}-${part(parts, "month")}-${part(parts, "day")}`;
}

/** True for a well-formed key that names a real calendar date. */
export function isDayKey(v: unknown): v is DayKey {
  if (typeof v !== "string") return false;
  const m = DAY_KEY_RE.exec(v);
  if (!m) return false;
  const [, y, mo, d] = m;
  const date = new Date(`${v}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return false;
  // Round-trip catches overflow like 2026-02-30 or 2026-13-01.
  return (
    date.getUTCFullYear() === Number(y) &&
    date.getUTCMonth() + 1 === Number(mo) &&
    date.getUTCDate() === Number(d)
  );
}

function dayKeyToUtc(key: DayKey): Date {
  if (!isDayKey(key)) throw new Error(`Not a day key: ${key}`);
  return new Date(`${key}T00:00:00.000Z`);
}

function utcToDayKey(d: Date): DayKey {
  return d.toISOString().slice(0, 10);
}

/**
 * Calendar-day arithmetic, done at UTC midnight so it can't be perturbed by DST
 * — "yesterday" is one row up in the sidebar, not 24 hours ago.
 */
export function shiftDayKey(key: DayKey, days: number): DayKey {
  return utcToDayKey(new Date(dayKeyToUtc(key).getTime() + days * DAY_MS));
}

/** Signed day count from `a` to `b`. */
export function daysBetween(a: DayKey, b: DayKey): number {
  return Math.round((dayKeyToUtc(b).getTime() - dayKeyToUtc(a).getTime()) / DAY_MS);
}

/** Today, yesterday, … as of the client's `now` — the sidebar's day rows. */
export function recentDayKeys(now: Instant | Date, tz: string, count = 3): DayKey[] {
  const today = localDayKey(now, tz);
  return Array.from({ length: count }, (_, i) => shiftDayKey(today, -i));
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Relabelled against the *client's* today, so it changes at the user's midnight. */
export function dayLabel(key: DayKey, today: DayKey): string {
  switch (daysBetween(today, key)) {
    case 0: return "Today";
    case -1: return "Yesterday";
    case -2: return "Day before yesterday";
    case 1: return "Tomorrow";
  }
  const d = dayKeyToUtc(key);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Wall-clock time in `tz`, as shown on an entry card: `2:10pm`. */
export function formatLocalTime(at: Instant | Date, tz: string): string {
  const parts = fmt(timeFmt, tz, {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(toDate(at));
  const period = part(parts, "dayPeriod").toLowerCase().replace(/[^a-z]/g, "");
  return `${part(parts, "hour")}:${part(parts, "minute")}${period}`;
}

/**
 * A parseable instant in a plausible range. Guards the log against a model
 * emitting `"tomorrow"`, a NaN date, or the year 9999.
 */
export function isSaneInstant(v: unknown): v is Instant {
  if (typeof v !== "string" || v === "") return false;
  const t = Date.parse(v);
  if (Number.isNaN(t)) return false;
  const year = new Date(t).getUTCFullYear();
  return year >= 2000 && year <= 2100;
}
