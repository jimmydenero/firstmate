// Scenario driver for tests/fm-browser-chat.test.sh: loads the real browser
// chat extension against a stand-in Pi API and exercises it over real HTTP.
// Usage: node tests/fm-browser-chat-driver.mjs <scenario>
// Environment: PLUGIN (extension path), FM_HOME, FM_ROOT_OVERRIDE.
import { request } from "node:http";
import { statSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const home = process.env.FM_HOME;
const assets = process.env.ASSETS;
const { createSseParser } = await import(pathToFileURL(`${assets}/client.js`).href);

function check(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
}

export function fakePi() {
  const handlers = {};
  const commands = {};
  const sent = [];
  const branch = [];
  const state = { idle: true, sessionId: "sess-1" };
  const ctx = {
    hasUI: false,
    ui: { notify() {} },
    isIdle: () => state.idle,
    hasPendingMessages: () => false,
    sessionManager: { getBranch: () => branch, getSessionId: () => state.sessionId },
  };
  const pi = {
    on(name, fn) {
      (handlers[name] ||= []).push(fn);
    },
    registerCommand(name, options) {
      commands[name] = options;
    },
    sendUserMessage(text, options) {
      sent.push({ text, options });
    },
    getSessionName: () => "lab",
  };
  async function emit(name, event = {}, { persist = true } = {}) {
    for (const fn of handlers[name] || []) await fn({ type: name, ...event }, ctx);
    if (name === "message_end" && persist) branch.push({ type: "message", id: `e${branch.length}`, message: event.message });
  }
  return { pi, ctx, emit, sent, branch, state, commands };
}

async function load(pi) {
  const mod = await import(`${pathToFileURL(process.env.PLUGIN).href}?instance=${Math.random()}`);
  mod.default(pi);
}

function endpoint() {
  const path = `${home}/state/extensions/browser-chat/endpoint.json`;
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

function token() {
  return readFileSync(`${home}/state/extensions/browser-chat/token`, "utf8").trim();
}

function http(port, path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolveRequest, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, agent: false, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolveRequest({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function auth() {
  return { Authorization: `Bearer ${token()}` };
}

function sendMessage(port, requestId, text, extra = {}) {
  return http(port, "/api/send", {
    method: "POST",
    headers: { ...auth(), "Content-Type": "application/json", ...extra },
    body: JSON.stringify({ requestId, text }),
  });
}

// Open the event stream; returns { events, waitFor(predicate), close() }.
function stream(port) {
  const events = [];
  const waiters = [];
  let req;
  const opened = new Promise((resolveOpen, reject) => {
    req = request({ host: "127.0.0.1", port, path: "/api/events", agent: false, headers: { Host: `127.0.0.1:${port}`, ...auth() } }, (res) => {
      check(res.statusCode === 200, `event stream status ${res.statusCode}`);
      const feed = createSseParser((event) => {
        event.receivedAt = Date.now();
        events.push(event);
        for (const waiter of [...waiters]) {
          if (waiter.predicate(event)) {
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve(event);
          }
        }
      });
      res.setEncoding("utf8");
      res.on("data", feed);
      resolveOpen();
    });
    req.on("error", reject);
    req.end();
  });
  return {
    events,
    opened,
    waitFor(predicate, label) {
      const found = events.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise((resolveWait) => {
        const timer = setTimeout(() => check(false, `timed out waiting for ${label}`), 5000);
        waiters.push({ predicate, resolve: (event) => { clearTimeout(timer); resolveWait(event); } });
      });
    },
    close() {
      req.destroy();
    },
  };
}

function lockSelf() {
  writeFileSync(`${home}/state/.lock`, `${process.pid}\n`);
}

function enable(content = "") {
  writeFileSync(`${home}/config/browser-chat`, content);
}

const LONG_URL =
  "https://auth.example.test/oauth/authorize?client_id=1234567890&redirect_uri=https%3A%2F%2Fapp.example.test%2Fcallback%3Fnext%3D%252Fhome&scope=user_profile%2Cuser_media&response_type=code&state=Zx_9-aB%2Fc%3D%3D&extra=" +
  "a".repeat(600) +
  "#frag_ment";

const scenarios = {
  async "off-by-default"() {
    lockSelf();
    const fake = fakePi();
    await load(fake.pi);
    await fake.emit("session_start");
    check(endpoint() === null, "no endpoint may be published without config/browser-chat");
    await fake.emit("session_shutdown");
  },

  async "lock-held-elsewhere"() {
    enable();
    const other = spawn("sleep", ["30"], { stdio: "ignore" });
    writeFileSync(`${home}/state/.lock`, `${other.pid}\n`);
    const fake = fakePi();
    await load(fake.pi);
    await fake.emit("session_start");
    await fake.emit("agent_settled");
    check(endpoint() === null, "a session that does not hold the lock must not serve");
    other.kill();
    await fake.emit("session_shutdown");
  },

  async "security-boundary"() {
    lockSelf();
    enable();
    const fake = fakePi();
    await load(fake.pi);
    await fake.emit("session_start");
    const ep = endpoint();
    check(ep && ep.port > 0, "endpoint published");
    check(ep.url === `http://127.0.0.1:${ep.port}/`, "endpoint URL is loopback");
    for (const file of ["token", "endpoint.json"]) {
      const mode = statSync(`${home}/state/extensions/browser-chat/${file}`).mode & 0o777;
      check(mode === 0o600, `${file} mode is ${mode.toString(8)}`);
    }
    const port = ep.port;
    const page = await http(port, "/");
    check(page.status === 200, "page served");
    check(/script-src 'self'/.test(page.headers["content-security-policy"] || ""), "page carries a same-origin CSP");
    check(!page.headers["access-control-allow-origin"], "no CORS header");
    check((await http(port, "/api/events")).status === 401, "events without token refused");
    check((await http(port, "/api/events", { headers: { Authorization: "Bearer wrong" } })).status === 401, "wrong token refused");
    check((await http(port, "/api/ping", { headers: { ...auth(), Host: `evil.test:${port}` } })).status === 403, "foreign Host refused");
    check((await http(port, "/api/ping", { headers: { ...auth(), Origin: "https://evil.test" } })).status === 403, "foreign Origin refused");
    check((await http(port, "/api/ping", { headers: { ...auth(), Origin: `http://127.0.0.1:${port}` } })).status === 200, "own Origin allowed");
    check((await http(port, "/api/ping", { headers: { ...auth(), "Sec-Fetch-Site": "cross-site" } })).status === 403, "cross-site fetch refused");
    const forged = await sendMessage(port, "req-forged-0001", "hi", { Origin: "http://localhost.evil.test" });
    check(forged.status === 403 && fake.sent.length === 0, "cross-origin send refused and not delivered");
    check((await http(port, "/../../etc/passwd")).status === 404, "no path lookup");
    check((await http(port, "/index.html")).status === 404, "only allowlisted asset paths");
    const noJson = await http(port, "/api/send", { method: "POST", headers: auth(), body: "requestId=x" });
    check(noJson.status === 415, "send requires JSON");
    check((await sendMessage(port, "short", "hi")).status === 400, "request id format enforced");
    check((await sendMessage(port, "req-empty-00001", "   ")).status === 400, "empty text refused");
    check(fake.sent.length === 0, "nothing delivered by refused requests");
    await fake.emit("session_shutdown");
    check(endpoint() === null, "endpoint removed at shutdown");
  },

  async "conversation"() {
    lockSelf();
    enable();
    const fake = fakePi();
    await load(fake.pi);
    await fake.emit("session_start");
    const port = endpoint().port;
    const live = stream(port);
    await live.opened;
    await live.waitFor((event) => event.type === "snapshot", "initial snapshot");

    const text = `Please check these\nsecond line\n${LONG_URL}`;
    const first = await sendMessage(port, "req-conversation-1", text);
    check(first.status === 200 && JSON.parse(first.body).status === "accepted", `first send accepted: ${first.body}`);
    check(fake.sent.length === 1 && fake.sent[0].text === text && fake.sent[0].options === undefined, "delivered once as a prompt with exact text");

    const userAt = 1_800_000_000_000;
    await fake.emit("message_start", { message: { role: "user", content: [{ type: "text", text }], timestamp: userAt } });
    await fake.emit("message_end", { message: { role: "user", content: [{ type: "text", text }], timestamp: userAt } });
    const userItem = await live.waitFor((event) => event.type === "item" && event.item.role === "user", "user item");
    check(userItem.item.requestId === "req-conversation-1", "user item carries its request id");
    check(userItem.item.text === text, "multiline user text preserved exactly");

    const replay = await sendMessage(port, "req-conversation-1", text);
    check(replay.status === 200 && JSON.parse(replay.body).status === "replay", "repeated request id is a replay");
    check(fake.sent.length === 1, "replay is never delivered again");
    const conflict = await sendMessage(port, "req-conversation-1", "different");
    check(conflict.status === 409, "same id with different text is a conflict");

    const replyAt = userAt + 10;
    const reply = `Here you go:\n\n1. ${LONG_URL}\n2. [second](https://example.test/b?x=1&y=%20z)`;
    const emittedAt = Date.now();
    await fake.emit("message_start", { message: { role: "assistant", content: [], timestamp: replyAt } });
    await fake.emit("message_update", { message: { role: "assistant", content: [{ type: "text", text: "Here you go:" }], timestamp: replyAt } });
    const partial = await live.waitFor((event) => event.type === "partial" && event.partial.text === "Here you go:", "streamed partial");
    const transportMs = partial.receivedAt - emittedAt;
    await fake.emit("message_update", { message: { role: "assistant", content: [{ type: "text", text: reply }], timestamp: replyAt } });
    await fake.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: reply }], timestamp: replyAt, stopReason: "stop" } });
    const final = await live.waitFor((event) => event.type === "item" && event.item.role === "assistant", "final reply");
    check(final.item.text === reply, "final reply text exact");
    live.close();

    // A reply finalized while no page is connected, and not yet persisted.
    const lateAt = replyAt + 50;
    await fake.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "late reply" }], timestamp: lateAt } }, { persist: false });

    const again = stream(port);
    await again.opened;
    const snap = await again.waitFor((event) => event.type === "snapshot", "reconnect snapshot");
    const keys = snap.items.map((item) => item.key);
    check(new Set(keys).size === keys.length, "snapshot has no duplicate messages");
    check(snap.items.some((item) => item.text === "late reply"), "reply finalized while disconnected is not lost");
    check(snap.items.filter((item) => item.role === "user" && item.requestId === "req-conversation-1").length === 1, "sent turn appears exactly once after reconnect");
    check(snap.items.some((item) => item.text === reply), "persisted reply present after reconnect");
    // Once persisted too, it still appears once.
    fake.branch.push({ type: "message", id: "late", message: { role: "assistant", content: [{ type: "text", text: "late reply" }], timestamp: lateAt } });
    again.close();
    const third = stream(port);
    await third.opened;
    const snap3 = await third.waitFor((event) => event.type === "snapshot", "third snapshot");
    check(snap3.items.filter((item) => item.text === "late reply").length === 1, "persisted and buffered reply deduplicated");
    third.close();

    // Busy session: the browser message is steered in, like terminal input.
    fake.state.idle = false;
    const steer = await sendMessage(port, "req-conversation-2", "while busy");
    check(JSON.parse(steer.body).delivery === "steer", "busy delivery is a steer");
    check(fake.sent[1].options && fake.sent[1].options.deliverAs === "steer", "Pi was asked to steer");
    await fake.emit("session_shutdown");

    // The request ledger survives an extension reload.
    const reloaded = fakePi();
    await load(reloaded.pi);
    await reloaded.emit("session_start");
    const afterReload = await sendMessage(endpoint().port, "req-conversation-1", text);
    check(JSON.parse(afterReload.body).status === "replay" && reloaded.sent.length === 0, "replay holds across reload");
    await reloaded.emit("session_shutdown");
    console.log(`transport_ms=${transportMs}`);
  },

  async "operational-and-tools"() {
    lockSelf();
    enable();
    const fake = fakePi();
    await load(fake.pi);
    await fake.emit("session_start");
    const encoded = readFileSync(process.env.OPERATIONAL_SAMPLE, "utf8");
    await fake.emit("message_end", { message: { role: "user", content: [{ type: "text", text: encoded }], timestamp: 1 } });
    await fake.emit("message_end", { message: { role: "user", content: "plain captain words", timestamp: 2 } });
    await fake.emit("message_end", { message: { role: "assistant", content: [{ type: "toolCall", id: "c", name: "bash", arguments: {} }], timestamp: 3 } });
    await fake.emit("message_end", { message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "x".repeat(5000) }], isError: false, timestamp: 4 } });
    const live = stream(endpoint().port);
    await live.opened;
    const snap = await live.waitFor((event) => event.type === "snapshot", "snapshot");
    const [op, captain, toolStep, toolResult] = snap.items;
    check(op.operational === true, "Firstmate operational input is marked");
    check(!captain.operational, "captain text is not marked");
    check(toolStep.tools && toolStep.tools[0] === "bash", "tool step names its tool");
    check(toolResult.role === "tool" && toolResult.text.length < 1700, "tool output is truncated in the page");
    live.close();
    await fake.emit("session_shutdown");
  },

  async markdown() {
    const fail = (message) => check(false, message);
    const { renderMarkdown, extractLinks, copyAllPayload } = await import(pathToFileURL(`${process.env.ASSETS}/markdown.js`).href);
    const long = "https://auth.example.test/oauth/authorize?client_id=42&redirect_uri=https%3A%2F%2Fapp.example.test%2Fcb%3Fa%3D1%26b%3D2&state=Q_w-e%2Fr%3D%3D&scope=a%2Cb#section_2";
    const text = [
      "Links, in order:",
      `1. ${long}.`,
      "2. [label hides it](https://example.test/p?x=(1)&y=\"q\" \"title\")",
      "3. <https://example.test/auto?z=%E2%9C%93>",
      "- **https://example.test/bold**, then (https://example.test/paren)",
      "`curl https://example.test/in-code?k=v&w=1`",
      "```",
      "https://example.test/fenced?one=1&two=2",
      "```",
      `again ${long}`,
      "not a link: javascript:alert(1) and [x](javascript:alert(2)) and ftp://example.test/f",
    ].join("\n");
    const links = extractLinks(text);
    const expected = [
      long,
      "https://example.test/p?x=(1)&y=\"q\"",
      "https://example.test/auto?z=%E2%9C%93",
      "https://example.test/bold",
      "https://example.test/paren",
      "https://example.test/in-code?k=v&w=1",
      "https://example.test/fenced?one=1&two=2",
    ];
    if (JSON.stringify(links) !== JSON.stringify(expected)) fail(`links: ${JSON.stringify(links, null, 1)}`);
    if (copyAllPayload(links) !== expected.join("\n")) fail("copy-all payload is not the exact links one per line");
    const hostile = [
      "<script>alert(1)</script>",
      "<img src=x onerror=alert(1)>",
      "[click](javascript:alert(1))",
      "[q](https://example.test/\"onmouseover=\"alert(1))",
      "![pic](https://tracker.example.test/pixel.png)",
      "**<b>bold</b>**",
      "<a href=\"https://example.test\">raw</a>",
    ].join("\n\n");
    const { html } = renderMarkdown(hostile);
    // Every "<" in text is escaped, so each tag in the output was built by the
    // renderer: check it against the fixed tag and attribute allowlist.
    const tags = new Set(["p", "br", "a", "strong", "em", "del", "code", "pre", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "hr", "table", "thead", "tbody", "tr", "th", "td", "div"]);
    const attrs = new Set(["href", "target", "rel", "referrerpolicy", "start", "class"]);
    for (const [, name, rest] of html.matchAll(/<\/?([a-z0-9]+)([^>]*)>/g)) {
      if (!tags.has(name)) fail(`unexpected tag ${name}: ${html}`);
      for (const [, attr, value] of rest.matchAll(/([a-z-]+)="([^"]*)"/g)) {
        if (!attrs.has(attr)) fail(`unexpected attribute ${attr}: ${html}`);
        if (attr === "href" && !/^(https?:|mailto:)/.test(value)) fail(`unsafe href ${value}`);
      }
      if (rest.replace(/\s*[a-z-]+="[^"]*"/g, "").trim()) fail(`unquoted attribute text in <${name}${rest}>`);
    }
    if (!html.includes("&lt;script&gt;")) fail("raw HTML must render as text");
    if (!html.includes("image: pic")) fail("images must render as links, not fetches");
    const multi = renderMarkdown("line one\nline two\n\n| a | b |\n|---|---|\n| 1 | 2 |").html;
    if (!multi.includes("line one<br>line two") || !multi.includes("<table>")) fail(`multiline or table rendering: ${multi}`);
  },

  async client() {
    const fail = (message) => check(false, message);
    const client = await import(pathToFileURL(`${process.env.ASSETS}/client.js`).href);
    const exact = "https://example.test/a?b=%20c&d=e#f";
    let copied = "";
    let result = await client.copyText(exact, { clipboard: { writeText: async (t) => { copied = t; } } });
    if (!result.ok || copied !== exact || result.method !== "clipboard") fail("clipboard API path");
    result = await client.copyText(exact, { clipboard: { writeText: async () => { throw new Error("Document is not focused"); } }, legacyCopy: (t) => { copied = `legacy:${t}`; return true; } });
    if (!result.ok || result.method !== "legacy" || copied !== `legacy:${exact}`) fail("legacy fallback path");
    result = await client.copyText(exact, { clipboard: undefined, legacyCopy: () => false });
    if (result.ok || !result.reason) fail("both-fail path must report a reason for the manual-copy dialog");
    if (!client.speechUnsupportedMessage({}).includes("Type instead")) fail("unsupported speech must offer text");
    if (client.speechUnsupportedMessage({ webkitSpeechRecognition: function () {}, isSecureContext: true }) !== "") fail("supported speech");
    if (!client.speechErrorMessage("not-allowed").includes("Microphone access was denied")) fail("permission denial message");
    if (!client.speechErrorMessage("network").includes("Type instead")) fail("network error falls back to text");
    const events = [];
    const feed = client.createSseParser((event) => events.push(event));
    feed("id: 1\ndata: {\"type\":\"a\",");
    feed("\"n\":1}\n\n: keepalive\n\nid: 2\ndata: {\"type\":\"b\"}\n");
    feed("\n");
    if (events.length !== 2 || events[0].n !== 1 || events[1].type !== "b") fail(`sse parser: ${JSON.stringify(events)}`);
  },
};

const name = process.argv[2];
check(Object.hasOwn(scenarios, name), `unknown scenario ${name}`);
await scenarios[name]();
console.log(`ok ${name}`);
process.exit(0);
