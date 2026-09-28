// Safe Markdown and link rendering for the Firstmate browser chat page.
//
// This module is the single owner of two contracts, shared by the page and by
// tests/fm-browser-chat.test.sh:
//
// 1. Rendering. renderMarkdown() turns untrusted message text into an HTML
//    string that can only contain the fixed tag set built below. Every text run
//    and attribute value passes through escapeHtml(); no input byte is ever
//    copied into markup unescaped, so raw HTML in a message renders as text.
//    Only http:, https: and mailto: destinations become anchors, and images are
//    rendered as links so nothing is fetched on display.
//
// 2. Link extraction. The same pass records every http(s) URL in display order
//    as the exact original substring of the message: markdown link
//    destinations, <autolinks>, and bare URLs, including ones inside code spans
//    and fenced code. Copy controls copy these strings, never text read back
//    from the rendered page, so visual wrapping, truncation, labels and HTML
//    escaping can never reach the clipboard. Exact duplicates keep their first
//    position. A bare URL ends at whitespace, < > " or a backtick, and loses
//    trailing sentence punctuation (. , : ; ! ? ' * ~) and unbalanced closing
//    ) or ]; everything else, including query strings, fragments, percent
//    escapes and underscores, is kept byte for byte.

const SAFE_SCHEME = /^(https?:|mailto:)/i;
const HTTP_URL = /^https?:\/\//i;
const BARE_URL_SOURCE = 'https?://[^\\s<>"`]+';
const TRAILING_PUNCTUATION = /[.,:;!?'*~]/;

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Trim a bare-URL regex match to the URL a reader means.
export function trimBareUrl(candidate) {
  let url = candidate;
  for (;;) {
    const last = url[url.length - 1];
    if (last === undefined) return url;
    if (TRAILING_PUNCTUATION.test(last)) {
      url = url.slice(0, -1);
      continue;
    }
    if (last === ")" || last === "]") {
      const open = last === ")" ? "(" : "[";
      const opens = url.split(open).length - 1;
      const closes = url.split(last).length - 1;
      if (closes > opens) {
        url = url.slice(0, -1);
        continue;
      }
    }
    return url;
  }
}

function createLinkSink() {
  const seen = new Set();
  const links = [];
  return {
    links,
    add(url) {
      if (!HTTP_URL.test(url) || seen.has(url)) return;
      seen.add(url);
      links.push(url);
    },
  };
}

function anchor(url, labelHtml) {
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">${labelHtml}</a>`;
}

// Bare URLs inside literal text (code) are recorded for copying but not linked.
function collectBareUrls(text, sink) {
  for (const match of text.matchAll(new RegExp(BARE_URL_SOURCE, "gi"))) sink.add(trimBareUrl(match[0]));
}

// Find the destination of a markdown link starting at the "(" at index open.
// Returns { url, end } where end is the index after ")", or null.
function parseDestination(text, open) {
  let i = open + 1;
  while (text[i] === " ") i += 1;
  let url;
  if (text[i] === "<") {
    const close = text.indexOf(">", i + 1);
    if (close === -1) return null;
    url = text.slice(i + 1, close);
    if (/[\s<]/.test(url)) return null;
    i = close + 1;
  } else {
    let depth = 0;
    const start = i;
    while (i < text.length) {
      const ch = text[i];
      if (/\s/.test(ch)) break;
      if (ch === "(") depth += 1;
      if (ch === ")") {
        if (depth === 0) break;
        depth -= 1;
      }
      i += 1;
    }
    url = text.slice(start, i);
  }
  while (text[i] === " ") i += 1;
  if (text[i] === '"' || text[i] === "'") {
    const quote = text[i];
    const close = text.indexOf(quote, i + 1);
    if (close === -1) return null;
    i = close + 1;
    while (text[i] === " ") i += 1;
  }
  if (text[i] !== ")") return null;
  return { url, end: i + 1 };
}

// Find the "]" closing a link label that opens at index open, honoring nesting.
function findLabelEnd(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "`") {
      const close = text.indexOf("`", i + 1);
      if (close === -1) return -1;
      i = close;
      continue;
    }
    if (ch === "[") depth += 1;
    if (ch === "]") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const EMPHASIS = [
  { marker: "**", tag: "strong" },
  { marker: "__", tag: "strong" },
  { marker: "~~", tag: "del" },
  { marker: "*", tag: "em" },
  { marker: "_", tag: "em" },
];

function renderInline(text, sink) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    if (ch === "\\" && i + 1 < text.length && /[\\`*_{}[\]()#+\-.!|~<>]/.test(text[i + 1])) {
      out += escapeHtml(text[i + 1]);
      i += 2;
      continue;
    }

    if (ch === "`") {
      let run = 1;
      while (text[i + run] === "`") run += 1;
      const fence = "`".repeat(run);
      const close = text.indexOf(fence, i + run);
      if (close !== -1) {
        const code = text.slice(i + run, close);
        collectBareUrls(code, sink);
        out += `<code>${escapeHtml(code)}</code>`;
        i = close + run;
        continue;
      }
      out += escapeHtml(fence);
      i += run;
      continue;
    }

    const image = ch === "!" && text[i + 1] === "[";
    if (ch === "[" || image) {
      const labelStart = image ? i + 1 : i;
      const labelEnd = findLabelEnd(text, labelStart);
      if (labelEnd !== -1 && text[labelEnd + 1] === "(") {
        const dest = parseDestination(text, labelEnd + 1);
        if (dest) {
          const label = text.slice(labelStart + 1, labelEnd);
          if (SAFE_SCHEME.test(dest.url)) {
            sink.add(dest.url);
            const labelHtml = image
              ? escapeHtml(label ? `image: ${label}` : "image")
              : renderInline(label, sink) || escapeHtml(dest.url);
            out += anchor(dest.url, labelHtml);
          } else {
            out += renderInline(label, sink);
          }
          i = dest.end;
          continue;
        }
      }
    }

    if (ch === "<") {
      const close = text.indexOf(">", i + 1);
      if (close !== -1) {
        const inner = text.slice(i + 1, close);
        if (/^(https?:\/\/|mailto:)[^\s<>]*$/i.test(inner)) {
          sink.add(inner);
          out += anchor(inner, escapeHtml(inner));
          i = close + 1;
          continue;
        }
      }
    }

    if ((ch === "h" || ch === "H") && /^https?:\/\//i.test(text.slice(i, i + 8))) {
      const prev = i > 0 ? text[i - 1] : "";
      if (!prev || !/[A-Za-z0-9]/.test(prev)) {
        const sticky = new RegExp(BARE_URL_SOURCE, "iy");
        sticky.lastIndex = i;
        const found = sticky.exec(text);
        if (found) {
          const url = trimBareUrl(found[0]);
          sink.add(url);
          out += anchor(url, escapeHtml(url));
          i += url.length;
          continue;
        }
      }
    }

    let matched = false;
    for (const { marker, tag } of EMPHASIS) {
      if (!text.startsWith(marker, i)) continue;
      const after = text[i + marker.length];
      if (after === undefined || /\s/.test(after)) continue;
      if (marker[0] === "_" && i > 0 && /[A-Za-z0-9]/.test(text[i - 1])) continue;
      const close = text.indexOf(marker, i + marker.length + 1);
      if (close === -1 || /\s/.test(text[close - 1])) continue;
      if (marker[0] === "_" && /[A-Za-z0-9]/.test(text[close + marker.length] ?? "")) continue;
      const inner = text.slice(i + marker.length, close);
      out += `<${tag}>${renderInline(inner, sink)}</${tag}>`;
      i = close + marker.length;
      matched = true;
      break;
    }
    if (matched) continue;

    out += escapeHtml(ch);
    i += 1;
  }
  return out;
}

function renderLines(lines, sink) {
  return lines.map((line) => renderInline(line, sink)).join("<br>");
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function splitRow(line) {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  const cells = [];
  let cell = "";
  for (let i = 0; i < row.length; i += 1) {
    if (row[i] === "\\" && row[i + 1] === "|") {
      cell += "|";
      i += 1;
    } else if (row[i] === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += row[i];
    }
  }
  cells.push(cell.trim());
  return cells;
}

function renderBlocks(lines, sink) {
  const html = [];
  let i = 0;
  const isTableStart = (at) =>
    lines[at].includes("|") && at + 1 < lines.length && TABLE_SEPARATOR.test(lines[at + 1]) && lines[at + 1].includes("-");
  const isBlockStart = (at) => {
    const line = lines[at];
    return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || LIST_ITEM.test(line) || isTableStart(at);
  };

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      const body = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1;
      const code = body.join("\n");
      collectBareUrls(code, sink);
      html.push(`<pre><code>${escapeHtml(code)}</code></pre>`);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(heading[2], sink)}</h${level}>`);
      i += 1;
      continue;
    }

    if (RULE.test(line)) {
      html.push("<hr>");
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        body.push(QUOTE.exec(lines[i])[1]);
        i += 1;
      }
      html.push(`<blockquote>${renderBlocks(body, sink)}</blockquote>`);
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item) {
      const ordered = /\d/.test(item[2]);
      const start = ordered ? Number.parseInt(item[2], 10) : 1;
      const items = [];
      while (i < lines.length) {
        const current = LIST_ITEM.exec(lines[i]);
        if (current && /\d/.test(current[2]) === ordered && current[1].length <= item[1].length + 1) {
          items.push({ first: current[3], rest: [] });
          i += 1;
          continue;
        }
        if (items.length && lines[i].trim() && /^\s+/.test(lines[i]) && !FENCE.test(lines[i])) {
          items[items.length - 1].rest.push(lines[i].trim());
          i += 1;
          continue;
        }
        break;
      }
      const tag = ordered ? "ol" : "ul";
      const startAttr = ordered && start !== 1 ? ` start="${start}"` : "";
      const body = items
        .map((entry) => {
          const nested = entry.rest.length && LIST_ITEM.test(entry.rest[0])
            ? renderBlocks(entry.rest, sink)
            : "";
          const text = nested ? [entry.first] : [entry.first, ...entry.rest];
          return `<li>${renderLines(text, sink)}${nested}</li>`;
        })
        .join("");
      html.push(`<${tag}${startAttr}>${body}</${tag}>`);
      continue;
    }

    if (isTableStart(i)) {
      const header = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      const head = header.map((cell) => `<th>${renderInline(cell, sink)}</th>`).join("");
      const body = rows
        .map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell, sink)}</td>`).join("")}</tr>`)
        .join("");
      html.push(`<div class="table"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`);
      continue;
    }

    const paragraph = [];
    while (i < lines.length && lines[i].trim() && (paragraph.length === 0 || !isBlockStart(i))) {
      paragraph.push(lines[i]);
      i += 1;
    }
    html.push(`<p>${renderLines(paragraph, sink)}</p>`);
  }
  return html.join("");
}

// Render untrusted Markdown. Returns { html, links } where links holds every
// http(s) URL in display order as the exact original substring.
export function renderMarkdown(markdown) {
  const sink = createLinkSink();
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  const html = renderBlocks(lines, sink);
  return { html, links: sink.links };
}

// The exact-byte link list without rendering, for callers that only copy.
export function extractLinks(markdown) {
  return renderMarkdown(markdown).links;
}

// The exact clipboard payload for "Copy all links": one URL per line in
// display order, no labels and no trailing newline.
export function copyAllPayload(links) {
  return links.join("\n");
}
