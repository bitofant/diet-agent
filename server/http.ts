import type { IncomingMessage, ServerResponse } from "node:http";

// Every response the server writes goes through here, so a client can rely on
// one shape: success is the payload object, failure is always `{ message }`
// (plus `errors` when a batch was rejected item by item).

const MAX_BODY_BYTES = 256 * 1024;

export function sendJson(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  for (const [k, v] of Object.entries(headers ?? {})) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

/** A failure the client can show. Never include ids or text it didn't send. */
export function sendError(res: ServerResponse, status: number, message: string, extra?: Record<string, unknown>): void {
  sendJson(res, status, { message, ...extra });
}

/** Parsed JSON body, or a rejection for malformed/oversized input. */
export function readJsonBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > maxBytes) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}
