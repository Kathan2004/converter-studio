/* UI wiring for the "Searchable PDF" tab of documents.html. OCR runs locally (tesseract.js, pdf.js, pdf-lib; all vendored). */
(function () {
  "use strict";

  const C = window.OcrPdfCore;
  const T = window.Tools;
  const panel = document.querySelector('[data-panel="ocr-pdf"]');
  if (!panel || !C || !T) return;

  const $ = (id) => document.getElementById(id);
  const el = { drop: $("op-drop"), pages: $("op-pages"), bar: $("op-bar"), batch: $("op-batch"), zip: $("op-zip"), status: $("op-status") };
  const MAX_SOURCE_PIXELS = 40e6;
  const RENDER_SCALE = 2; // pdf.js render scale for OCR and for the embedded page image
  const JPEG_QUALITY = 0.8;
  const abs = (p) => new URL(p, location.href).href;
  const errMsg = (e) => (e && e.message ? e.message : String(e));

  let busy = false;
  let results = [];
  let workerPromise = null;
  let currentProgress = () => {};

  // ---------- Lazy loading ----------

  const scripts = {};
  function loadScript(src) {
    if (!scripts[src]) {
      scripts[src] = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = src;
        s.onload = resolve;
        s.onerror = () => { delete scripts[src]; reject(new Error(`Could not load ${src}`)); };
        document.head.appendChild(s);
      });
    }
    return scripts[src];
  }

  async function loadPdfJs() {
    const pdfjs = await import(abs("vendor/pdf.min.mjs"));
    pdfjs.GlobalWorkerOptions.workerSrc = abs("vendor/pdf.worker.min.mjs");
    return pdfjs;
  }

  // ---------- OCR worker (same options as js/ocr.js) ----------

  const ENGINE_START_TIMEOUT_MS = 45000;
  const STARTUP_LABELS = {
    "loading tesseract core": "loading OCR engine",
    "initializing tesseract": "starting OCR engine",
    "loading language traineddata": "loading English model",
    "initializing api": "preparing recognizer",
  };

  function setStage(text) {
    T.setStatus(el.status, `Preparing OCR: ${text}`, "busy");
  }

  async function startWorker() {
    if (!window.Tesseract) await loadScript("vendor/tesseract/tesseract.min.js");
    let created = null;
    let timer = null;
    const starting = window.Tesseract.createWorker("eng", 1, {
      workerPath: abs("vendor/tesseract/worker.min.js"),
      corePath: abs("vendor/tesseract/core/"),
      langPath: abs("vendor/tesseract/lang"),
      gzip: true,
      workerBlobURL: false, // CSP: the worker script must be same-origin, not a blob
      cacheMethod: "none", // the model is a same-origin file; skip the IndexedDB copy
      logger: (m) => {
        if (STARTUP_LABELS[m.status] && !created) {
          const pct = Number.isFinite(m.progress) ? ` ${Math.round(m.progress * 100)}%` : "";
          setStage(`${STARTUP_LABELS[m.status]}${pct}`);
        }
        currentProgress(m);
      },
    }).then((w) => { created = w; return w; });
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("The OCR engine did not start in time.")), ENGINE_START_TIMEOUT_MS);
    });
    try {
      return await Promise.race([starting, timeout]);
    } catch (e) {
      starting.then((w) => w.terminate()).catch(() => {});
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  function getWorker() {
    if (!workerPromise) {
      workerPromise = startWorker().catch(() => {
        setStage("retrying engine start");
        return startWorker();
      }).catch((e) => {
        throw new Error(`${e.message} Reload the page and try again.`);
      });
      workerPromise.catch(() => { workerPromise = null; });
    }
    return workerPromise;
  }

  window.addEventListener("pagehide", () => {
    if (workerPromise) workerPromise.then((w) => w.terminate()).catch(() => {});
    workerPromise = null;
  });

  // ---------- Page building ----------

  function makeCanvas(w, h) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  }

  function toJpeg(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? b.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)), reject) : reject(new Error("Could not encode the page image"))), "image/jpeg", JPEG_QUALITY);
    });
  }

  async function recognize(canvas, label, page, total) {
    const worker = await getWorker();
    currentProgress = (m) => {
      if (m.status === "recognizing text") {
        T.setStatus(el.status, `${label}: page ${page} of ${total}, reading ${Math.round(m.progress * 100)}%`, "busy");
      }
    };
    try {
      const { data } = await worker.recognize(canvas);
      return data.words || [];
    } finally {
      currentProgress = () => {};
    }
  }

  /** Add one page: the image at the original size plus invisible, selectable words. */
  async function addPage(ctx, canvas, widthPt, heightPt, words) {
    const { pdf, font } = ctx;
    const jpg = await pdf.embedJpg(await toJpeg(canvas));
    const page = pdf.addPage([widthPt, heightPt]);
    page.drawImage(jpg, { x: 0, y: 0, width: widthPt, height: heightPt });
    const scale = C.scaleFor(widthPt, heightPt, canvas.width, canvas.height);
    const canEncode = (ch) => { try { font.encodeText(ch); return true; } catch (e) { return false; } };
    let drawn = 0;
    for (const w of words) {
      const text = C.encodable(w.text, canEncode);
      if (!text) continue;
      const p = C.placeWord({ text, bbox: w.bbox }, scale, heightPt, font.widthOfTextAtSize(text, 1));
      if (!p) continue;
      page.drawText(p.text, { x: p.x, y: p.y, size: p.size, font, opacity: 0 });
      drawn++;
    }
    return drawn;
  }

  async function ocrPdfFile(ctx, file, label) {
    const pdfjs = await loadPdfJs();
    let doc;
    try {
      doc = await pdfjs.getDocument({ data: new Uint8Array(await T.readAsArrayBuffer(file)), isEvalSupported: false }).promise;
    } catch (e) {
      if (e && e.name === "PasswordException") throw new Error("the PDF is encrypted; remove the password first");
      throw new Error(`could not open this PDF (${errMsg(e)})`);
    }
    try {
      const pages = C.parsePages(el.pages.value, doc.numPages);
      let words = 0;
      for (let i = 0; i < pages.length; i++) {
        const n = pages[i];
        T.setStatus(el.status, `${label}: page ${i + 1} of ${pages.length}, rendering`, "busy");
        el.bar.value = i / pages.length;
        const page = await doc.getPage(n);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: RENDER_SCALE });
        if (viewport.width * viewport.height > MAX_SOURCE_PIXELS) throw new Error(`page ${n} is too large to render`);
        const canvas = makeCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const g = canvas.getContext("2d");
        g.fillStyle = "#fff";
        g.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: g, viewport }).promise;
        const found = await recognize(canvas, label, i + 1, pages.length);
        words += await addPage(ctx, canvas, base.width, base.height, found);
        page.cleanup();
      }
      return { pages: pages.length, words };
    } finally {
      doc.destroy();
    }
  }

  async function ocrImageFile(ctx, file, label) {
    const bitmap = await createImageBitmap(file).catch(() => { throw new Error("could not decode this image"); });
    try {
      if (bitmap.width * bitmap.height > MAX_SOURCE_PIXELS) throw new Error("the image is too large (over 40 megapixels)");
      const canvas = makeCanvas(bitmap.width, bitmap.height);
      const g = canvas.getContext("2d");
      g.fillStyle = "#fff"; // transparent PNGs would otherwise turn black in the JPEG
      g.fillRect(0, 0, canvas.width, canvas.height);
      g.drawImage(bitmap, 0, 0);
      // Assume a 150 dpi scan, but keep the page within A4's long side.
      const pt = Math.min(0.48, 842 / Math.max(bitmap.width, bitmap.height));
      const found = await recognize(canvas, label, 1, 1);
      const words = await addPage(ctx, canvas, bitmap.width * pt, bitmap.height * pt, found);
      return { pages: 1, words };
    } finally {
      if (bitmap.close) bitmap.close();
    }
  }

  async function convert(file) {
    await Promise.all([loadScript("vendor/pdf-lib.min.js"), getWorker()]);
    const pdf = await PDFLib.PDFDocument.create();
    const font = await pdf.embedFont(PDFLib.StandardFonts.Helvetica);
    const ctx = { pdf, font };
    const isPdf = /\.pdf$/i.test(file.name) || file.type === "application/pdf";
    const info = isPdf ? await ocrPdfFile(ctx, file, file.name) : await ocrImageFile(ctx, file, file.name);
    const bytes = await pdf.save();
    return { name: `${T.safeFilename(T.baseName(file.name))}-searchable.pdf`, blob: new Blob([bytes], { type: "application/pdf" }), pages: info.pages, words: info.words };
  }

  // ---------- UI ----------

  function renderList() {
    el.batch.textContent = "";
    results.forEach((r) => {
      const li = document.createElement("li");
      li.className = "file-item";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = r.error ? `${r.source}: ${r.error}` : r.name;
      li.appendChild(name);
      if (!r.error) {
        const meta = document.createElement("span");
        meta.className = "meta";
        meta.textContent = `${r.pages} page${r.pages === 1 ? "" : "s"}, ${r.words} words, ${T.formatBytes(r.blob.size)}`;
        li.appendChild(meta);
        const dl = document.createElement("button");
        dl.type = "button";
        dl.className = "ghost";
        dl.textContent = "Download";
        dl.addEventListener("click", () => T.download(r.blob, r.name, "application/pdf"));
        li.appendChild(dl);
      }
      el.batch.appendChild(li);
    });
  }

  async function run(files) {
    if (busy) { T.setStatus(el.status, "Still working on the previous files.", "error"); return; }
    busy = true;
    results = [];
    el.zip.disabled = true;
    renderList();
    try {
      for (let i = 0; i < files.length; i++) {
        T.setStatus(el.status, `Reading ${files[i].name} (${i + 1} of ${files.length})`, "busy");
        try {
          results.push(await convert(files[i]));
        } catch (err) {
          console.error(err);
          results.push({ error: errMsg(err), source: files[i].name });
        }
        el.bar.value = (i + 1) / files.length;
      }
      renderList();
      const ok = results.filter((r) => !r.error);
      el.zip.disabled = ok.length < 2;
      const failed = results.length - ok.length;
      T.setStatus(el.status, failed ? `Converted ${ok.length} of ${files.length} files.` : `Done. ${ok.length} searchable PDF${ok.length === 1 ? "" : "s"} ready.`, failed ? "error" : "ok");
    } catch (err) {
      T.setStatus(el.status, `Failed: ${errMsg(err)}`, "error");
    } finally {
      busy = false;
    }
  }

  el.zip.addEventListener("click", async () => {
    const files = results.filter((r) => !r.error).map((r) => ({ name: r.name, data: r.blob }));
    if (files.length) T.download(await T.zip(files), "searchable-pdfs.zip", "application/zip");
  });

  T.mountDropZone(el.drop, {
    accept: ".pdf,.png,.jpg,.jpeg",
    multiple: true,
    onFiles: run,
    onReject: (m) => T.setStatus(el.status, `Unsupported file: ${m}`, "error"),
  });
})();
