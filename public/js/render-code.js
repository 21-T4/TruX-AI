/* Code blocks: escaping, copy/download, highlighting. */
function escapeHtml(t) { return String(t).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;"); }
function copyCodeToClipboard(b, id) { let e = getEl(id); if(e) navigator.clipboard.writeText(e.value).then(() => { let x = b.innerText; b.innerText = "Copied ✓"; setTimeout(() => b.innerText = x, 1500); }); }
function downloadCode(id, filename) {
  let e = getEl(id); if(!e) return;
  let url = URL.createObjectURL(new Blob([e.value], { type: "text/plain;charset=utf-8" }));
  let a = document.createElement("a"); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
function codeFileExtension(language) {
  let map = { javascript: "js", js: "js", typescript: "ts", ts: "ts", html: "html", css: "css", json: "json", python: "py", java: "java", c: "c", cpp: "cpp", csharp: "cs", sql: "sql", bash: "sh", shell: "sh", markdown: "md", md: "md", xml: "xml", yaml: "yml", yml: "yml" };
  return map[String(language || "").toLowerCase()] || "txt";
}

/* =====================================================================
   MARKDOWN RENDERER
   Full block-level markdown: tables, headings, lists, quotes, rules,
   links and code files. The old renderer only understood bold/italic
   and code fences, which is exactly why tables came out as raw pipes.
   ===================================================================== */

/* Lightweight, dependency-free tokeniser. Runs over ALREADY-escaped text
   in a single pass, so no span it emits can be re-matched. */
const CODE_KEYWORDS = ("abstract as async await bool break case catch class const constructor continue "
  + "def default del delete do double elif else end enum except export extends false final finally float fn for "
  + "from func function global go if impl implements import in instanceof int interface is lambda let match mod "
  + "mut new nil none not null or package pass print private protected public raise range record return self "
  + "static str struct super switch template then this throw throws trait true try type typeof undefined union "
  + "unless until use var void when where while with yield and True False None NaN NULL Boolean String Number").split(" ");

function highlightCode(escaped) {
  const kw = new RegExp("\\b(?:" + CODE_KEYWORDS.join("|") + ")\\b", "g");
  const re = new RegExp([
    "(&quot;(?:[^&\\n]|&(?!quot;))*&quot;|&#039;(?:[^&\\n]|&(?!#039;))*&#039;|`(?:[^`\\\\]|\\\\.)*`)",
    "((?<![\\w&;:])#[^\\n]*|(?<![:\\w])\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/|(?<![\\w-])--(?=\\s)[^\\n]*)",
    "(@[A-Za-z_]\\w*)",
    "\\b(\\d[\\d_]*(?:\\.\\d+)?)\\b",
    "([A-Za-z_]\\w*)(?=\\()"
  ].join("|"), "g");

  return escaped.replace(re, (m, str, com, dec, num, fn) => {
    if(str) return '<span class="tk-str">' + str + '</span>';
    if(com) return '<span class="tk-com">' + com + '</span>';
    if(dec) return '<span class="tk-dec">' + dec + '</span>';
    if(num) return '<span class="tk-num">' + num + '</span>';
    if(fn)  return kw.test(fn) ? '<span class="tk-key">' + fn + '</span>'
                               : '<span class="tk-fn">' + fn + '</span>';
    return m;
  }).replace(/(<span[^>]*>[\s\S]*?<\/span>)|([A-Za-z_]\w*)/g, (m, span, word) => {
    if(span) return span;
    return CODE_KEYWORDS.indexOf(word) > -1 ? '<span class="tk-key">' + word + '</span>' : word;
  });
}

function toggleCodeCard(btn) {
  let card = btn.closest(".code-file");
  if(!card) return;
  let open = card.classList.toggle("collapsed");
  btn.querySelector("span").textContent = open ? ("Show all " + btn.dataset.lines + " lines") : "Collapse";
}

function buildCodeCard(lang, rawCode, isWriting) {
  let id = `code_${++codeBlockCounter}_${Math.random().toString(36).slice(2, 8)}`;
  let code = String(rawCode).replace(/\s+$/, "");
  let displayLang = (lang || "text").toLowerCase();
  let extension = codeFileExtension(lang);
  let filename = `trux-omni-output.${extension}`;
  let lineCount = code ? code.split("\n").length : 0;
  let runnable = (extension === "html" || extension === "js");

  let body = `<div class="code-body"><pre><code>${highlightCode(escapeHtml(code))}</code></pre></div>`;

  if (isWriting) {
    return `<div class="code-file writing"><div class="code-file-header"><div class="code-file-info">` +
      `<span class="code-file-icon">&lt;/&gt;</span><div class="code-file-meta"><b>${escapeHtml(filename)}</b>` +
      `<small>${escapeHtml(displayLang.toUpperCase())} · writing ${lineCount} lines…</small></div></div></div>` +
      body + `</div>`;
  }

  // Long files start folded so a single answer never buries the thread.
  let folded = lineCount > 18;
  let expander = folded
    ? `<button type="button" class="code-expand" data-lines="${lineCount}" onclick="toggleCodeCard(this)">` +
      `<svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg><span>Show all ${lineCount} lines</span></button>`
    : ``;

  return `<div class="code-file${folded ? " collapsed" : ""}"><div class="code-file-header"><div class="code-file-info">` +
    `<span class="code-file-icon">&lt;/&gt;</span><div class="code-file-meta"><b>${escapeHtml(filename)}</b>` +
    `<small>${escapeHtml(displayLang.toUpperCase())} · ${lineCount} Lines</small></div></div>` +
    `<div class="code-actions">` +
    (runnable ? `<button type="button" onclick="openCodeSandbox('${id}','${extension}')"><svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l11-6.5-11-6.5Z"/></svg>Run</button>` : ``) +
    `<button type="button" onclick="copyCodeToClipboard(this,'${id}')">Copy</button>` +
    `<button type="button" onclick="downloadCode('${id}','${filename}')">Download</button>` +
    `</div></div>` + body +
    `<textarea id="${id}" hidden>${escapeHtml(code)}</textarea>` + expander +
    `</div>`;
}

/* ============================================================
   ROBUST LATEX PROTECTION
   Keep LaTeX expressions intact while Markdown is converted.
   This avoids losing multiline/long equations when paragraphs are
   split or <br> tags are inserted before KaTeX runs.
   ============================================================ */
