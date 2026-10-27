/* UI wiring for pdf.html. All processing is local; libraries are loaded lazily from /vendor. */
(function () {
  "use strict";

  const T = window.Tools;
  const C = window.PdfCore;
  const $ = (id) => document.getElementById(id);

  // ---------- Lazy library loading ----------
  const scriptCache = new Map();
  function loadScript(src) {
    if (!scriptCache.has(src)) {
      scriptCache.set(src, new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = src;
        s.onload = () => resolve();
        s.onerror = () => { scriptCache.delete(src); reject(new Error(`Could not load ${src}`)); };
        document.head.appendChild(s);
      }));
    }
    return scriptCache.get(src);
  }
  async function lib() {
    if (!window.PDFLib) await loadScript("vendor/pdf-lib.min.js");
    return window.PDFLib;
  }
  let pdfjsPromise = null;
  function pdfjs() {
    if (!pdfjsPromise) {
      pdfjsPromise = import(new URL("vendor/pdf.min.mjs", location.href).href).then((m) => {
        m.GlobalWorkerOptions.workerSrc = new URL("vendor/pdf.worker.min.mjs", location.href).href;
        return m;
      }).catch((e) => { pdfjsPromise = null; throw e; });
    }
    return pdfjsPromise;
  }

  // ---------- Shared helpers ----------
  const ENCRYPTED_MSG = "This PDF is password-protected or encrypted. Remove the protection first; this tool does not bypass it.";

  function friendlyError(err, name) {
    const msg = String((err && err.message) || err);
    if ((err && (err.name === "EncryptedPDFError" || err.name === "PasswordException")) || /encrypted|password/i.test(msg)) {
      return new Error(`${name ? name + ": " : ""}${ENCRYPTED_MSG}`);
    }
    return new Error(`${name ? name + ": " : ""}${/parse|invalid|header|trailer|xref/i.test(msg) ? "could not read this file as a PDF (" + msg + ")" : msg}`);
  }

  async function readBytes(file) { return new Uint8Array(await file.arrayBuffer()); }

  /** Load with pdf-lib. Returns { file, bytes, doc, count }. */
  async function loadPdf(file) {
    const L = await lib();
    const bytes = await readBytes(file);
    try {
      const doc = await L.PDFDocument.load(bytes, { updateMetadata: false });
      return { file, bytes, doc, count: doc.getPageCount() };
    } catch (e) {
      throw friendlyError(e, file.name);
    }
  }

  /** Open with pdf.js (for rendering). Pass a copy of the bytes: pdf.js transfers the buffer to its worker. */
  async function openRender(bytes, name) {
    const lib2 = await pdfjs();
    try {
      return await lib2.getDocument({ data: bytes.slice() }).promise;
    } catch (e) {
      throw friendlyError(e, name);
    }
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not encode the image."))), type, quality);
    });
  }

  async function renderPageToCanvas(page, scale, canvas) {
    const viewport = page.getViewport({ scale });
    const w = Math.ceil(viewport.width);
    const h = Math.ceil(viewport.height);
    if (w * h > 100e6) throw new Error("This page is too large to render at the chosen resolution. Pick a lower DPI.");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    await page.render({ canvasContext: ctx, viewport }).promise;
    return viewport;
  }

  /** Disable buttons, show busy status, always recover. */
  async function run(statusEl, buttons, fn) {
    const before = buttons.map((b) => b.disabled);
    buttons.forEach((b) => { b.disabled = true; });
    try {
      await fn();
    } catch (e) {
      T.setStatus(statusEl, (e && e.message) || String(e), "error");
    } finally {
      // If the task itself re-enabled a button (e.g. a file finished loading), keep that;
      // otherwise restore the state it had before the task started.
      buttons.forEach((b, i) => { if (b.disabled) b.disabled = before[i]; });
    }
  }

  function pdfZone(zoneId, onFile, statusEl) {
    T.mountDropZone($(zoneId), {
      accept: ".pdf,application/pdf", multiple: false,
      onFiles: (files) => onFile(files[0]),
      onReject: (m) => T.setStatus(statusEl, m, "error"),
    });
  }

  function sniffImage(bytes) {
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpg";
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
    return "other";
  }

  async function imageToPngBytes(file) {
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch (e) {
      throw new Error(`${file.name}: this image format is not supported by your browser.`);
    }
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    if (bitmap.close) bitmap.close();
    const blob = await canvasToBlob(canvas, "image/png");
    canvas.width = canvas.height = 0;
    return new Uint8Array(await blob.arrayBuffer());
  }

  /** Embed JPG/PNG directly; anything else is converted to PNG first. */
  async function embedImage(doc, file) {
    let bytes = await readBytes(file);
    let kind = sniffImage(bytes);
    if (kind === "other") { bytes = await imageToPngBytes(file); kind = "png"; }
    try {
      return kind === "jpg" ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
    } catch (e) {
      throw new Error(`${file.name}: could not embed this image (${e.message}).`);
    }
  }

  function addImagePage(doc, img, size, orientation, margin) {
    const dim = C.pageDimensions(size, orientation, img.width, img.height, margin);
    const page = doc.addPage([dim.width, dim.height]);
    const fit = C.computeFit(img.width, img.height, dim.width, dim.height, margin);
    page.drawImage(img, fit);
  }

  /** Reorderable file list with Up/Down/Remove buttons. */
  function createList(ul, opts) {
    const items = [];
    function revoke(it) { if (it.thumbUrl) URL.revokeObjectURL(it.thumbUrl); }
    function render(focusIdx, act) {
      ul.replaceChildren();
      items.forEach((it, i) => {
        const li = document.createElement("li");
        li.className = "file-item";
        if (it.thumbUrl) {
          const img = document.createElement("img");
          img.className = "thumb"; img.alt = ""; img.src = it.thumbUrl;
          li.appendChild(img);
        }
        const name = document.createElement("span");
        name.className = "name"; name.textContent = `${i + 1}. ${it.file.name}`; name.title = it.file.name;
        const meta = document.createElement("span");
        meta.className = "meta"; meta.textContent = opts.meta(it);
        li.append(name, meta);
        [["up", "Up", i === 0], ["down", "Down", i === items.length - 1], ["remove", "Remove", false]].forEach(([key, label, disabled]) => {
          const b = document.createElement("button");
          b.type = "button"; b.className = "ghost"; b.textContent = label; b.disabled = disabled;
          b.dataset.act = key;
          b.setAttribute("aria-label", `${label}: ${it.file.name}`);
          b.addEventListener("click", () => {
            if (key === "remove") { revoke(it); items.splice(i, 1); render(Math.min(i, items.length - 1), "remove"); }
            else { const j = key === "up" ? i - 1 : i + 1; const [x] = items.splice(i, 1); items.splice(j, 0, x); render(j, key); }
            opts.onChange();
          });
          li.appendChild(b);
        });
        ul.appendChild(li);
      });
      if (focusIdx !== undefined && focusIdx >= 0 && ul.children[focusIdx]) {
        const target = ul.children[focusIdx].querySelector(`[data-act="${act}"]:not(:disabled)`) || ul.children[focusIdx].querySelector("button:not(:disabled)");
        if (target) target.focus();
      }
    }
    return {
      items,
      render,
      push(it) { items.push(it); render(); opts.onChange(); },
      clear() { items.forEach(revoke); items.length = 0; render(); opts.onChange(); },
    };
  }

  const totalPages = (n) => `${n} page${n === 1 ? "" : "s"}`;

  // =====================================================================
  // Merge
  // =====================================================================
  (function merge() {
    const status = $("merge-status");
    const runBtn = $("merge-run");
    const clearBtn = $("merge-clear");
    const list = createList($("merge-list"), {
      meta: (it) => (it.kind === "pdf" ? totalPages(it.pages) : "image") + ` | ${T.formatBytes(it.file.size)}`,
      onChange: () => { runBtn.disabled = clearBtn.disabled = list.items.length === 0; },
    });

    T.mountDropZone($("merge-drop"), {
      accept: ".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png", multiple: true,
      onReject: (m) => T.setStatus(status, m, "error"),
      onFiles: (files) => run(status, [runBtn], async () => {
        const errors = [];
        for (const file of files) {
          T.setStatus(status, `Reading ${file.name}...`, "busy");
          try {
            if (/\.pdf$/i.test(file.name) || file.type === "application/pdf") {
              const p = await loadPdf(file);
              list.push({ file, kind: "pdf", pages: p.count, doc: p.doc });
            } else {
              list.push({ file, kind: "image" });
            }
          } catch (e) { errors.push(e.message); }
        }
        if (errors.length) T.setStatus(status, errors.join(" | "), "error");
        else T.setStatus(status, `${list.items.length} file(s) ready.`, "idle");
      }),
    });

    clearBtn.addEventListener("click", () => { list.clear(); T.setStatus(status, "", "idle"); });

    runBtn.addEventListener("click", () => run(status, [runBtn, clearBtn], async () => {
      const L = await lib();
      const out = await L.PDFDocument.create();
      const imgSize = $("merge-imgsize").value;
      let n = 0;
      for (const it of list.items) {
        n += 1;
        T.setStatus(status, `Merging ${n} of ${list.items.length}: ${it.file.name}`, "busy");
        if (it.kind === "pdf") {
          const pages = await out.copyPages(it.doc, it.doc.getPageIndices());
          pages.forEach((p) => out.addPage(p));
        } else {
          addImagePage(out, await embedImage(out, it.file), imgSize, "auto", 0);
        }
      }
      const bytes = await out.save({ useObjectStreams: true });
      T.download(bytes, "merged.pdf", "application/pdf");
      T.setStatus(status, `Merged ${out.getPageCount()} pages into merged.pdf (${T.formatBytes(bytes.length)}).`, "ok");
    }));
  })();

  // =====================================================================
  // Split
  // =====================================================================
  (function split() {
    const status = $("split-status");
    const runBtn = $("split-run");
    let cur = null;
    const mode = $("split-mode");
    function syncMode() {
      $("split-ranges-field").classList.toggle("is-hidden", mode.value !== "ranges");
      $("split-n-field").classList.toggle("is-hidden", mode.value !== "every");
    }
    mode.addEventListener("change", syncMode);
    syncMode();

    pdfZone("split-drop", (file) => run(status, [runBtn], async () => {
      T.setStatus(status, "Reading...", "busy");
      cur = null; runBtn.disabled = true;
      cur = await loadPdf(file);
      $("split-info").textContent = `${file.name}: ${totalPages(cur.count)}, ${T.formatBytes(file.size)}`;
      runBtn.disabled = false;
      T.setStatus(status, "Ready.", "idle");
    }), status);

    runBtn.addEventListener("click", () => run(status, [runBtn], async () => {
      if (!cur) return;
      const L = await lib();
      let groups;
      if (mode.value === "each") groups = C.chunkPages(cur.count, 1);
      else if (mode.value === "every") groups = C.chunkPages(cur.count, Number($("split-n").value));
      else groups = C.parseRanges($("split-ranges").value, cur.count);
      const base = T.safeFilename(T.baseName(cur.file.name));
      const pad = String(groups.length).length;
      const files = [];
      for (let i = 0; i < groups.length; i++) {
        T.setStatus(status, `Creating part ${i + 1} of ${groups.length}...`, "busy");
        const out = await L.PDFDocument.create({ updateMetadata: false });
        (await out.copyPages(cur.doc, groups[i])).forEach((p) => out.addPage(p));
        files.push({ name: `${base}-part-${String(i + 1).padStart(pad, "0")}.pdf`, data: await out.save({ useObjectStreams: true }) });
      }
      if (files.length === 1) {
        T.download(files[0].data, files[0].name, "application/pdf");
        T.setStatus(status, `Created ${files[0].name}.`, "ok");
      } else {
        T.download(await T.zip(files), `${base}-split.zip`, "application/zip");
        T.setStatus(status, `Created ${files.length} PDFs in ${base}-split.zip.`, "ok");
      }
    }));
  })();

  // =====================================================================
  // Pages: select, delete, rotate, reorder
  // =====================================================================
  (function pagesTool() {
    const status = $("pages-status");
    const grid = $("pages-grid");
    const saveBtn = $("pages-save");
    let cur = null; // { pdf, render, pages, queue, busy }
    let observer = null;

    function labelFor(p, i) {
      return `Page ${i + 1}${p.src !== i ? ` (was ${p.src + 1})` : ""}${p.rot ? `, rotated ${p.rot}` : ""}`;
    }

    function refresh() {
      if (!cur) return;
      const frag = document.createDocumentFragment();
      cur.pages.forEach((p, i) => {
        p.label.textContent = labelFor(p, i);
        p.card.setAttribute("aria-pressed", String(p.selected));
        p.card.setAttribute("aria-label", `${labelFor(p, i)}, ${p.selected ? "selected" : "not selected"}`);
        p.canvas.style.transform = p.rot ? `rotate(${p.rot}deg)` : "";
        frag.appendChild(p.card);
      });
      grid.replaceChildren(frag);
      const sel = cur.pages.filter((p) => p.selected).length;
      $("pages-info").textContent = `${cur.file.name}: ${cur.pages.length} of ${cur.total} pages in output, ${sel} selected.`;
      saveBtn.disabled = cur.pages.length === 0;
    }

    function makeCard(p) {
      const card = document.createElement("button");
      card.type = "button"; card.className = "page-card";
      const frame = document.createElement("span");
      frame.className = "frame";
      p.canvas = document.createElement("canvas");
      p.canvas.width = 90; p.canvas.height = 120;
      frame.appendChild(p.canvas);
      p.label = document.createElement("span");
      card.append(frame, p.label);
      card.addEventListener("click", () => { p.selected = !p.selected; refresh(); });
      p.card = card;
    }

    async function pump(state) {
      if (state.busy) return;
      state.busy = true;
      while (state.queue.length && cur === state) {
        const p = state.queue.shift();
        try {
          const page = await state.render.getPage(p.src + 1);
          const base = page.getViewport({ scale: 1 });
          await renderPageToCanvas(page, Math.min(2, 220 / Math.max(base.width, base.height)), p.canvas);
        } catch (e) { /* leave placeholder */ }
      }
      state.busy = false;
    }

    function enqueue(state, p) {
      if (p.queued) return;
      p.queued = true;
      state.queue.push(p);
      pump(state);
    }

    async function load(file) {
      T.setStatus(status, "Reading and rendering thumbnails...", "busy");
      if (cur) { cur.render.destroy(); cur = null; }
      if (observer) observer.disconnect();
      grid.replaceChildren(); saveBtn.disabled = true;
      const pdf = await loadPdf(file);
      const render = await openRender(pdf.bytes, file.name);
      const state = { file, pdf, render, total: pdf.count, queue: [], busy: false, pages: [] };
      for (let i = 0; i < pdf.count; i++) {
        const p = { src: i, rot: 0, selected: false, queued: false };
        makeCard(p);
        state.pages.push(p);
      }
      state.allPages = state.pages.slice(); // Reset restores deleted pages
      cur = state;
      observer = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
        entries.forEach((en) => {
          if (!en.isIntersecting) return;
          observer.unobserve(en.target);
          enqueue(state, state.pages.find((p) => p.card === en.target));
        });
      }, { rootMargin: "300px" }) : null;
      refresh();
      state.pages.forEach((p) => (observer ? observer.observe(p.card) : enqueue(state, p)));
      T.setStatus(status, "Click pages to select them.", "idle");
    }

    pdfZone("pages-drop", (file) => run(status, [], () => load(file)), status);

    const selected = () => cur.pages.filter((p) => p.selected);
    function act(fn) {
      return () => {
        if (!cur) return;
        try { fn(); refresh(); } catch (e) { T.setStatus(status, e.message, "error"); }
      };
    }
    function needSelection() {
      if (!selected().length) throw new Error("Select at least one page first.");
    }
    function rotateBy(d) { needSelection(); selected().forEach((p) => { p.rot = C.addRotation(p.rot, d); }); T.setStatus(status, "", "idle"); }
    function nudge(dir) {
      needSelection();
      const a = cur.pages;
      if (dir < 0) { for (let i = 1; i < a.length; i++) if (a[i].selected && !a[i - 1].selected) [a[i - 1], a[i]] = [a[i], a[i - 1]]; }
      else { for (let i = a.length - 2; i >= 0; i--) if (a[i].selected && !a[i + 1].selected) [a[i + 1], a[i]] = [a[i], a[i + 1]]; }
    }

    $("pages-all").addEventListener("click", act(() => cur.pages.forEach((p) => { p.selected = true; })));
    $("pages-none").addEventListener("click", act(() => cur.pages.forEach((p) => { p.selected = false; })));
    $("pages-invert").addEventListener("click", act(() => cur.pages.forEach((p) => { p.selected = !p.selected; })));
    $("pages-keep").addEventListener("click", act(() => { needSelection(); cur.pages = selected(); cur.pages.forEach((p) => { p.selected = false; }); }));
    $("pages-delete").addEventListener("click", act(() => {
      needSelection();
      if (selected().length === cur.pages.length) throw new Error("That would delete every page. Deselect at least one.");
      cur.pages = cur.pages.filter((p) => !p.selected);
    }));
    $("pages-r90").addEventListener("click", act(() => rotateBy(90)));
    $("pages-r180").addEventListener("click", act(() => rotateBy(180)));
    $("pages-r270").addEventListener("click", act(() => rotateBy(270)));
    $("pages-left").addEventListener("click", act(() => nudge(-1)));
    $("pages-right").addEventListener("click", act(() => nudge(1)));
    $("pages-reset").addEventListener("click", act(() => {
      cur.allPages.forEach((p) => { p.rot = 0; p.selected = false; });
      cur.pages = cur.allPages.slice();
    }));
    $("pages-apply-order").addEventListener("click", act(() => {
      const idx = C.applyOrder($("pages-order").value, cur.pages.length);
      const old = cur.pages;
      cur.pages = idx.map((i) => old[i]);
    }));

    saveBtn.addEventListener("click", () => run(status, [saveBtn], async () => {
      if (!cur || !cur.pages.length) return;
      const L = await lib();
      T.setStatus(status, "Saving...", "busy");
      const out = await L.PDFDocument.create({ updateMetadata: false });
      const copied = await out.copyPages(cur.pdf.doc, cur.pages.map((p) => p.src));
      copied.forEach((page, i) => {
        const rot = cur.pages[i].rot;
        if (rot) page.setRotation(L.degrees(C.addRotation(page.getRotation().angle, rot)));
        out.addPage(page);
      });
      const bytes = await out.save({ useObjectStreams: true });
      T.download(bytes, `${T.safeFilename(T.baseName(cur.file.name))}-edited.pdf`, "application/pdf");
      T.setStatus(status, `Saved ${totalPages(copied.length)} (${T.formatBytes(bytes.length)}).`, "ok");
    }));
  })();

  // =====================================================================
  // Compress
  // =====================================================================
  (function compress() {
    const status = $("compress-status");
    const runBtn = $("compress-run");
    const dlBtn = $("compress-download");
    const mode = $("compress-mode");
    const quality = $("compress-quality");
    let cur = null;
    let result = null; // { bytes, name }

    function syncMode() {
      const strong = mode.value === "strong";
      document.querySelectorAll("[data-strong]").forEach((el) => el.classList.toggle("is-hidden", !strong));
      $("compress-warn").classList.toggle("is-hidden", !strong);
    }
    mode.addEventListener("change", syncMode);
    quality.addEventListener("input", () => { $("compress-quality-out").textContent = quality.value; });
    syncMode();

    pdfZone("compress-drop", (file) => run(status, [runBtn], async () => {
      T.setStatus(status, "Reading...", "busy");
      cur = null; result = null; runBtn.disabled = dlBtn.disabled = true;
      $("compress-result").textContent = "";
      cur = await loadPdf(file);
      $("compress-info").textContent = `${file.name}: ${totalPages(cur.count)}, ${T.formatBytes(file.size)}`;
      runBtn.disabled = false;
      T.setStatus(status, "Ready.", "idle");
    }), status);

    function copyInfo(src, out) {
      const pairs = [["getTitle", "setTitle"], ["getAuthor", "setAuthor"], ["getSubject", "setSubject"], ["getCreator", "setCreator"], ["getProducer", "setProducer"]];
      pairs.forEach(([g, s]) => { const v = src[g](); if (v) out[s](v); });
      const kw = src.getKeywords();
      if (kw) out.setKeywords([kw]);
    }

    dlBtn.addEventListener("click", () => { if (result) T.download(result.bytes, result.name, "application/pdf"); });

    runBtn.addEventListener("click", () => run(status, [runBtn, dlBtn], async () => {
      if (!cur) return;
      const L = await lib();
      const strip = $("compress-strip").checked;
      const out = await L.PDFDocument.create({ updateMetadata: false });
      if (!strip) copyInfo(cur.doc, out);
      if (mode.value === "lossless") {
        T.setStatus(status, "Re-saving...", "busy");
        (await out.copyPages(cur.doc, cur.doc.getPageIndices())).forEach((p) => out.addPage(p));
      } else {
        const scale = C.dpiToScale(Number($("compress-dpi").value));
        const q = Number(quality.value) / 100;
        const render = await openRender(cur.bytes, cur.file.name);
        const canvas = document.createElement("canvas");
        try {
          for (let i = 1; i <= render.numPages; i++) {
            T.setStatus(status, `Rendering page ${i} of ${render.numPages}...`, "busy");
            const page = await render.getPage(i);
            const base = page.getViewport({ scale: 1 });
            await renderPageToCanvas(page, scale, canvas);
            const blob = await canvasToBlob(canvas, "image/jpeg", q);
            const img = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
            out.addPage([base.width, base.height]).drawImage(img, { x: 0, y: 0, width: base.width, height: base.height });
            page.cleanup();
          }
        } finally {
          canvas.width = canvas.height = 0;
          render.destroy();
        }
      }
      T.setStatus(status, "Writing output...", "busy");
      const bytes = await out.save({ useObjectStreams: true });
      const original = cur.file.size;
      const s = C.savings(original, bytes.length);
      const keepOutput = s.smaller;
      result = keepOutput
        ? { bytes, name: `${T.safeFilename(T.baseName(cur.file.name))}-compressed.pdf` }
        : { bytes: cur.bytes, name: cur.file.name };
      const kept = keepOutput ? bytes.length : original;
      const pct = keepOutput ? s.percent : 0;
      const res = $("compress-result");
      res.replaceChildren();
      [`Original: ${T.formatBytes(original)}`, `Output: ${T.formatBytes(bytes.length)}`, `Kept: ${T.formatBytes(kept)} (${pct.toFixed(1)}% saved)`].forEach((t) => {
        const span = document.createElement("span"); span.textContent = t; res.appendChild(span);
      });
      dlBtn.disabled = false;
      const hint = $("compress-mode").value === "strong"
        ? "Try a lower DPI or quality."
        : "Try Strong mode for scanned or image-heavy PDFs.";
      T.setStatus(status, keepOutput
        ? `Done. The compressed file is ${s.percent.toFixed(1)}% smaller and was kept.`
        : `Done. The result was not smaller than the original, so the original was kept. ${hint}`, "ok");
    }));
  })();

  // =====================================================================
  // Images to PDF
  // =====================================================================
  (function imagesToPdf() {
    const status = $("i2p-status");
    const runBtn = $("i2p-run");
    const clearBtn = $("i2p-clear");
    const list = createList($("i2p-list"), {
      meta: (it) => T.formatBytes(it.file.size),
      onChange: () => { runBtn.disabled = clearBtn.disabled = list.items.length === 0; },
    });
    T.mountDropZone($("i2p-drop"), {
      accept: ".jpg,.jpeg,.png,.webp,.gif,.bmp,.avif,image/*", multiple: true,
      onReject: (m) => T.setStatus(status, m, "error"),
      onFiles: (files) => {
        files.forEach((file) => list.push({ file, thumbUrl: URL.createObjectURL(file) }));
        T.setStatus(status, `${list.items.length} image(s) ready.`, "idle");
      },
    });
    clearBtn.addEventListener("click", () => { list.clear(); T.setStatus(status, "", "idle"); });
    runBtn.addEventListener("click", () => run(status, [runBtn, clearBtn], async () => {
      const L = await lib();
      const margin = Math.max(0, Number($("i2p-margin").value) || 0);
      const out = await L.PDFDocument.create();
      let n = 0;
      for (const it of list.items) {
        n += 1;
        T.setStatus(status, `Adding image ${n} of ${list.items.length}...`, "busy");
        addImagePage(out, await embedImage(out, it.file), $("i2p-size").value, $("i2p-orient").value, margin);
      }
      const bytes = await out.save({ useObjectStreams: true });
      T.download(bytes, "images.pdf", "application/pdf");
      T.setStatus(status, `Created images.pdf with ${totalPages(n)} (${T.formatBytes(bytes.length)}).`, "ok");
    }));
  })();

  // =====================================================================
  // PDF to images
  // =====================================================================
  (function pdfToImages() {
    const status = $("p2i-status");
    const runBtn = $("p2i-run");
    const zipBtn = $("p2i-zip");
    const results = $("p2i-results");
    let cur = null;
    let outputs = []; // { name, blob, url }

    function clearOutputs() {
      outputs.forEach((o) => URL.revokeObjectURL(o.url));
      outputs = []; results.replaceChildren(); zipBtn.disabled = true;
    }

    pdfZone("p2i-drop", (file) => run(status, [runBtn], async () => {
      T.setStatus(status, "Reading...", "busy");
      clearOutputs(); cur = null; runBtn.disabled = true;
      const bytes = await readBytes(file);
      const doc = await openRender(bytes, file.name);
      cur = { file, bytes, count: doc.numPages };
      doc.destroy();
      $("p2i-info").textContent = `${file.name}: ${totalPages(cur.count)}, ${T.formatBytes(file.size)}`;
      runBtn.disabled = false;
      T.setStatus(status, "Ready.", "idle");
    }), status);

    zipBtn.addEventListener("click", () => run(status, [zipBtn], async () => {
      const base = T.safeFilename(T.baseName(cur.file.name));
      T.download(await T.zip(outputs.map((o) => ({ name: o.name, data: o.blob }))), `${base}-images.zip`, "application/zip");
    }));

    runBtn.addEventListener("click", () => run(status, [runBtn, zipBtn], async () => {
      if (!cur) return;
      clearOutputs();
      const text = $("p2i-pages").value.trim();
      const indices = text ? C.flattenRanges(C.parseRanges(text, cur.count)) : Array.from({ length: cur.count }, (_, i) => i);
      const fmt = $("p2i-format").value;
      const ext = fmt === "jpeg" ? "jpg" : "png";
      const scale = C.dpiToScale(Number($("p2i-dpi").value));
      const base = T.safeFilename(T.baseName(cur.file.name));
      const pad = String(cur.count).length;
      const render = await openRender(cur.bytes, cur.file.name);
      const canvas = document.createElement("canvas");
      try {
        for (let k = 0; k < indices.length; k++) {
          T.setStatus(status, `Rendering page ${indices[k] + 1} (${k + 1} of ${indices.length})...`, "busy");
          const page = await render.getPage(indices[k] + 1);
          await renderPageToCanvas(page, scale, canvas);
          const blob = await canvasToBlob(canvas, fmt === "jpeg" ? "image/jpeg" : "image/png", 0.92);
          const o = { name: `${base}-page-${String(indices[k] + 1).padStart(pad, "0")}.${ext}`, blob, url: URL.createObjectURL(blob) };
          outputs.push(o);
          page.cleanup();

          const li = document.createElement("li");
          li.className = "file-item";
          const img = document.createElement("img");
          img.className = "result-img"; img.alt = ""; img.src = o.url;
          const name = document.createElement("span");
          name.className = "name"; name.textContent = o.name;
          const meta = document.createElement("span");
          meta.className = "meta"; meta.textContent = `${canvas.width}x${canvas.height} | ${T.formatBytes(blob.size)}`;
          const dl = document.createElement("button");
          dl.type = "button"; dl.className = "ghost"; dl.textContent = "Download";
          dl.setAttribute("aria-label", `Download ${o.name}`);
          dl.addEventListener("click", () => T.download(blob, o.name, blob.type));
          li.append(img, name, meta, dl);
          results.appendChild(li);
        }
      } finally {
        canvas.width = canvas.height = 0;
        render.destroy();
      }
      zipBtn.disabled = outputs.length < 1;
      T.setStatus(status, `Rendered ${outputs.length} page(s).`, "ok");
    }));
  })();

  // =====================================================================
  // Rotate / watermark / page numbers
  // =====================================================================
  (function stamp() {
    const status = $("stamp-status");
    const runBtn = $("stamp-run");
    let cur = null;
    const opacity = $("stamp-wm-opacity");
    opacity.addEventListener("input", () => { $("stamp-wm-opacity-out").textContent = Number(opacity.value).toFixed(2); });

    pdfZone("stamp-drop", (file) => run(status, [runBtn], async () => {
      T.setStatus(status, "Reading...", "busy");
      cur = null; runBtn.disabled = true;
      cur = await loadPdf(file);
      $("stamp-info").textContent = `${file.name}: ${totalPages(cur.count)}, ${T.formatBytes(file.size)}`;
      runBtn.disabled = false;
      T.setStatus(status, "Ready.", "idle");
    }), status);

    runBtn.addEventListener("click", () => run(status, [runBtn], async () => {
      if (!cur) return;
      const L = await lib();
      const rot = Number($("stamp-rotate").value);
      const wm = $("stamp-wm").checked;
      const pn = $("stamp-pn").checked;
      if (!rot && !wm && !pn) throw new Error("Choose at least one option: rotate, watermark or page numbers.");
      T.setStatus(status, "Applying...", "busy");
      // Re-parse so repeated runs always start from the original file.
      const doc = await L.PDFDocument.load(cur.bytes, { updateMetadata: false });
      const font = await doc.embedFont(L.StandardFonts.Helvetica);
      const pages = doc.getPages();
      const total = pages.length;

      const wmText = $("stamp-wm-text").value;
      const wmSize = Math.max(4, Number($("stamp-wm-size").value) || 64);
      const fmt = $("stamp-pn-format").value || "{n}";
      const start = Math.trunc(Number($("stamp-pn-start").value));
      const startNum = Number.isFinite(start) ? start : 1;
      if (wm && !wmText.trim()) throw new Error("Enter the watermark text.");
      try {
        if (wm) font.widthOfTextAtSize(wmText, wmSize);
        if (pn) font.widthOfTextAtSize(C.formatPageLabel(fmt, startNum, total), 10);
      } catch (e) {
        throw new Error("The text contains characters the built-in Helvetica font cannot draw. Use Latin characters only.");
      }

      pages.forEach((page, i) => {
        const { width, height } = page.getSize();
        if (wm) {
          const tw = font.widthOfTextAtSize(wmText, wmSize);
          const th = wmSize * 0.7;
          const angle = $("stamp-wm-diag").checked ? Math.atan2(height, width) * 0.9 : 0;
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);
          page.drawText(wmText, {
            x: width / 2 - (tw / 2) * cos + (th / 2) * sin,
            y: height / 2 - (tw / 2) * sin - (th / 2) * cos,
            size: wmSize, font, color: L.rgb(0.5, 0.5, 0.5),
            opacity: Number(opacity.value), rotate: L.degrees((angle * 180) / Math.PI),
          });
        }
        if (pn) {
          const label = C.formatPageLabel(fmt, startNum + i, total);
          const pos = C.numberPosition($("stamp-pn-pos").value, width, font.widthOfTextAtSize(label, 10));
          page.drawText(label, { x: pos.x, y: pos.y, size: 10, font, color: L.rgb(0.2, 0.2, 0.2) });
        }
        if (rot) page.setRotation(L.degrees(C.addRotation(page.getRotation().angle, rot)));
      });
      const bytes = await doc.save({ useObjectStreams: true });
      T.download(bytes, `${T.safeFilename(T.baseName(cur.file.name))}-stamped.pdf`, "application/pdf");
      T.setStatus(status, `Done (${T.formatBytes(bytes.length)}).`, "ok");
    }));
  })();

  // =====================================================================
  // Metadata
  // =====================================================================
  (function metadata() {
    const status = $("meta-status");
    const saveBtn = $("meta-save");
    const stripBtn = $("meta-strip");
    let cur = null;

    function fill() {
      const d = cur.doc;
      $("meta-title").value = d.getTitle() || "";
      $("meta-author").value = d.getAuthor() || "";
      $("meta-subject").value = d.getSubject() || "";
      $("meta-keywords").value = d.getKeywords() || "";
      $("meta-creator").value = d.getCreator() || "";
      $("meta-producer").value = d.getProducer() || "";
      $("meta-created").value = C.toDateInput(d.getCreationDate());
      $("meta-modified").value = C.toDateInput(d.getModificationDate());
    }

    pdfZone("meta-drop", (file) => run(status, [saveBtn, stripBtn], async () => {
      T.setStatus(status, "Reading...", "busy");
      cur = null; saveBtn.disabled = stripBtn.disabled = true;
      cur = await loadPdf(file);
      fill();
      $("meta-info").textContent = `${file.name}: ${totalPages(cur.count)}, ${T.formatBytes(file.size)}`;
      saveBtn.disabled = stripBtn.disabled = false;
      T.setStatus(status, "Edit the fields, then save.", "idle");
    }), status);

    async function fresh() {
      const L = await lib();
      return { L, doc: await L.PDFDocument.load(cur.bytes, { updateMetadata: false }) };
    }
    const KEYS = ["Title", "Author", "Subject", "Keywords", "Creator", "Producer", "CreationDate", "ModDate"];
    function finish(doc, suffix, message) {
      return doc.save({ useObjectStreams: true }).then((bytes) => {
        T.download(bytes, `${T.safeFilename(T.baseName(cur.file.name))}-${suffix}.pdf`, "application/pdf");
        T.setStatus(status, `${message} (${T.formatBytes(bytes.length)}).`, "ok");
      });
    }

    saveBtn.addEventListener("click", () => run(status, [saveBtn, stripBtn], async () => {
      if (!cur) return;
      const { L, doc } = await fresh();
      const info = doc.getInfoDict();
      const set = (key, value, fn) => { if (value) fn(); else info.delete(L.PDFName.of(key)); };
      const v = (id) => $(id).value.trim();
      set("Title", v("meta-title"), () => doc.setTitle(v("meta-title")));
      set("Author", v("meta-author"), () => doc.setAuthor(v("meta-author")));
      set("Subject", v("meta-subject"), () => doc.setSubject(v("meta-subject")));
      set("Creator", v("meta-creator"), () => doc.setCreator(v("meta-creator")));
      set("Producer", v("meta-producer"), () => doc.setProducer(v("meta-producer")));
      const kws = C.splitKeywords($("meta-keywords").value);
      set("Keywords", kws.length, () => doc.setKeywords(kws));
      const created = C.fromDateInput($("meta-created").value);
      set("CreationDate", created, () => doc.setCreationDate(created));
      const modified = C.fromDateInput($("meta-modified").value);
      set("ModDate", modified, () => doc.setModificationDate(modified));
      await finish(doc, "metadata", "Saved with updated metadata");
    }));

    stripBtn.addEventListener("click", () => run(status, [saveBtn, stripBtn], async () => {
      if (!cur) return;
      const { L, doc } = await fresh();
      const info = doc.getInfoDict();
      KEYS.forEach((k) => info.delete(L.PDFName.of(k)));
      doc.catalog.delete(L.PDFName.of("Metadata")); // XMP packet
      await finish(doc, "clean", "Removed all metadata");
      ["meta-title", "meta-author", "meta-subject", "meta-keywords", "meta-creator", "meta-producer", "meta-created", "meta-modified"].forEach((id) => { $(id).value = ""; });
    }));
  })();

  T.mountTabs($("tabs"));
})();
