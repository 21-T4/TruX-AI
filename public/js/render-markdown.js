/* Markdown renderer and clipboard copy. */
function renderFormattedText(t, allowOpenFence) {
  if (t === null || t === undefined || t === "") return "";

  let src = String(t).replace(/\r\n/g, "\n");
  let cards = [];
  if (!src.includes("```") && isTruxDiagram("", src)) return buildTruxDiagramCard(src, false);

  src = src.replace(/```([\w+#.-]*)[ \t]*\n?([\s\S]*?)```/g, (m, lang, code) => {
    cards.push(isTruxDiagram(lang, code) ? buildTruxDiagramCard(code, false) : buildCodeCard(lang, code, false));
    return `\n\n\u0000F${cards.length - 1}\u0000\n\n`;
  });

  // A single unterminated fence left over (streaming in progress).
  let openFence = src.indexOf("```");
  if (openFence !== -1) {
    let rest = src.slice(openFence + 3);
    let nl = rest.indexOf("\n");
    let lang = (nl === -1 ? rest : rest.slice(0, nl)).trim();
    let code = nl === -1 ? "" : rest.slice(nl + 1);
    cards.push(isTruxDiagram(lang, code) ? buildTruxDiagramCard(code, true) : buildCodeCard(lang, code, !!allowOpenFence));
    src = src.slice(0, openFence) + `\n\n\u0000F${cards.length - 1}\u0000\n`;
  }

  // Only the non-code Markdown stream is protected.
  const mathSegments = [];
  src = protectTruxMathSegments(src, mathSegments);

  let lines = src.split("\n");
  let out = [];
  let para = [];
  let quote = [];
  let list = null;

  function flushPara() {
    if (!para.length) return;
    out.push(`<p>${renderInline(escapeHtml(para.join("\n"))).replace(/\n/g, "<br>")}</p>`);
    para = [];
  }
  function flushQuote() {
    if (!quote.length) return;
    out.push(`<blockquote><p>${renderInline(escapeHtml(quote.join("\n"))).replace(/\n/g, "<br>")}</p></blockquote>`);
    quote = [];
  }
  function flushList() {
    if (!list) return;
    out.push(buildList(list.items, list.ordered));
    list = null;
  }
  function flushAll() { flushPara(); flushQuote(); flushList(); }

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    let trimmed = line.trim();

    // code-file placeholder
    let ph = trimmed.match(/^\u0000F(\d+)\u0000$/);
    if (ph) { flushAll(); out.push(cards[Number(ph[1])] || ""); continue; }

    if (!trimmed) { flushAll(); continue; }

    // horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { flushAll(); out.push("<hr>"); continue; }

    // heading
    let h = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushAll();
      let level = Math.min(h[1].length, 4);
      out.push(`<h${level}>${renderInline(escapeHtml(h[2].replace(/\s*#+\s*$/, "")))}</h${level}>`);
      continue;
    }

    // table: header row followed by an alignment row
    if (trimmed.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushAll();
      let body = [];
      let j = i + 2;
      while (j < lines.length && lines[j].trim().includes("|") && lines[j].trim()) {
        body.push(lines[j]);
        j++;
      }
      out.push(buildTable(trimmed, lines[i + 1], body));
      i = j - 1;
      continue;
    }

    // blockquote
    if (/^>\s?/.test(trimmed)) {
      flushPara(); flushList();
      quote.push(trimmed.replace(/^>\s?/, ""));
      continue;
    }
    flushQuote();

    // list items
    let indent = line.match(/^\s*/)[0].replace(/\t/g, "  ").length;
    let ul = trimmed.match(/^[-*+]\s+(.*)$/);
    let ol = trimmed.match(/^(\d+)[.)]\s+(.*)$/);

    if (ul || ol) {
      flushPara();
      let ordered = !!ol;
      let text = ul ? ul[1] : ol[2];
      // An indented item of the OTHER marker type is a nested list, not a
      // new one — flushing there used to restart "1." after the sublist.
      let isNested = list && indent > list.baseIndent + 1;
      if (list && list.ordered !== ordered && !isNested) flushList();
      if (!list) list = { ordered, baseIndent: indent, items: [] };
      list.items.push({ indent, text, ordered });
      continue;
    }

    // continuation of the previous list item
    if (list && indent >= 2) {
      list.items[list.items.length - 1].text += " " + trimmed;
      continue;
    }
    flushList();

    para.push(trimmed);
  }

  flushAll();
  return restoreTruxMathSegments(out.join(""), mathSegments);
}

function copyTextMessage(txt, btn) {
  navigator.clipboard.writeText(txt).then(() => {
    let prev = btn.innerHTML;
    btn.classList.add("done");
    btn.innerHTML = ICON.check + "Copied";
    setTimeout(() => { btn.innerHTML = prev; btn.classList.remove("done"); }, 1500);
  }).catch(() => toast("Clipboard unavailable.", "err"));
}
