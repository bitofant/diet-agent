// The LLM's entire output surface. Small and orthogonal on purpose: prefer
// `clarify` over adding a special-cased intent.

import type { DayLog, EntryDraft, EntryKind, EntryPatch, ItemPatch, LogItem } from "./types.js";
import { isSaneInstant } from "./dates.js";

export interface AddEntry { type: "add_entry"; entry: EntryDraft }
export interface UpdateEntry { type: "update_entry"; id: string; patch: EntryPatch }
export interface DeleteEntry { type: "delete_entry"; id: string }
export interface AddItem { type: "add_item"; entryId: string; item: LogItem }
export interface UpdateItem { type: "update_item"; entryId: string; index: number; patch: ItemPatch }
export interface RemoveItem { type: "remove_item"; entryId: string; index: number }
/** A question answered, not a mutation. Always allowed alongside mutations. */
export interface Answer { type: "answer"; text: string }
/** The model is unsure — ask instead of inventing a quantity. */
export interface Clarify { type: "clarify"; question: string }

export type LogAction =
  | AddEntry | UpdateEntry | DeleteEntry
  | AddItem | UpdateItem | RemoveItem
  | Answer | Clarify;

export type ValidationResult =
  | { ok: true; actions: LogAction[] }
  | { ok: false; errors: string[] };

const ENTRY_KINDS: readonly EntryKind[] = ["meal", "activity", "note", "weight"];

// Sanity bounds, not nutrition science: they exist to stop a hallucinated
// exponent from poisoning a day's total, nothing more.
const MAX_ABS_KCAL = 20_000;
const MAX_ABS_GRAMS = 5_000;
const MAX_QTY = 10_000;
const MAX_TEXT = 2_000;
const MAX_ITEMS_PER_ENTRY = 100;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown, max = MAX_TEXT): v is string {
  return typeof v === "string" && v.trim() !== "" && v.length <= max;
}

function isBoundedNumber(v: unknown, max: number): v is number {
  return typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= max;
}

function validateItem(raw: unknown, where: string, errors: string[]): void {
  if (!isObj(raw)) return void errors.push(`${where}: item must be an object`);
  if (!isNonEmptyString(raw.name, 200)) errors.push(`${where}: item.name must be a non-empty string`);
  if (!isBoundedNumber(raw.kcal, MAX_ABS_KCAL)) errors.push(`${where}: item.kcal must be a finite number within ±${MAX_ABS_KCAL}`);
  if (raw.qty !== undefined && !(isBoundedNumber(raw.qty, MAX_QTY) && raw.qty > 0)) errors.push(`${where}: item.qty must be a positive finite number`);
  if (raw.unit !== undefined && !isNonEmptyString(raw.unit, 50)) errors.push(`${where}: item.unit must be a non-empty string`);
  for (const macro of ["protein", "carbs", "fat"] as const) {
    const v = raw[macro];
    if (v !== undefined && !(isBoundedNumber(v, MAX_ABS_GRAMS) && v >= 0)) errors.push(`${where}: item.${macro} must be a non-negative finite number`);
  }
}

function validateItemPatch(raw: unknown, where: string, errors: string[]): void {
  if (!isObj(raw)) return void errors.push(`${where}: patch must be an object`);
  if (Object.keys(raw).length === 0) errors.push(`${where}: patch is empty`);
  if (raw.name !== undefined && !isNonEmptyString(raw.name, 200)) errors.push(`${where}: patch.name must be a non-empty string`);
  if (raw.kcal !== undefined && !isBoundedNumber(raw.kcal, MAX_ABS_KCAL)) errors.push(`${where}: patch.kcal must be a finite number within ±${MAX_ABS_KCAL}`);
  if (raw.qty !== undefined && !(isBoundedNumber(raw.qty, MAX_QTY) && raw.qty > 0)) errors.push(`${where}: patch.qty must be a positive finite number`);
  if (raw.unit !== undefined && !isNonEmptyString(raw.unit, 50)) errors.push(`${where}: patch.unit must be a non-empty string`);
  for (const macro of ["protein", "carbs", "fat"] as const) {
    const v = raw[macro];
    if (v !== undefined && !(isBoundedNumber(v, MAX_ABS_GRAMS) && v >= 0)) errors.push(`${where}: patch.${macro} must be a non-negative finite number`);
  }
}

function validateItems(raw: unknown, where: string, errors: string[]): void {
  if (!Array.isArray(raw)) return void errors.push(`${where}: items must be an array`);
  if (raw.length > MAX_ITEMS_PER_ENTRY) return void errors.push(`${where}: items exceeds ${MAX_ITEMS_PER_ENTRY}`);
  raw.forEach((it, i) => validateItem(it, `${where}.items[${i}]`, errors));
}

function validateIndex(raw: unknown, where: string, errors: string[]): void {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) errors.push(`${where}: index must be a non-negative integer`);
}

/**
 * Validates one action against the requesting user's own day.
 *
 * Every id the model produced is resolved here, against `day` — which the caller
 * has already scoped to the session's user. That resolution *is* the tenant
 * check: an id the model invented, or borrowed from another context, simply is
 * not in this day and fails.
 */
function validateAction(day: DayLog, raw: unknown, where: string, errors: string[]): void {
  if (!isObj(raw)) return void errors.push(`${where}: action must be an object`);

  const known = new Set(day.entries.map((e) => e.id));
  const entryAt = (id: unknown) => day.entries.find((e) => e.id === id);
  const requireEntry = (id: unknown, field: string) => {
    if (typeof id !== "string" || !known.has(id)) {
      errors.push(`${where}: ${field} does not name an entry in this day`);
      return undefined;
    }
    return entryAt(id);
  };

  switch (raw.type) {
    case "add_entry": {
      const e = raw.entry;
      if (!isObj(e)) return void errors.push(`${where}: entry must be an object`);
      if (!ENTRY_KINDS.includes(e.kind as EntryKind)) errors.push(`${where}: entry.kind must be one of ${ENTRY_KINDS.join(", ")}`);
      if (!isSaneInstant(e.at)) errors.push(`${where}: entry.at must be a plausible ISO instant`);
      if (!isNonEmptyString(e.label, 200)) errors.push(`${where}: entry.label must be a non-empty string`);
      if (e.note !== undefined && !isNonEmptyString(e.note)) errors.push(`${where}: entry.note must be a non-empty string`);
      // An id from the model is never authorization — the server assigns ids.
      if ("id" in e) errors.push(`${where}: entry.id is assigned by the server, not the model`);
      validateItems(e.items, `${where}.entry`, errors);
      return;
    }
    case "update_entry": {
      requireEntry(raw.id, "id");
      const p = raw.patch;
      if (!isObj(p)) return void errors.push(`${where}: patch must be an object`);
      if (Object.keys(p).length === 0) errors.push(`${where}: patch is empty`);
      if ("id" in p || "createdAt" in p) errors.push(`${where}: patch may not touch id or createdAt`);
      if (p.kind !== undefined && !ENTRY_KINDS.includes(p.kind as EntryKind)) errors.push(`${where}: patch.kind must be one of ${ENTRY_KINDS.join(", ")}`);
      if (p.at !== undefined && !isSaneInstant(p.at)) errors.push(`${where}: patch.at must be a plausible ISO instant`);
      if (p.label !== undefined && !isNonEmptyString(p.label, 200)) errors.push(`${where}: patch.label must be a non-empty string`);
      if (p.note !== undefined && !isNonEmptyString(p.note)) errors.push(`${where}: patch.note must be a non-empty string`);
      if (p.items !== undefined) validateItems(p.items, `${where}.patch`, errors);
      return;
    }
    case "delete_entry":
      requireEntry(raw.id, "id");
      return;
    case "add_item":
      requireEntry(raw.entryId, "entryId");
      validateItem(raw.item, where, errors);
      return;
    case "update_item": {
      const entry = requireEntry(raw.entryId, "entryId");
      validateIndex(raw.index, where, errors);
      if (entry && typeof raw.index === "number" && raw.index >= entry.items.length) errors.push(`${where}: index ${raw.index} is out of range for that entry`);
      validateItemPatch(raw.patch, where, errors);
      return;
    }
    case "remove_item": {
      const entry = requireEntry(raw.entryId, "entryId");
      validateIndex(raw.index, where, errors);
      if (entry && typeof raw.index === "number" && raw.index >= entry.items.length) errors.push(`${where}: index ${raw.index} is out of range for that entry`);
      return;
    }
    case "answer":
      if (!isNonEmptyString(raw.text)) errors.push(`${where}: text must be a non-empty string`);
      return;
    case "clarify":
      if (!isNonEmptyString(raw.question)) errors.push(`${where}: question must be a non-empty string`);
      return;
    default:
      errors.push(`${where}: unknown action type ${JSON.stringify(raw.type)}`);
  }
}

/**
 * All-or-nothing: a batch is only applied if every action in it is valid, so a
 * partially-understood turn can never half-edit the log.
 *
 * `day` must already be scoped to the requesting user — this function trusts it
 * as the universe of reachable ids.
 */
export function validateActions(day: DayLog, raw: unknown): ValidationResult {
  if (!Array.isArray(raw)) return { ok: false, errors: ["actions must be an array"] };
  const errors: string[] = [];
  raw.forEach((a, i) => validateAction(day, a, `actions[${i}]`, errors));
  return errors.length ? { ok: false, errors } : { ok: true, actions: raw as LogAction[] };
}

/** True when the action changes the log (as opposed to just talking). */
export function isMutation(action: LogAction): boolean {
  return action.type !== "answer" && action.type !== "clarify";
}
