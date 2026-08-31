import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { openDb, type Db } from "./db.js";
import { authedUser, handleAuthRoute, hashPassword, requireUser, verifyPassword, type AuthOptions } from "./auth.js";

let db: Db;

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => db.close());

interface Reply {
  handled: boolean;
  status: number;
  body: any;
  cookie: string | undefined;
}

function mkReq(method: string, url: string, opts: { body?: unknown; cookie?: string } = {}): IncomingMessage {
  const req = Readable.from(opts.body === undefined ? [] : [JSON.stringify(opts.body)]) as any;
  req.method = method;
  req.url = url;
  req.headers = opts.cookie ? { cookie: opts.cookie } : {};
  return req as IncomingMessage;
}

function mkRes() {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    setHeader: (k: string, v: string) => void (headers[k.toLowerCase()] = v),
    end: (chunk?: string) => void (res.body = chunk ?? ""),
    body: "",
  };
  return { res: res as unknown as ServerResponse, headers, raw: res };
}

async function call(method: string, url: string, opts: { body?: unknown; cookie?: string } & AuthOptions = {}): Promise<Reply> {
  const { res, headers, raw } = mkRes();
  const handled = await handleAuthRoute(db, mkReq(method, url, opts), res, { secure: opts.secure ?? false });
  return {
    handled,
    status: raw.statusCode,
    body: raw.body ? JSON.parse(raw.body) : undefined,
    cookie: headers["set-cookie"],
  };
}

function tokenOf(cookie: string | undefined): string {
  return cookie?.split(";")[0] ?? "";
}

async function register(username: string, password = "correct horse"): Promise<Reply> {
  return call("POST", "/api/register", { body: { username, password } });
}

describe("password hashing", () => {
  it("round-trips a password and rejects a wrong one", () => {
    const stored = hashPassword("correct horse");
    expect(verifyPassword("correct horse", stored)).toBe(true);
    expect(verifyPassword("Correct horse", stored)).toBe(false);
    expect(verifyPassword("", stored)).toBe(false);
  });

  it("salts, so the same password hashes differently every time", () => {
    expect(hashPassword("hunter22")).not.toBe(hashPassword("hunter22"));
  });

  it("never stores the password itself", () => {
    expect(hashPassword("hunter22")).not.toContain("hunter22");
    expect(hashPassword("hunter22").split(":")).toHaveLength(2);
  });

  it("returns false for a malformed stored value instead of throwing", () => {
    for (const bad of ["", ":", "nosalt", "salt:", ":hash", "salt:nothex"]) {
      expect(verifyPassword("correct horse", bad)).toBe(false);
    }
  });
});

describe("register", () => {
  it("creates the account and logs it in", async () => {
    const r = await register("alice");
    expect(r.status).toBe(200);
    expect(r.body.user).toMatchObject({ username: "alice" });
    expect(r.body.user).not.toHaveProperty("passwordHash");
    expect(db.sessionUser(tokenOf(r.cookie)?.split("=")[1])).toMatchObject({ username: "alice" });
  });

  it("sets an HttpOnly, SameSite=Lax, path-wide cookie — Secure only in prod", async () => {
    const dev = await register("alice");
    expect(dev.cookie).toContain("HttpOnly");
    expect(dev.cookie).toContain("SameSite=Lax");
    expect(dev.cookie).toContain("Path=/");
    expect(dev.cookie).not.toContain("Secure");

    const prod = await call("POST", "/api/register", { body: { username: "bob", password: "correct horse" }, secure: true });
    expect(prod.cookie).toContain("Secure");
  });

  it("rejects a taken username, case-insensitively, without creating a session", async () => {
    await register("alice");
    const dup = await register("ALICE");
    expect(dup.status).toBe(409);
    expect(dup.cookie).toBeUndefined();
  });

  it("rejects unusable credentials", async () => {
    for (const body of [
      { username: "", password: "correct horse" },
      { username: "al", password: "correct horse" },
      { username: "not a username", password: "correct horse" },
      { username: "alice", password: "short" },
      { username: "alice" },
      { username: 1, password: "correct horse" },
      {},
    ]) {
      const r = await call("POST", "/api/register", { body });
      expect(r.status).toBe(400);
    }
    expect(db.findUser("alice")).toBeUndefined();
  });
});

describe("login", () => {
  beforeEach(async () => {
    await register("alice");
  });

  it("issues a session for the right password", async () => {
    const r = await call("POST", "/api/login", { body: { username: "alice", password: "correct horse" } });
    expect(r.status).toBe(200);
    expect(r.body.user).toMatchObject({ username: "alice" });
    expect(r.cookie).toContain("HttpOnly");
  });

  it("gives the same generic 401 for a wrong password and an unknown user", async () => {
    const wrong = await call("POST", "/api/login", { body: { username: "alice", password: "wrong horse" } });
    const unknown = await call("POST", "/api/login", { body: { username: "mallory", password: "wrong horse" } });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    // Identical wording: a different message would enumerate accounts.
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.cookie).toBeUndefined();
  });
});

describe("session identity", () => {
  it("identifies the request by its cookie alone", async () => {
    const a = await register("alice");
    const b = await register("bob");
    expect(authedUser(db, mkReq("GET", "/api/day", { cookie: tokenOf(a.cookie) }))).toMatchObject({ username: "alice" });
    expect(authedUser(db, mkReq("GET", "/api/day", { cookie: tokenOf(b.cookie) }))).toMatchObject({ username: "bob" });
  });

  it("ignores any user hint the client supplies", async () => {
    const a = await register("alice");
    await register("bob");
    const bobId = db.findUser("bob")!.id;
    const req = mkReq("GET", `/api/day?user=${bobId}&username=bob`, { cookie: tokenOf(a.cookie) });
    expect(authedUser(db, req)).toMatchObject({ username: "alice" });
  });

  it("is null without a cookie, with a junk token, or after the session expires", async () => {
    expect(authedUser(db, mkReq("GET", "/api/day"))).toBeNull();
    expect(authedUser(db, mkReq("GET", "/api/day", { cookie: "diet_session=deadbeef" }))).toBeNull();
    expect(authedUser(db, mkReq("GET", "/api/day", { cookie: "unrelated=x" }))).toBeNull();

    const user = db.createUser("carol", hashPassword("correct horse"));
    db.createSession(user.id, "expired-token", Date.now() - 1);
    expect(authedUser(db, mkReq("GET", "/api/day", { cookie: "diet_session=expired-token" }))).toBeNull();
  });

  it("stops identifying a deleted account", async () => {
    const a = await register("alice");
    db.deleteUser(db.findUser("alice")!.id);
    expect(authedUser(db, mkReq("GET", "/api/day", { cookie: tokenOf(a.cookie) }))).toBeNull();
  });
});

describe("/api/me and logout", () => {
  it("401s when logged out, 200s when logged in", async () => {
    expect((await call("GET", "/api/me")).status).toBe(401);
    const a = await register("alice");
    const me = await call("GET", "/api/me", { cookie: tokenOf(a.cookie) });
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ username: "alice" });
  });

  it("logout invalidates the session and clears the cookie", async () => {
    const a = await register("alice");
    const cookie = tokenOf(a.cookie);
    const out = await call("POST", "/api/logout", { cookie });
    expect(out.status).toBe(200);
    expect(out.cookie).toContain("Max-Age=0");
    expect(authedUser(db, mkReq("GET", "/api/me", { cookie }))).toBeNull();
  });

  it("logs out only the device that asked", async () => {
    const phone = await register("alice");
    const laptop = await call("POST", "/api/login", { body: { username: "alice", password: "correct horse" } });
    await call("POST", "/api/logout", { cookie: tokenOf(phone.cookie) });
    expect(authedUser(db, mkReq("GET", "/api/me", { cookie: tokenOf(laptop.cookie) }))).toMatchObject({ username: "alice" });
  });
});

describe("route gating", () => {
  it("leaves non-auth routes for the caller to handle", async () => {
    expect((await call("GET", "/api/day")).handled).toBe(false);
    expect((await call("GET", "/")).handled).toBe(false);
    // Method matters: only POST logs in.
    expect((await call("GET", "/api/login")).handled).toBe(false);
  });

  it("matches the path, not the query string", async () => {
    const a = await register("alice");
    expect((await call("GET", "/api/me?cachebust=1", { cookie: tokenOf(a.cookie) })).status).toBe(200);
  });

  it("requireUser is default-deny: it 401s and hands back null", async () => {
    const { res, raw } = mkRes();
    expect(requireUser(db, mkReq("GET", "/api/day"), res)).toBeNull();
    expect(raw.statusCode).toBe(401);

    const a = await register("alice");
    const ok = mkRes();
    expect(requireUser(db, mkReq("GET", "/api/day", { cookie: tokenOf(a.cookie) }), ok.res)).toMatchObject({ username: "alice" });
    expect(ok.raw.statusCode).toBe(200);
  });
});
