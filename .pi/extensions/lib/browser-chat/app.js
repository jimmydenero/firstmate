// Firstmate browser chat page. The server contract lives in
// ../fm-browser-chat-server.ts and ../../fm-browser-chat.ts; rendering and link
// extraction live in markdown.js; DOM-free helpers live in client.js.
import { copyAllPayload, renderMarkdown } from "./markdown.js";
import {
  copyText,
  createSseParser,
  median,
  newRequestId,
  speechErrorMessage,
  speechRecognitionConstructor,
  speechUnsupportedMessage,
} from "./client.js";

const $ = (id) => document.getElementById(id);
const log = $("log");
const input = $("input");

// Browser storage is a convenience only: every read and write may fail.
function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private windows and blocked storage keep working in memory.
  }
}

// The access token arrives in the URL fragment (never sent to the server as a
// URL) and is then kept for this origin so a bookmark of the bare page works.
function takeToken() {
  const match = /(?:^#|&)token=([A-Za-z0-9_-]+)/.exec(location.hash);
  if (match) {
    save("fm-chat-token", match[1]);
    history.replaceState(null, "", location.pathname);
    return match[1];
  }
  return load("fm-chat-token", "");
}
const token = takeToken();

const view = {
  sessionId: null,
  items: new Map(),
  order: [],
  partial: null,
  busy: false,
  queued: false,
  prefs: load("fm-chat-prefs", { notifications: false, tools: false }),
  outbox: load("fm-chat-outbox", []).filter((entry) => Date.now() - entry.createdAt < 86400000),
  transport: [],
  lastCaptainAt: null,
  modelFirstText: null,
};

function persistOutbox() {
  save("fm-chat-outbox", view.outbox);
}

function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 1800);
}

function banner(text) {
  const el = $("banner");
  el.textContent = text;
  el.hidden = !text;
}

function setConnection(state, label) {
  const el = $("connection");
  el.dataset.state = state;
  el.textContent = label;
}

function setActivity() {
  const el = $("activity");
  el.dataset.state = view.busy ? "busy" : "idle";
  el.textContent = view.busy ? (view.queued ? "Working - message queued" : "Working…") : "Idle";
}

function showLatency() {
  const parts = [];
  const link = median(view.transport);
  if (link !== undefined) parts.push(`link ${Math.max(0, Math.round(link))} ms`);
  if (view.modelFirstText !== null) parts.push(`model first words ${(view.modelFirstText / 1000).toFixed(1)} s`);
  $("latency").textContent = parts.join(" · ");
}

// Transport-to-display: server send time to this page's next paint. Both
// clocks are this machine's, since the server is loopback-only.
function measureTransport(sentAt) {
  if (typeof sentAt !== "number") return;
  requestAnimationFrame(() => {
    view.transport.push(Date.now() - sentAt);
    if (view.transport.length > 25) view.transport.shift();
    showLatency();
  });
}

// ---------------------------------------------------------------- copying

function legacyCopy(text) {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } finally {
    area.remove();
  }
  return ok;
}

async function copy(text, label) {
  const result = await copyText(text, { clipboard: navigator.clipboard, legacyCopy });
  if (result.ok) {
    toast(label);
    return;
  }
  const dialog = $("copy-fallback");
  $("copy-fallback-reason").textContent = `Could not copy automatically: ${result.reason}.`;
  const area = $("copy-fallback-text");
  area.value = text;
  dialog.showModal();
  area.focus();
  area.select();
}

// ---------------------------------------------------------------- rendering

function isQuiet(item) {
  if (item.role === "tool") return true;
  if (item.role === "assistant" && !item.text.trim() && !item.error) return true;
  return false;
}

function visible(item) {
  if (item.role === "user" && item.operational) return view.prefs.notifications;
  if (isQuiet(item)) return view.prefs.tools;
  return true;
}

function linkTray(links) {
  const tray = document.createElement("div");
  tray.className = "links";
  const head = document.createElement("div");
  head.className = "head";
  head.textContent = links.length === 1 ? "1 link" : `${links.length} links`;
  const all = document.createElement("button");
  all.type = "button";
  all.textContent = links.length === 1 ? "Copy link" : `Copy all ${links.length} links`;
  all.addEventListener("click", () => copy(copyAllPayload(links), links.length === 1 ? "Copied 1 link" : `Copied ${links.length} links`));
  head.appendChild(all);
  tray.appendChild(head);
  const list = document.createElement("ol");
  links.forEach((url, index) => {
    const row = document.createElement("li");
    const text = document.createElement("span");
    text.className = "url";
    text.textContent = url;
    const actions = document.createElement("span");
    actions.className = "actions";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Copy";
    button.setAttribute("aria-label", `Copy link ${index + 1}`);
    button.addEventListener("click", () => copy(url, `Copied link ${index + 1}`));
    actions.appendChild(button);
    row.append(text, actions);
    list.appendChild(row);
  });
  tray.appendChild(list);
  return tray;
}

function who(label, timestamp, extra) {
  const el = document.createElement("div");
  el.className = "who";
  const name = document.createElement("span");
  name.textContent = label;
  el.appendChild(name);
  if (timestamp) {
    const time = document.createElement("span");
    time.textContent = new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    el.appendChild(time);
  }
  if (extra) {
    const note = document.createElement("span");
    note.textContent = extra;
    el.appendChild(note);
  }
  return el;
}

function markdownBody(text) {
  const body = document.createElement("div");
  body.className = "body";
  const rendered = renderMarkdown(text);
  // renderMarkdown escapes every input byte and emits only its fixed tag set.
  body.innerHTML = rendered.html;
  return { body, links: rendered.links };
}

function renderItem(item) {
  const el = document.createElement("article");
  el.className = "msg";
  el.dataset.key = item.key;
  if (item.role === "user" && item.operational) {
    el.classList.add("quiet");
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Firstmate notification";
    const body = document.createElement("div");
    body.className = "body plain";
    body.textContent = item.text;
    details.append(summary, body);
    el.appendChild(details);
    return el;
  }
  if (item.role === "tool") {
    el.classList.add("quiet");
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = `${item.toolName}${item.isError ? " (error)" : ""}`;
    const pre = document.createElement("pre");
    pre.textContent = item.text;
    details.append(summary, pre);
    el.appendChild(details);
    return el;
  }
  if (item.role === "notice") {
    el.classList.add("quiet");
    el.textContent = item.text;
    return el;
  }
  if (item.role === "user") el.classList.add("captain");
  if (item.role === "assistant" && isQuiet(item)) {
    el.classList.add("quiet");
    el.textContent = `Working: ${(item.tools || []).join(", ")}`;
    return el;
  }
  const label = item.role === "user" ? "You" : item.role === "custom" ? "Firstmate note" : "Firstmate";
  const extra = item.tools && item.tools.length ? `used ${item.tools.join(", ")}` : "";
  el.appendChild(who(label, item.timestamp, extra));
  const { body, links } = markdownBody(item.text);
  el.appendChild(body);
  if (item.error) {
    el.classList.add("error-reply");
    const error = document.createElement("p");
    error.className = "hint";
    error.textContent = `The reply stopped with an error: ${item.error}`;
    el.appendChild(error);
  }
  if (links.length) el.appendChild(linkTray(links));
  return el;
}

function renderPending(entry) {
  const el = document.createElement("article");
  el.className = "msg captain pending";
  el.dataset.pending = entry.requestId;
  const status = {
    sending: "sending…",
    accepted: view.busy ? "queued - Firstmate will read it after the current step" : "delivered",
    unsent: "not sent yet - will retry when connected",
    failed: `not sent: ${entry.error || "refused"}`,
  }[entry.state] || entry.state;
  el.appendChild(who("You", entry.createdAt, status));
  const body = document.createElement("div");
  body.className = "body plain";
  body.textContent = entry.text;
  el.appendChild(body);
  if (entry.state === "failed") {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "Edit and resend";
    retry.addEventListener("click", () => {
      input.value = entry.text;
      view.outbox = view.outbox.filter((other) => other !== entry);
      persistOutbox();
      renderAll();
      input.focus();
    });
    el.appendChild(retry);
  }
  return el;
}

function renderPartial() {
  const existing = log.querySelector("[data-partial]");
  if (!view.partial || !view.partial.text.trim()) {
    existing?.remove();
    return;
  }
  const el = document.createElement("article");
  el.className = "msg";
  el.dataset.partial = view.partial.key;
  el.appendChild(who("Firstmate", view.partial.timestamp, "writing…"));
  const { body, links } = markdownBody(view.partial.text);
  el.appendChild(body);
  if (links.length) el.appendChild(linkTray(links));
  if (existing) existing.replaceWith(el);
  else log.appendChild(el);
}

function nearBottom() {
  return log.scrollHeight - log.scrollTop - log.clientHeight < 120;
}

function stick(wasNear) {
  if (wasNear) log.scrollTop = log.scrollHeight;
}

function renderAll() {
  const wasNear = nearBottom();
  log.replaceChildren();
  for (const key of view.order) {
    const item = view.items.get(key);
    if (item && visible(item)) log.appendChild(renderItem(item));
  }
  for (const entry of view.outbox) log.appendChild(renderPending(entry));
  renderPartial();
  setActivity();
  stick(wasNear);
}

let partialFrame = 0;
function schedulePartialRender() {
  if (partialFrame) return;
  partialFrame = requestAnimationFrame(() => {
    partialFrame = 0;
    const wasNear = nearBottom();
    renderPartial();
    // Pending bubbles stay below the reply being written.
    for (const pending of log.querySelectorAll("[data-pending]")) log.appendChild(pending);
    stick(wasNear);
  });
}

// ---------------------------------------------------------------- events

function settleOutbox(item) {
  if (item.role !== "user" || item.operational) return;
  const before = view.outbox.length;
  view.outbox = view.outbox.filter((entry) =>
    !(item.requestId ? entry.requestId === item.requestId : entry.state === "accepted" && entry.text === item.text));
  if (view.outbox.length !== before) persistOutbox();
}

function upsert(item) {
  if (!view.items.has(item.key)) view.order.push(item.key);
  view.items.set(item.key, item);
  settleOutbox(item);
}

function applySnapshot(event) {
  const sessionId = event.session ? event.session.id : null;
  if (view.sessionId && sessionId && view.sessionId !== sessionId) banner("Firstmate switched to a different conversation; showing the current one.");
  view.sessionId = sessionId;
  view.items.clear();
  view.order = [];
  for (const item of event.items || []) upsert(item);
  view.partial = event.partial || null;
  view.busy = Boolean(event.busy);
  view.queued = Boolean(event.queued);
  renderAll();
  resendOutbox();
}

function handleEvent(event) {
  switch (event.type) {
    case "snapshot":
      applySnapshot(event);
      break;
    case "item": {
      upsert(event.item);
      if (event.item.role === "user" && !event.item.operational) {
        view.lastCaptainAt = event.t;
      }
      if (view.partial && view.partial.key === event.item.key) view.partial = null;
      renderAll();
      break;
    }
    case "partial": {
      const first = !view.partial || view.partial.key !== event.partial.key || !view.partial.text.trim();
      view.partial = event.partial;
      if (first && event.partial.text.trim() && view.lastCaptainAt !== null) {
        view.modelFirstText = event.t - view.lastCaptainAt;
        view.lastCaptainAt = null;
        showLatency();
      }
      schedulePartialRender();
      break;
    }
    case "status":
      view.busy = Boolean(event.busy);
      view.queued = Boolean(event.queued);
      setActivity();
      break;
    case "accepted":
    case "send-failed": {
      const entry = view.outbox.find((pending) => pending.requestId === event.requestId);
      if (entry) {
        entry.state = event.type === "accepted" ? "accepted" : "failed";
        if (event.message) entry.error = event.message;
        persistOutbox();
        renderAll();
      }
      break;
    }
    default:
      break;
  }
  measureTransport(event.t);
}

// ---------------------------------------------------------------- connection

let connected = false;
let backoff = 250;

async function connect() {
  if (!token) {
    setConnection("error", "No access token");
    banner("This page needs its access link. Run /browser-chat in the Firstmate terminal, or bin/fm-browser-chat.sh open.");
    return;
  }
  setConnection(connected ? "reconnecting" : "connecting", connected ? "Reconnecting…" : "Connecting…");
  const controller = new AbortController();
  let watchdog;
  const arm = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => controller.abort(), 45000);
  };
  try {
    arm();
    const response = await fetch("/api/events", {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: controller.signal,
    });
    if (response.status === 401) {
      clearTimeout(watchdog);
      setConnection("error", "Access refused");
      banner("The access token was refused. Open a fresh link with /browser-chat or bin/fm-browser-chat.sh open.");
      return;
    }
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    connected = true;
    backoff = 250;
    setConnection("live", "Live");
    banner("");
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    const feed = createSseParser(handleEvent, arm);
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      arm();
      feed(value);
    }
  } catch {
    // Reconnect below.
  }
  clearTimeout(watchdog);
  setConnection("reconnecting", "Reconnecting…");
  if (connected) banner("Lost the connection to Firstmate; reconnecting. Nothing you sent will be sent twice.");
  setTimeout(connect, backoff);
  backoff = Math.min(backoff * 2, 5000);
}

// ---------------------------------------------------------------- sending

async function post(entry) {
  entry.state = "sending";
  renderAll();
  try {
    const response = await fetch("/api/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: entry.requestId, text: entry.text }),
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok) {
      if (entry.state === "sending") entry.state = "accepted";
    } else if (response.status === 503) {
      entry.state = "unsent";
      banner(body.message || "Firstmate is not ready to receive; will retry.");
    } else {
      entry.state = "failed";
      entry.error = body.message || body.error || `HTTP ${response.status}`;
    }
  } catch {
    entry.state = "unsent";
  }
  persistOutbox();
  renderAll();
}

function resendOutbox() {
  for (const entry of view.outbox) {
    if (entry.state === "unsent" || entry.state === "sending" || entry.state === "accepted") {
      // An already-accepted id is answered as a replay and never delivered twice.
      void post(entry);
    }
  }
}

function sendCurrent() {
  const text = input.value;
  if (!text.trim()) return;
  stopDictation();
  const entry = { requestId: newRequestId(crypto), text, state: "sending", createdAt: Date.now() };
  view.outbox.push(entry);
  persistOutbox();
  input.value = "";
  void post(entry);
}

$("send").addEventListener("click", sendCurrent);
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendCurrent();
  }
});

// ---------------------------------------------------------------- voice

const Recognition = speechRecognitionConstructor(window);
const mic = $("mic");
const voiceNote = $("voice-note");
let recognition = null;
let dictating = false;

function voiceMessage(text) {
  voiceNote.textContent = text;
}

function stopDictation() {
  if (recognition && dictating) recognition.stop();
}

function insertAtCursor(text) {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  const before = input.value.slice(0, start);
  const spacer = before && !/\s$/.test(before) ? " " : "";
  input.value = `${before}${spacer}${text}${input.value.slice(end)}`;
  const caret = before.length + spacer.length + text.length;
  input.setSelectionRange(caret, caret);
}

const unsupported = speechUnsupportedMessage(window);
if (unsupported) {
  mic.disabled = true;
  mic.title = unsupported;
  voiceMessage("Voice: not available here - type or use system dictation.");
} else {
  mic.title = "Dictate into the message box (uses your browser's speech recognition; in Chrome, audio goes to Google's speech service). Nothing is sent until you press Send.";
  mic.addEventListener("click", () => {
    if (dictating) {
      stopDictation();
      return;
    }
    recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";
    recognition.onstart = () => {
      dictating = true;
      mic.setAttribute("aria-pressed", "true");
      voiceMessage("Listening… press the microphone again to stop. Edit the text before sending.");
    };
    recognition.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result.isFinal) insertAtCursor(result[0].transcript.trim());
        else interim += result[0].transcript;
      }
      $("interim").textContent = interim;
      $("interim").hidden = !interim;
    };
    recognition.onerror = (event) => {
      const message = speechErrorMessage(event.error);
      if (message) voiceMessage(message);
    };
    recognition.onend = () => {
      dictating = false;
      mic.setAttribute("aria-pressed", "false");
      $("interim").hidden = true;
      if (voiceNote.textContent.startsWith("Listening")) voiceMessage("");
      input.focus();
    };
    try {
      recognition.start();
    } catch (error) {
      voiceMessage(speechErrorMessage(error && error.name === "NotAllowedError" ? "not-allowed" : String(error)));
    }
  });
}

// ---------------------------------------------------------------- start

for (const [id, key] of [["show-notifications", "notifications"], ["show-tools", "tools"]]) {
  const box = $(id);
  box.checked = Boolean(view.prefs[key]);
  box.addEventListener("change", () => {
    view.prefs[key] = box.checked;
    save("fm-chat-prefs", view.prefs);
    renderAll();
  });
}

renderAll();
void connect();
