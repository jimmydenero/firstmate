# Browser chat

Talk to the first mate from a local browser page instead of the terminal.
It is the same conversation, not a second assistant: what you type in the page arrives in the primary session exactly as if you had typed it at the terminal, and the page shows that session's replies as they stream.
The terminal keeps working alongside it, and anything typed there appears in the page too.

The page exists for the things a terminal does badly:

- **Long links copy whole.** Every link in a message is listed under it with its own Copy button, plus one "Copy all links" button.
  Copying uses the exact characters of the original link, so terminal line wrapping, truncation and display labels never reach the clipboard.
- **Formatted replies.** Markdown renders as headings, lists, tables and code, and a wrapped link still copies whole.
- **Voice input you can edit.** Dictate into the message box, fix it, then press Send.
- **Reconnects on its own.** Closing the laptop lid, restarting the first mate, or a dropped connection never sends a message twice and never loses a finished reply.

## Supported limits

- **Pi primary only.** The page is served by a Pi extension inside the primary session, so it needs a home whose primary runs Pi.
  Claude Code, Codex and the other primary harnesses have no equivalent in-process hook that can both stream replies and deliver input to the running session, so they are not supported.
- **This machine only.** The page listens on `127.0.0.1` and refuses any other host name, so another computer cannot reach it.
  There is no tunnel, public address or multi-user mode.
- **One home.** The page belongs to the home whose primary session holds the session lock; a second, lock-refused session in the same home serves nothing.
- **History window.** A freshly opened page shows the most recent 250 messages of the current conversation; older ones remain in the terminal and the session file.
  Tool output is cut to 1,500 characters in the page.
- **Text only.** No attachments, search or spoken replies.

## Turning it on

The page is off until you create the flag file in the home's `config/` directory:

```sh
touch config/browser-chat
```

Pi reads its extensions only when a session starts, so a primary that was already running before this feature arrived needs one `/reload` (or restart) to load it; `/reload` keeps the conversation.
Once loaded, the extension checks the flag when the session starts, after each reply, and whenever you run `/browser-chat`, so creating the flag later needs no reload.
Removing the flag stops the page after the next reply.
If a start fails, for example because a pinned port is taken, you see one warning, and later replies and session starts do not retry it.
It is retried only when you run `/browser-chat`, edit the flag file, or restart or `/reload` the session.

To pin a port, add one line to the flag file, such as `port=7788`.
Without it the page keeps whatever port it first got, so a bookmark keeps working across restarts.

## Opening it

Any one of these opens or hands you the access link:

- `/browser-chat` in the primary terminal opens the page in your default browser.
- `/browser-chat copy` in the primary terminal copies the access link to the clipboard.
- `bin/fm-browser-chat.sh open`, `copy`, `url`, or `status` from a shell in the home.

The access link has the form `http://127.0.0.1:<port>/#token=<token>`.
The page keeps the token for that address, so after the first visit a bookmark of `http://127.0.0.1:<port>/` is enough.
Treat the link like a password: anyone holding it on this machine can talk to the first mate as you.
To revoke every issued link, delete `state/extensions/browser-chat/token` and run `/reload`; a new token is created.

## Using it

- **Enter** sends, **Shift+Enter** adds a line.
  A message sent while the first mate is working is queued and read after its current step, the same as typing at the terminal.
- A message sent while the page is disconnected waits in the page, marked "not sent yet", and goes out once it reconnects.
- **Notifications** and **Tool activity** in the header show the first mate's internal notifications and tool steps, which are folded away by default.
- The footer shows two separate timings.
  "link" is the time from the first mate sending an update to this page drawing it, which is the page's own latency.
  "model first words" is how long the model took to start answering your last message, which the page cannot make faster.

## Voice input

The microphone button uses the browser's built-in speech recognition, so it needs no key, account or setup.
It asks for microphone permission the first time and listens only after you press it.
Words appear in the message box, where you can edit them before pressing Send; nothing is ever sent automatically.
In Chrome, the browser sends the audio to Google's speech service to transcribe it; Safari uses Apple's.
If the browser has no speech recognition, or microphone permission is refused, the page says so and you can type, or use your system dictation (macOS Dictation or a dictation app) straight into the message box.

## Security model

- Loopback only, with the host name checked on every request so a web page cannot reach the port through DNS rebinding.
- Every request must carry the access token in a header, and a request from any other web origin is refused; there are no cross-origin permissions.
- The page loads only its own scripts and styles, renders every message as untrusted text, turns only `http`, `https` and `mailto` addresses into links, and shows images as links rather than loading them.
- Copy buttons never open, prefetch or visit a link.
- The token, port, endpoint and request-id records live under `state/extensions/browser-chat/` with owner-only permissions.
  The page's own copy of the token, your display toggles and unsent messages live in the browser's storage for that address.

## Owners

| Concern | Owner |
| --- | --- |
| Binding to the Pi session, reconnect and duplicate-delivery rules | `.pi/extensions/fm-browser-chat.ts` |
| Transport and its security boundary | `.pi/extensions/lib/fm-browser-chat-server.ts` |
| Markdown rendering and exact link extraction | `.pi/extensions/lib/browser-chat/markdown.js` |
| The page | `.pi/extensions/lib/browser-chat/` |
| Reaching the page from a shell | `bin/fm-browser-chat.sh` |
| Executable checks | `tests/fm-browser-chat.test.sh` |

The out-of-band note queue in `bin/fm-inbox.sh` and the spoken interface in [`voice-relay.md`](voice-relay.md) are separate paths for when you cannot, or do not want to, talk to the running session directly.
