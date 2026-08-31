import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as connectTcp, type AddressInfo } from "node:net";
import WebSocket from "ws";
import { createApp, type App } from "./index.js";
import { openDb, type Db } from "./db.js";
import { hashPassword } from "./auth.js";
import { withDefaults } from "./config.js";
import type { LogAction } from "../shared/actions.js";

const DATE = "2026-08-30";
const NOW = "2026-08-30T12:10:00.000Z";

interface Harness {
  db: Db;
  port: number;
  base: string;
}

const running: { app: App; db: Db; sockets: WebSocket[] }[] = [];

afterEach(async () => {
  for (const r of running.splice(0)) {
    for (const s of r.sockets) s.terminate();
    await r.app.close();
    r.db.close();
  }
});

async function start(opts: { staticRoot?: string } = {}): Promise<Harness> {
  const db = openDb(":memory:");
  const app = await createApp({ db, config: withDefaults({}), staticRoot: opts.staticRoot });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const { port } = app.server.address() as AddressInfo;
  running.push({ app, db, sockets: [] });
  return { db, port, base: `http://127.0.0.1:${port}` };
}

interface Reply {
  status: number;
  body: any;
  cookie: string | undefined;
}

async function call(h: Harness, method: string, path: string, opts: { body?: unknown; cookie?: string } = {}): Promise<Reply> {
  const res = await fetch(`${h.base}${path}`, {
    method,
    headers: {
      ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const raw = await res.text();
  const setCookie = res.headers.get("set-cookie") ?? undefined;
  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : undefined;
  } catch {
    body = raw;
  }
  return { status: res.status, body, cookie: setCookie?.split(";")[0] };
}

async function register(h: Harness, username: string): Promise<string> {
  const r = await call(h, "POST", "/api/register", { body: { username, password: "correct horse" } });
  expect(r.status).toBe(200);
  return r.cookie!;
}

/** A request exactly as written, bypassing a client library's path normalising. */
function rawGet(h: Harness, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    const socket = connectTcp(h.port, "127.0.0.1", () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    socket.on("data", (chunk) => (data += chunk));
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
  });
}

function connect(h: Harness, cookie?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${h.port}/ws`, cookie ? { headers: { cookie } } : undefined);
    running.at(-1)!.sockets.push(socket);
    socket.on("open", () => resolve(socket));
    socket.on("unexpected-response", (_req, res) => reject(Object.assign(new Error("rejected"), { status: res.statusCode })));
    socket.on("error", reject);
  });
}

function nextMessage(socket: WebSocket, ms = 1000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no message")), ms);
    socket.once("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
}

const addLunch: LogAction = {
  type: "add_entry",
  entry: { kind: "meal", at: NOW, label: "Lunch", items: [{ name: "hot dog", qty: 2, kcal: 350 }] },
};

function postActions(h: Harness, cookie: string, actions: LogAction[], over: Record<string, unknown> = {}) {
  return call(h, "POST", "/api/actions", { cookie, body: { date: DATE, now: NOW, actions, ...over } });
}

describe("health", () => {
  it("answers without a session and says nothing about users", async () => {
    const h = await start();
    const r = await call(h, "GET", "/api/health");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
  });
});

describe("auth routes are wired in", () => {
  it("registers, identifies and logs out over HTTP", async () => {
    const h = await start();
    const cookie = await register(h, "alice");
    const me = await call(h, "GET", "/api/me", { cookie });
    expect(me.body.user).toMatchObject({ username: "alice" });

    await call(h, "POST", "/api/logout", { cookie });
    expect((await call(h, "GET", "/api/me", { cookie })).status).toBe(401);
  });

  it("logs in with the credentials it registered", async () => {
    const h = await start();
    await register(h, "alice");
    const login = await call(h, "POST", "/api/login", { body: { username: "alice", password: "correct horse" } });
    expect(login.status).toBe(200);
    expect(login.cookie).toBeTruthy();
  });
});

// Default-deny: a route is unreachable until a session opts it in.
describe("unauthenticated access", () => {
  it("401s every data route, including ones that do not exist", async () => {
    const h = await start();
    for (const [method, path] of [
      ["GET", "/api/config"],
      ["GET", `/api/day?date=${DATE}`],
      ["GET", "/api/days"],
      ["POST", "/api/actions"],
      ["GET", "/api/not-a-route"],
      ["POST", "/api/not-a-route"],
    ] as const) {
      const r = await call(h, method, path, { body: method === "POST" ? {} : undefined });
      expect({ path, status: r.status }).toEqual({ path, status: 401 });
      expect(typeof r.body.message).toBe("string");
    }
  });

  it("does not accept a forged or expired cookie", async () => {
    const h = await start();
    expect((await call(h, "GET", "/api/days", { cookie: "diet_session=deadbeef" })).status).toBe(401);

    const user = h.db.createUser("carol", hashPassword("correct horse"));
    h.db.createSession(user.id, "expired", Date.now() - 1);
    expect((await call(h, "GET", "/api/days", { cookie: "diet_session=expired" })).status).toBe(401);
  });

  it("404s an unknown route once logged in — the 401 was about the session, not the path", async () => {
    const h = await start();
    const cookie = await register(h, "alice");
    const r = await call(h, "GET", "/api/not-a-route", { cookie });
    expect(r.status).toBe(404);
    expect(typeof r.body.message).toBe("string");
  });
});

describe("GET /api/config", () => {
  it("returns the deployment defaults, and nothing about the model endpoint", async () => {
    const h = await start();
    const cookie = await register(h, "alice");
    const r = await call(h, "GET", "/api/config", { cookie });
    expect(r.body).toEqual({ defaults: { targetKcal: 2000, energyUnit: "kcal", measurementSystem: "metric" } });
    expect(JSON.stringify(r.body)).not.toContain("localhost");
  });
});

describe("GET /api/day", () => {
  it("returns an empty day for a date never logged", async () => {
    const h = await start();
    const cookie = await register(h, "alice");
    const r = await call(h, "GET", `/api/day?date=${DATE}`, { cookie });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ day: { date: DATE, entries: [] }, chat: [] });
  });

  it("returns the day's entries and its chat in one read", async () => {
    const h = await start();
    const cookie = await register(h, "alice");
    await postActions(h, cookie, [addLunch]);
    h.db.appendChatMessage(h.db.findUser("alice")!.id, DATE, { id: "m1", role: "user", text: "2 hot dogs", at: NOW });

    const r = await call(h, "GET", `/api/day?date=${DATE}`, { cookie });
    expect(r.body.day.entries).toHaveLength(1);
    expect(r.body.chat).toEqual([{ id: "m1", role: "user", text: "2 hot dogs", at: NOW }]);
  });

  it("400s a missing or malformed date rather than guessing one", async () => {
    const h = await start();
    const cookie = await register(h, "alice");
    for (const q of ["", "?date=", "?date=today", "?date=2026-02-30", "?date=2026-8-30"]) {
      const r = await call(h, "GET", `/api/day${q}`, { cookie });
      expect({ q, status: r.status }).toEqual({ q, status: 400 });
    }
  });
});

describe("GET /api/days", () => {
  it("lists the user's days, newest first, and honours limit/before", async () => {
    const h = await start();
    const cookie = await register(h, "alice");
    await postActions(h, cookie, [addLunch]);
    await postActions(h, cookie, [{ ...addLunch, entry: { ...addLunch.entry, at: "2026-08-29T12:00:00.000Z" } } as LogAction], {
      date: "2026-08-29",
      now: "2026-08-29T12:00:00.000Z",
    });

    expect((await call(h, "GET", "/api/days", { cookie })).body.days.map((d: any) => d.date)).toEqual([DATE, "2026-08-29"]);
    expect((await call(h, "GET", "/api/days?limit=1", { cookie })).body.days.map((d: any) => d.date)).toEqual([DATE]);
    expect((await call(h, "GET", `/api/days?before=${DATE}`, { cookie })).body.days.map((d: any) => d.date)).toEqual(["2026-08-29"]);
  });

  it("400s a nonsense limit or before instead of silently ignoring it", async () => {
    const h = await start();
    const cookie = await register(h, "alice");
    expect((await call(h, "GET", "/api/days?limit=all", { cookie })).status).toBe(400);
    expect((await call(h, "GET", "/api/days?before=lastweek", { cookie })).status).toBe(400);
  });
});

describe("POST /api/actions", () => {
  it("folds an action into the day and returns the new day", async () => {
    const h = await start();
    const cookie = await register(h, "alice");
    const r = await postActions(h, cookie, [addLunch]);
    expect(r.status).toBe(200);
    expect(r.body.day.entries).toHaveLength(1);
    expect(r.body.day.entries[0]).toMatchObject({ label: "Lunch", at: NOW });
    // The server assigns identity and provenance; the client never supplies them.
    expect(r.body.day.entries[0].id).toEqual(expect.any(String));
    expect(r.body.day.entries[0].createdAt).toBe(NOW);
  });

  it("persists, so the next read sees it", async () => {
    const h = await start();
    const cookie = await register(h, "alice");
    await postActions(h, cookie, [addLunch]);
    expect((await call(h, "GET", `/api/day?date=${DATE}`, { cookie })).body.day.entries).toHaveLength(1);
  });

  it("edits an existing entry by the id it just handed out", async () => {
    const h = await start();
    const cookie = await register(h, "alice");
    const id = (await postActions(h, cookie, [addLunch])).body.day.entries[0].id;
    const patched = await postActions(h, cookie, [{ type: "update_entry", id, patch: { at: "2026-08-30T11:10:00.000Z" } }]);
    expect(patched.body.day.entries[0]).toMatchObject({ id, at: "2026-08-30T11:10:00.000Z" });
  });

  it("stamps a manual edit's source, and takes one from the client when given", async () => {
    const h = await start();
    const cookie = await register(h, "alice");
    expect((await postActions(h, cookie, [addLunch])).body.day.entries[0].source).toEqual(expect.any(String));
    // Later in the day, so it sorts last deterministically — two entries at the
    // same instant are tie-broken by a random uuid.
    const dinner = { ...addLunch, entry: { ...addLunch.entry, at: "2026-08-30T18:00:00.000Z" } } as LogAction;
    const withSource = await postActions(h, cookie, [dinner], { source: "2 hot dogs" });
    expect(withSource.body.day.entries.at(-1).source).toBe("2 hot dogs");
  });

  it("rejects the whole batch when any action is invalid, changing nothing", async () => {
    const h = await start();
    const cookie = await register(h, "alice");
    const r = await postActions(h, cookie, [addLunch, { type: "delete_entry", id: "no-such-entry" }]);
    expect(r.status).toBe(400);
    expect(r.body.errors.length).toBeGreaterThan(0);
    expect((await call(h, "GET", `/api/day?date=${DATE}`, { cookie })).body.day.entries).toEqual([]);
  });

  it("400s a malformed envelope", async () => {
    const h = await start();
    const cookie = await register(h, "alice");
    for (const body of [
      {},
      { date: DATE, now: NOW },
      { date: "today", now: NOW, actions: [] },
      { date: DATE, now: "an hour ago", actions: [] },
      { date: DATE, now: NOW, actions: "add lunch" },
      { date: DATE, now: NOW, actions: [{ type: "nonsense" }] },
    ]) {
      const r = await call(h, "POST", "/api/actions", { cookie, body });
      expect({ body, status: r.status }).toMatchObject({ status: 400 });
      expect(typeof r.body.message).toBe("string");
    }
  });

  it("400s a body that is not JSON at all", async () => {
    const h = await start();
    const cookie = await register(h, "alice");
    const res = await fetch(`${h.base}/api/actions`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
    expect(typeof (await res.json() as any).message).toBe("string");
  });
});

// The rule that outranks the rest: one user's log is unreachable with another
// user's session, through the API as well as in the database.
describe("cross-tenant isolation through the API", () => {
  it("shows each session only its own day and history", async () => {
    const h = await start();
    const alice = await register(h, "alice");
    const bob = await register(h, "bob");
    await postActions(h, alice, [addLunch]);

    expect((await call(h, "GET", `/api/day?date=${DATE}`, { cookie: bob })).body.day.entries).toEqual([]);
    expect((await call(h, "GET", "/api/days", { cookie: bob })).body.days).toEqual([]);
    expect((await call(h, "GET", `/api/day?date=${DATE}`, { cookie: alice })).body.day.entries).toHaveLength(1);
  });

  it("refuses to resolve another user's entry id — and says 400, not 403", async () => {
    const h = await start();
    const alice = await register(h, "alice");
    const bob = await register(h, "bob");
    const id = (await postActions(h, alice, [addLunch])).body.day.entries[0].id;

    for (const action of [
      { type: "update_entry", id, patch: { label: "Bob was here" } },
      { type: "delete_entry", id },
      { type: "add_item", entryId: id, item: { name: "mayo", kcal: 90 } },
      { type: "remove_item", entryId: id, index: 0 },
    ] as LogAction[]) {
      const r = await postActions(h, bob, [action]);
      // 403 would confirm the row exists; the id simply is not in bob's day.
      expect({ type: action.type, status: r.status }).toEqual({ type: action.type, status: 400 });
    }
    const mine = (await call(h, "GET", `/api/day?date=${DATE}`, { cookie: alice })).body.day;
    expect(mine.entries[0]).toMatchObject({ id, label: "Lunch" });
    expect(mine.entries[0].items).toHaveLength(1);
  });

  it("ignores a user hint in the query string or the body", async () => {
    const h = await start();
    const alice = await register(h, "alice");
    const bob = await register(h, "bob");
    await postActions(h, alice, [addLunch]);
    const aliceId = h.db.findUser("alice")!.id;

    const spoofed = await call(h, "GET", `/api/day?date=${DATE}&user=${aliceId}&username=alice`, { cookie: bob });
    expect(spoofed.body.day.entries).toEqual([]);

    await postActions(h, bob, [addLunch], { userId: aliceId, user: "alice" });
    expect((await call(h, "GET", `/api/day?date=${DATE}`, { cookie: alice })).body.day.entries).toHaveLength(1);
  });

  it("keeps chat scoped to the session that wrote it", async () => {
    const h = await start();
    const alice = await register(h, "alice");
    const bob = await register(h, "bob");
    h.db.appendChatMessage(h.db.findUser("alice")!.id, DATE, { id: "m1", role: "user", text: "2 hot dogs", at: NOW });
    expect((await call(h, "GET", `/api/day?date=${DATE}`, { cookie: bob })).body.chat).toEqual([]);
    expect((await call(h, "GET", `/api/day?date=${DATE}`, { cookie: alice })).body.chat).toHaveLength(1);
  });
});

describe("websocket", () => {
  it("accepts a logged-in session", async () => {
    const h = await start();
    const cookie = await register(h, "alice");
    const socket = await connect(h, cookie);
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it("rejects the upgrade without a session, with a forged cookie, or after logout", async () => {
    const h = await start();
    await expect(connect(h)).rejects.toMatchObject({ status: 401 });
    await expect(connect(h, "diet_session=deadbeef")).rejects.toMatchObject({ status: 401 });

    const cookie = await register(h, "alice");
    await call(h, "POST", "/api/logout", { cookie });
    await expect(connect(h, cookie)).rejects.toMatchObject({ status: 401 });
  });

  it("pushes the new day to the user who changed it", async () => {
    const h = await start();
    const cookie = await register(h, "alice");
    const socket = await connect(h, cookie);
    const message = nextMessage(socket);
    await postActions(h, cookie, [addLunch]);
    expect(await message).toMatchObject({ type: "day", day: { date: DATE } });
    expect((await message).day.entries).toHaveLength(1);
  });

  it("reaches every device of that user", async () => {
    const h = await start();
    const cookie = await register(h, "alice");
    const phone = await connect(h, cookie);
    const laptop = await connect(h, cookie);
    const both = Promise.all([nextMessage(phone), nextMessage(laptop)]);
    await postActions(h, cookie, [addLunch]);
    expect((await both).map((m) => m.type)).toEqual(["day", "day"]);
  });

  it("never pushes one user's day to another user's socket", async () => {
    const h = await start();
    const alice = await register(h, "alice");
    const bob = await register(h, "bob");
    const bobSocket = await connect(h, bob);
    const leaked = nextMessage(bobSocket, 300);
    const seen: any[] = [];
    bobSocket.on("message", (d) => seen.push(JSON.parse(d.toString())));

    await postActions(h, alice, [addLunch]);
    await expect(leaked).rejects.toThrow("no message");
    expect(seen).toEqual([]);
  });
});

describe("static serving", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function buildDir(): string {
    const root = mkdtempSync(join(tmpdir(), "diet-static-"));
    dirs.push(root);
    mkdirSync(join(root, "web/assets"), { recursive: true });
    writeFileSync(join(root, "web/index.html"), "<!doctype html><title>diet</title>");
    writeFileSync(join(root, "web/assets/app.js"), "console.log('hi')");
    writeFileSync(join(root, "secret.txt"), "not part of the build");
    return root;
  }

  it("serves the built app shell without a session — the login page must load", async () => {
    const root = buildDir();
    const h = await start({ staticRoot: join(root, "web") });
    const res = await fetch(`${h.base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<title>diet</title>");
  });

  it("serves assets with their content type", async () => {
    const root = buildDir();
    const h = await start({ staticRoot: join(root, "web") });
    const res = await fetch(`${h.base}/assets/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
  });

  it("falls back to the shell for client-side routes", async () => {
    const root = buildDir();
    const h = await start({ staticRoot: join(root, "web") });
    const res = await fetch(`${h.base}/history`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>diet</title>");
  });

  it("cannot be walked out of, however the dots are encoded", async () => {
    const root = buildDir();
    const h = await start({ staticRoot: join(root, "web") });
    // Raw sockets, not fetch: a client library normalises `..` away before it
    // ever reaches the server, so fetch cannot express this attack.
    for (const target of [
      "/../secret.txt",
      "/%2e%2e/secret.txt",
      "/..%2fsecret.txt",
      "/assets/../../secret.txt",
      "/assets/%2e%2e%2f%2e%2e%2fsecret.txt",
    ]) {
      const raw = await rawGet(h, target);
      // The invariant, whichever layer catches it: the file outside the build
      // root is never served. Some forms are collapsed by URL parsing into a
      // path inside the root (which then falls back to the shell); the rest
      // reach the confinement check and are refused.
      expect({ target, leaked: raw.includes("not part of the build") }).toEqual({ target, leaked: false });
      expect(raw.startsWith("HTTP/1.1 404") || raw.includes("<title>diet</title>")).toBe(true);
    }
    // Encoded separators survive URL parsing, so these are the confinement
    // check's own work.
    expect(await rawGet(h, "/..%2fsecret.txt")).toContain("HTTP/1.1 404");
    expect(await rawGet(h, "/assets/%2e%2e%2f%2e%2e%2fsecret.txt")).toContain("HTTP/1.1 404");
  });

  it("503s rather than crashing when the build is missing or mid-swap", async () => {
    const h = await start({ staticRoot: join(tmpdir(), "diet-never-built") });
    const res = await fetch(`${h.base}/`);
    expect(res.status).toBe(503);
  });
});
