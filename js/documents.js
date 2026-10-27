/* UI wiring for documents.html. All processing is local; no network requests. */
(function () {
  "use strict";

  const Core = window.DocumentsCore;
  const T = window.Tools;
  const $ = (id) => document.getElementById(id);

  // ---------- Helpers ----------

  const loaded = {};
  function loadScript(src) {
    if (!loaded[src]) {
      loaded[src] = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = src;
        s.onload = resolve;
        s.onerror = () => { delete loaded[src]; reject(new Error(`Could not load ${src}`)); };
        document.head.appendChild(s);
      });
    }
    return loaded[src];
  }

  function msg(err) {
    return err && err.message ? err.message : String(err);
  }

  function sanitize(html) {
    return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
  }

  function mdToSafeHtml(md) {
    return sanitize(marked.parse(String(md), { gfm: true, async: false }));
  }

  /** Run a task while keeping the status line truthful; never leaves it on "busy". */
  async function guarded(statusEl, buttons, task) {
    buttons.forEach((b) => { if (b) b.disabled = true; });
    try {
      return await task();
    } catch (err) {
      console.error(err);
      T.setStatus(statusEl, `Failed: ${msg(err)}`, "error");
      return null;
    } finally {
      buttons.forEach((b) => { if (b) b.disabled = false; });
    }
  }

  function copyText(text, statusEl) {
    const done = () => T.setStatus(statusEl, "Copied to clipboard.", "ok");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => T.setStatus(statusEl, "Clipboard unavailable. Select the text and copy manually.", "error"));
    } else {
      T.setStatus(statusEl, "Clipboard unavailable. Select the text and copy manually.", "error");
    }
  }

  const debounce = (fn, ms) => {
    let t;
    return () => { clearTimeout(t); t = setTimeout(fn, ms); };
  };

  /**
   * Batch list shared by several tabs. results: [{name, blob|text, error?}].
   * Renders one row per file with a per-file download button.
   */
  function renderBatch(listEl, results, mime, onSelect) {
    listEl.textContent = "";
    results.forEach((r) => {
      const li = document.createElement("li");
      li.className = "file-item";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = r.error ? `${r.source}: ${r.error}` : r.name;
      li.appendChild(name);
      if (!r.error) {
        const size = r.blob ? r.blob.size : new Blob([r.text]).size;
        const meta = document.createElement("span");
        meta.className = "meta";
        meta.textContent = T.formatBytes(size);
        li.appendChild(meta);
        if (onSelect) {
          const view = document.createElement("button");
          view.type = "button";
          view.className = "ghost";
          view.textContent = "View";
          view.addEventListener("click", () => onSelect(r));
          li.appendChild(view);
        }
        const dl = document.createElement("button");
        dl.type = "button";
        dl.className = "ghost";
        dl.textContent = "Download";
        dl.addEventListener("click", () => T.download(r.blob || r.text, r.name, mime));
        li.appendChild(dl);
      }
      listEl.appendChild(li);
    });
  }

  async function downloadZip(results, filename) {
    const files = results.filter((r) => !r.error).map((r) => ({ name: r.name, data: r.blob || r.text }));
    if (!files.length) return;
    T.download(await T.zip(files), filename, "application/zip");
  }

  // ---------- Markdown input tabs (PDF, Word, HTML) ----------

  /**
   * cfg: { prefix, convert(md, name) -> Promise<{name, blob|text}>, preview(md) -> html, runBtn, mime, zipName }
   * Handles pasted text, single-file load, and multi-file batch conversion.
   */
  function mountMarkdownTab(cfg) {
    const input = $(`${cfg.prefix}-input`);
    const preview = $(`${cfg.prefix}-preview`);
    const status = $(`${cfg.prefix}-status`);
    const batchEl = $(`${cfg.prefix}-batch`);
    const runBtn = $(`${cfg.prefix}-run`);
    const zipBtn = $(`${cfg.prefix}-zip`);
    let currentName = "document";
    let batchResults = [];

    const refresh = debounce(() => {
      try {
        preview.innerHTML = input.value.trim() ? cfg.preview(input.value) : '<p class="hint">Preview appears here.</p>';
      } catch (err) {
        preview.textContent = `Preview failed: ${msg(err)}`;
      }
    }, 200);
    input.addEventListener("input", refresh);
    preview.innerHTML = '<p class="hint">Preview appears here.</p>';
    if (cfg.onOptionChange) {
      document.querySelectorAll(`[id^="${cfg.prefix}-"]`).forEach((el) => {
        if (el.matches("select, input[type=checkbox], input[type=text]")) el.addEventListener("change", refresh);
      });
    }

    async function runSingle() {
      if (!input.value.trim()) { T.setStatus(status, "Enter or drop some Markdown first.", "error"); return; }
      await guarded(status, [runBtn], async () => {
        T.setStatus(status, "Converting...", "busy");
        const out = await cfg.convert(input.value, currentName);
        T.download(out.blob || out.text, out.name, cfg.mime);
        T.setStatus(status, `Done: ${out.name} (${T.formatBytes(out.blob ? out.blob.size : new Blob([out.text]).size)}).`, "ok");
      });
    }
    runBtn.addEventListener("click", runSingle);

    async function runBatch(files) {
      await guarded(status, [runBtn, zipBtn], async () => {
        batchResults = [];
        for (let i = 0; i < files.length; i++) {
          T.setStatus(status, `Converting ${i + 1} of ${files.length}: ${files[i].name}`, "busy");
          try {
            const text = await T.readAsText(files[i]);
            const out = await cfg.convert(text, T.baseName(files[i].name));
            batchResults.push(out);
          } catch (err) {
            batchResults.push({ error: msg(err), source: files[i].name });
          }
        }
        renderBatch(batchEl, batchResults, cfg.mime);
        const ok = batchResults.filter((r) => !r.error).length;
        zipBtn.disabled = ok < 1;
        T.setStatus(status, `Converted ${ok} of ${files.length} files.`, ok === files.length ? "ok" : "error");
      });
      zipBtn.disabled = !batchResults.some((r) => !r.error);
    }

    zipBtn.addEventListener("click", () => downloadZip(batchResults, cfg.zipName));

    T.mountDropZone($(`${cfg.prefix}-drop`), {
      accept: ".md,.markdown,.txt",
      multiple: true,
      onReject: (m) => T.setStatus(status, m, "error"),
      onFiles: async (files) => {
        batchEl.textContent = "";
        if (files.length === 1) {
          batchResults = [];
          zipBtn.disabled = true;
          try {
            input.value = await T.readAsText(files[0]);
            currentName = T.baseName(files[0].name);
            refresh();
            T.setStatus(status, `Loaded ${files[0].name} (${T.formatBytes(files[0].size)}).`, "ok");
          } catch (err) {
            T.setStatus(status, `Could not read file: ${msg(err)}`, "error");
          }
        } else {
          runBatch(files);
        }
      },
    });
    return { refresh, input };
  }

  // ---------- 1. Markdown to PDF ----------

  const PAGE_MM = { a4: [210, 297], letter: [215.9, 279.4] };

  function pdfOptions() {
    const size = $("pdf-size").value;
    const landscape = $("pdf-orient").value === "landscape";
    const [w, h] = PAGE_MM[size];
    const margin = Number($("pdf-margin").value);
    return {
      size,
      landscape,
      pageW: landscape ? h : w,
      pageH: landscape ? w : h,
      margin,
      fontPx: Number($("pdf-font").value),
      numbers: $("pdf-numbers").checked,
    };
  }

  async function renderMarkdownPdf(md, name) {
    await loadScript("vendor/html2canvas.min.js");
    await loadScript("vendor/jspdf.umd.min.js");
    const o = pdfOptions();
    const contentMm = o.pageW - o.margin * 2;
    const contentPx = Math.round((contentMm * 96) / 25.4);
    const stage = document.createElement("div");
    stage.className = "md-render pdf-stage";
    stage.style.width = `${contentPx}px`;
    stage.style.fontSize = `${o.fontPx}px`;
    stage.innerHTML = mdToSafeHtml(md);
    document.body.appendChild(stage);
    try {
      const doc = new jspdf.jsPDF({ unit: "mm", format: o.size, orientation: o.landscape ? "landscape" : "portrait", compress: true });
      await new Promise((resolve, reject) => {
        const job = doc.html(stage, {
          callback: () => resolve(),
          margin: [o.margin, o.margin, o.margin, o.margin],
          autoPaging: "text",
          x: 0,
          y: 0,
          width: contentMm,
          windowWidth: contentPx,
          html2canvas: { scale: 2, backgroundColor: "#ffffff", logging: false, useCORS: false, allowTaint: false },
        });
        if (job && typeof job.catch === "function") job.catch(reject);
      });
      if (o.numbers) {
        const total = doc.getNumberOfPages();
        doc.setFontSize(9);
        doc.setTextColor(110);
        for (let i = 1; i <= total; i++) {
          doc.setPage(i);
          doc.text(`${i} / ${total}`, o.pageW / 2, o.pageH - Math.min(o.margin / 2, 7), { align: "center" });
        }
      }
      return { name: `${T.safeFilename(name)}.pdf`, blob: doc.output("blob") };
    } finally {
      stage.remove();
    }
  }

  function printMarkdown(md, statusEl) {
    const o = pdfOptions();
    const css = `${Core.DOC_CSS}
@page { size: ${o.size === "a4" ? "A4" : "Letter"} ${o.landscape ? "landscape" : "portrait"}; margin: ${o.margin}mm; }
body { margin: 0; max-width: none; font-size: ${o.fontPx}px; }
pre { white-space: pre-wrap; word-break: break-word; }
table { display: table; }
h1, h2, h3, h4, tr, pre, blockquote, img { break-inside: avoid; }`;
    const srcdoc = Core.buildHtmlDocument(mdToSafeHtml(md), { title: "Document", css });
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-same-origin allow-modals");
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
    frame.addEventListener("load", () => {
      try {
        frame.contentWindow.focus();
        frame.contentWindow.print();
        T.setStatus(statusEl, "Print dialog opened. Choose Save as PDF as the destination.", "ok");
      } catch (err) {
        T.setStatus(statusEl, `Could not open print dialog: ${msg(err)}`, "error");
      }
      setTimeout(() => frame.remove(), 60000);
    });
    frame.srcdoc = srcdoc;
    document.body.appendChild(frame);
  }

  const pdfTab = mountMarkdownTab({
    prefix: "pdf",
    mime: "application/pdf",
    zipName: "markdown-pdfs.zip",
    preview: mdToSafeHtml,
    convert: renderMarkdownPdf,
  });
  $("pdf-print").addEventListener("click", () => {
    const status = $("pdf-status");
    if (!pdfTab.input.value.trim()) { T.setStatus(status, "Enter or drop some Markdown first.", "error"); return; }
    try { printMarkdown(pdfTab.input.value, status); } catch (err) { T.setStatus(status, `Failed: ${msg(err)}`, "error"); }
  });

  // ---------- 2. Markdown to Word ----------

  async function markdownToDocx(md, name) {
    await loadScript("vendor/docx.iife.js");
    const tokens = marked.lexer(String(md), { gfm: true });
    const children = Core.tokensToDocx(tokens, docx);
    const font = $("docx-font").value;
    const size = Number($("docx-size").value);
    const headingStyle = (id, pts) => ({ id, name: id, basedOn: "Normal", next: "Normal", quickFormat: true, run: { font, size: pts * 2, bold: true }, paragraph: { spacing: { before: 280, after: 120 } } });
    const doc = new docx.Document({
      creator: "Converter Studio",
      title: name,
      numbering: Core.numberingConfig(docx),
      styles: {
        default: { document: { run: { font, size } } },
        paragraphStyles: [
          headingStyle("Heading1", 20), headingStyle("Heading2", 16), headingStyle("Heading3", 14),
          headingStyle("Heading4", 12), headingStyle("Heading5", 11), headingStyle("Heading6", 10),
        ],
      },
      sections: [{ children: children.length ? children : [new docx.Paragraph("")] }],
    });
    const blob = await docx.Packer.toBlob(doc);
    return { name: `${T.safeFilename(name)}.docx`, blob };
  }

  mountMarkdownTab({
    prefix: "docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    zipName: "markdown-docx.zip",
    preview: mdToSafeHtml,
    convert: markdownToDocx,
  });

  // ---------- 3. Markdown to HTML ----------

  function markdownToHtmlDoc(md, name) {
    const safe = mdToSafeHtml(md);
    const tpl = document.createElement("template");
    tpl.innerHTML = safe;
    const used = new Set();
    const headings = [];
    tpl.content.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach((h) => {
      const text = h.textContent.trim();
      const slug = Core.slugify(text, used);
      h.id = slug;
      headings.push({ level: Number(h.tagName[1]), text, slug });
    });
    const holder = document.createElement("div");
    holder.appendChild(tpl.content);
    const toc = $("html-toc").checked ? Core.buildToc(headings, { maxLevel: Number($("html-toc-depth").value) }) : "";
    const title = $("html-title").value.trim() || (headings[0] && headings[0].text) || name;
    const html = Core.buildHtmlDocument(holder.innerHTML, { title, tocHtml: toc });
    return { name: `${T.safeFilename(name)}.html`, text: html };
  }

  const htmlTab = mountMarkdownTab({
    prefix: "html",
    mime: "text/html",
    zipName: "markdown-html.zip",
    onOptionChange: true,
    preview: (md) => {
      const out = markdownToHtmlDoc(md, "preview");
      const body = out.text.slice(out.text.indexOf("<main>") + 6, out.text.lastIndexOf("</main>"));
      return sanitize(body);
    },
    convert: async (md, name) => markdownToHtmlDoc(md, name),
  });
  $("html-copy").addEventListener("click", () => {
    const status = $("html-status");
    if (!htmlTab.input.value.trim()) { T.setStatus(status, "Enter or drop some Markdown first.", "error"); return; }
    try { copyText(markdownToHtmlDoc(htmlTab.input.value, "document").text, status); } catch (err) { T.setStatus(status, `Failed: ${msg(err)}`, "error"); }
  });

  // ---------- Turndown ----------

  function makeTurndown(opts) {
    const service = new TurndownService({
      headingStyle: opts.heading,
      bulletListMarker: opts.bullet,
      codeBlockStyle: opts.code || "fenced",
      emDelimiter: "*",
      hr: "---",
    });
    Core.installTurndownRules(service);
    if (!opts.images) service.addRule("dropImages", { filter: "img", replacement: () => "" });
    return service;
  }

  // ---------- Generic "files in, text out" tab ----------

  /**
   * cfg: { prefix, accept, convert(file) -> Promise<{name, text, note?}>, mime, zipName, outputEl }
   * Shows a batch list, puts the latest output in the textarea.
   */
  function mountFileTextTab(cfg) {
    const status = $(`${cfg.prefix}-status`);
    const batchEl = $(`${cfg.prefix}-batch`);
    const out = $(cfg.outputEl);
    const dl = $(`${cfg.prefix}-download`);
    const copy = $(`${cfg.prefix}-copy`);
    const zipBtn = $(`${cfg.prefix}-zip`);
    let results = [];
    let current = null;
    [dl, copy, zipBtn].forEach((b) => { b.disabled = true; });

    function show(r) {
      current = r;
      const cap = 200000;
      out.value = r.text.length > cap ? `${r.text.slice(0, cap)}\n\n[Preview truncated at ${cap} characters. Download for the full text.]` : r.text;
      dl.disabled = false;
      copy.disabled = false;
    }

    async function run(files) {
      results = [];
      current = null;
      [dl, copy, zipBtn].forEach((b) => { b.disabled = true; });
      await guarded(status, [], async () => {
        const notes = [];
        for (let i = 0; i < files.length; i++) {
          T.setStatus(status, `Converting ${i + 1} of ${files.length}: ${files[i].name}`, "busy");
          try {
            const r = await cfg.convert(files[i], (text) => T.setStatus(status, `${files[i].name}: ${text}`, "busy"));
            results.push(r);
            if (r.note) notes.push(`${files[i].name}: ${r.note}`);
          } catch (err) {
            console.error(err);
            results.push({ error: msg(err), source: files[i].name });
          }
        }
        renderBatch(batchEl, results, cfg.mime, show);
        const good = results.filter((r) => !r.error);
        if (good.length) show(good[good.length - 1]);
        else out.value = "";
        zipBtn.disabled = good.length < 2;
        const failed = results.length - good.length;
        const summary = `Converted ${good.length} of ${files.length} file(s).${notes.length ? ` Notes: ${notes.join(" | ")}` : ""}`;
        T.setStatus(status, summary, failed ? "error" : "ok");
      });
    }

    dl.addEventListener("click", () => current && T.download(current.text, current.name, cfg.mime));
    copy.addEventListener("click", () => current && copyText(current.text, status));
    zipBtn.addEventListener("click", () => downloadZip(results, cfg.zipName));
    T.mountDropZone($(`${cfg.prefix}-drop`), {
      accept: cfg.accept,
      multiple: true,
      onReject: (m) => T.setStatus(status, m, "error"),
      onFiles: run,
    });
    return { run, status, show, getResults: () => results };
  }

  // ---------- 4. Word to Markdown / HTML / Text ----------

  function stripImagesIfNeeded(html, keep) {
    if (keep) return html;
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    tpl.content.querySelectorAll("img").forEach((i) => i.remove());
    const holder = document.createElement("div");
    holder.appendChild(tpl.content);
    return holder.innerHTML;
  }

  mountFileTextTab({
    prefix: "dx",
    accept: ".docx",
    outputEl: "dx-output",
    mime: "text/plain",
    zipName: "word-conversions.zip",
    async convert(file) {
      await loadScript("vendor/mammoth.browser.min.js");
      const format = $("dx-format").value;
      const arrayBuffer = await T.readAsArrayBuffer(file);
      const warnings = (res) => {
        const uniq = Array.from(new Set(res.messages.map((m) => m.message)));
        return uniq.length ? `${uniq.length} warning(s): ${uniq.slice(0, 3).join("; ")}${uniq.length > 3 ? "; ..." : ""}` : "";
      };
      if (format === "txt") {
        const res = await mammoth.extractRawText({ arrayBuffer });
        return { name: T.replaceExt(file.name, "txt"), text: res.value, note: warnings(res) };
      }
      const res = await mammoth.convertToHtml({ arrayBuffer });
      const html = stripImagesIfNeeded(sanitize(res.value), $("dx-images").checked);
      if (format === "html") {
        return { name: T.replaceExt(file.name, "html"), text: Core.buildHtmlDocument(html, { title: T.baseName(file.name) }), note: warnings(res) };
      }
      const td = makeTurndown({ heading: $("dx-heading").value, bullet: $("dx-bullet").value, images: $("dx-images").checked });
      return { name: T.replaceExt(file.name, "md"), text: `${td.turndown(html).trim()}\n`, note: warnings(res) };
    },
  });

  // ---------- 5. HTML to Markdown ----------

  (function htmlToMd() {
    const input = $("hm-input");
    const output = $("hm-output");
    const status = $("hm-status");
    const dl = $("hm-download");
    const copy = $("hm-copy");
    const zipBtn = $("hm-zip");
    const batchEl = $("hm-batch");
    let results = [];
    let name = "converted";
    [dl, copy, zipBtn].forEach((b) => { b.disabled = true; });

    const opts = () => ({ heading: $("hm-heading").value, bullet: $("hm-bullet").value, code: $("hm-code").value, images: $("hm-images").checked });
    function convert(html) {
      return `${makeTurndown(opts()).turndown(sanitize(html)).trim()}\n`;
    }
    const refresh = debounce(() => {
      try {
        if (!input.value.trim()) { output.value = ""; dl.disabled = copy.disabled = true; return; }
        output.value = convert(input.value);
        dl.disabled = copy.disabled = false;
        T.setStatus(status, `Converted ${T.formatBytes(new Blob([input.value]).size)} of HTML to ${T.formatBytes(new Blob([output.value]).size)} of Markdown.`, "ok");
      } catch (err) {
        T.setStatus(status, `Failed: ${msg(err)}`, "error");
      }
    }, 250);
    input.addEventListener("input", refresh);
    ["hm-heading", "hm-bullet", "hm-code", "hm-images"].forEach((id) => $(id).addEventListener("change", refresh));
    dl.addEventListener("click", () => T.download(output.value, `${T.safeFilename(name)}.md`, "text/markdown"));
    copy.addEventListener("click", () => copyText(output.value, status));
    zipBtn.addEventListener("click", () => downloadZip(results, "html-to-markdown.zip"));

    T.mountDropZone($("hm-drop"), {
      accept: ".html,.htm,.txt",
      multiple: true,
      onReject: (m) => T.setStatus(status, m, "error"),
      onFiles: async (files) => {
        await guarded(status, [], async () => {
          results = [];
          batchEl.textContent = "";
          zipBtn.disabled = true;
          if (files.length === 1) {
            input.value = await T.readAsText(files[0]);
            name = T.baseName(files[0].name);
            refresh();
            return;
          }
          for (let i = 0; i < files.length; i++) {
            T.setStatus(status, `Converting ${i + 1} of ${files.length}: ${files[i].name}`, "busy");
            try {
              results.push({ name: T.replaceExt(files[i].name, "md"), text: convert(await T.readAsText(files[i])) });
            } catch (err) {
              results.push({ error: msg(err), source: files[i].name });
            }
          }
          renderBatch(batchEl, results, "text/markdown");
          const ok = results.filter((r) => !r.error).length;
          zipBtn.disabled = ok < 1;
          T.setStatus(status, `Converted ${ok} of ${files.length} files.`, ok === files.length ? "ok" : "error");
        });
      },
    });
  })();

  // ---------- 6. PDF to Text ----------

  let pdfjsPromise = null;
  function loadPdfjs() {
    if (!pdfjsPromise) {
      pdfjsPromise = import("../vendor/pdf.min.mjs").then((mod) => {
        mod.GlobalWorkerOptions.workerSrc = new URL("vendor/pdf.worker.min.mjs", location.href).href;
        return mod;
      }).catch((err) => { pdfjsPromise = null; throw err; });
    }
    return pdfjsPromise;
  }

  mountFileTextTab({
    prefix: "pt",
    accept: ".pdf",
    outputEl: "pt-output",
    mime: "text/plain",
    zipName: "pdf-text.zip",
    async convert(file, progress) {
      const pdfjs = await loadPdfjs();
      const data = new Uint8Array(await T.readAsArrayBuffer(file));
      const pdf = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
      const tolerance = Math.max(0.5, Number($("pt-tol").value) || 3);
      const format = $("pt-format").value;
      const pages = [];
      try {
        for (let n = 1; n <= pdf.numPages; n++) {
          progress(`page ${n} of ${pdf.numPages}`);
          const page = await pdf.getPage(n);
          const content = await page.getTextContent();
          pages.push(Core.itemsToLines(content.items, { yTolerance: tolerance }));
          page.cleanup();
        }
      } finally {
        pdf.destroy();
      }
      let text;
      if (format === "md") {
        text = pages.map((lines, i) => `## Page ${i + 1}\n\n${lines.join("  \n")}`).join("\n\n");
      } else {
        text = Core.pagesToText(pages, { separator: $("pt-sep").value });
      }
      const empty = pages.every((p) => !p.length);
      return {
        name: T.replaceExt(file.name, format),
        text: `${text}\n`,
        note: empty ? "no text layer found (likely a scanned PDF; OCR is not supported)" : "",
      };
    },
  });

  // ---------- 7. Text tools ----------

  (function textTools() {
    const input = $("tt-input");
    const output = $("tt-output");
    const status = $("tt-status");
    const stats = $("tt-stats");

    function updateStats() {
      const c = Core.countText(input.value);
      stats.textContent = `${c.words} words, ${c.characters} characters (${c.charactersNoSpaces} without spaces), ${c.lines} lines, ${c.sentences} sentences, about ${c.readingMinutes} min read.`;
    }
    input.addEventListener("input", debounce(updateStats, 100));
    updateStats();

    function apply(label, fn) {
      try {
        output.value = fn(input.value);
        T.setStatus(status, `${label} applied.`, "ok");
      } catch (err) {
        T.setStatus(status, `${label} failed: ${err instanceof URIError ? "malformed URL encoding" : err.name === "InvalidCharacterError" ? "input is not valid Base64" : msg(err)}`, "error");
      }
    }
    const on = (id, label, fn) => $(id).addEventListener("click", () => apply(label, fn));

    ["upper", "lower", "title", "sentence", "camel", "snake", "kebab"].forEach((mode) => {
      on(`tt-case-${mode}`, `${mode} case`, (t) => Core.convertCase(t, mode));
    });
    on("tt-dedupe", "Remove duplicates", (t) => Core.dedupeLines(t, { ignoreCase: $("tt-icase").checked, trim: true }));
    on("tt-sort-asc", "Sort A-Z", (t) => Core.sortLines(t, { order: "asc", numeric: $("tt-numeric").checked, ignoreCase: $("tt-icase").checked }));
    on("tt-sort-desc", "Sort Z-A", (t) => Core.sortLines(t, { order: "desc", numeric: $("tt-numeric").checked, ignoreCase: $("tt-icase").checked }));
    on("tt-trim", "Trim", (t) => Core.trimWhitespace(t, { collapse: $("tt-collapse").checked, removeEmpty: $("tt-noempty").checked }));
    on("tt-b64e", "Base64 encode", Core.base64Encode);
    on("tt-b64d", "Base64 decode", Core.base64Decode);
    on("tt-urle", "URL encode", Core.urlEncode);
    on("tt-urld", "URL decode", Core.urlDecode);

    $("tt-use").addEventListener("click", () => { input.value = output.value; updateStats(); T.setStatus(status, "Output moved to input.", "ok"); });
    $("tt-copy").addEventListener("click", () => copyText(output.value, status));
    $("tt-download").addEventListener("click", () => T.download(output.value, "text-output.txt", "text/plain"));
    $("tt-clear").addEventListener("click", () => { input.value = ""; output.value = ""; updateStats(); T.setStatus(status, "", "idle"); });

    T.mountDropZone($("tt-drop"), {
      accept: ".txt,.md,.markdown,.csv,.json,.log,.xml,.html,.yaml,.yml,.tsv",
      multiple: false,
      onReject: (m) => T.setStatus(status, m, "error"),
      onFiles: async (files) => {
        try {
          input.value = await T.readAsText(files[0]);
          updateStats();
          T.setStatus(status, `Loaded ${files[0].name}.`, "ok");
        } catch (err) {
          T.setStatus(status, `Could not read file: ${msg(err)}`, "error");
        }
      },
    });
  })();

  T.mountTabs($("tabs"));
})();
