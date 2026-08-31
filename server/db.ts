import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { ChatMessage, DayKey, DayLog, LogEntry, LogItem } from "../shared/types.js";
import { emptyDay } from "../shared/types.js";

// The only persistence layer. Multi-tenancy is enforced *here*, not at the call
// sites: every user-owned accessor takes `userId` first and puts it in the WHERE
// clause of the same statement that fetches the row, so a wrong or guessed id
// simply matches nothing. There is deliberately no unscoped `getEntry(id)`.

const DEFAULT_DB_PATH = resolve(process.cwd(), "data/diet-agent.db");

export interface UserRow {
  id: string;
  username: string;
  createdAt: number;
}

export interface UserWithHash extends UserRow {
  passwordHash: string;
}

export interface LlmTurnInput {
  date: DayKey;
  userMessage: string;
  /** Raw model output, verbatim — this is how the prompt gets improved. */
  raw: string;
  actions?: unknown;
  /** How many actions this turn's validation threw away. */
  rejected?: number;
  error?: string;
}

export interface LlmTurnRow extends Omit<LlmTurnInput, "rejected"> {
  id: number;
  rejected: number;
  createdAt: number;
}

export interface UserExport {
  user: UserRow;
  days: DayLog[];
  chat: (ChatMessage & { date: DayKey })[];
  llmTurns: LlmTurnRow[];
}

interface EntryRow {
  id: string;
  date: DayKey;
  kind: string;
  at: string;
  label: string;
  items: string;
  note: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
}

interface ChatRow {
  id: string;
  date: DayKey;
  role: string;
  text: string;
  at: string;
  entryIds: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Login sessions: opaque token from an HttpOnly cookie. Cascades so deleting an
-- account logs out every device it was signed in on.
CREATE TABLE IF NOT EXISTS auth_sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_sessions_user ON auth_sessions(user_id);

-- One row per local calendar day the user has touched. Holds only the target;
-- totals are derived from items (nutrition.ts), never stored.
CREATE TABLE IF NOT EXISTS days (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  target_kcal REAL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, date)
);

-- (user_id, id) is the primary key, not id alone: an id one tenant supplies can
-- then never address another tenant's row, even on an upsert.
-- The items column is JSON because items are a value array — always read and written
-- whole with their entry, never queried across entries.
-- at_ms exists only to sort: at may carry a UTC offset, so lexical ordering
-- of it disagrees with the reducer's Date.parse ordering.
CREATE TABLE IF NOT EXISTS entries (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  date TEXT NOT NULL,
  kind TEXT NOT NULL,
  at TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  label TEXT NOT NULL,
  items TEXT NOT NULL,
  note TEXT,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS entries_day ON entries(user_id, date, at_ms);

CREATE TABLE IF NOT EXISTS chat_messages (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  date TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  at TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  entry_ids TEXT,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS chat_messages_day ON chat_messages(user_id, date, at_ms);

-- The most sensitive table in the app: raw prompts and raw model output. Owned,
-- scoped and pruned like everything else; never logged to stdout.
CREATE TABLE IF NOT EXISTS llm_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  user_message TEXT NOT NULL,
  raw TEXT NOT NULL,
  actions TEXT,
  rejected INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS llm_turns_user ON llm_turns(user_id, id);
`;

// Bounded like every other diagnostic log; pruned probabilistically on insert.
const LLM_TURN_RETENTION = 2_000;
const DEFAULT_DAY_LIMIT = 60;

function msOf(at: string): number {
  const t = Date.parse(at);
  return Number.isNaN(t) ? 0 : t;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toEntry(row: EntryRow): LogEntry {
  const entry: LogEntry = {
    id: row.id,
    kind: row.kind as LogEntry["kind"],
    at: row.at,
    label: row.label,
    items: parseJson<LogItem[]>(row.items, []),
    source: row.source,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (row.note !== null) entry.note = row.note;
  return entry;
}

function toChatMessage(row: ChatRow): ChatMessage {
  const msg: ChatMessage = {
    id: row.id,
    role: row.role as ChatMessage["role"],
    text: row.text,
    at: row.at,
  };
  const ids = parseJson<string[]>(row.entryIds, []);
  if (ids.length) msg.entryIds = ids;
  return msg;
}

function toTurn(row: Record<string, unknown>): LlmTurnRow {
  const turn: LlmTurnRow = {
    id: row.id as number,
    date: row.date as DayKey,
    userMessage: row.userMessage as string,
    raw: row.raw as string,
    rejected: row.rejected as number,
    createdAt: row.createdAt as number,
  };
  if (row.actions !== null) turn.actions = parseJson<unknown>(row.actions as string, undefined);
  if (row.error !== null) turn.error = row.error as string;
  return turn;
}

/** Open (and migrate) the database. `":memory:"` gives tests a private one. */
export function openDb(path: string = DEFAULT_DB_PATH) {
  const inMemory = path === ":memory:";
  if (!inMemory) mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  // Per-connection, and load-bearing: without it ON DELETE CASCADE is inert and
  // a deleted account leaves its food log behind.
  db.pragma("foreign_keys = ON");
  if (!inMemory) db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);

  const s = {
    createUser: db.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)"),
    findUser: db.prepare("SELECT id, username, password_hash AS passwordHash, created_at AS createdAt FROM users WHERE username = ?"),
    getUser: db.prepare("SELECT id, username, created_at AS createdAt FROM users WHERE id = ?"),
    deleteUser: db.prepare("DELETE FROM users WHERE id = ?"),

    createSession: db.prepare("INSERT INTO auth_sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"),
    sessionUser: db.prepare(
      `SELECT u.id, u.username, u.created_at AS createdAt, s.expires_at AS expiresAt
       FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`,
    ),
    deleteSession: db.prepare("DELETE FROM auth_sessions WHERE token = ?"),

    upsertDay: db.prepare(
      `INSERT INTO days (user_id, date, target_kcal, created_at, updated_at)
       VALUES (@userId, @date, @targetKcal, @ts, @ts)
       ON CONFLICT(user_id, date) DO UPDATE SET
         target_kcal = excluded.target_kcal,
         updated_at = excluded.updated_at`,
    ),
    getDay: db.prepare("SELECT target_kcal AS targetKcal FROM days WHERE user_id = ? AND date = ?"),
    // A day with neither entries nor a target is a row the user never filled in
    // — it must not show up as a blank row in History.
    listDays: db.prepare(
      `SELECT date, target_kcal AS targetKcal FROM days
       WHERE user_id = @userId AND date < @before
         AND (target_kcal IS NOT NULL
              OR EXISTS (SELECT 1 FROM entries e WHERE e.user_id = days.user_id AND e.date = days.date))
       ORDER BY date DESC LIMIT @limit`,
    ),

    // Same order as the reducer's byTime, so server and client agree. Comparing
    // created_at as text is safe only because the server stamps it in UTC.
    dayEntries: db.prepare(
      `SELECT id, date, kind, at, label, items, note, source, created_at AS createdAt, updated_at AS updatedAt
       FROM entries WHERE user_id = ? AND date = ? ORDER BY at_ms, created_at, id`,
    ),
    allEntries: db.prepare(
      `SELECT id, date, kind, at, label, items, note, source, created_at AS createdAt, updated_at AS updatedAt
       FROM entries WHERE user_id = ? ORDER BY date DESC, at_ms, created_at, id`,
    ),
    getEntry: db.prepare(
      `SELECT id, date, kind, at, label, items, note, source, created_at AS createdAt, updated_at AS updatedAt
       FROM entries WHERE user_id = ? AND id = ?`,
    ),
    clearDayEntries: db.prepare("DELETE FROM entries WHERE user_id = ? AND date = ?"),
    insertEntry: db.prepare(
      `INSERT INTO entries (user_id, id, date, kind, at, at_ms, label, items, note, source, created_at, updated_at)
       VALUES (@userId, @id, @date, @kind, @at, @atMs, @label, @items, @note, @source, @createdAt, @updatedAt)`,
    ),

    upsertChat: db.prepare(
      `INSERT INTO chat_messages (user_id, id, date, role, text, at, at_ms, entry_ids)
       VALUES (@userId, @id, @date, @role, @text, @at, @atMs, @entryIds)
       ON CONFLICT(user_id, id) DO UPDATE SET
         date = excluded.date, role = excluded.role, text = excluded.text,
         at = excluded.at, at_ms = excluded.at_ms, entry_ids = excluded.entry_ids`,
    ),
    listChat: db.prepare(
      `SELECT id, date, role, text, at, entry_ids AS entryIds FROM chat_messages
       WHERE user_id = ? AND date = ? ORDER BY at_ms, rowid LIMIT ?`,
    ),
    allChat: db.prepare(
      `SELECT id, date, role, text, at, entry_ids AS entryIds FROM chat_messages
       WHERE user_id = ? ORDER BY date, at_ms, rowid`,
    ),

    insertTurn: db.prepare(
      `INSERT INTO llm_turns (user_id, date, user_message, raw, actions, rejected, error, created_at)
       VALUES (@userId, @date, @userMessage, @raw, @actions, @rejected, @error, @createdAt)`,
    ),
    listTurns: db.prepare(
      `SELECT id, date, user_message AS userMessage, raw, actions, rejected, error, created_at AS createdAt
       FROM llm_turns WHERE user_id = ? ORDER BY id DESC LIMIT ?`,
    ),
    pruneTurns: db.prepare(
      `DELETE FROM llm_turns WHERE user_id = @userId AND id NOT IN
         (SELECT id FROM llm_turns WHERE user_id = @userId ORDER BY id DESC LIMIT @keep)`,
    ),
  };

  function readTurns(userId: string, limit: number): LlmTurnRow[] {
    return (s.listTurns.all(userId, limit) as Record<string, unknown>[]).map(toTurn);
  }

  function readDay(userId: string, date: DayKey): DayLog {
    const row = s.getDay.get(userId, date) as { targetKcal: number | null } | undefined;
    const entries = (s.dayEntries.all(userId, date) as EntryRow[]).map(toEntry);
    const day = emptyDay(date, row?.targetKcal ?? undefined);
    return { ...day, entries };
  }

  const writeDayTx = db.transaction((userId: string, day: DayLog) => {
    const ts = Date.now();
    s.upsertDay.run({ userId, date: day.date, targetKcal: day.targetKcal ?? null, ts });
    // Replace wholesale: the reducer hands back the whole day, so a diff here
    // would be a second source of truth about what the day contains.
    s.clearDayEntries.run(userId, day.date);
    for (const e of day.entries) {
      s.insertEntry.run({
        userId,
        id: e.id,
        date: day.date,
        kind: e.kind,
        at: e.at,
        atMs: msOf(e.at),
        label: e.label,
        items: JSON.stringify(e.items),
        note: e.note ?? null,
        source: e.source,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
      });
    }
  });

  return {
    /** Throws on a duplicate username (UNIQUE, case-insensitive). */
    createUser(username: string, passwordHash: string): UserRow {
      const row: UserRow = { id: randomUUID(), username, createdAt: Date.now() };
      s.createUser.run(row.id, row.username, passwordHash, row.createdAt);
      return row;
    },

    /** By username, *with* the hash — for the login check only. */
    findUser(username: string): UserWithHash | undefined {
      return s.findUser.get(username) as UserWithHash | undefined;
    },

    getUser(userId: string): UserRow | undefined {
      return s.getUser.get(userId) as UserRow | undefined;
    },

    /** Cascades to days, entries, chat, llm turns and sessions. */
    deleteUser(userId: string): void {
      s.deleteUser.run(userId);
    },

    createSession(userId: string, token: string, expiresAt: number): void {
      s.createSession.run(token, userId, Date.now(), expiresAt);
    },

    /** The session's user, or undefined if unknown or expired (pruned lazily). */
    sessionUser(token: string): UserRow | undefined {
      const row = s.sessionUser.get(token) as (UserRow & { expiresAt: number }) | undefined;
      if (!row) return undefined;
      if (row.expiresAt <= Date.now()) {
        s.deleteSession.run(token);
        return undefined;
      }
      const { expiresAt: _, ...user } = row;
      return user;
    },

    deleteSession(token: string): void {
      s.deleteSession.run(token);
    },

    /** The user's own day; an untouched date reads as an empty day, not null. */
    getDay(userId: string, date: DayKey): DayLog {
      return readDay(userId, date);
    },

    /** Persist a day the reducer produced. Atomic: never half a day. */
    writeDay(userId: string, day: DayLog): void {
      writeDayTx(userId, day);
    },

    /** Days with something in them, newest first — the History list. */
    listDays(userId: string, opts: { limit?: number; before?: DayKey } = {}): DayLog[] {
      const rows = s.listDays.all({
        userId,
        limit: opts.limit ?? DEFAULT_DAY_LIMIT,
        // `before` is exclusive; the sentinel sorts after any real key.
        before: opts.before ?? "9999-99-99",
      }) as { date: DayKey; targetKcal: number | null }[];
      return rows.map((r) => readDay(userId, r.date));
    },

    /** An entry and the day it lives in. Scoped, so a foreign id is a miss. */
    getEntry(userId: string, entryId: string): { date: DayKey; entry: LogEntry } | undefined {
      const row = s.getEntry.get(userId, entryId) as EntryRow | undefined;
      return row && { date: row.date, entry: toEntry(row) };
    },

    /** Insert, or update in place when the id is already the user's own. */
    appendChatMessage(userId: string, date: DayKey, msg: ChatMessage): void {
      s.upsertChat.run({
        userId,
        id: msg.id,
        date,
        role: msg.role,
        text: msg.text,
        at: msg.at,
        atMs: msOf(msg.at),
        entryIds: msg.entryIds?.length ? JSON.stringify(msg.entryIds) : null,
      });
    },

    listChatMessages(userId: string, date: DayKey, limit = 500): ChatMessage[] {
      return (s.listChat.all(userId, date, limit) as ChatRow[]).map(toChatMessage);
    },

    logLlmTurn(userId: string, turn: LlmTurnInput): void {
      s.insertTurn.run({
        userId,
        date: turn.date,
        userMessage: turn.userMessage,
        raw: turn.raw,
        actions: turn.actions === undefined ? null : JSON.stringify(turn.actions),
        rejected: turn.rejected ?? 0,
        error: turn.error ?? null,
        createdAt: Date.now(),
      });
      if (Math.random() < 0.02) s.pruneTurns.run({ userId, keep: LLM_TURN_RETENTION });
    },

    listLlmTurns(userId: string, limit = 100): LlmTurnRow[] {
      return readTurns(userId, limit);
    },

    /** Everything this user owns, for "give me my data back". */
    exportUser(userId: string): UserExport | undefined {
      const user = s.getUser.get(userId) as UserRow | undefined;
      if (!user) return undefined;
      const byDate = new Map<DayKey, LogEntry[]>();
      for (const row of s.allEntries.all(userId) as EntryRow[]) {
        const list = byDate.get(row.date) ?? [];
        list.push(toEntry(row));
        byDate.set(row.date, list);
      }
      const days = (s.listDays.all({ userId, limit: -1, before: "9999-99-99" }) as { date: DayKey; targetKcal: number | null }[]).map(
        (r) => ({ ...emptyDay(r.date, r.targetKcal ?? undefined), entries: byDate.get(r.date) ?? [] }),
      );
      const chat = (s.allChat.all(userId) as ChatRow[]).map((r) => ({ ...toChatMessage(r), date: r.date }));
      return { user, days, chat, llmTurns: readTurns(userId, -1) };
    },

    /** Flush the WAL into the .db file; without it a SIGKILL strands writes. */
    close(): void {
      try {
        if (!inMemory) db.pragma("wal_checkpoint(TRUNCATE)");
      } finally {
        db.close();
      }
    },
  };
}

export type Db = ReturnType<typeof openDb>;

let shared: Db | undefined;

/** The process-wide database. Tests use `openDb(":memory:")` instead. */
export function getDb(): Db {
  return (shared ??= openDb());
}
