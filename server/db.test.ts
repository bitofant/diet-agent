import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, type Db } from "./db.js";
import type { ChatMessage, DayLog, LogEntry } from "../shared/types.js";
import { emptyDay } from "../shared/types.js";

const DATE = "2026-08-30";

let db: Db;
let alice: string;
let bob: string;

beforeEach(() => {
  db = openDb(":memory:");
  alice = db.createUser("alice", "salt:hash").id;
  bob = db.createUser("bob", "salt:hash").id;
});

afterEach(() => db.close());

function entry(id: string, at: string, over: Partial<LogEntry> = {}): LogEntry {
  return {
    id,
    kind: "meal",
    at,
    label: "Lunch",
    items: [{ name: "hot dog", qty: 2, unit: "each", kcal: 290, protein: 10 }],
    source: "2 hot dogs",
    createdAt: "2026-08-30T12:00:00.000Z",
    updatedAt: "2026-08-30T12:00:00.000Z",
    ...over,
  };
}

function day(entries: LogEntry[], over: Partial<DayLog> = {}): DayLog {
  return { date: DATE, entries, ...over };
}

function chat(id: string, over: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: "user", text: "2 hot dogs", at: "2026-08-30T12:00:00.000Z", ...over };
}

describe("users", () => {
  it("round-trips a user and finds it by username", () => {
    const row = db.findUser("alice");
    expect(row).toMatchObject({ id: alice, username: "alice", passwordHash: "salt:hash" });
    expect(db.getUser(alice)).toMatchObject({ username: "alice" });
    expect(db.getUser("nope")).toBeUndefined();
  });

  it("never leaks the hash through getUser", () => {
    expect(db.getUser(alice)).not.toHaveProperty("passwordHash");
  });

  it("rejects a duplicate username, case-insensitively", () => {
    expect(() => db.createUser("alice", "x")).toThrow();
    expect(() => db.createUser("ALICE", "x")).toThrow();
    expect(db.findUser("ALICE")?.id).toBe(alice);
  });
});

describe("sessions", () => {
  it("resolves a live token to its own user", () => {
    db.createSession(alice, "tok-a", Date.now() + 60_000);
    expect(db.sessionUser("tok-a")).toMatchObject({ id: alice, username: "alice" });
  });

  it("rejects unknown and expired tokens", () => {
    db.createSession(alice, "stale", Date.now() - 1);
    expect(db.sessionUser("stale")).toBeUndefined();
    expect(db.sessionUser("never-issued")).toBeUndefined();
  });

  it("logs out one token without touching the user's others", () => {
    db.createSession(alice, "phone", Date.now() + 60_000);
    db.createSession(alice, "laptop", Date.now() + 60_000);
    db.deleteSession("phone");
    expect(db.sessionUser("phone")).toBeUndefined();
    expect(db.sessionUser("laptop")).toMatchObject({ id: alice });
  });
});

describe("days and entries", () => {
  it("returns an empty day for a date never written", () => {
    expect(db.getDay(alice, DATE)).toEqual(emptyDay(DATE));
  });

  it("round-trips a day with its entries, items and target", () => {
    const d = day([entry("e1", "2026-08-30T12:10:00.000Z")], { targetKcal: 2000 });
    db.writeDay(alice, d);
    expect(db.getDay(alice, DATE)).toEqual(d);
  });

  it("keeps an absent note absent rather than turning it into null", () => {
    db.writeDay(alice, day([entry("e1", "2026-08-30T12:10:00.000Z")]));
    expect(db.getDay(alice, DATE).entries[0]).not.toHaveProperty("note");
    db.writeDay(alice, day([entry("e2", "2026-08-30T12:10:00.000Z", { note: "with mayo" })]));
    expect(db.getDay(alice, DATE).entries[0].note).toBe("with mayo");
  });

  it("orders entries by time, then createdAt, then id — as the reducer does", () => {
    db.writeDay(
      alice,
      day([
        entry("b", "2026-08-30T18:00:00.000Z"),
        entry("a", "2026-08-30T08:00:00.000Z"),
        // Same instant, different offsets: a lexical sort of `at` gets this wrong.
        entry("d", "2026-08-30T14:00:00.000+02:00", { createdAt: "2026-08-30T13:00:00.000Z" }),
        entry("c", "2026-08-30T12:00:00.000Z", { createdAt: "2026-08-30T09:00:00.000Z" }),
      ]),
    );
    expect(db.getDay(alice, DATE).entries.map((e) => e.id)).toEqual(["a", "c", "d", "b"]);
  });

  it("replaces the day wholesale: entries dropped by the reducer disappear", () => {
    db.writeDay(alice, day([entry("e1", "2026-08-30T12:00:00.000Z"), entry("e2", "2026-08-30T13:00:00.000Z")]));
    db.writeDay(alice, day([entry("e2", "2026-08-30T13:00:00.000Z", { label: "Snack" })]));
    const got = db.getDay(alice, DATE);
    expect(got.entries.map((e) => e.id)).toEqual(["e2"]);
    expect(got.entries[0].label).toBe("Snack");
  });

  it("keeps days separate", () => {
    db.writeDay(alice, day([entry("e1", "2026-08-30T12:00:00.000Z")]));
    db.writeDay(alice, { date: "2026-08-29", entries: [entry("e0", "2026-08-29T12:00:00.000Z")] });
    expect(db.getDay(alice, "2026-08-29").entries.map((e) => e.id)).toEqual(["e0"]);
    expect(db.getDay(alice, DATE).entries.map((e) => e.id)).toEqual(["e1"]);
  });

  it("finds an entry and the day it lives in", () => {
    db.writeDay(alice, day([entry("e1", "2026-08-30T12:00:00.000Z")]));
    expect(db.getEntry(alice, "e1")).toMatchObject({ date: DATE, entry: { id: "e1" } });
    expect(db.getEntry(alice, "missing")).toBeUndefined();
  });

  it("lists days newest first, skipping days with nothing in them", () => {
    db.writeDay(alice, day([entry("e1", "2026-08-30T12:00:00.000Z")]));
    db.writeDay(alice, { date: "2026-08-28", entries: [], targetKcal: 1800 });
    db.writeDay(alice, { date: "2026-08-29", entries: [entry("e0", "2026-08-29T12:00:00.000Z")] });
    db.writeDay(alice, { date: "2026-08-27", entries: [] }); // nothing logged, no target
    expect(db.listDays(alice).map((d) => d.date)).toEqual(["2026-08-30", "2026-08-29", "2026-08-28"]);
    expect(db.listDays(alice, { limit: 2 }).map((d) => d.date)).toEqual(["2026-08-30", "2026-08-29"]);
    expect(db.listDays(alice, { before: "2026-08-30" }).map((d) => d.date)).toEqual(["2026-08-29", "2026-08-28"]);
    expect(db.listDays(alice)[0].entries.map((e) => e.id)).toEqual(["e1"]);
  });
});

describe("chat messages", () => {
  it("round-trips a turn with the entries it cites", () => {
    db.appendChatMessage(alice, DATE, chat("m1"));
    db.appendChatMessage(alice, DATE, chat("m2", { role: "assistant", text: "Logged 350 kcal.", at: "2026-08-30T12:00:01.000Z", entryIds: ["e1"] }));
    expect(db.listChatMessages(alice, DATE)).toEqual([
      chat("m1"),
      { id: "m2", role: "assistant", text: "Logged 350 kcal.", at: "2026-08-30T12:00:01.000Z", entryIds: ["e1"] },
    ]);
  });

  it("omits entryIds when the turn cited none", () => {
    db.appendChatMessage(alice, DATE, chat("m1"));
    expect(db.listChatMessages(alice, DATE)[0]).not.toHaveProperty("entryIds");
  });

  it("scopes to the day", () => {
    db.appendChatMessage(alice, DATE, chat("m1"));
    expect(db.listChatMessages(alice, "2026-08-29")).toEqual([]);
  });
});

describe("llm turns", () => {
  it("logs the raw model output alongside the parsed actions and a rejected count", () => {
    db.logLlmTurn(alice, { date: DATE, userMessage: "2 hot dogs", raw: '{"actions":[]}', actions: [{ type: "answer", text: "ok" }], rejected: 2, error: "1 action rejected" });
    const [turn] = db.listLlmTurns(alice);
    expect(turn).toMatchObject({ date: DATE, userMessage: "2 hot dogs", raw: '{"actions":[]}', rejected: 2, error: "1 action rejected" });
    expect(turn.actions).toEqual([{ type: "answer", text: "ok" }]);
  });

  it("defaults the rejected counter and tolerates a turn with no parsed actions", () => {
    db.logLlmTurn(alice, { date: DATE, userMessage: "???", raw: "not json" });
    const [turn] = db.listLlmTurns(alice);
    expect(turn.rejected).toBe(0);
    expect(turn.actions).toBeUndefined();
    expect(turn.error).toBeUndefined();
  });

  it("lists newest first", () => {
    db.logLlmTurn(alice, { date: DATE, userMessage: "first", raw: "{}" });
    db.logLlmTurn(alice, { date: DATE, userMessage: "second", raw: "{}" });
    expect(db.listLlmTurns(alice).map((t) => t.userMessage)).toEqual(["second", "first"]);
  });
});

// The rule that outranks the rest of the file: nothing of one user's is
// reachable with another user's id, on any path.
describe("cross-tenant isolation", () => {
  beforeEach(() => {
    db.writeDay(alice, day([entry("e1", "2026-08-30T12:00:00.000Z")], { targetKcal: 2000 }));
    db.appendChatMessage(alice, DATE, chat("m1"));
    db.logLlmTurn(alice, { date: DATE, userMessage: "2 hot dogs", raw: "{}" });
  });

  it("hides alice's day, entries and target from bob", () => {
    expect(db.getDay(bob, DATE)).toEqual(emptyDay(DATE));
    expect(db.listDays(bob)).toEqual([]);
  });

  it("hides alice's entry from bob even with the exact id", () => {
    expect(db.getEntry(bob, "e1")).toBeUndefined();
  });

  it("hides alice's chat and llm turns from bob", () => {
    expect(db.listChatMessages(bob, DATE)).toEqual([]);
    expect(db.listLlmTurns(bob)).toEqual([]);
  });

  it("cannot overwrite alice's entry by reusing its id", () => {
    db.writeDay(bob, day([entry("e1", "2026-08-30T20:00:00.000Z", { label: "Dinner", source: "bob" })]));
    const mine = db.getDay(alice, DATE).entries[0];
    expect(mine).toMatchObject({ label: "Lunch", source: "2 hot dogs" });
    expect(db.getDay(bob, DATE).entries[0]).toMatchObject({ label: "Dinner", source: "bob" });
  });

  it("cannot clear alice's day by writing an empty one over it", () => {
    db.writeDay(bob, day([]));
    expect(db.getDay(alice, DATE).entries).toHaveLength(1);
    expect(db.getDay(alice, DATE).targetKcal).toBe(2000);
  });

  it("cannot reuse alice's chat message id to overwrite it", () => {
    db.appendChatMessage(bob, DATE, chat("m1", { text: "bob's message" }));
    expect(db.listChatMessages(alice, DATE)[0].text).toBe("2 hot dogs");
    expect(db.listChatMessages(bob, DATE)[0].text).toBe("bob's message");
  });

  it("gives each user only their own export", () => {
    const exported = db.exportUser(alice);
    expect(exported.user).toMatchObject({ username: "alice" });
    expect(exported.days).toHaveLength(1);
    expect(exported.chat).toHaveLength(1);
    expect(exported.llmTurns).toHaveLength(1);
    expect(db.exportUser(bob)).toMatchObject({ days: [], chat: [], llmTurns: [] });
  });
});

describe("account deletion", () => {
  it("cascades every table the user owns and leaves other users alone", () => {
    db.createSession(alice, "tok-a", Date.now() + 60_000);
    db.writeDay(alice, day([entry("e1", "2026-08-30T12:00:00.000Z")], { targetKcal: 2000 }));
    db.appendChatMessage(alice, DATE, chat("m1"));
    db.logLlmTurn(alice, { date: DATE, userMessage: "2 hot dogs", raw: "{}" });
    db.writeDay(bob, day([entry("b1", "2026-08-30T12:00:00.000Z")]));

    db.deleteUser(alice);

    expect(db.getUser(alice)).toBeUndefined();
    expect(db.findUser("alice")).toBeUndefined();
    expect(db.sessionUser("tok-a")).toBeUndefined();
    // Rows survive a missing ON DELETE CASCADE, so reading through the same
    // accessors is the check: an uncascaded day would still come back here.
    expect(db.getDay(alice, DATE)).toEqual(emptyDay(DATE));
    expect(db.listDays(alice)).toEqual([]);
    expect(db.listChatMessages(alice, DATE)).toEqual([]);
    expect(db.listLlmTurns(alice)).toEqual([]);
    expect(db.getEntry(alice, "e1")).toBeUndefined();
    expect(db.getDay(bob, DATE).entries).toHaveLength(1);
  });
});
