import { createServer as createHttpServer, type Server, type ServerResponse } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { ViteDevServer } from "vite";
import { createApi, type ServerEvent } from "./api.js";
import { authedUser, handleAuthRoute } from "./auth.js";
import { isLocalEndpoint, loadConfig, type Config } from "./config.js";
import { getDb, type Db } from "./db.js";
import { sendError, sendJson } from "./http.js";

// UI, /api and /ws on a single port. In dev, Vite runs embedded as middleware
// (--dev flag, not an env var); in prod the prebuilt dist/web is served from
// disk. The server itself is never compiled — tsx runs this file directly.

export interface AppDeps {
  db: Db;
  config: Config;
  /** Embed Vite in middleware mode instead of serving a build. */
  dev?: boolean;
  staticRoot?: string;
  /** Force the Secure cookie attribute; otherwise it follows x-forwarded-proto. */
  secure?: boolean;
}

export interface App {
  server: Server;
  close(): Promise<void>;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

function readFileOrNull(path: string): Buffer | null {
  try {
    return statSync(path).isFile() ? readFileSync(path) : null;
  } catch {
    return null;
  }
}

export async function createApp(deps: AppDeps): Promise<App> {
  const { db, config, dev = false } = deps;
  const staticRoot = resolve(deps.staticRoot ?? resolve(process.cwd(), "dist/web"));

  // One socket set per user id: a broadcast can only be addressed to the user
  // whose data changed, never fanned out to everyone connected.
  const sockets = new Map<string, Set<WebSocket>>();
  const broadcast = (userId: string, event: ServerEvent): void => {
    const payload = JSON.stringify(event);
    for (const socket of sockets.get(userId) ?? []) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  };

  const handleApiRoute = createApi({ db, config, broadcast });
  let vite: ViteDevServer | undefined;

  const server = createHttpServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;

      // Liveness only — it must never say anything about who uses this server.
      if (req.method === "GET" && path === "/api/health") return sendJson(res, 200, { ok: true });

      // Secure whenever the request actually arrived over TLS (a proxy reports
      // it here); a plain-http local run must not get a cookie browsers drop.
      const secure = deps.secure ?? req.headers["x-forwarded-proto"] === "https";
      if (await handleAuthRoute(db, req, res, { secure })) return;

      if (path.startsWith("/api/")) return await handleApiRoute(req, res);

      if (vite) return vite.middlewares(req, res);
      serveStatic(staticRoot, req.method ?? "GET", path, res);
    } catch {
      // Never surface the error itself: it can quote the request body, which is
      // a food log.
      if (!res.headersSent) sendError(res, 500, "Something went wrong.");
      else res.end();
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path !== "/ws") {
      // In dev, Vite's HMR listener owns every other upgrade on this server.
      if (!dev) socket.destroy();
      return;
    }
    const user = authedUser(db, req);
    if (!user) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const forUser = sockets.get(user.id) ?? new Set<WebSocket>();
      forUser.add(ws);
      sockets.set(user.id, forUser);
      ws.on("close", () => {
        forUser.delete(ws);
        if (forUser.size === 0) sockets.delete(user.id);
      });
    });
  });

  if (dev) {
    const { createServer: createViteServer } = await import("vite");
    vite = await createViteServer({ server: { middlewareMode: true, hmr: { server } }, appType: "spa" });
  }

  return {
    server,
    async close() {
      for (const client of wss.clients) client.terminate();
      wss.close();
      await vite?.close();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

/**
 * Serve the built frontend. The app shell is public — the login page has to
 * load before there is a session — while every byte of user data sits behind
 * /api and /ws.
 */
function serveStatic(root: string, method: string, path: string, res: ServerResponse): void {
  if (method !== "GET" && method !== "HEAD") return sendError(res, 404, "Not found.");

  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return sendError(res, 400, "Bad request.");
  }

  const filePath = resolve(root, `.${decoded}`);
  // Confinement is checked after resolving, so encoded dots cannot walk out.
  if (filePath !== root && !filePath.startsWith(root + sep)) return sendError(res, 404, "Not found.");

  const shell = join(root, "index.html");
  // Unknown paths are client-side routes, so they fall back to the shell.
  const target = readFileOrNull(filePath) === null ? shell : filePath;
  const body = readFileOrNull(target);
  if (body === null) {
    // Missing build, or the moment rebuild.sh swaps dist/web. Not an error the
    // user can act on beyond retrying.
    return sendError(res, 503, "Frontend is not available. Run `npm run build`.");
  }
  res.statusCode = 200;
  res.setHeader("content-type", CONTENT_TYPES[extname(target)] ?? "application/octet-stream");
  res.end(method === "HEAD" ? undefined : body);
}

async function start(): Promise<void> {
  const dev = process.argv.includes("--dev");
  const config = loadConfig();
  const db = getDb();
  const app = await createApp({ db, config, dev });

  if (!isLocalEndpoint(config.llm.baseUrl)) {
    console.warn(
      `LLM endpoint ${config.llm.baseUrl} is not local: food logs are health data and will be sent to a third party.`,
    );
  }

  app.server.listen(config.server.port, () => {
    console.log(`diet-agent listening on http://localhost:${config.server.port}${dev ? " (dev)" : ""}`);
  });

  const shutdown = async () => {
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Only when run directly (`tsx server/index.ts`), never when imported by a test.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void start();
