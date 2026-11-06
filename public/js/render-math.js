/* Math (KaTeX) protection and rendering, list building. */
function protectTruxMathSegments(source, segments) {
  const s = String(source);
  let out = "";
  let i = 0;

  function isBoundaryChar(ch) {
    return !ch || " \t\n,.;:!?()[]{}+-=*/^=|".includes(ch);
  }

  function add(raw) {
    const token = "\uE000TRUXMATH" + segments.length + "\uE001";
    segments.push(String(raw));
    return token;
  }

  while (i < s.length) {
    // Display math must be checked before single-dollar inline math.
    if (s.startsWith("$$", i)) {
      const end = s.indexOf("$$", i + 2);
      if (end !== -1) {
        const finish = end + 2;
        out += add(s.slice(i, finish));
        i = finish;
        continue;
      }
    }

    // TeX display and inline delimiters.
    if (s.startsWith("\\[", i)) {
      const end = s.indexOf("\\]", i + 2);
      if (end !== -1) {
        const finish = end + 2;
        out += add(s.slice(i, finish));
        i = finish;
        continue;
      }
    }
    if (s.startsWith("\\(", i)) {
      const end = s.indexOf("\\)", i + 2);
      if (end !== -1) {
        const finish = end + 2;
        out += add(s.slice(i, finish));
        i = finish;
        continue;
      }
    }

    // Single-dollar inline TeX: never cross a line or consume the
    // character after the closing delimiter. Leave plain currency alone.
    if (s[i] === "$" && s[i + 1] !== "$" && (i === 0 || s[i - 1] !== "\\")) {
      let end = i + 1;
      while (end < s.length) {
        if (s[end] === "\n") {
          end = -1;
          break;
        }
        if (s[end] === "$" && s[end - 1] !== "\\" && s[end + 1] !== "$") break;
        end++;
      }

      if (end > i + 1 && end < s.length) {
        const body = s.slice(i + 1, end);
        const before = i > 0 ? s[i - 1] : "";
        const after = end + 1 < s.length ? s[end + 1] : "";
        const hasMathSyntax = /\\[A-Za-z]+|[=+\-*\/^_{}]/.test(body);
        const looksLikeCurrency = /^\s*\d[\d,.]*\s*(?:USD|INR|EUR|GBP|CAD|AUD|Rs\.?|₹)\s*$/i.test(body) ||
          /^\s*\d[\d,.]*\s+[A-Za-z]{2,}(?:\s+[A-Za-z]{2,})*\s*$/.test(body);

        if ((!looksLikeCurrency || hasMathSyntax) &&
            (isBoundaryChar(before) || before === "") &&
            (isBoundaryChar(after) || after === "")) {
          const finish = end + 1;
          out += add(s.slice(i, finish));
          i = finish;
          continue;
        }
      }
    }

    out += s[i];
    i++;
  }
  return out;
}

function restoreTruxMathSegments(html, segments) {
  let out = String(html);
  segments.forEach((raw, index) => {
    const token = "\uE000TRUXMATH" + index + "\uE001";
    out = out.split(token).join(escapeHtml(raw));
  });
  return out;
}

/* ============================================================
   KATEX MATH RENDERING
   The API may emit Markdown plus TeX; render TeX in-browser.
   ============================================================ */
const TRUX_MATH_OPTIONS = {
  delimiters: [
    { left: "$$", right: "$$", display: true },
    { left: "\\[", right: "\\]", display: true },
    { left: "\\(", right: "\\)", display: false },
    { left: "$", right: "$", display: false }
  ],
  throwOnError: false,
  strict: false,
  ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code", "option"]
};

function renderTruxMath(root) {
  if (!root || typeof window.renderMathInElement !== "function") return;
  try {
    window.renderMathInElement(root, TRUX_MATH_OPTIONS);
  } catch (err) {
    console.warn("TruX math render skipped:", err);
  }
}

function scheduleTruxMath(root) {
  if (!root) return;
  requestAnimationFrame(() => requestAnimationFrame(() => renderTruxMath(root)));
  // Streaming HTML can settle a frame late, so use one bounded final pass.
  setTimeout(() => { if (root.isConnected) renderTruxMath(root); }, 140);
}

function renderInline(escaped) {
  let codeSpans = [];
  let s = String(escaped);

  // `code` — pulled out first so nothing else mangles its contents.
  s = s.replace(/`([^`\n]+)`/g, (m, c) => {
    codeSpans.push(`<code>${c}</code>`);
    return `\u0000C${codeSpans.length - 1}\u0000`;
  });

  // [label](url) and bare urls
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (m, label, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`);
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g,
    (m, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);

  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, "<b><em>$1</em></b>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/(^|[^\w*])\*([^*\n]+)\*(?=[^\w*]|$)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^\w_])_([^_\n]+)_(?=[^\w_]|$)/g, "$1<em>$2</em>");

  return s.replace(/\u0000C(\d+)\u0000/g, (m, i) => codeSpans[Number(i)] || "");
}

function isTableSeparator(line) {
  return /^\s*\|?[\s]*:?-{2,}:?[\s]*(\|[\s]*:?-{2,}:?[\s]*)*\|?\s*$/.test(line) && line.includes("-");
}

function splitTableRow(line) {
  let s = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  let cells = [], cur = "";
  for (let i = 0; i < s.length; i++) {
    let ch = s[i];

    // A backslash only escapes a pipe in Markdown table syntax.
    // Preserve all other backslashes so LaTeX such as \\frac, \\sqrt,
    // \\alpha, etc. survives intact inside table cells.
    if (ch === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }

    if (ch === "|") {
      cells.push(cur);
      cur = "";
      continue;
    }

    cur += ch;
  }
  cells.push(cur);
  return cells.map(c => c.trim());
}

function buildTable(headerLine, alignLine, bodyLines) {
  let heads = splitTableRow(headerLine);
  let aligns = splitTableRow(alignLine).map(a => {
    let left = a.startsWith(":"), right = a.endsWith(":");
    if (left && right) return "col-center";
    if (right) return "col-right";
    return "";
  });

  let thead = "<tr>" + heads.map((h, i) =>
    `<th class="${aligns[i] || ""}">${renderInline(escapeHtml(h))}</th>`).join("") + "</tr>";

  let tbody = bodyLines.map(line => {
    let cells = splitTableRow(line);
    while (cells.length < heads.length) cells.push("");
    return "<tr>" + cells.slice(0, heads.length).map((c, i) =>
      `<td class="${aligns[i] || ""}">${renderInline(escapeHtml(c))}</td>`).join("") + "</tr>";
  }).join("");

  return `<div class="table-wrap"><table class="md-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table></div>`;
}

function buildList(items, ordered) {
  // items: [{ indent, text, ordered }] — supports one level of nesting,
  // and the nested level may use a different marker type than its parent.
  let baseIndent = Math.min(...items.map(i => i.indent));
  let openTag = ordered ? "<ol>" : "<ul>";
  let closeTag = ordered ? "</ol>" : "</ul>";

  let html = openTag;
  let nestClose = null;   // closing tag of the open nested list, if any
  let liOpen = false;     // the parent <li> holding it is still unclosed

  items.forEach(item => {
    let nested = item.indent > baseIndent + 1;
    let li = `<li>${renderInline(escapeHtml(item.text))}`;

    if (nested) {
      // Nested lists must live INSIDE the preceding <li> to be valid HTML.
      let nOpen = item.ordered ? "<ol>" : "<ul>";
      let nClose = item.ordered ? "</ol>" : "</ul>";
      if (nestClose && nestClose !== nClose) { html += nestClose; nestClose = null; }
      if (!nestClose) { html += nOpen; nestClose = nClose; }
      html += li + "</li>";
    } else {
      if (nestClose) { html += nestClose; nestClose = null; }
      if (liOpen) { html += "</li>"; liOpen = false; }
      html += li;
      liOpen = true;
    }
  });

  if (nestClose) html += nestClose;
  if (liOpen) html += "</li>";
  return html + closeTag;
}

let truxMermaidRenderSequence = 0;
let truxMermaidRenderQueue = Promise.resolve();
let truxMermaidFallbackPromise = null;

function normalizeTruxMermaidSource(raw){
  let source=String(raw||"").replace(/^\uFEFF/,"").replace(/\r\n?/g,"\n")
    .replace(/[\u2018\u2019\u201A\u201B]/g,"'")
    .replace(/[\u201C\u201D\u201E\u201F]/g,'"').trim();
  const fence = String.fromCharCode(96).repeat(3);
  source=source.replace(new RegExp("^\\s*"+fence+"(?:[\\w+#.-]+)?[ \\t]*\\n?","i"),"").replace(new RegExp("\\n?\\s*"+fence+"\\s*$"),"").trim();
  source=source.replace(/&nbsp;/gi," ").replace(/<br\s*\/?\s*>/gi," ");
  const lines=source.split("\n");
  const first=lines.findIndex(line=>/^\s*(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|mindmap|timeline|quadrantChart|xychart-beta|block-beta|architecture-beta|gitGraph|sankey-beta|zenuml|requirementDiagram)\b/i.test(line));
  if(first>0) source=lines.slice(first).join("\n");
  return source.trim();
}
function repairTruxMermaidSource(raw){
  let source=normalizeTruxMermaidSource(raw);
  if(!/^(?:flowchart|graph)\b/i.test(source))return source;
  // Recover common model-generated flowchart slips without changing valid edge syntax.
  source=source.replace(/^(\s*(?:flowchart|graph))\s*$/im,"$1 TD");
  source=source.replace(/(?<![-.])-(?![-.])>/g,"-->");
  source=source.split("\n").map(line=>line.replace(
    /^(\s*[A-Za-z_][\w-]*\s*)\[([^\]\n]*)\](.*)$/,
    (whole,id,label,tail)=>{
      const value=label.trim();
      const alreadyQuoted=/^(?:"(?:\\.|[^"\\\\])*"|'(?:\\.|[^'\\\\])*'|`[^`]*`)$/.test(value);
      return /[():,;|{}]/.test(value)&&!alreadyQuoted
        ? id+"["+JSON.stringify(value)+"]"+tail : whole;
    }
  )).join("\n");
  return source;
}
