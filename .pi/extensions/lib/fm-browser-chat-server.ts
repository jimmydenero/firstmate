// Loopback HTTP transport for the Firstmate browser chat.
//
// This module owns the transport and its security boundary; it knows nothing
// about Pi. The extension in ../fm-browser-chat.ts supplies a bridge that
// produces conversation snapshots and accepts sends.
//
// Security boundary (stated once here):
// - Binds 127.0.0.1 only. Every request must carry a Host of 127.0.0.1:<port>
//   or localhost:<port>, which defeats DNS rebinding.
// - A request carrying Origin must be exactly this server's own origin, and a
//   browser Sec-Fetch-Site other than same-origin or none is refused. No CORS
//   header is ever sent, so no other origin can read a response.
// - Every /api/ route requires "Authorization: Bearer <token>". A header
//   (never a cookie) means another site cannot ride an ambient credential.
// - Only a fixed allowlist of page assets is served; there is no path lookup.
// - The page is served with a Content-Security-Policy that allows only
//   same-origin scripts, styles, connections and data: images, and a
//   Permissions-Policy that grants the microphone to this origin only.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type BrowserChatSendOutcome =
  | { status: "accepted"; requestId: string; delivery: "prompt" | "steer" }
  | { status: "replay"; requestId: string }
  | { status: "conflict"; requestId: string; message: string }
  | { status: "unavailable"; requestId: string; message: string };

export type BrowserChatBridge = {
  // The full state a newly connected page renders from, sent as its first event.
  snapshot(): Record<string, unknown>;
  send(requestId: string, text: string): BrowserChatSendOutcome;
};

export type BrowserChatServerOptions = {
  port: number;
  token: string;
  assetsDir: string;
  bridge: BrowserChatBridge;
  heartbeatMs?: number;
  maxClients?: number;
  maxBodyBytes?: number;
};

export type BrowserChatServer = {
  port: number;
  publish(event: Record<string, unknown>): void;
  clientCount(): number;
  close(): Promise<void>;
};

const ASSETS: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/markdown.js": { file: "markdown.js", type: "text/javascript; charset=utf-8" },
  "/client.js": { file: "client.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
};

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const REQUEST_ID = /^[A-Za-z0-9_-]{8,80}$/;

function baseHeaders(): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cross-Origin-Opener-Policy": "same-origin",
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...baseHeaders(),
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function tokenMatches(expected: string, header: string | undefined): boolean {
  if (!header || !header.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice("Bearer ".length));
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

// Returns a refusal reason, or "" when the request may proceed.
export function originRefusal(req: IncomingMessage, port: number): string {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const host = req.headers.host ?? "";
  if (!allowedHosts.has(host)) return "host not allowed";
  const origin = req.headers.origin;
  if (origin !== undefined) {
    const allowedOrigins = new Set([...allowedHosts].map((value) => `http://${value}`));
    if (!allowedOrigins.has(origin)) return "origin not allowed";
  }
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") return "cross-site request refused";
  return "";
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function startBrowserChatServer(options: BrowserChatServerOptions): Promise<BrowserChatServer> {
  const heartbeatMs = options.heartbeatMs ?? 15000;
  const maxClients = options.maxClients ?? 8;
  const maxBodyBytes = options.maxBodyBytes ?? 256 * 1024;
  const clients = new Set<ServerResponse>();
  let seq = 0;
  let boundPort = options.port;

  function frame(event: Record<string, unknown>): string {
    seq += 1;
    return `id: ${seq}\ndata: ${JSON.stringify({ ...event, seq, t: Date.now() })}\n\n`;
  }

  function serveAsset(res: ServerResponse, path: string): void {
    const asset = ASSETS[path];
    let body: Buffer;
    try {
      body = readFileSync(join(options.assetsDir, asset.file));
    } catch {
      sendJson(res, 500, { error: "asset unavailable" });
      return;
    }
    res.writeHead(200, {
      ...baseHeaders(),
      "Content-Type": asset.type,
      "Content-Length": body.length,
      "Content-Security-Policy": CSP,
      "Permissions-Policy": "microphone=(self), camera=(), geolocation=()",
    });
    res.end(body);
  }

  function openStream(req: IncomingMessage, res: ServerResponse): void {
    if (clients.size >= maxClients) {
      sendJson(res, 503, { error: "too many open pages" });
      return;
    }
    res.writeHead(200, {
      ...baseHeaders(),
      "Content-Type": "text/event-stream; charset=utf-8",
      Connection: "keep-alive",
    });
    res.flushHeaders();
    // Snapshot and registration happen in the same tick, so no live event can
    // fall between what the snapshot shows and what the stream delivers.
    res.write(frame({ type: "snapshot", ...options.bridge.snapshot() }));
    clients.add(res);
    const drop = () => clients.delete(res);
    req.on("close", drop);
    res.on("close", drop);
  }

  async function handleSend(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
      sendJson(res, 415, { error: "expected application/json" });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBody(req, maxBodyBytes));
    } catch {
      sendJson(res, 400, { error: "invalid or oversized JSON body" });
      return;
    }
    const body = parsed as { requestId?: unknown; text?: unknown };
    if (typeof body.requestId !== "string" || !REQUEST_ID.test(body.requestId)) {
      sendJson(res, 400, { error: "requestId must be 8-80 characters of letters, digits, - or _" });
      return;
    }
    if (typeof body.text !== "string" || !body.text.trim()) {
      sendJson(res, 400, { error: "text must be a non-empty string" });
      return;
    }
    let outcome: BrowserChatSendOutcome;
    try {
      outcome = options.bridge.send(body.requestId, body.text);
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const status = outcome.status === "conflict" ? 409 : outcome.status === "unavailable" ? 503 : 200;
    sendJson(res, status, outcome);
  }

  const server: Server = createServer((req, res) => {
    const refusal = originRefusal(req, boundPort);
    if (refusal) {
      sendJson(res, 403, { error: refusal });
      return;
    }
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && Object.hasOwn(ASSETS, path)) {
      serveAsset(res, path);
      return;
    }
    if (!path.startsWith("/api/")) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    if (!tokenMatches(options.token, req.headers.authorization)) {
      sendJson(res, 401, { error: "missing or wrong access token" });
      return;
    }
    if (req.method === "GET" && path === "/api/events") {
      openStream(req, res);
      return;
    }
    if (req.method === "GET" && path === "/api/ping") {
      sendJson(res, 200, { t: Date.now() });
      return;
    }
    if (req.method === "POST" && path === "/api/send") {
      void handleSend(req, res);
      return;
    }
    sendJson(res, 404, { error: "not found" });
  });

  const heartbeat = setInterval(() => {
    for (const client of clients) client.write(`: keepalive ${Date.now()}\n\n`);
  }, heartbeatMs);
  heartbeat.unref();

  return new Promise((resolveServer, reject) => {
    server.once("error", (error) => {
      clearInterval(heartbeat);
      reject(error);
    });
    server.listen(options.port, "127.0.0.1", () => {
      const address = server.address();
      boundPort = typeof address === "object" && address ? address.port : options.port;
      resolveServer({
        port: boundPort,
        publish(event) {
          if (!clients.size) return;
          const data = frame(event);
          for (const client of clients) client.write(data);
        },
        clientCount: () => clients.size,
        close() {
          clearInterval(heartbeat);
          for (const client of clients) client.end();
          clients.clear();
          return new Promise((resolveClose) => {
            server.close(() => resolveClose());
            server.closeAllConnections();
          });
        },
      });
    });
  });
}
