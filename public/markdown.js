export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function safeLink(value) {
  if (/[\u0000-\u0020\u007f-\u009f]/u.test(value) || !URL.canParse(value, "https://memory.invalid/")) return false;
  const url = new URL(value, "https://memory.invalid/");
  return ["https:", "http:", "mailto:"].includes(url.protocol);
}

function emphasis(text) {
  return escapeHtml(text)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s.,!?):])/g, "$1<em>$2</em>")
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
}

function inline(text) {
  // Only these two token types generate attributes; all other input is escaped.
  const pattern = /`([^`\n]+)`|\[([^\]\n]+)\]\(([^()\s]*(?:\([^()\s]*\)[^()\s]*)*)\)/g;
  let html = "";
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    html += emphasis(text.slice(cursor, match.index));
    if (match[1] !== undefined) {
      html += `<code>${escapeHtml(match[1])}</code>`;
    } else if (safeLink(match[3])) {
      html += `<a href="${escapeHtml(match[3])}" target="_blank" rel="noopener noreferrer">${emphasis(match[2])}</a>`;
    } else {
      html += emphasis(match[2]);
    }
    cursor = match.index + match[0].length;
  }
  return html + emphasis(text.slice(cursor));
}

export function renderMarkdown(value) {
  const lines = String(value ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let paragraph = [];
  let list = [];
  let listType = "";
  let code = null;
  let fenceLength = 0;
  const flushParagraph = () => {
    if (paragraph.length) blocks.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list.length) blocks.push(`<${listType}>${list.map((line) => `<li>${inline(line)}</li>`).join("")}</${listType}>`);
    list = [];
    listType = "";
  };
  for (const line of lines) {
    const fence = line.match(/^\s{0,3}(`{3,})(.*)$/);
    if (code !== null) {
      if (fence && fence[1].length >= fenceLength && !fence[2].trim()) {
        blocks.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
        code = null;
      } else {
        code.push(line);
      }
      continue;
    }
    if (fence) {
      flushParagraph();
      flushList();
      code = [];
      fenceLength = fence[1].length;
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    const item = line.match(/^\s{0,3}([-+*]|\d+\.)\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(6, heading[1].length + 1);
      blocks.push(`<h${level}>${inline(heading[2])}</h${level}>`);
    } else if (item) {
      flushParagraph();
      const type = /^\d/.test(item[1]) ? "ol" : "ul";
      if (listType && listType !== type) flushList();
      listType = type;
      list.push(item[2]);
    } else if (/^>\s?/.test(line)) {
      flushParagraph();
      flushList();
      blocks.push(`<blockquote><p>${inline(line.replace(/^>\s?/, ""))}</p></blockquote>`);
    } else if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) {
      flushParagraph();
      flushList();
      blocks.push("<hr>");
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();
  if (code !== null) blocks.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
  return blocks.join("\n");
}
