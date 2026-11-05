/**
 * An escaping-first Markdown renderer. Raw HTML is always escaped; only the
 * renderer's own tags and http(s) links survive. Inline formatting runs on
 * already-escaped text so code spans and emphasis cannot double-escape.
 */

export const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));

/** Strip sentence punctuation from the end of an autolinked URL. */
function cleanLinkHref(href) {
  let url = String(href ?? "");
  let changed = true;
  while (changed && url) {
    changed = false;
    if (/[.,;:!?]+$/.test(url)) {
      url = url.replace(/[.,;:!?]+$/, "");
      changed = true;
      continue;
    }
    const last = url.slice(-1);
    if (last === ")" || last === "]") {
      const open = last === ")" ? "(" : "[";
      const opens = url.split(open).length - 1;
      const closes = url.split(last).length - 1;
      if (closes > opens) {
        url = url.slice(0, -1);
        changed = true;
      }
    }
  }
  return url;
}

function inline(escaped) {
  const codes = [];
  let text = escaped.replace(/`([^`\n]+)`/g, (_match, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  text = text
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label, href) => {
      const url = cleanLinkHref(href);
      const tail = href.slice(url.length);
      return `<a href="${url}" target="_blank" rel="noreferrer noopener">${label}</a>${tail}`;
    })
    .replace(/(^|[\s(])(https?:\/\/[^\s)<]+)/g, (_match, prefix, href) => {
      const url = cleanLinkHref(href);
      const tail = href.slice(url.length);
      return `${prefix}<a href="${url}" target="_blank" rel="noreferrer noopener">${url}</a>${tail}`;
    })
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,])/g, "$1<em>$2</em>");
  return text.replace(/\u0000(\d+)\u0000/g, (match, index) => (index in codes ? `<code>${codes[Number(index)]}</code>` : match));
}

function isTableDivider(line) {
  const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

function renderTable(headerLine, rows) {
  const split = (line) => line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
  const headers = split(headerLine);
  const aligns = split(rows[0]).map((cell) => {
    if (/^:.*:$/.test(cell)) return ' data-align="center"';
    if (/.*:$/.test(cell)) return ' data-align="right"';
    if (/^:/.test(cell)) return ' data-align="left"';
    return "";
  });
  const head = `<tr>${headers.map((cell, index) => `<th${aligns[index] ?? ""}>${inline(escapeHtml(cell)) || ""}</th>`).join("")}</tr>`;
  const body = rows.slice(1).map((line) => {
    const cells = split(line);
    return `<tr>${headers.map((_, index) => `<td${aligns[index] ?? ""}>${inline(escapeHtml(cells[index] ?? ""))}</td>`).join("")}</tr>`;
  }).join("");
  return `<table>${head}${body ? `<tbody>${body}</tbody>` : ""}</table>`;
}

/** Extract <think> blocks so streamed reasoning never leaks into the answer. */
export function extractThinking(input) {
  const text = String(input ?? "");
  let thinking = "";
  const visible = text.replace(/<(?:think|thinking|reasoning)[^>]*>([\s\S]*?)(?:<\/(?:think|thinking|reasoning)>|$)/gi, (_match, inner) => {
    thinking += (thinking ? "\n\n" : "") + String(inner ?? "").trim();
    return "";
  });
  const trimmed = visible.trim();
  return { thinking: thinking.trim(), visible: trimmed ? trimmed : (thinking ? "" : text) };
}

export function renderMarkdown(input) {
  // Thinking traces render separately; never leak them into the answer body.
  const cleaned = String(input ?? "").replace(/<(?:think|thinking|reasoning)[^>]*>[\s\S]*?(?:<\/(?:think|thinking|reasoning)>|$)/gi, "");
  const lines = cleaned.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let fence = null;
  let list = null;

  const renderItem = (item) => {
    const task = item.match(/^\[([ xX])\]\s+(.*)$/);
    if (task) {
      const checked = task[1].toLowerCase() === "x" ? " checked disabled" : " disabled";
      return `<li class="task"><input type="checkbox"${checked}>${inline(escapeHtml(task[2]))}</li>`;
    }
    return `<li>${inline(escapeHtml(item))}</li>`;
  };

  const flushList = () => {
    if (!list) return;
    out.push(`<${list.tag}>${list.items.map(renderItem).join("")}</${list.tag}>`);
    list = null;
  };

  const fenceLang = { value: "" };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (fence !== null) {
      if (/^```\s*$/.test(line.trim())) {
        const label = fenceLang.value ? `<span class="code-lang">${escapeHtml(fenceLang.value)}</span>` : "";
        out.push(`<pre>${label}<code>${escapeHtml(fence.join("\n"))}</code></pre>`);
        fence = null;
        fenceLang.value = "";
      } else {
        fence.push(line);
      }
      continue;
    }
    if (line.trim().startsWith("```")) {
      flushList();
      fence = [];
      fenceLang.value = line.trim().slice(3).trim().split(/\s+/)[0] ?? "";
      continue;
    }
    // GFM tables: header | divider | rows.
    if (line.includes("|") && index + 1 < lines.length && isTableDivider(lines[index + 1])) {
      flushList();
      const rows = [lines[index + 1]];
      let cursor = index + 2;
      while (cursor < lines.length && lines[cursor].includes("|") && lines[cursor].trim()) {
        rows.push(lines[cursor]);
        cursor += 1;
      }
      out.push(renderTable(line, rows));
      index = cursor - 1;
      continue;
    }
    if (!line.trim()) {
      flushList();
      continue;
    }
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      flushList();
      out.push("<hr>");
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushList();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(escapeHtml(heading[2]))}</h${level}>`);
      continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flushList();
      out.push(`<blockquote>${inline(escapeHtml(quote[1]))}</blockquote>`);
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) {
      if (!list || list.tag !== "ul") {
        flushList();
        list = { tag: "ul", items: [] };
      }
      list.items.push(bullet[1]);
      continue;
    }
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ordered) {
      if (!list || list.tag !== "ol") {
        flushList();
        list = { tag: "ol", items: [] };
      }
      list.items.push(ordered[1]);
      continue;
    }
    flushList();
    out.push(`<p>${inline(escapeHtml(line))}</p>`);
  }
  flushList();
  if (fence !== null) {
    const label = fenceLang.value ? `<span class="code-lang">${escapeHtml(fenceLang.value)}</span>` : "";
    out.push(`<pre>${label}<code>${escapeHtml(fence.join("\n"))}</code></pre>`);
  }
  return out.join("\n");
}
