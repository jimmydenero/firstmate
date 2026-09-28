// DOM-free pieces of the browser chat page, importable by tests.

// Incremental text/event-stream parser. Feed decoded chunks; each complete
// event's data is JSON-parsed and handed to onEvent. Comment lines (keepalives)
// only call onActivity.
export function createSseParser(onEvent, onActivity = () => {}) {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      onActivity();
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data) continue;
      try {
        onEvent(JSON.parse(data));
      } catch {
        // A malformed frame is dropped; the next snapshot repairs the view.
      }
    }
  };
}

// Copy exact text. env supplies navigator.clipboard (optional) and a
// legacyCopy(text) fallback that returns true on success. Resolves to
// { ok: true, method } or { ok: false, reason }; the caller shows the text for
// manual copying when ok is false.
export async function copyText(text, env) {
  let reason = "";
  const clipboard = env.clipboard;
  if (clipboard && typeof clipboard.writeText === "function") {
    try {
      await clipboard.writeText(text);
      return { ok: true, method: "clipboard" };
    } catch (error) {
      reason = error && error.message ? error.message : String(error);
    }
  } else {
    reason = "this browser does not offer the clipboard API here";
  }
  try {
    if (env.legacyCopy && env.legacyCopy(text)) return { ok: true, method: "legacy" };
  } catch (error) {
    reason = error && error.message ? error.message : String(error);
  }
  return { ok: false, reason: reason || "the browser refused to copy" };
}

export function speechRecognitionConstructor(win) {
  return (win && (win.SpeechRecognition || win.webkitSpeechRecognition)) || null;
}

export function speechUnsupportedMessage(win) {
  if (!speechRecognitionConstructor(win)) {
    return "Voice input is not available in this browser. Type instead, or use your system dictation (macOS Dictation or a dictation app) in the message box.";
  }
  if (win.isSecureContext === false) {
    return "Voice input needs a secure page; open the chat at http://127.0.0.1 rather than another address.";
  }
  return "";
}

export function speechErrorMessage(code) {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access was denied. Allow the microphone for this page in the browser's site settings, or type instead.";
    case "audio-capture":
      return "No microphone was found. Connect one or type instead.";
    case "network":
      return "The browser's speech service could not be reached. Type instead, or try again.";
    case "no-speech":
      return "No speech was heard. Press the microphone and try again.";
    case "aborted":
      return "";
    case "language-not-supported":
      return "The browser's speech service does not support this language. Type instead.";
    default:
      return `Voice input stopped (${code || "unknown error"}). Type instead, or try again.`;
  }
}

export function newRequestId(cryptoApi) {
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function median(values) {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
