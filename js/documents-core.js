/*
 * Pure logic for the Document Converters page. No DOM access at load time.
 * Library dependencies (docx, Turndown) are injected so Node tests run without them.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DocumentsCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------- Slugs, headings, TOC ----------

  function slugify(text, used) {
    let slug = String(text == null ? "" : text)
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/[\s-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "section";
    if (used) {
      const base = slug;
      let n = 1;
      while (used.has(slug)) slug = `${base}-${++n}`;
      used.add(slug);
    }
    return slug;
  }

  function stripInlineMarkdown(text) {
    return String(text)
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/(\*\*|__|\*|_|~~|`)/g, "")
      .replace(/<[^>]+>/g, "")
      .trim();
  }

  /** ATX/setext headings from Markdown source, ignoring fenced code. Returns [{level, text, slug}]. */
  function extractHeadings(md) {
    const lines = String(md || "").split(/\r?\n/);
    const used = new Set();
    const out = [];
    let fence = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const f = line.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (f) {
        if (!fence) fence = f[1][0];
        else if (f[1][0] === fence) fence = null;
        continue;
      }
      if (fence) continue;
      const atx = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (atx) {
        const text = stripInlineMarkdown(atx[2]);
        out.push({ level: atx[1].length, text, slug: slugify(text, used) });
        continue;
      }
      const next = lines[i + 1];
      if (next && line.trim() && /^\s{0,3}(=+|-+)\s*$/.test(next) && !/^\s*([-*+]|\d+[.)])\s/.test(line) && !/^\s*>/.test(line)) {
        const text = stripInlineMarkdown(line);
        out.push({ level: /=/.test(next) ? 1 : 2, text, slug: slugify(text, used) });
        i++;
      }
    }
    return out;
  }

  function escapeHtml(v) {
    return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /** Nested <ul> table of contents from headings. */
  function buildToc(headings, opts) {
    const o = Object.assign({ minLevel: 1, maxLevel: 3 }, opts);
    const items = (headings || []).filter((h) => h.level >= o.minLevel && h.level <= o.maxLevel);
    if (!items.length) return "";
    let html = "";
    const stack = [];
    for (const h of items) {
      const level = h.level;
      if (!stack.length) {
        html += "<ul>";
        stack.push(level);
      } else if (level > stack[stack.length - 1]) {
        html += "<ul>";
        stack.push(level);
      } else {
        html += "</li>";
        while (stack.length > 1 && level < stack[stack.length - 1]) {
          stack.pop();
          html += "</ul></li>";
        }
      }
      html += `<li><a href="#${escapeHtml(h.slug)}">${escapeHtml(h.text)}</a>`;
    }
    while (stack.length) {
      html += "</li></ul>";
      stack.pop();
    }
    return `<nav class="toc" aria-label="Table of contents"><p class="toc-title">Contents</p>${html}</nav>`;
  }

  // ---------- Standalone HTML document ----------

  const DOC_CSS = `:root{color-scheme:light}
body{max-width:48rem;margin:2rem auto;padding:0 1rem;font:16px/1.65 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1f2328;background:#fff}
h1,h2,h3,h4,h5,h6{line-height:1.25;margin:1.6em 0 .6em}
h1,h2{border-bottom:1px solid #d8dee4;padding-bottom:.3em}
a{color:#0b5fff}
code{font:.9em ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#f3f4f6;padding:.15em .35em;border-radius:4px}
pre{background:#f6f8fa;padding:1em;overflow:auto;border-radius:6px}
pre code{background:none;padding:0}
blockquote{margin:1em 0;padding:.2em 1em;border-left:4px solid #d0d7de;color:#57606a}
table{border-collapse:collapse;margin:1em 0;max-width:100%;display:block;overflow:auto}
th,td{border:1px solid #d0d7de;padding:6px 12px}
th{background:#f6f8fa}
img{max-width:100%}
hr{border:0;border-top:1px solid #d8dee4;margin:2em 0}
.toc{background:#f6f8fa;border:1px solid #d8dee4;border-radius:6px;padding:.5em 1.25em;margin:1.5em 0}
.toc-title{font-weight:700;margin:.4em 0}
.toc ul{margin:.2em 0;padding-left:1.2em}`;

  /** bodyHtml must already be sanitized. */
  function buildHtmlDocument(bodyHtml, opts) {
    const o = Object.assign({ title: "Document", css: DOC_CSS, tocHtml: "", lang: "en" }, opts);
    return `<!doctype html>\n<html lang="${escapeHtml(o.lang)}">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${escapeHtml(o.title)}</title>\n<style>\n${o.css}\n</style>\n</head>\n<body>\n<main>\n${o.tocHtml}\n${bodyHtml}\n</main>\n</body>\n</html>\n`;
  }

  // ---------- Case converters ----------

  function words(text) {
    return String(text == null ? "" : text)
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[^A-Za-z0-9À-ɏ]+/)
      .filter(Boolean);
  }
  const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  const SMALL = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "in", "nor", "of", "on", "or", "per", "the", "to", "via", "vs"]);

  const toUpper = (t) => String(t).toUpperCase();
  const toLower = (t) => String(t).toLowerCase();
  function toTitle(t) {
    let first = true;
    return String(t).toLowerCase().replace(/[A-Za-zÀ-ɏ][A-Za-zÀ-ɏ']*/g, (w, offset) => {
      const lead = first;
      first = false;
      return !lead && SMALL.has(w) ? w : cap(w);
    });
  }
  function toSentence(t) {
    return String(t).toLowerCase().replace(/(^\s*|[.!?]\s+|\n\s*)([a-zà-ɏ])/g, (m, pre, ch) => pre + ch.toUpperCase());
  }
  function toCamel(t) {
    return words(t).map((w, i) => (i === 0 ? w.toLowerCase() : cap(w))).join("");
  }
  const toPascal = (t) => words(t).map(cap).join("");
  const toSnake = (t) => words(t).map((w) => w.toLowerCase()).join("_");
  const toKebab = (t) => words(t).map((w) => w.toLowerCase()).join("-");

  const CASE_MODES = { upper: toUpper, lower: toLower, title: toTitle, sentence: toSentence, camel: toCamel, pascal: toPascal, snake: toSnake, kebab: toKebab };

  /** Word-style modes (camel/snake/kebab/pascal) convert each line separately so multi-line input survives. */
  function convertCase(text, mode) {
    const fn = CASE_MODES[mode];
    if (!fn) throw new Error(`Unknown case mode: ${mode}`);
    if (["camel", "pascal", "snake", "kebab"].includes(mode)) return String(text).split(/\r?\n/).map(fn).join("\n");
    return fn(text);
  }

  // ---------- Line utilities ----------

  const splitLines = (t) => String(t == null ? "" : t).split(/\r?\n/);

  function dedupeLines(text, opts) {
    const o = Object.assign({ ignoreCase: false, trim: false, keepEmpty: true }, opts);
    const seen = new Set();
    return splitLines(text).filter((line) => {
      if (line === "" && o.keepEmpty) return true;
      let key = o.trim ? line.trim() : line;
      if (o.ignoreCase) key = key.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).join("\n");
  }

  function sortLines(text, opts) {
    const o = Object.assign({ order: "asc", numeric: false, ignoreCase: false }, opts);
    const lines = splitLines(text);
    const cmp = new Intl.Collator(undefined, { numeric: o.numeric, sensitivity: o.ignoreCase ? "base" : "variant" }).compare;
    lines.sort(cmp);
    if (o.order === "desc") lines.reverse();
    return lines.join("\n");
  }

  function trimWhitespace(text, opts) {
    const o = Object.assign({ collapse: false, removeEmpty: false }, opts);
    let lines = splitLines(text).map((l) => {
      const t = l.trim();
      return o.collapse ? t.replace(/[ \t]+/g, " ") : t;
    });
    if (o.removeEmpty) lines = lines.filter(Boolean);
    return lines.join("\n");
  }

  function countText(text) {
    const s = String(text == null ? "" : text);
    const w = s.trim() ? s.trim().split(/\s+/).length : 0;
    return {
      words: w,
      characters: s.length,
      charactersNoSpaces: s.replace(/\s/g, "").length,
      lines: s === "" ? 0 : splitLines(s).length,
      sentences: (s.match(/[^.!?]+[.!?]+(\s|$)/g) || []).length || (w ? 1 : 0),
      readingMinutes: w ? Math.max(1, Math.ceil(w / 225)) : 0,
    };
  }

  // ---------- Encoders ----------

  function bytesToBinary(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return bin;
  }
  function base64Encode(text) {
    return btoa(bytesToBinary(new TextEncoder().encode(String(text))));
  }
  function base64Decode(b64) {
    const clean = String(b64).replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(clean + "=".repeat((4 - (clean.length % 4)) % 4));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  const urlEncode = (t) => encodeURIComponent(String(t));
  const urlDecode = (t) => decodeURIComponent(String(t).replace(/\+/g, " "));

  // ---------- PDF text reconstruction ----------

  /**
   * items: pdf.js text items { str, transform: [a,b,c,d,x,y], width?, height? }.
   * Groups by baseline y (within tolerance), sorts each line by x, inserts spaces for visible gaps.
   */
  function itemsToLines(items, opts) {
    const o = Object.assign({ yTolerance: 3 }, opts);
    const valid = (items || []).filter((it) => it && typeof it.str === "string" && it.str !== "" && Array.isArray(it.transform));
    const sorted = valid.slice().sort((a, b) => b.transform[5] - a.transform[5]);
    const rows = [];
    for (const it of sorted) {
      const y = it.transform[5];
      const row = rows.find((r) => Math.abs(r.y - y) <= o.yTolerance);
      if (row) row.items.push(it);
      else rows.push({ y, items: [it] });
    }
    rows.sort((a, b) => b.y - a.y);
    const lines = [];
    for (const row of rows) {
      row.items.sort((a, b) => a.transform[4] - b.transform[4]);
      let text = "";
      let prevEnd = null;
      for (const it of row.items) {
        const x = it.transform[4];
        const size = it.height || Math.abs(it.transform[3]) || 10;
        if (prevEnd !== null && text && !/\s$/.test(text) && !/^\s/.test(it.str)) {
          const gap = x - prevEnd;
          if (gap > size * 0.15) text += " ";
        }
        text += it.str;
        prevEnd = typeof it.width === "number" ? x + it.width : x + it.str.length * size * 0.5;
      }
      lines.push(text.replace(/\s+$/, ""));
    }
    return lines.filter((l) => l.trim() !== "");
  }

  function pagesToText(pages, opts) {
    const o = Object.assign({ separator: "none" }, opts);
    return pages.map((lines, i) => {
      const body = lines.join("\n");
      if (o.separator === "marker") return `--- Page ${i + 1} ---\n${body}`;
      if (o.separator === "rule") return `${body}${i < pages.length - 1 ? "\n\n---" : ""}`;
      return body;
    }).join("\n\n");
  }

  // ---------- Markdown table helper + Turndown rules ----------

  function escapeCell(t) {
    return String(t == null ? "" : t).replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim();
  }

  /** rows: array of arrays of strings; first row is the header. aligns: ["left"|"center"|"right"|null]. */
  function rowsToMarkdownTable(rows, aligns) {
    if (!rows || !rows.length) return "";
    const width = Math.max(...rows.map((r) => r.length), 1);
    const norm = rows.map((r) => Array.from({ length: width }, (_, i) => escapeCell(r[i])));
    const sep = Array.from({ length: width }, (_, i) => {
      const a = aligns && aligns[i];
      return a === "center" ? ":---:" : a === "right" ? "---:" : a === "left" ? ":---" : "---";
    });
    const fmt = (r) => `| ${r.join(" | ")} |`;
    return [fmt(norm[0]), fmt(sep), ...norm.slice(1).map(fmt)].join("\n");
  }

  /** Adds GFM table, strikethrough and task-list rules to a TurndownService instance. */
  function installTurndownRules(service) {
    service.addRule("gfmTable", {
      filter: "table",
      replacement(content, node) {
        const rows = Array.from(node.rows || node.querySelectorAll("tr")).map((tr) =>
          Array.from(tr.cells || tr.children).map((c) => c.textContent || ""));
        const first = node.rows && node.rows[0];
        const aligns = first ? Array.from(first.cells).map((c) => c.getAttribute("align") || (c.style && c.style.textAlign) || null) : null;
        return `\n\n${rowsToMarkdownTable(rows, aligns)}\n\n`;
      },
    });
    service.addRule("strikethrough", {
      filter: ["del", "s", "strike"],
      replacement: (content) => `~~${content}~~`,
    });
    service.addRule("taskListItem", {
      filter(node) {
        return node.nodeName === "LI" && node.firstElementChild && node.firstElementChild.nodeName === "INPUT" && node.firstElementChild.getAttribute("type") === "checkbox";
      },
      replacement(content, node) {
        const checked = node.firstElementChild.checked || node.firstElementChild.hasAttribute("checked");
        return `- [${checked ? "x" : " "}] ${content.trim()}\n`;
      },
    });
    return service;
  }

  // ---------- marked tokens -> docx ----------

  const HEADINGS = ["HEADING_1", "HEADING_2", "HEADING_3", "HEADING_4", "HEADING_5", "HEADING_6"];
  const MONO = "Courier New";

  /** Numbering definition for ordered lists; pass as `numbering` option to `new docx.Document`. */
  function numberingConfig(docx) {
    const formats = ["DECIMAL", "LOWER_LETTER", "LOWER_ROMAN"];
    return {
      config: [{
        reference: "md-numbered",
        levels: Array.from({ length: 9 }, (_, level) => ({
          level,
          format: docx.LevelFormat[formats[level % 3]],
          text: `%${level + 1}.`,
          alignment: docx.AlignmentType.START,
          style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
        })),
      }],
    };
  }

  function decodeEntities(s) {
    return String(s).replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  }

  /**
   * Convert marked tokens into an array of docx Paragraph/Table objects.
   * `docx` is injected (the real library in the browser, a stub in tests).
   */
  function tokensToDocx(tokens, docx, opts) {
    const o = Object.assign({ codeFont: MONO }, opts);
    const state = { listInstance: 0 };

    function runs(inline, style) {
      const out = [];
      for (const t of inline || []) {
        switch (t.type) {
          case "text":
          case "escape":
            if (t.tokens && t.tokens.length) out.push(...runs(t.tokens, style));
            else out.push(new docx.TextRun(Object.assign({ text: decodeEntities(t.text) }, style)));
            break;
          case "strong": out.push(...runs(t.tokens, Object.assign({}, style, { bold: true }))); break;
          case "em": out.push(...runs(t.tokens, Object.assign({}, style, { italics: true }))); break;
          case "del": out.push(...runs(t.tokens, Object.assign({}, style, { strike: true }))); break;
          case "codespan":
            out.push(new docx.TextRun(Object.assign({}, style, {
              text: decodeEntities(t.text),
              font: o.codeFont,
              shading: { type: docx.ShadingType.CLEAR, fill: "EEEEEE", color: "auto" },
            })));
            break;
          case "br": out.push(new docx.TextRun({ text: "", break: 1 })); break;
          case "link":
            out.push(new docx.ExternalHyperlink({
              link: t.href,
              children: runs(t.tokens, Object.assign({}, style, { style: "Hyperlink", color: "0B5FFF", underline: {} })),
            }));
            break;
          case "image":
            out.push(new docx.TextRun(Object.assign({ text: `[image: ${t.text || t.href}]` }, style, { italics: true })));
            break;
          case "html": {
            const stripped = decodeEntities(String(t.text || t.raw || "").replace(/<[^>]*>/g, ""));
            if (stripped) out.push(new docx.TextRun(Object.assign({ text: stripped }, style)));
            break;
          }
          default:
            if (t.tokens) out.push(...runs(t.tokens, style));
            else if (t.text) out.push(new docx.TextRun(Object.assign({ text: t.text }, style)));
        }
      }
      return out;
    }

    function blocks(list, ctx) {
      const out = [];
      for (const t of list || []) {
        switch (t.type) {
          case "space": break;
          case "heading":
            out.push(new docx.Paragraph({ heading: docx.HeadingLevel[HEADINGS[Math.min(t.depth, 6) - 1]], children: runs(t.tokens, {}) }));
            break;
          case "paragraph":
          case "text":
            out.push(new docx.Paragraph(Object.assign({ children: runs(t.tokens || [{ type: "text", text: t.text }], {}), spacing: { after: 120 } }, quoteProps(ctx))));
            break;
          case "code": {
            const lines = String(t.text).split("\n");
            out.push(new docx.Paragraph(Object.assign({
              children: lines.map((line, i) => new docx.TextRun({ text: line, font: o.codeFont, size: 20, break: i === 0 ? undefined : 1 })),
              shading: { type: docx.ShadingType.CLEAR, fill: "F3F4F6", color: "auto" },
              spacing: { before: 80, after: 160 },
            }, quoteProps(ctx))));
            break;
          }
          case "blockquote":
            out.push(...blocks(t.tokens, { quote: (ctx.quote || 0) + 1, level: ctx.level }));
            break;
          case "hr":
            out.push(new docx.Paragraph({
              children: [],
              border: { bottom: { style: docx.BorderStyle.SINGLE, size: 6, space: 1, color: "999999" } },
              spacing: { before: 120, after: 120 },
            }));
            break;
          case "list": {
            const instance = t.ordered ? ++state.listInstance : 0;
            const level = Math.min(ctx.level == null ? 0 : ctx.level + 1, 8);
            for (const item of t.items) out.push(...listItem(item, t.ordered, instance, level, ctx));
            break;
          }
          case "table": out.push(table(t)); break;
          case "html": {
            const stripped = decodeEntities(String(t.text || "").replace(/<[^>]*>/g, "")).trim();
            if (stripped) out.push(new docx.Paragraph({ children: [new docx.TextRun({ text: stripped })] }));
            break;
          }
          default:
            if (t.text) out.push(new docx.Paragraph({ children: [new docx.TextRun({ text: t.text })] }));
        }
      }
      return out;
    }

    function quoteProps(ctx) {
      if (!ctx.quote) return {};
      return {
        indent: { left: 360 * ctx.quote },
        border: { left: { style: docx.BorderStyle.SINGLE, size: 18, space: 8, color: "BBBBBB" } },
      };
    }

    function listItem(item, ordered, instance, level, ctx) {
      const out = [];
      let first = true;
      const prefix = item.task ? [new docx.TextRun({ text: item.checked ? "☑ " : "☐ " })] : [];
      for (const t of item.tokens || []) {
        if ((t.type === "text" || t.type === "paragraph") && first) {
          const numbering = ordered
            ? { numbering: { reference: "md-numbered", level, instance } }
            : { bullet: { level } };
          out.push(new docx.Paragraph(Object.assign({ children: prefix.concat(runs(t.tokens || [{ type: "text", text: t.text }], {})) }, numbering)));
          first = false;
        } else if (t.type === "list") {
          out.push(...blocks([t], { quote: ctx.quote, level }));
        } else {
          // Continuation blocks (extra paragraphs, code) inside the item.
          out.push(...blocks([t], { quote: ctx.quote, level }));
        }
      }
      if (first) out.unshift(new docx.Paragraph(ordered ? { children: prefix, numbering: { reference: "md-numbered", level, instance } } : { children: prefix, bullet: { level } }));
      return out;
    }

    function table(t) {
      const toCell = (cell, header) => new docx.TableCell({
        children: [new docx.Paragraph({ children: runs(cell.tokens || [{ type: "text", text: cell.text }], header ? { bold: true } : {}) })],
        shading: header ? { type: docx.ShadingType.CLEAR, fill: "E8EEF7", color: "auto" } : undefined,
      });
      const rows = [new docx.TableRow({ tableHeader: true, children: t.header.map((c) => toCell(c, true)) })];
      for (const r of t.rows) rows.push(new docx.TableRow({ children: r.map((c) => toCell(c, false)) }));
      return new docx.Table({ rows, width: { size: 100, type: docx.WidthType.PERCENTAGE } });
    }

    return blocks(tokens, { quote: 0, level: null });
  }

  return {
    slugify, stripInlineMarkdown, extractHeadings, buildToc, buildHtmlDocument, DOC_CSS,
    toUpper, toLower, toTitle, toSentence, toCamel, toPascal, toSnake, toKebab, convertCase, CASE_MODES,
    dedupeLines, sortLines, trimWhitespace, splitLines, countText,
    base64Encode, base64Decode, urlEncode, urlDecode,
    itemsToLines, pagesToText,
    rowsToMarkdownTable, installTurndownRules,
    tokensToDocx, numberingConfig, escapeHtml,
  };
});
