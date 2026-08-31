import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { requireUser } from "./auth.js";
import { readJsonBody, sendError, sendJson } from "./http.js";
import { validateActions } from "../shared/actions.js";
import { isDayKey, isSaneInstant } from "../shared/dates.js";
import { applyActions } from "../shared/reduce.js";
import type { DayLog } from "../shared/types.js";

// The user-data routes. Everything here is behind requireUser() — the gate is
// the first statement of the handler, so a route added below is unreachable
// until a session proves who is asking. The user id comes from that session and
// from nowhere else: no `?user=`, no id in a path or body.

/**
 * Server → client push. Lives here until `web/` lands, then moves to
 * `shared/protocol.ts` so both sides fold the same events.
 */
export type ServerEvent = { type: "day"; day: DayLog };

export type Broadcast = (userId: string, event: ServerEvent) => void;

export interface ApiDeps {
  db: Db;
  config: Config;
  broadcast: Broadcast;
}

const MAX_DAYS = 365;
const MAX_SOURCE = 2_000;
// What a manual card edit records as provenance, where a chat turn records the
// user's own words.
const MANUAL_SOURCE = "manual edit";

function readActionsBody(raw: unknown): { date: string; now: string; source: string; actions: unknown } | string {
  if (typeof raw !== "object" || raw === null) return "Expected a JSON object.";
  const { date, now, source, actions } = raw as Record<string, unknown>;
  if (!isDayKey(date)) return "date must be a YYYY-MM-DD day key.";
  // The client's clock, not the server's: the day a turn belongs to is the
  // user's local day, which only the client knows.
  if (!isSaneInstant(now)) return "now must be an ISO instant.";
  if (source !== undefined && (typeof source !== "string" || source.length > MAX_SOURCE)) {
    return "source must be a short string.";
  }
  return { date, now, source: (source as string) ?? MANUAL_SOURCE, actions };
}

export function createApi({ db, config, broadcast }: ApiDeps) {
  /** Handles `/api/*` other than health and auth. Always sends a response. */
  return async function handleApiRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    const user = requireUser(db, req, res);
    if (!user) return;

    if (req.method === "GET" && path === "/api/config") {
      // Deployment defaults only — never the model endpoint or its key.
      return sendJson(res, 200, { defaults: config.defaults });
    }

    if (req.method === "GET" && path === "/api/day") {
      const date = url.searchParams.get("date");
      if (!isDayKey(date)) return sendError(res, 400, "date must be a YYYY-MM-DD day key.");
      // Chat and log are one timeline in the UI, so they are one read here.
      return sendJson(res, 200, { day: db.getDay(user.id, date), chat: db.listChatMessages(user.id, date) });
    }

    if (req.method === "GET" && path === "/api/days") {
      const rawLimit = url.searchParams.get("limit");
      const before = url.searchParams.get("before");
      const limit = rawLimit === null ? undefined : Number(rawLimit);
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > MAX_DAYS)) {
        return sendError(res, 400, `limit must be an integer between 1 and ${MAX_DAYS}.`);
      }
      if (before !== null && !isDayKey(before)) return sendError(res, 400, "before must be a YYYY-MM-DD day key.");
      return sendJson(res, 200, { days: db.listDays(user.id, { limit, before: before ?? undefined }) });
    }

    if (req.method === "POST" && path === "/api/actions") {
      const raw = await readJsonBody(req).catch(() => null);
      if (raw === null) return sendError(res, 400, "Invalid JSON.");
      const parsed = readActionsBody(raw);
      if (typeof parsed === "string") return sendError(res, 400, parsed);

      // Validation resolves every id against this user's own day — that
      // resolution is the tenant check, and it is all-or-nothing.
      const day = db.getDay(user.id, parsed.date);
      const result = validateActions(day, parsed.actions);
      if (!result.ok) return sendError(res, 400, "Those changes were rejected.", { errors: result.errors });

      const next = applyActions(day, result.actions, { now: parsed.now, newId: randomUUID, source: parsed.source });
      db.writeDay(user.id, next);
      broadcast(user.id, { type: "day", day: next });
      return sendJson(res, 200, { day: next });
    }

    // Authenticated but unknown: the 401 above was about the session, this is
    // about the path.
    return sendError(res, 404, "Not found.");
  };
}
