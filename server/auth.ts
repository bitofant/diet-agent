import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Db, UserRow } from "./db.js";
import { readJsonBody, sendJson } from "./http.js";

// All authentication lives here: password hashing, session cookies, the auth
// routes. The rest of the server only ever asks "who is this request?" via
// authedUser()/requireUser() and stays auth-agnostic.
//
// Sessions are opaque random tokens stored server-side in SQLite and handed out
// in an HttpOnly cookie — page JS never sees one, and revoking is a DELETE.

const COOKIE_NAME = "diet_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,64}$/;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 256;

export interface AuthOptions {
  /** Add `Secure` to the cookie. Set in prod; off for plain-http dev. */
  secure: boolean;
}

// --- password hashing ------------------------------------------------------

/** `salt:derivedKeyHex`, scrypt. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}

/** Constant-time compare against a stored `salt:hash`. */
export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  // Buffer.from ignores trailing garbage, so a non-hex hash yields a short
  // buffer rather than an error — the length check below catches it.
  if (expected.length !== 64) return false;
  return timingSafeEqual(scryptSync(password, salt, 64), expected);
}

// Burned when the username is unknown, so a login attempt costs the same
// whether or not the account exists. Enumeration by timing is still a leak.
const DUMMY_HASH = hashPassword(randomBytes(16).toString("hex"));

// --- cookies ---------------------------------------------------------------

function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function sessionCookie(token: string, maxAgeSec: number, opts: AuthOptions): string {
  // Lax, not Strict: following a link into the app should still arrive logged in.
  const attrs = [`${COOKIE_NAME}=${token}`, "HttpOnly", "SameSite=Lax", "Path=/", `Max-Age=${maxAgeSec}`];
  if (opts.secure) attrs.push("Secure");
  return attrs.join("; ");
}

// --- request identity ------------------------------------------------------

/**
 * The user this request belongs to, or null.
 *
 * The cookie is the *only* input: no `?user=`, no id in a path or body. Works
 * for the `/ws` upgrade request too, which is why it takes an IncomingMessage
 * rather than a response-bearing context.
 */
export function authedUser(db: Db, req: IncomingMessage): UserRow | null {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!token) return null;
  return db.sessionUser(token) ?? null;
}

/** Default-deny gate for a route: 401s and returns null when not logged in. */
export function requireUser(db: Db, req: IncomingMessage, res: ServerResponse): UserRow | null {
  const user = authedUser(db, req);
  if (!user) sendJson(res, 401, { message: "Not logged in." });
  return user;
}

// --- credentials -----------------------------------------------------------

interface Credentials {
  username: string;
  password: string;
}

function readCredentials(data: unknown): Credentials | null {
  if (typeof data !== "object" || data === null) return null;
  const { username, password } = data as Record<string, unknown>;
  if (typeof username !== "string" || typeof password !== "string") return null;
  const trimmed = username.trim();
  if (!USERNAME_RE.test(trimmed)) return null;
  if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) return null;
  return { username: trimmed, password };
}

function login(db: Db, res: ServerResponse, user: UserRow, opts: AuthOptions): void {
  const token = randomBytes(32).toString("hex");
  db.createSession(user.id, token, Date.now() + SESSION_TTL_MS);
  sendJson(res, 200, { user }, { "set-cookie": sessionCookie(token, SESSION_TTL_MS / 1000, opts) });
}

/**
 * Handle `/api/{me,register,login,logout}`. Returns true when the request was
 * an auth route and a reply has been sent; false to let the caller route it.
 */
export async function handleAuthRoute(
  db: Db,
  req: IncomingMessage,
  res: ServerResponse,
  opts: AuthOptions,
): Promise<boolean> {
  const path = (req.url ?? "").split("?")[0];

  if (req.method === "GET" && path === "/api/me") {
    const user = authedUser(db, req);
    if (user) sendJson(res, 200, { user });
    else sendJson(res, 401, { message: "Not logged in." });
    return true;
  }

  if (req.method === "POST" && path === "/api/register") {
    const creds = readCredentials(await readJsonBody(req).catch(() => null));
    if (!creds) {
      sendJson(res, 400, {
        message: `Pick a username of 3-64 letters, digits, dot, dash or underscore, and a password of at least ${MIN_PASSWORD} characters.`,
      });
      return true;
    }
    if (db.findUser(creds.username)) {
      sendJson(res, 409, { message: "That username is taken." });
      return true;
    }
    login(db, res, db.createUser(creds.username, hashPassword(creds.password)), opts);
    return true;
  }

  if (req.method === "POST" && path === "/api/login") {
    const creds = readCredentials(await readJsonBody(req).catch(() => null));
    if (!creds) {
      sendJson(res, 400, { message: "Username and password are required." });
      return true;
    }
    const found = db.findUser(creds.username);
    const ok = verifyPassword(creds.password, found?.passwordHash ?? DUMMY_HASH);
    // One message for both failures: a specific one would enumerate accounts.
    if (!found || !ok) {
      sendJson(res, 401, { message: "Invalid username or password." });
      return true;
    }
    const { passwordHash: _, ...user } = found;
    login(db, res, user, opts);
    return true;
  }

  if (req.method === "POST" && path === "/api/logout") {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (token) db.deleteSession(token);
    sendJson(res, 200, { ok: true }, { "set-cookie": sessionCookie("", 0, opts) });
    return true;
  }

  return false;
}
