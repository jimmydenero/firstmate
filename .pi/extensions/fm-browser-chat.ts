// Firstmate browser chat: the primary Pi session's own conversation, in a
// local browser page.
//
// Ownership (stated once here; docs/browser-chat.md is the operator guide):
// - Opt-in. Nothing listens unless <config>/browser-chat exists, and only the
//   Pi process holding this home's session lock serves it. A lock-refused or
//   secondary session in the same home never opens a socket.
// - Same conversation. Browser input enters this session through Pi's own
//   sendUserMessage, exactly as if typed at the terminal (steered in when a
//   turn is running), and the page is fed from this session's message events
//   and its SessionManager branch. Nothing is scraped from the terminal and no
//   second assistant is started.
// - Reconnect. Every page connection starts from a fresh snapshot built from
//   the session branch, plus messages finalized but not yet persisted, plus the
//   reply currently streaming, so a reconnect never loses a completed reply.
//   Messages are keyed by role and timestamp so a page never shows one twice.
// - Duplicate delivery. A send carries a page-generated request id recorded in
//   <state>/extensions/browser-chat/requests.json before the message is handed
//   to Pi; a repeated id is answered as a replay and never delivered again, even
//   across reloads and restarts.
// - The transport and its security boundary live in lib/fm-browser-chat-server.ts.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  startBrowserChatServer,
  type BrowserChatSendOutcome,
  type BrowserChatServer,
} from "./lib/fm-browser-chat-server.ts";
import { isFirstmateOperationalPresentationText } from "./lib/fm-operational-input.ts";
import { sessionLockOwnership } from "./lib/fm-session-lock.ts";

const extensionFile = fileURLToPath(import.meta.url);
const extensionDir = dirname(extensionFile);
const root = resolve(extensionDir, "../..");
const fmHome = process.env.FM_HOME || process.env.FM_ROOT_OVERRIDE || root;
const state = process.env.FM_STATE_OVERRIDE || `${fmHome}/state`;
const config = process.env.FM_CONFIG_OVERRIDE || `${fmHome}/config`;
const flagFile = `${config}/browser-chat`;
const workDir = `${state}/extensions/browser-chat`;
const tokenFile = `${workDir}/token`;
const endpointFile = `${workDir}/endpoint.json`;
const ledgerFile = `${workDir}/requests.json`;
// The last bound port, kept after stop so a restart reuses it and a bookmark
// keeps working; endpoint.json exists only while serving.
const portFile = `${workDir}/port`;
const assetsDir = `${extensionDir}/lib/browser-chat`;

const SNAPSHOT_ITEMS = 250;
const RECENT_ITEMS = 60;
const LEDGER_ENTRIES = 500;
const TOOL_TEXT_CHARS = 1500;
const PARTIAL_FLUSH_MS = 30;

export type ChatItem = {
  key: string;
  role: "user" | "assistant" | "tool" | "custom" | "notice";
  text: string;
  timestamp: number;
  operational?: boolean;
  tools?: string[];
  toolName?: string;
  isError?: boolean;
  stopReason?: string;
  error?: string;
  requestId?: string;
};

type LedgerEntry = {
  requestId: string;
  sha256: string;
  acceptedAt: number;
  messageTimestamp?: number;
};

type ContentBlock = { type?: unknown; text?: unknown; name?: unknown };
type LooseMessage = {
  role?: unknown;
  content?: unknown;
  timestamp?: unknown;
  toolName?: unknown;
  isError?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
  customType?: unknown;
  display?: unknown;
};

function blocks(content: unknown): ContentBlock[] {
  return Array.isArray(content) ? (content as ContentBlock[]) : [];
}

export function messageText(content: unknown, separator = "\n"): string {
  if (typeof content === "string") return content;
  return blocks(content)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join(separator);
}

function toolNames(content: unknown): string[] {
  return blocks(content)
    .filter((block) => block.type === "toolCall" && typeof block.name === "string")
    .map((block) => block.name as string);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function writePrivate(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, path);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

// config/browser-chat is a presence flag; an optional "port=<n>" line pins the port.
function configuredPort(): number | undefined {
  let text = "";
  try {
    text = readFileSync(flagFile, "utf8");
  } catch {
    return undefined;
  }
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    const match = /^port=(\d{1,5})$/.exec(line);
    if (match) {
      const port = Number(match[1]);
      if (port >= 1024 && port <= 65535) return port;
    }
  }
  return undefined;
}

function accessToken(): string {
  try {
    const existing = readFileSync(tokenFile, "utf8").trim();
    if (/^[A-Za-z0-9_-]{32,}$/.test(existing)) return existing;
  } catch {
    // Created below.
  }
  const token = randomBytes(32).toString("base64url");
  writePrivate(tokenFile, `${token}\n`);
  return token;
}

function previousPort(): number | undefined {
  try {
    const port = Number(readFileSync(portFile, "utf8").trim());
    return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : undefined;
  } catch {
    return undefined;
  }
}

export default function firstmateBrowserChat(pi: ExtensionAPI): void {
  let ctx: ExtensionContext | null = null;
  let server: BrowserChatServer | null = null;
  let starting: Promise<void> | null = null;
  let stopped = false;
  let busy = false;
  let partial: { key: string; text: string; tools: string[]; timestamp: number } | null = null;
  let partialTimer: ReturnType<typeof setTimeout> | null = null;
  const recent: ChatItem[] = [];
  const pendingSends: { requestId: string; text: string }[] = [];
  const operationalCache = new Map<string, boolean>();
  let ledger: Map<string, LedgerEntry> | null = null;
  let fallbackKey = 0;

  function loadLedger(): Map<string, LedgerEntry> {
    if (ledger) return ledger;
    ledger = new Map();
    const stored = readJson(ledgerFile) as { entries?: unknown } | undefined;
    if (Array.isArray(stored?.entries)) {
      for (const entry of stored.entries as LedgerEntry[]) {
        if (entry && typeof entry.requestId === "string" && typeof entry.sha256 === "string") {
          ledger.set(entry.requestId, entry);
        }
      }
    }
    return ledger;
  }

  function saveLedger(): void {
    const entries = [...loadLedger().values()].slice(-LEDGER_ENTRIES);
    ledger = new Map(entries.map((entry) => [entry.requestId, entry]));
    writePrivate(ledgerFile, `${JSON.stringify({ version: 1, entries })}\n`);
  }

  function requestIdForTimestamp(timestamp: number): string | undefined {
    for (const entry of loadLedger().values()) {
      if (entry.messageTimestamp === timestamp) return entry.requestId;
    }
    return undefined;
  }

  function isOperational(key: string, text: string): boolean {
    const cached = operationalCache.get(key);
    if (cached !== undefined) return cached;
    const answer = isFirstmateOperationalPresentationText(text);
    operationalCache.set(key, answer);
    return answer;
  }

  function project(message: LooseMessage): ChatItem | null {
    const timestamp = typeof message.timestamp === "number" ? message.timestamp : Date.now();
    const role = message.role;
    const key = typeof message.timestamp === "number" ? `${String(role)}:${timestamp}` : `${String(role)}:x${fallbackKey++}`;
    if (role === "user") {
      const text = messageText(message.content);
      const item: ChatItem = { key, role: "user", text, timestamp };
      if (isOperational(key, text)) item.operational = true;
      const requestId = requestIdForTimestamp(timestamp);
      if (requestId) item.requestId = requestId;
      return item;
    }
    if (role === "assistant") {
      const item: ChatItem = { key, role: "assistant", text: messageText(message.content, "\n\n"), timestamp };
      const tools = toolNames(message.content);
      if (tools.length) item.tools = tools;
      if (typeof message.stopReason === "string") item.stopReason = message.stopReason;
      if (typeof message.errorMessage === "string") item.error = message.errorMessage;
      return item;
    }
    if (role === "toolResult") {
      const text = messageText(message.content);
      return {
        key,
        role: "tool",
        text: text.length > TOOL_TEXT_CHARS ? `${text.slice(0, TOOL_TEXT_CHARS)}\n[... ${text.length - TOOL_TEXT_CHARS} more characters in the terminal]` : text,
        timestamp,
        toolName: typeof message.toolName === "string" ? message.toolName : "tool",
        isError: message.isError === true,
      };
    }
    if (role === "custom" && message.display === true) {
      return { key, role: "custom", text: messageText(message.content), timestamp };
    }
    return null;
  }

  function snapshot(): Record<string, unknown> {
    const items: ChatItem[] = [];
    const current = ctx;
    if (current) {
      try {
        for (const entry of current.sessionManager.getBranch()) {
          const loose = entry as { type?: unknown; message?: unknown; customType?: unknown; content?: unknown; display?: unknown; timestamp?: unknown };
          if (loose.type === "message") {
            const item = project(loose.message as LooseMessage);
            if (item) items.push(item);
          } else if (loose.type === "custom_message" && loose.display === true) {
            const at = typeof loose.timestamp === "string" ? Date.parse(loose.timestamp) : Date.now();
            items.push({ key: `custom:${at}`, role: "custom", text: messageText(loose.content), timestamp: at });
          } else if (loose.type === "compaction") {
            const at = typeof loose.timestamp === "string" ? Date.parse(loose.timestamp) : Date.now();
            items.push({ key: `notice:${at}`, role: "notice", text: "Earlier conversation was compacted.", timestamp: at });
          }
        }
      } catch {
        // A replaced session context answers from the recent buffer below.
      }
    }
    const keys = new Set(items.map((item) => item.key));
    for (const item of recent) if (!keys.has(item.key)) items.push(item);
    return {
      session: current ? { id: safe(() => current.sessionManager.getSessionId()), name: safe(() => pi.getSessionName()) } : null,
      busy,
      queued: current ? safe(() => current.hasPendingMessages()) ?? false : false,
      partial,
      items: items.slice(-SNAPSHOT_ITEMS),
      itemLimit: SNAPSHOT_ITEMS,
    };
  }

  function safe<T>(read: () => T): T | undefined {
    try {
      return read();
    } catch {
      return undefined;
    }
  }

  function publish(event: Record<string, unknown>): void {
    server?.publish(event);
  }

  function publishStatus(): void {
    publish({ type: "status", busy, queued: ctx ? safe(() => ctx!.hasPendingMessages()) ?? false : false });
  }

  let lastPartialFlush = 0;

  function flushPartial(): void {
    partialTimer = null;
    lastPartialFlush = Date.now();
    if (partial) publish({ type: "partial", partial });
  }

  // Leading-edge throttle: an update after a quiet spell goes out at once, and
  // a burst coalesces into at most one frame per PARTIAL_FLUSH_MS.
  function schedulePartial(): void {
    if (partialTimer) return;
    const wait = PARTIAL_FLUSH_MS - (Date.now() - lastPartialFlush);
    if (wait <= 0) flushPartial();
    else partialTimer = setTimeout(flushPartial, wait);
  }

  function finalize(message: LooseMessage): void {
    if (message.role === "user") {
      const text = messageText(message.content);
      const index = pendingSends.findIndex((pending) => pending.text === text);
      if (index !== -1 && typeof message.timestamp === "number") {
        const [pending] = pendingSends.splice(index, 1);
        const entry = loadLedger().get(pending.requestId);
        if (entry) {
          entry.messageTimestamp = message.timestamp;
          try {
            saveLedger();
          } catch {
            // The in-memory binding still labels this page's view.
          }
        }
      }
    }
    const item = project(message);
    if (!item) return;
    if (item.role === "assistant" && partial?.key === item.key) {
      partial = null;
      if (partialTimer) {
        clearTimeout(partialTimer);
        partialTimer = null;
      }
    }
    recent.push(item);
    if (recent.length > RECENT_ITEMS) recent.splice(0, recent.length - RECENT_ITEMS);
    publish({ type: "item", item });
  }

  function send(requestId: string, text: string): BrowserChatSendOutcome {
    const digest = sha256(text);
    const known = loadLedger().get(requestId);
    if (known) {
      return known.sha256 === digest
        ? { status: "replay", requestId }
        : { status: "conflict", requestId, message: "this request id was already used for different text" };
    }
    const current = ctx;
    if (!current || stopped) return { status: "unavailable", requestId, message: "the Firstmate session is not ready" };
    if (sessionLockOwnership(state) !== "owned") {
      return { status: "unavailable", requestId, message: "this Pi session no longer holds the Firstmate session lock" };
    }
    loadLedger().set(requestId, { requestId, sha256: digest, acceptedAt: Date.now() });
    saveLedger();
    const idle = safe(() => current.isIdle()) ?? !busy;
    const delivery = idle ? "prompt" : "steer";
    // Registered before the hand-off so an immediately delivered message still
    // binds to its request id.
    pendingSends.push({ requestId, text });
    if (pendingSends.length > 20) pendingSends.shift();
    try {
      const result = pi.sendUserMessage(text, idle ? undefined : { deliverAs: "steer" }) as unknown;
      if (result && typeof (result as Promise<unknown>).catch === "function") {
        (result as Promise<unknown>).catch((error: unknown) => {
          publish({ type: "send-failed", requestId, message: error instanceof Error ? error.message : String(error) });
        });
      }
    } catch (error) {
      const index = pendingSends.findIndex((pending) => pending.requestId === requestId);
      if (index !== -1) pendingSends.splice(index, 1);
      loadLedger().delete(requestId);
      saveLedger();
      return { status: "unavailable", requestId, message: error instanceof Error ? error.message : String(error) };
    }
    publish({ type: "accepted", requestId, delivery });
    return { status: "accepted", requestId, delivery };
  }

  async function start(): Promise<void> {
    const token = accessToken();
    const preferred = configuredPort() ?? previousPort() ?? 0;
    const options = { token, assetsDir, bridge: { snapshot, send } };
    let started: BrowserChatServer;
    try {
      started = await startBrowserChatServer({ ...options, port: preferred });
    } catch (error) {
      if (preferred === 0 || configuredPort() !== undefined) throw error;
      started = await startBrowserChatServer({ ...options, port: 0 });
    }
    if (stopped) {
      await started.close();
      return;
    }
    server = started;
    writePrivate(portFile, `${started.port}\n`);
    const url = `http://127.0.0.1:${started.port}/`;
    writePrivate(endpointFile, `${JSON.stringify({
      version: 1,
      pid: process.pid,
      port: started.port,
      url,
      sessionId: ctx ? safe(() => ctx!.sessionManager.getSessionId()) ?? null : null,
      startedAt: new Date().toISOString(),
    })}\n`);
  }

  function maybeStart(): Promise<void> {
    if (server || stopped) return Promise.resolve();
    if (starting) return starting;
    if (!existsSync(flagFile)) return Promise.resolve();
    if (sessionLockOwnership(state) !== "owned") return Promise.resolve();
    starting = start()
      .catch((error: unknown) => {
        if (ctx?.hasUI) ctx.ui.notify(`Browser chat could not start: ${error instanceof Error ? error.message : String(error)}`, "warning");
      })
      .finally(() => {
        starting = null;
      });
    return starting;
  }

  async function stop(): Promise<void> {
    stopped = true;
    if (partialTimer) clearTimeout(partialTimer);
    partialTimer = null;
    if (starting) await starting;
    const current = server;
    server = null;
    if (!current) return;
    await current.close();
    const endpoint = readJson(endpointFile) as { pid?: unknown } | undefined;
    if (endpoint?.pid === process.pid) {
      try {
        unlinkSync(endpointFile);
      } catch {
        // Already gone.
      }
    }
  }

  function openInBrowser(url: string): boolean {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    return spawnSync(opener, [url], { stdio: "ignore" }).status === 0;
  }

  pi.on("session_start", async (_event, context) => {
    ctx = context;
    await maybeStart();
  });
  pi.on("agent_start", async (_event, context) => {
    ctx = context;
    busy = true;
    publishStatus();
  });
  pi.on("agent_settled", async (_event, context) => {
    ctx = context;
    busy = false;
    publishStatus();
    if (server && !existsSync(flagFile)) {
      await stop();
      stopped = false;
      return;
    }
    await maybeStart();
  });
  pi.on("message_start", async (event) => {
    const message = event.message as LooseMessage;
    if (message.role !== "assistant") return;
    const timestamp = typeof message.timestamp === "number" ? message.timestamp : Date.now();
    partial = { key: `assistant:${timestamp}`, text: messageText(message.content, "\n\n"), tools: toolNames(message.content), timestamp };
    // An empty start waits for the first words, which then go out at once.
    if (partial.text || partial.tools.length) schedulePartial();
  });
  pi.on("message_update", async (event) => {
    const message = event.message as LooseMessage;
    if (message.role !== "assistant") return;
    const timestamp = typeof message.timestamp === "number" ? message.timestamp : partial?.timestamp ?? Date.now();
    partial = { key: `assistant:${timestamp}`, text: messageText(message.content, "\n\n"), tools: toolNames(message.content), timestamp };
    schedulePartial();
  });
  pi.on("message_end", async (event) => {
    finalize(event.message as LooseMessage);
  });
  pi.on("session_compact", async () => {
    const at = Date.now();
    const item: ChatItem = { key: `notice:${at}`, role: "notice", text: "Earlier conversation was compacted.", timestamp: at };
    recent.push(item);
    publish({ type: "item", item });
  });
  pi.on("session_shutdown", async () => {
    await stop();
  });

  pi.registerCommand("browser-chat", {
    description: "Open this Firstmate conversation in the local browser chat page (\"copy\" copies its link instead).",
    handler: async (args, context) => {
      ctx = context;
      if (!existsSync(flagFile)) {
        context.ui.notify(`Browser chat is off. Create ${flagFile} to turn it on, then run /browser-chat again.`, "warning");
        return;
      }
      await maybeStart();
      if (!server) {
        context.ui.notify("Browser chat is not running: this Pi session does not hold the Firstmate session lock.", "warning");
        return;
      }
      const url = `http://127.0.0.1:${server.port}/#token=${accessToken()}`;
      if (args.trim() === "copy") {
        const copied = process.platform === "darwin" && spawnSync("pbcopy", [], { input: url }).status === 0;
        context.ui.notify(copied ? "Browser chat link copied to the clipboard." : `Could not copy; run bin/fm-browser-chat.sh url`, copied ? "info" : "warning");
        return;
      }
      const opened = openInBrowser(url);
      context.ui.notify(
        opened ? `Browser chat opened at http://127.0.0.1:${server.port}/` : "Could not open a browser; run bin/fm-browser-chat.sh url",
        opened ? "info" : "warning",
      );
    },
  });
}
