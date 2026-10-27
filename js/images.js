/* UI wiring for images.html. All processing is local (canvas, createImageBitmap, Blob). */
(function () {
  "use strict";

  const C = window.ImagesCore;
  const T = window.Tools;
  const IMAGE_ACCEPT = ".png,.jpg,.jpeg,.webp,.avif,.gif,.bmp,.svg,.ico";
  const MAX_PIXELS = 150e6;

  const $ = (sel, root = document) => root.querySelector(sel);
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const errMsg = (e) => (e && e.message ? e.message : String(e));

  // ---------- Format support ----------

  const support = { "image/png": true, "image/jpeg": true, "image/webp": false, "image/avif": false };

  function makeCanvas(w, h) {
    if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  }

  function encodeCanvas(canvas, mime, quality) {
    if (typeof canvas.convertToBlob === "function") return canvas.convertToBlob({ type: mime, quality });
    return new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("The browser could not encode this image"))), mime, quality);
    });
  }

  async function detectSupport() {
    for (const mime of ["image/webp", "image/avif"]) {
      try {
        const c = makeCanvas(1, 1);
        // A canvas needs a rendering context before it can be encoded (OffscreenCanvas throws otherwise).
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, 1, 1);
        const blob = await encodeCanvas(c, mime, 0.8);
        support[mime] = blob.type === mime;
      } catch (e) { support[mime] = false; }
    }
    // PNG and JPEG encoding is required by the HTML spec in every browser.
    support["image/png"] = true;
    support["image/jpeg"] = true;
  }

  /** Disable unsupported output formats in a select and explain why in a note element. */
  function applySupport(select, note) {
    const missing = [];
    for (const opt of select.options) {
      if (opt.value in support && !support[opt.value]) {
        opt.disabled = true;
        opt.textContent = `${opt.textContent} (not supported here)`;
        missing.push(opt.value.replace("image/", "").toUpperCase());
        if (select.value === opt.value) select.selectedIndex = 0;
      }
    }
    if (note && missing.length) note.textContent = `This browser cannot encode ${missing.join(" or ")}; those options are disabled.`;
  }

  async function encode(canvas, mime, quality) {
    const blob = await encodeCanvas(canvas, mime, quality);
    if (blob.type !== mime) throw new Error(`This browser cannot encode ${mime.replace("image/", "").toUpperCase()}`);
    return blob;
  }

  // ---------- Decoding and drawing ----------

  function mimeOfFile(file) {
    const ext = T.extension(file.name);
    const byExt = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", avif: "image/avif", gif: "image/gif", bmp: "image/bmp", svg: "image/svg+xml", ico: "image/x-icon" }[ext];
    return byExt || file.type || "";
  }

  function loadImgElement(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("The browser could not read this image")); };
      img.src = url;
    });
  }

  /** Returns {source, width, height, vector, close()}. SVGs are sized from svgWidth (or their natural size). */
  async function decodeImage(file, svgWidth) {
    const isSvg = mimeOfFile(file) === "image/svg+xml";
    if (!isSvg && typeof createImageBitmap === "function") {
      try {
        const bmp = await createImageBitmap(file);
        return { source: bmp, width: bmp.width, height: bmp.height, vector: false, close: () => bmp.close() };
      } catch (e) { /* fall back to an <img> element */ }
    }
    const img = await loadImgElement(file);
    let w = img.naturalWidth;
    let h = img.naturalHeight;
    if (isSvg) {
      if (!w || !h) { w = 512; h = 512; }
      if (svgWidth) { h = Math.max(1, Math.round((svgWidth * h) / w)); w = Math.round(svgWidth); }
    }
    if (!w || !h) throw new Error("The image has no readable dimensions");
    return { source: img, width: w, height: h, vector: isSvg, close() {} };
  }

  function checkSize(w, h) {
    if (w * h > MAX_PIXELS) throw new Error(`Output would be ${w} x ${h} pixels, which is too large for the browser`);
  }

  /** Draw the decoded image at dw x dh; large reductions go through halving steps. bg fills transparency. */
  function renderScaled(dec, dw, dh, bg) {
    checkSize(dw, dh);
    const steps = dec.vector ? [{ width: dw, height: dh }] : C.downscaleSteps(dec.width, dec.height, dw, dh);
    let src = dec.source;
    let sw = dec.width;
    let sh = dec.height;
    let canvas = null;
    steps.forEach((step, i) => {
      canvas = makeCanvas(step.width, step.height);
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      if (bg && i === steps.length - 1) { ctx.fillStyle = bg; ctx.fillRect(0, 0, step.width, step.height); }
      ctx.drawImage(src, 0, 0, sw, sh, 0, 0, step.width, step.height);
      src = canvas;
      sw = step.width;
      sh = step.height;
    });
    return canvas;
  }

  const EXT_FOR_MIME = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/avif": "avif" };
  const extFor = (mime) => EXT_FOR_MIME[mime] || "png";

  /** Output mime when the user chose "keep": same type when we can encode it, otherwise a sensible fallback. */
  function keepMime(file, preferred) {
    const m = mimeOfFile(file);
    if (m === "image/jpeg" || m === "image/png") return { mime: m, fallback: false };
    if ((m === "image/webp" || m === "image/avif") && support[m]) return { mime: m, fallback: false };
    const alt = preferred || (support["image/webp"] ? "image/webp" : "image/png");
    return { mime: alt, fallback: true };
  }

  function readBytes(file) { return file.arrayBuffer().then((b) => new Uint8Array(b)); }

  // ---------- Batch list framework ----------

  let nextId = 1;

  function createBatch(panel, cfg) {
    const listEl = $('[data-role="list"]', panel);
    const statusEl = $('[data-role="status"]', panel);
    const runBtn = $('[data-role="run"]', panel);
    const zipBtn = $('[data-role="zip"]', panel);
    const clearBtn = $('[data-role="clear"]', panel);
    let items = [];
    let running = false;

    function refreshButtons() {
      runBtn.disabled = running || !items.length;
      clearBtn.disabled = running || !items.length;
      zipBtn.disabled = running || items.filter((i) => i.result).length < 2;
    }

    function buildRow(item) {
      const li = document.createElement("li");
      li.className = "file-item";
      const thumb = document.createElement("img");
      thumb.className = "thumb";
      thumb.alt = "";
      thumb.src = item.thumbUrl;
      thumb.addEventListener("error", () => { thumb.style.visibility = "hidden"; });
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = item.file.name;
      name.title = item.file.name;
      const orig = document.createElement("span");
      orig.className = "meta";
      orig.textContent = T.formatBytes(item.file.size);
      const out = document.createElement("span");
      out.className = "meta";
      const pct = document.createElement("span");
      pct.className = "meta";
      const dl = document.createElement("button");
      dl.type = "button";
      dl.className = "ghost";
      dl.textContent = "Download";
      dl.hidden = true;
      dl.addEventListener("click", () => item.result && T.download(item.result.blob, item.result.name));
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "ghost";
      rm.textContent = "Remove";
      rm.addEventListener("click", () => removeItem(item));
      const note = document.createElement("p");
      note.className = "note";
      note.hidden = true;
      const warn = document.createElement("p");
      warn.className = "note warn";
      warn.hidden = true;
      li.append(thumb, name, orig, out, pct, dl, rm, warn, note);
      item.ui = { li, out, pct, dl, note, warn, rm };
      return li;
    }

    function updateRow(item) {
      const u = item.ui;
      if (item.error) {
        u.out.textContent = "";
        u.pct.textContent = "";
        u.dl.hidden = true;
        u.note.hidden = false;
        u.note.className = "note error";
        u.note.textContent = item.error;
      } else if (item.result) {
        const size = item.result.blob.size;
        u.out.textContent = `-> ${T.formatBytes(size)}`;
        const p = C.savingsPercent(item.file.size, size);
        u.pct.className = `meta ${p >= 0 ? "saving" : "growth"}`;
        u.pct.textContent = p >= 0 ? `-${p}%` : `+${Math.abs(p)}%`;
        u.dl.hidden = false;
        u.note.className = "note";
        u.note.hidden = !item.result.note;
        u.note.textContent = item.result.note || "";
      } else {
        u.out.textContent = "";
        u.pct.textContent = "";
        u.dl.hidden = true;
        u.note.className = "note";
        u.note.hidden = !item.info;
        u.note.textContent = item.info || "";
      }
      u.warn.hidden = !item.warn;
      u.warn.textContent = item.warn || "";
    }

    function removeItem(item) {
      if (running) return;
      URL.revokeObjectURL(item.thumbUrl);
      items = items.filter((i) => i !== item);
      item.ui.li.remove();
      refreshButtons();
      if (cfg.onChange) cfg.onChange(items);
    }

    function add(files) {
      for (const file of files) {
        const item = { id: nextId++, file, thumbUrl: URL.createObjectURL(file), result: null, error: null, info: "", warn: "" };
        items.push(item);
        listEl.appendChild(buildRow(item));
        updateRow(item);
        if (cfg.onAdd) Promise.resolve(cfg.onAdd(item)).then(() => updateRow(item)).catch(() => {});
      }
      T.setStatus(statusEl, `${items.length} file${items.length === 1 ? "" : "s"} ready.`, "idle");
      refreshButtons();
      if (cfg.onChange) cfg.onChange(items);
    }

    function clear() {
      if (running) return;
      items.forEach((i) => URL.revokeObjectURL(i.thumbUrl));
      items = [];
      listEl.textContent = "";
      T.setStatus(statusEl, "", "idle");
      refreshButtons();
      if (cfg.onChange) cfg.onChange(items);
    }

    async function run() {
      if (running || !items.length) return;
      running = true;
      refreshButtons();
      let ok = 0;
      let failed = 0;
      let origTotal = 0;
      let outTotal = 0;
      try {
        if (cfg.prepare) cfg.prepare();
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          item.result = null;
          item.error = null;
          T.setStatus(statusEl, `Processing ${i + 1}/${items.length}: ${item.file.name}`, "busy");
          await tick();
          try {
            item.result = await cfg.process(item);
            ok += 1;
            origTotal += item.file.size;
            outTotal += item.result.blob.size;
          } catch (e) {
            item.error = errMsg(e);
            failed += 1;
          }
          updateRow(item);
        }
        const p = C.savingsPercent(origTotal, outTotal);
        const total = ok ? ` ${T.formatBytes(origTotal)} -> ${T.formatBytes(outTotal)} (${p >= 0 ? `saved ${p}%` : `${Math.abs(p)}% larger`}).` : "";
        T.setStatus(statusEl, `Done: ${ok} processed${failed ? `, ${failed} failed` : ""}.${total}`, failed && !ok ? "error" : "ok");
      } catch (e) {
        T.setStatus(statusEl, errMsg(e), "error");
      } finally {
        running = false;
        refreshButtons();
      }
    }

    async function downloadZip() {
      const files = items.filter((i) => i.result).map((i) => ({ name: i.result.name, data: i.result.blob }));
      if (!files.length) return;
      try {
        T.setStatus(statusEl, "Building zip...", "busy");
        T.download(await T.zip(files), `${cfg.zipName || "images"}.zip`, "application/zip");
        T.setStatus(statusEl, `Zip with ${files.length} files downloaded.`, "ok");
      } catch (e) {
        T.setStatus(statusEl, errMsg(e), "error");
      }
    }

    T.mountDropZone($('[data-role="drop"]', panel), {
      accept: IMAGE_ACCEPT,
      multiple: true,
      onFiles: add,
      onReject: (msg) => T.setStatus(statusEl, msg, "error"),
    });
    runBtn.addEventListener("click", run);
    zipBtn.addEventListener("click", downloadZip);
    clearBtn.addEventListener("click", clear);
    refreshButtons();
    return { get items() { return items; }, status: statusEl };
  }

  /** Keep a range input and its <output> in sync. */
  function bindRange(input, output) {
    const sync = () => { output.textContent = Number(input.value).toFixed(2); };
    input.addEventListener("input", sync);
    sync();
  }

  const num = (el) => (el.value === "" ? null : Number(el.value));
  const panelOf = (id) => $(`[data-panel="${id}"]`);

  // ---------- Compress ----------

  function initCompress() {
    const p = panelOf("compress");
    const quality = $("#c-quality");
    bindRange(quality, $("#c-quality-out"));

    createBatch(p, {
      zipName: "compressed-images",
      async process(item) {
        const q = Number(quality.value);
        const fmt = $("#c-format").value;
        const maxDim = num($("#c-max"));
        const targetOn = $("#c-target-on").checked;
        const targetKb = num($("#c-target-kb"));
        if (targetOn && !(targetKb > 0)) throw new Error("Enter a target size in KB");

        const dec = await decodeImage(item.file);
        try {
          let w = dec.width;
          let h = dec.height;
          if (maxDim > 0) ({ width: w, height: h } = C.computeResize({ width: w, height: h }, { mode: "fit", width: maxDim, height: maxDim, noEnlarge: true }));
          let mime;
          let fallbackNote = "";
          if (fmt === "keep") {
            const k = keepMime(item.file);
            mime = k.mime;
            if (k.fallback) fallbackNote = `${mimeOfFile(item.file).replace("image/", "").toUpperCase()} cannot be kept, so it was re-encoded as ${extFor(mime).toUpperCase()}. `;
          } else mime = fmt;
          if (!support[mime]) throw new Error(`This browser cannot encode ${extFor(mime).toUpperCase()}`);

          const canvas = renderScaled(dec, w, h, mime === "image/jpeg" ? "#ffffff" : null);
          const lossy = mime !== "image/png";
          let blob;
          let note = fallbackNote;
          if (targetOn && lossy) {
            const cache = new Map();
            const r = await C.findTargetQuality(async (qq) => {
              const b = await encode(canvas, mime, qq);
              cache.set(qq, b);
              return b.size;
            }, targetKb * 1024, { minQuality: 0.05, maxQuality: q, maxIterations: 8 });
            blob = cache.get(r.quality);
            note += r.met ? `Quality ${r.quality.toFixed(2)} fits ${targetKb} KB. ` : `Could not reach ${targetKb} KB; smallest result at quality ${r.quality.toFixed(2)}. Try a smaller max width/height. `;
          } else {
            blob = await encode(canvas, mime, q);
            if (targetOn && !lossy) note += "Target size does not apply to PNG; choose WebP or JPEG. ";
            if (mime === "image/png") note += "PNG is lossless; WebP usually saves much more. ";
          }
          if (blob.size >= item.file.size) {
            return { blob: item.file, name: item.file.name, note: `Compressed output (${T.formatBytes(blob.size)}) was not smaller, so the original was kept.` };
          }
          return { blob, name: `${T.baseName(item.file.name)}-compressed.${extFor(mime)}`, note: `${dec.width}x${dec.height}${w !== dec.width ? ` -> ${w}x${h}` : ""}. ${note}`.trim() };
        } finally { dec.close(); }
      },
    });
  }

  // ---------- Convert ----------

  function initConvert() {
    const p = panelOf("convert");
    const format = $("#v-format");
    const quality = $("#v-quality");
    bindRange(quality, $("#v-quality-out"));
    const syncUi = () => {
      const f = format.value;
      $("#v-ico-opts").classList.toggle("is-hidden", f !== "ico");
      $("#v-quality-field").classList.toggle("is-hidden", f === "image/png" || f === "ico");
    };
    format.addEventListener("change", syncUi);
    syncUi();

    createBatch(p, {
      zipName: "converted-images",
      async process(item) {
        const f = format.value;
        const bg = $("#v-bg").value;
        const svgW = num($("#v-svgw"));
        const dec = await decodeImage(item.file, svgW > 0 ? svgW : undefined);
        try {
          if (f === "ico") {
            const sizes = Array.from(p.querySelectorAll('input[name="v-ico-size"]:checked')).map((c) => Number(c.value));
            if (!sizes.length) throw new Error("Select at least one ICO size");
            const fill = $("#v-ico-fill").checked ? bg : null;
            const entries = [];
            for (const size of sizes) {
              const fit = C.computeResize(dec, { mode: "fit", width: size, height: size });
              const scaled = renderScaled(dec, fit.width, fit.height, null);
              const sq = makeCanvas(size, size);
              const ctx = sq.getContext("2d");
              if (fill) { ctx.fillStyle = fill; ctx.fillRect(0, 0, size, size); }
              ctx.imageSmoothingQuality = "high";
              ctx.drawImage(scaled, Math.round((size - fit.width) / 2), Math.round((size - fit.height) / 2));
              entries.push({ size, pngBytes: new Uint8Array(await (await encode(sq, "image/png")).arrayBuffer()) });
            }
            const blob = new Blob([C.buildIco(entries)], { type: "image/x-icon" });
            return { blob, name: `${T.baseName(item.file.name)}.ico`, note: `Sizes: ${sizes.join(", ")}` };
          }
          if (!support[f]) throw new Error(`This browser cannot encode ${extFor(f).toUpperCase()}`);
          const canvas = renderScaled(dec, dec.width, dec.height, f === "image/jpeg" ? bg : null);
          const blob = await encode(canvas, f, Number(quality.value));
          return { blob, name: `${T.baseName(item.file.name)}.${extFor(f)}`, note: `${dec.width}x${dec.height}` };
        } finally { dec.close(); }
      },
    });
  }

  // ---------- Resize ----------

  function initResize() {
    const p = panelOf("resize");
    const mode = $("#r-mode");
    bindRange($("#r-quality"), $("#r-quality-out"));
    const syncMode = () => p.querySelectorAll("[data-mode]").forEach((el) => el.classList.toggle("is-hidden", el.dataset.mode !== mode.value));
    mode.addEventListener("change", syncMode);
    syncMode();

    createBatch(p, {
      zipName: "resized-images",
      async process(item) {
        const dec = await decodeImage(item.file);
        try {
          const opts = { mode: mode.value, lockAspect: $("#r-lock").checked, noEnlarge: $("#r-noenlarge").checked, percent: num($("#r-pct")) };
          if (mode.value === "fit") { opts.width = num($("#r-fw")); opts.height = num($("#r-fh")); }
          else { opts.width = num($("#r-w")); opts.height = num($("#r-h")); }
          const size = C.computeResize(dec, opts);
          const fmt = $("#r-format").value;
          const mime = fmt === "keep" ? keepMime(item.file, "image/png").mime : fmt;
          if (!support[mime]) throw new Error(`This browser cannot encode ${extFor(mime).toUpperCase()}`);
          const canvas = renderScaled(dec, size.width, size.height, mime === "image/jpeg" ? "#ffffff" : null);
          const blob = await encode(canvas, mime, Number($("#r-quality").value));
          return { blob, name: `${T.baseName(item.file.name)}-resized.${extFor(mime)}`, note: `${dec.width}x${dec.height} -> ${size.width}x${size.height}` };
        } finally { dec.close(); }
      },
    });
  }

  // ---------- Crop & rotate ----------

  function initTransform() {
    const p = panelOf("transform");
    const ratio = $("#t-ratio");
    bindRange($("#t-quality"), $("#t-quality-out"));
    const previewEl = $("#t-preview");
    const dimsEl = $("#t-dims");

    function options() {
      return {
        rotate: Number($("#t-rotate").value),
        flipH: $("#t-fliph").checked,
        flipV: $("#t-flipv").checked,
        ratio: ratio.value,
        rect: { x: num($("#t-x")), y: num($("#t-y")), width: num($("#t-w")), height: num($("#t-h")) },
      };
    }

    /** Rotate/flip, then crop. Returns a canvas. */
    function transformImage(dec, o) {
      const swap = o.rotate === 90 || o.rotate === 270;
      const w = swap ? dec.height : dec.width;
      const h = swap ? dec.width : dec.height;
      checkSize(w, h);
      let canvas = makeCanvas(w, h);
      const ctx = canvas.getContext("2d");
      ctx.translate(w / 2, h / 2);
      ctx.scale(o.flipH ? -1 : 1, o.flipV ? -1 : 1);
      ctx.rotate((o.rotate * Math.PI) / 180);
      ctx.drawImage(dec.source, -dec.width / 2, -dec.height / 2, dec.width, dec.height);
      let rect = null;
      if (o.ratio === "free") rect = C.clampCrop({ width: w, height: h }, o.rect);
      else if (o.ratio !== "none") rect = C.computeCrop({ width: w, height: h }, o.ratio);
      if (rect) {
        const cropped = makeCanvas(rect.width, rect.height);
        cropped.getContext("2d").drawImage(canvas, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
        canvas = cropped;
      }
      return canvas;
    }

    // Live preview of the first image, debounced; stale renders are discarded.
    let previewSeq = 0;
    let previewTimer = null;
    let previewDec = null;
    let previewFileId = null;
    async function renderPreview() {
      const seq = ++previewSeq;
      const first = batch.items[0];
      if (!first) {
        previewEl.innerHTML = '<p class="hint">Add an image to see a live preview.</p>';
        dimsEl.textContent = "";
        if (previewDec) { previewDec.close(); previewDec = null; previewFileId = null; }
        return;
      }
      try {
        if (previewFileId !== first.id) {
          if (previewDec) previewDec.close();
          previewDec = await decodeImage(first.file);
          previewFileId = first.id;
        }
        if (seq !== previewSeq) return;
        const result = transformImage(previewDec, options());
        const maxW = 640;
        const scale = Math.min(1, maxW / result.width);
        const view = document.createElement("canvas");
        view.width = Math.max(1, Math.round(result.width * scale));
        view.height = Math.max(1, Math.round(result.height * scale));
        const vctx = view.getContext("2d");
        vctx.imageSmoothingQuality = "high";
        vctx.drawImage(result, 0, 0, view.width, view.height);
        previewEl.textContent = "";
        previewEl.appendChild(view);
        dimsEl.textContent = `Source ${previewDec.width}x${previewDec.height}, result ${result.width}x${result.height}.`;
      } catch (e) {
        previewEl.textContent = errMsg(e);
        dimsEl.textContent = "";
      }
    }
    function schedulePreview() {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(renderPreview, 120);
    }

    const batch = createBatch(p, {
      zipName: "edited-images",
      onChange: schedulePreview,
      async process(item) {
        const dec = await decodeImage(item.file);
        try {
          const canvas = transformImage(dec, options());
          const fmt = $("#t-format").value;
          const mime = fmt === "keep" ? keepMime(item.file, "image/png").mime : fmt;
          if (!support[mime]) throw new Error(`This browser cannot encode ${extFor(mime).toUpperCase()}`);
          if (mime === "image/jpeg") {
            const flat = makeCanvas(canvas.width, canvas.height);
            const fctx = flat.getContext("2d");
            fctx.fillStyle = "#ffffff";
            fctx.fillRect(0, 0, flat.width, flat.height);
            fctx.drawImage(canvas, 0, 0);
            return finish(item, await encode(flat, mime, Number($("#t-quality").value)), mime, canvas, dec);
          }
          return finish(item, await encode(canvas, mime, Number($("#t-quality").value)), mime, canvas, dec);
        } finally { dec.close(); }
      },
    });
    function finish(item, blob, mime, canvas, dec) {
      return { blob, name: `${T.baseName(item.file.name)}-edited.${extFor(mime)}`, note: `${dec.width}x${dec.height} -> ${canvas.width}x${canvas.height}` };
    }

    ratio.addEventListener("change", () => $("#t-free").classList.toggle("is-hidden", ratio.value !== "free"));
    p.querySelectorAll("select, input[type=checkbox], input[type=number]").forEach((el) => {
      el.addEventListener("input", schedulePreview);
      el.addEventListener("change", schedulePreview);
    });
  }

  // ---------- Strip metadata ----------

  function describeJpeg(bytes) {
    const s = C.readExifSummary(bytes);
    const segs = C.listJpegMetadata(bytes);
    const lines = [];
    if (s.hasExif) {
      const bits = [];
      if (s.make || s.model) bits.push(`Camera: ${[s.make, s.model].filter(Boolean).join(" ")}`);
      if (s.dateTimeOriginal) bits.push(`Taken: ${s.dateTimeOriginal}`);
      if (s.orientation) bits.push(`Orientation: ${s.orientation}`);
      if (s.software) bits.push(`Software: ${s.software}`);
      if (bits.length) lines.push(bits.join(" | "));
    }
    if (segs.length) lines.push(`Blocks: ${segs.map((x) => `${x.label} (${T.formatBytes(x.size)})`).join(", ")}`);
    return { text: lines.length ? lines.join(". ") : "No metadata blocks found.", gps: s.hasGps };
  }

  function describePng(bytes) {
    const list = C.listPngMetadata(bytes);
    const s = C.readExifSummary(bytes);
    const lines = [];
    if (list.length) lines.push(`Chunks: ${list.map((c) => (c.keyword ? `${c.type} "${c.keyword}"` : c.type)).join(", ")}`);
    if (s.hasExif) {
      const bits = [];
      if (s.make || s.model) bits.push(`Camera: ${[s.make, s.model].filter(Boolean).join(" ")}`);
      if (s.dateTimeOriginal) bits.push(`Taken: ${s.dateTimeOriginal}`);
      if (bits.length) lines.push(bits.join(" | "));
    }
    return { text: lines.length ? lines.join(". ") : "No metadata chunks found.", gps: s.hasGps };
  }

  function initMetadata() {
    const p = panelOf("metadata");
    createBatch(p, {
      zipName: "clean-images",
      async onAdd(item) {
        try {
          const bytes = await readBytes(item.file);
          let d = null;
          if (C.isJpeg(bytes)) d = describeJpeg(bytes);
          else if (C.isPng(bytes)) d = describePng(bytes);
          if (d) {
            item.info = d.text;
            item.warn = d.gps ? "Privacy warning: this file contains GPS location data." : "";
          } else item.info = "Metadata is not inspected for this format; it will be re-encoded to remove it.";
        } catch (e) { item.info = `Could not read metadata: ${errMsg(e)}`; }
      },
      async process(item) {
        const bytes = await readBytes(item.file);
        const base = T.baseName(item.file.name);
        if (C.isJpeg(bytes)) {
          const out = C.stripJpegMetadata(bytes, { keepIcc: $("#m-icc").checked });
          return { blob: new Blob([out], { type: "image/jpeg" }), name: `${base}-clean.jpg`, note: `Lossless: removed ${T.formatBytes(bytes.length - out.length)} of metadata.` };
        }
        if (C.isPng(bytes)) {
          const out = C.stripPngMetadata(bytes);
          return { blob: new Blob([out], { type: "image/png" }), name: `${base}-clean.png`, note: `Lossless: removed ${T.formatBytes(bytes.length - out.length)} of metadata.` };
        }
        const dec = await decodeImage(item.file);
        try {
          const src = mimeOfFile(item.file);
          const mime = src === "image/webp" && support["image/webp"] ? "image/webp" : "image/png";
          const canvas = renderScaled(dec, dec.width, dec.height, null);
          const blob = await encode(canvas, mime, 1);
          return { blob, name: `${base}-clean.${extFor(mime)}`, note: "Re-encoded through a canvas, which drops all metadata." };
        } finally { dec.close(); }
      },
    });
  }

  // ---------- Base64 ----------

  function initBase64() {
    const p = panelOf("base64");
    const listEl = $('[data-role="list"]', p);
    const statusEl = $('[data-role="status"]', p);
    const out = $("#b-out");
    const copyBtn = $("#b-copy");
    const saveBtn = $("#b-save");
    const mode = $("#b-mode");
    const DISPLAY_CAP = 2000000;
    let entries = []; // {file, dataUrl}
    let selected = null;
    let currentText = "";

    function textFor(entry) {
      return mode.value === "raw" ? entry.dataUrl.slice(entry.dataUrl.indexOf(",") + 1) : entry.dataUrl;
    }
    function show(entry) {
      selected = entry;
      currentText = textFor(entry);
      out.value = currentText.length > DISPLAY_CAP ? `${currentText.slice(0, DISPLAY_CAP)}\n... (display truncated; Copy and Download use the full text)` : currentText;
      copyBtn.disabled = false;
      saveBtn.disabled = false;
      listEl.querySelectorAll(".file-item").forEach((li) => li.classList.toggle("is-selected", li.dataset.id === String(entry.id)));
    }
    function renderRow(entry) {
      const li = document.createElement("li");
      li.className = "file-item";
      li.dataset.id = entry.id;
      const thumb = document.createElement("img");
      thumb.className = "thumb";
      thumb.alt = "";
      thumb.src = entry.dataUrl;
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = entry.file.name;
      const orig = document.createElement("span");
      orig.className = "meta";
      orig.textContent = T.formatBytes(entry.file.size);
      const sz = document.createElement("span");
      sz.className = "meta growth";
      sz.textContent = `-> ${T.formatBytes(entry.dataUrl.length)} text`;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ghost";
      btn.textContent = "Show";
      btn.addEventListener("click", () => show(entry));
      li.append(thumb, name, orig, sz, btn);
      listEl.appendChild(li);
    }

    T.mountDropZone($('[data-role="drop"]', p), {
      accept: IMAGE_ACCEPT,
      multiple: true,
      onReject: (msg) => T.setStatus(statusEl, msg, "error"),
      async onFiles(files) {
        try {
          for (let i = 0; i < files.length; i++) {
            T.setStatus(statusEl, `Encoding ${i + 1}/${files.length}: ${files[i].name}`, "busy");
            await tick();
            let dataUrl = await T.readAsDataURL(files[i]);
            // Some browsers report an empty type for .ico/.avif; fix the data URL header from the extension.
            if (/^data:(application\/octet-stream)?;base64,/.test(dataUrl)) dataUrl = dataUrl.replace(/^data:[^,]*,/, `data:${mimeOfFile(files[i]) || "application/octet-stream"};base64,`);
            const entry = { id: nextId++, file: files[i], dataUrl };
            entries.push(entry);
            renderRow(entry);
            show(entry);
          }
          T.setStatus(statusEl, `Encoded ${files.length} file${files.length === 1 ? "" : "s"}.`, "ok");
        } catch (e) {
          T.setStatus(statusEl, errMsg(e), "error");
        }
      },
    });
    mode.addEventListener("change", () => { if (selected) show(selected); });
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(currentText);
        T.setStatus(statusEl, "Copied to clipboard.", "ok");
      } catch (e) {
        out.focus();
        out.select();
        T.setStatus(statusEl, "Clipboard access was blocked; the text is selected, press Ctrl+C.", "error");
      }
    });
    saveBtn.addEventListener("click", () => selected && T.download(currentText, `${T.baseName(selected.file.name)}.base64.txt`, "text/plain"));

    // Decode
    const preview = $("#b-preview");
    const dstatus = $("#b-dstatus");
    const dlBtn = $("#b-dl");
    let decoded = null;
    let previewUrl = null;
    $("#b-decode").addEventListener("click", () => {
      try {
        const parsed = C.parseBase64Input($("#b-in").value);
        const bin = atob(parsed.base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const mime = C.sniffImageType(bytes) || (parsed.mime && parsed.mime.startsWith("image/") ? parsed.mime : null);
        if (!mime) throw new Error("The decoded data is not a recognised image");
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        decoded = { blob: new Blob([bytes], { type: mime }), name: `decoded.${C.extensionForMime(mime)}` };
        previewUrl = URL.createObjectURL(decoded.blob);
        const img = document.createElement("img");
        img.alt = "Decoded image preview";
        img.addEventListener("error", () => { dstatus.dataset.state = "error"; dstatus.textContent = "The data decoded, but the browser cannot display it as an image."; });
        img.src = previewUrl;
        preview.textContent = "";
        preview.appendChild(img);
        dlBtn.disabled = false;
        T.setStatus(dstatus, `Decoded ${mime.replace("image/", "").toUpperCase()}, ${T.formatBytes(bytes.length)}.`, "ok");
      } catch (e) {
        decoded = null;
        dlBtn.disabled = true;
        preview.innerHTML = '<p class="hint">Decoded image appears here.</p>';
        T.setStatus(dstatus, errMsg(e) === "Failed to execute 'atob' on 'Window': The string to be decoded is not correctly encoded." ? "This is not valid base64" : errMsg(e), "error");
      }
    });
    dlBtn.addEventListener("click", () => decoded && T.download(decoded.blob, decoded.name));
  }

  // ---------- Boot ----------

  T.mountTabs(document.getElementById("tabs"));
  initCompress();
  initConvert();
  initResize();
  initTransform();
  initMetadata();
  initBase64();

  detectSupport().then(() => {
    applySupport($("#c-format"), $("#c-support-note"));
    applySupport($("#v-format"), $("#v-support-note"));
    applySupport($("#r-format"), $("#r-support-note"));
    applySupport($("#t-format"), $("#t-support-note"));
  });
})();
