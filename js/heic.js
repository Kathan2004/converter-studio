/*
 * HEIC to JPG/PNG (images.html, tab "heic"). Decoding order:
 *   1. the browser's own decoder (createImageBitmap) where it supports HEIC (Safari, some OS codecs);
 *   2. heic2any (libheif), which needs dynamic code evaluation. The production CSP forbids that, so
 *      when it is blocked the tool shows a clear "not supported here" message instead of failing.
 */
(function () {
  "use strict";

  const T = window.Tools;
  const panel = document.querySelector('[data-panel="heic"]');
  if (!panel) return;
  const $ = (id) => document.getElementById(id);
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const fmt = T.formatBytes;
  const UNSUPPORTED = "HEIC decoding is not supported here: this browser cannot read HEIC and the page's security policy blocks the fallback decoder.";
  const BRANDS = ["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1", "heif"];

  const status = $("heic-status");
  const list = $("heic-list");
  const runBtn = $("heic-run");
  const zipBtn = $("heic-zip");
  const clearBtn = $("heic-clear");
  const format = $("heic-format");
  const quality = $("heic-quality");
  let items = [];
  let running = false;

  const cell = (tag, text, cls) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    el.textContent = text;
    return el;
  };

  function looksLikeHeic(bytes) {
    if (bytes.length < 12) return false;
    const box = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    return box === "ftyp" && BRANDS.includes(brand);
  }

  // heic2any needs new Function(). Read the page's own CSP first so a blocked attempt does not
  // raise a violation report; fall back to trying when the header cannot be read.
  let evalOk = null;
  async function canEval() {
    if (evalOk !== null) return evalOk;
    try {
      const res = await fetch(location.href, { method: "HEAD", cache: "force-cache" });
      const csp = res.headers.get("content-security-policy") || "";
      const scriptSrc = (csp.split(";").map((d) => d.trim()).find((d) => /^script-src(\s|$)/.test(d)))
        || (csp.split(";").map((d) => d.trim()).find((d) => /^default-src(\s|$)/.test(d))) || "";
      if (csp && !/'unsafe-eval'/.test(scriptSrc)) { evalOk = false; return false; }
    } catch (e) { /* unreadable: try below */ }
    try { evalOk = Boolean(new Function("return 1")()); } catch (e) { evalOk = false; }
    return evalOk;
  }

  let libPromise = null;
  function loadHeic2any() {
    if (window.heic2any) return Promise.resolve(window.heic2any);
    if (!libPromise) {
      libPromise = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "vendor/heic2any.min.js";
        s.onload = () => resolve(window.heic2any);
        s.onerror = () => { libPromise = null; reject(new Error("Could not load the HEIC decoder.")); };
        document.head.appendChild(s);
      });
    }
    return libPromise;
  }

  function encodeCanvas(canvas, mime, q) {
    return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("The browser could not encode this image."))), mime, q));
  }

  async function nativeConvert(file, mime, q) {
    const bmp = await createImageBitmap(file);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      const ctx = canvas.getContext("2d");
      if (mime === "image/jpeg") { ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, bmp.width, bmp.height); }
      ctx.drawImage(bmp, 0, 0);
      return await encodeCanvas(canvas, mime, q);
    } finally { bmp.close(); }
  }

  async function convert(file) {
    const mime = format.value;
    const q = Number(quality.value);
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    if (!looksLikeHeic(head)) throw new Error("This is not a HEIC/HEIF file.");
    try { return await nativeConvert(file, mime, q); } catch (e) { /* fall through to heic2any */ }
    if (!(await canEval())) throw new Error(UNSUPPORTED);
    try {
      const lib = await loadHeic2any();
      const out = await lib({ blob: file, toType: mime, quality: q });
      return Array.isArray(out) ? out[0] : out;
    } catch (e) {
      throw new Error(e && e.message && !/^ERR_/.test(String(e.message)) ? e.message : "Could not decode this HEIC file.");
    }
  }

  function refresh() {
    runBtn.disabled = running || !items.length;
    clearBtn.disabled = running || !items.length;
    zipBtn.disabled = running || items.filter((i) => i.result).length < 2;
  }

  function renderRow(item) {
    const u = item.ui;
    u.note.hidden = !(item.error || item.result);
    u.note.className = item.error ? "note error" : "note";
    u.note.textContent = item.error || (item.result ? `${item.result.name} (${fmt(item.result.blob.size)})` : "");
    u.dl.hidden = !item.result;
  }

  function buildRow(item) {
    const li = document.createElement("li");
    li.className = "file-item";
    const dl = cell("button", "Download", "ghost");
    dl.type = "button";
    dl.hidden = true;
    dl.addEventListener("click", () => item.result && T.download(item.result.blob, item.result.name));
    const rm = cell("button", "Remove", "ghost");
    rm.type = "button";
    rm.setAttribute("aria-label", `Remove ${item.file.name}`);
    rm.addEventListener("click", () => { if (running) return; items = items.filter((i) => i !== item); li.remove(); refresh(); });
    const note = cell("p", "", "note");
    note.hidden = true;
    li.append(cell("span", item.file.name, "name"), cell("span", fmt(item.file.size), "meta"), dl, rm, note);
    item.ui = { li, dl, note };
    return li;
  }

  const syncFormat = () => $("heic-quality-field").classList.toggle("is-hidden", format.value === "image/png");
  format.addEventListener("change", syncFormat);
  quality.addEventListener("input", () => { $("heic-quality-out").textContent = Number(quality.value).toFixed(2); });
  syncFormat();

  T.mountDropZone($("heic-drop"), {
    accept: ".heic,.heif,image/heic,image/heif",
    multiple: true,
    onReject: (m) => T.setStatus(status, m, "error"),
    onFiles(files) {
      for (const file of files) {
        const item = { file, result: null, error: "" };
        items.push(item);
        list.appendChild(buildRow(item));
      }
      T.setStatus(status, `${items.length} file${items.length === 1 ? "" : "s"} ready.`, "idle");
      refresh();
    },
  });

  runBtn.addEventListener("click", async () => {
    if (running || !items.length) return;
    running = true;
    refresh();
    let ok = 0;
    let failed = 0;
    const ext = format.value === "image/png" ? "png" : "jpg";
    try {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        item.result = null;
        item.error = "";
        T.setStatus(status, `Converting ${i + 1}/${items.length}: ${item.file.name}`, "busy");
        await tick();
        try {
          const blob = await convert(item.file);
          item.result = { blob, name: `${T.safeFilename(T.baseName(item.file.name))}.${ext}` };
          ok += 1;
        } catch (e) {
          item.error = e && e.message ? e.message : "Could not convert this file.";
          failed += 1;
        }
        renderRow(item);
      }
      const firstErr = (items.find((i) => i.error) || {}).error;
      T.setStatus(status, failed && !ok ? firstErr : `Done: ${ok} converted${failed ? `, ${failed} failed` : ""}.`, failed && !ok ? "error" : "ok");
    } finally {
      running = false;
      refresh();
    }
  });

  zipBtn.addEventListener("click", async () => {
    const seen = new Set();
    const files = items.filter((i) => i.result).map((i) => {
      let name = i.result.name;
      for (let n = 2; seen.has(name); n++) name = i.result.name.replace(/(\.[^.]+)$/, ` (${n})$1`);
      seen.add(name);
      return { name, data: i.result.blob };
    });
    if (files.length < 2) return;
    try {
      T.download(await T.zip(files), "heic-converted.zip", "application/zip");
      T.setStatus(status, `Zip with ${files.length} files downloaded.`, "ok");
    } catch (e) {
      T.setStatus(status, "Could not build the zip.", "error");
    }
  });

  clearBtn.addEventListener("click", () => {
    if (running) return;
    items = [];
    list.textContent = "";
    T.setStatus(status, "", "idle");
    refresh();
  });

  refresh();
})();
