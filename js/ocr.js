/* UI wiring for the "Image to text" tab of images.html. Everything runs locally (tesseract.js + pdf.js, vendored). */
(function () {
  "use strict";

  const C = window.OcrCore;
  const T = window.Tools;
  const panel = document.querySelector('[data-panel="ocr"]');
  if (!panel || !C || !T) return;

  const $ = (id) => document.getElementById(id);
  const el = {
    drop: panel.querySelector('[data-role="drop"]'),
    paste: $("ocr-paste"), stage: $("ocr-stage"), bar: $("ocr-bar"), status: $("ocr-status"),
    separate: $("ocr-separate"), hyphen: $("ocr-hyphen"), lines: $("ocr-lines"), enhance: $("ocr-enhance"), pages: $("ocr-pages"),
    out: $("ocr-output"), conf: $("ocr-conf"), chars: $("ocr-chars"), words: $("ocr-words"),
    copy: $("ocr-copy"), save: $("ocr-save"), clear: $("ocr-clear"),
  };
  const ACCEPT = ".png,.jpg,.jpeg,.webp,.avif,.gif,.bmp,.pdf";
  const MAX_SOURCE_PIXELS = 40e6;
  const abs = (p) => new URL(p, location.href).href;
  const errMsg = (e) => (e && e.message ? e.message : String(e));

  const queue = [];
  let busy = false;
  let pasteCount = 0;
  let confidences = [];
  let previewUrl = null;
  let workerPromise = null;
  let currentProgress = () => {};

  // ---------- Lazy loading ----------

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`Could not load ${src}`));
      document.head.appendChild(s);
    });
  }

  /** Report engine start-up progress (first use only) in the status line. */
  function setStage(text) {
    T.setStatus(el.status, `Preparing OCR: ${text}`, "busy");
  }

  const ENGINE_START_TIMEOUT_MS = 45000;
  const STARTUP_LABELS = {
    "loading tesseract core": "loading OCR engine",
    "initializing tesseract": "starting OCR engine",
    "loading language traineddata": "loading English model",
    "initializing api": "preparing recognizer",
  };

  /** Start one Tesseract worker; reject (and kill it) if it does not come up in time. */
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
      // One automatic retry with a fresh worker if the first start hangs or fails.
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

  async function loadPdfJs() {
    const pdfjs = await import(abs("vendor/pdf.min.mjs"));
    pdfjs.GlobalWorkerOptions.workerSrc = abs("vendor/pdf.worker.min.mjs");
    return pdfjs;
  }

  window.addEventListener("pagehide", () => {
    if (workerPromise) workerPromise.then((w) => w.terminate()).catch(() => {});
    workerPromise = null;
  });

  // ---------- UI helpers ----------

  function setBar(fraction) {
    el.bar.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
  }

  function updateStats() {
    const text = el.out.value;
    el.chars.textContent = `${text.length.toLocaleString()} characters`;
    el.words.textContent = `${C.countWords(text).toLocaleString()} words`;
    const avg = C.averageConfidence(confidences);
    el.conf.textContent = `Confidence: ${avg === null ? "n/a" : C.formatConfidence(avg)}`;
    const has = text.trim().length > 0;
    el.copy.disabled = !has;
    el.save.disabled = !has;
    el.clear.disabled = !has && !queue.length && !busy;
  }

  function showPreview(source) {
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    el.stage.textContent = "";
    if (source instanceof Blob) {
      previewUrl = URL.createObjectURL(source);
      const img = document.createElement("img");
      img.alt = "Image being read";
      img.src = previewUrl;
      el.stage.appendChild(img);
    }
  }

  function canvasToBlob(canvas) {
    return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/png"));
  }

  // ---------- Image preparation ----------

  function makeCanvas(w, h) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  }

  /** Draw a bitmap/canvas to a (possibly upscaled, enhanced) canvas ready for recognition. */
  function prepare(source, w, h, scale) {
    const canvas = makeCanvas(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)));
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#fff"; // transparent screenshots would otherwise turn black
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    if (el.enhance.checked) {
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
      C.enhancePixels(data.data);
      ctx.putImageData(data, 0, 0);
    }
    return canvas;
  }

  // ---------- Recognition ----------

  async function recognize(canvas, label, baseFraction, spanFraction) {
    const worker = await getWorker();
    currentProgress = (m) => {
      if (m.status === "recognizing text") {
        setBar(baseFraction + spanFraction * m.progress);
        T.setStatus(el.status, `${label}: reading text ${Math.round(m.progress * 100)}%`, "busy");
      } else if (m.status) {
        T.setStatus(el.status, `${label}: ${m.status}`, "busy");
      }
    };
    el.stage.classList.add("is-scanning");
    try {
      const { data } = await worker.recognize(canvas);
      return { text: C.cleanText(data.text, { joinHyphens: el.hyphen.checked, keepLineBreaks: el.lines.checked }), confidence: data.confidence };
    } finally {
      el.stage.classList.remove("is-scanning");
      currentProgress = () => {};
    }
  }

  function addResult(text, label, withHeading) {
    if (!text) return;
    const heading = withHeading && el.separate.checked ? label : "";
    el.out.value = C.appendBlock(el.out.value, text, heading);
    updateStats();
  }

  async function processImage(file, index, total) {
    const label = file.name;
    const bitmap = await createImageBitmap(file).catch(() => { throw new Error(`${file.name}: could not decode this image`); });
    try {
      if (bitmap.width * bitmap.height > MAX_SOURCE_PIXELS) throw new Error(`${file.name}: image is too large to read (over 40 megapixels)`);
      const canvas = prepare(bitmap, bitmap.width, bitmap.height, C.chooseScale(bitmap.width, bitmap.height));
      showPreview(await canvasToBlob(canvas));
      const r = await recognize(canvas, label, index / total, 1 / total);
      if (Number.isFinite(r.confidence)) confidences.push(r.confidence);
      if (!r.text) return `${file.name}: no text found`;
      addResult(r.text, label, true);
      return "";
    } finally {
      if (bitmap.close) bitmap.close();
    }
  }

  async function processPdf(file, index, total) {
    const pdfjs = await loadPdfJs();
    let doc;
    try {
      doc = await pdfjs.getDocument({ data: new Uint8Array(await T.readAsArrayBuffer(file)) }).promise;
    } catch (e) {
      if (e && e.name === "PasswordException") throw new Error(`${file.name}: the PDF is encrypted; remove the password first`);
      throw new Error(`${file.name}: could not open this PDF (${errMsg(e)})`);
    }
    try {
      const pageList = C.parsePages(el.pages.value, doc.numPages);
      const notes = [];
      for (let i = 0; i < pageList.length; i++) {
        const n = pageList[i];
        const label = `${file.name}, page ${n}`;
        const base = (index + i / pageList.length) / total;
        T.setStatus(el.status, `${label}: rendering`, "busy");
        const page = await doc.getPage(n);
        const viewport = page.getViewport({ scale: 2 });
        if (viewport.width * viewport.height > MAX_SOURCE_PIXELS) throw new Error(`${label}: page is too large to render`);
        const raw = makeCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const ctx = raw.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, raw.width, raw.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        const canvas = el.enhance.checked ? prepare(raw, raw.width, raw.height, 1) : raw;
        showPreview(await canvasToBlob(canvas));
        const r = await recognize(canvas, label, base, 1 / (total * pageList.length));
        if (Number.isFinite(r.confidence)) confidences.push(r.confidence);
        if (r.text) addResult(r.text, `${file.name} - Page ${n}`, true);
        else notes.push(`page ${n}`);
        page.cleanup();
      }
      return notes.length ? `${file.name}: no text found on ${notes.join(", ")}` : "";
    } finally {
      doc.destroy();
    }
  }

  async function run() {
    if (busy) return;
    busy = true;
    const done = [];
    const problems = [];
    let total = queue.length;
    let index = 0;
    try {
      while (queue.length) {
        const file = queue.shift();
        total = Math.max(total, index + 1 + queue.length);
        T.setStatus(el.status, `Reading ${file.name} (${index + 1} of ${total})`, "busy");
        try {
          const isPdf = /\.pdf$/i.test(file.name) || file.type === "application/pdf";
          const note = isPdf ? await processPdf(file, index, total) : await processImage(file, index, total);
          if (note) problems.push(note);
          else done.push(file.name);
        } catch (e) {
          problems.push(errMsg(e));
        }
        index++;
        setBar(index / total);
      }
    } finally {
      busy = false;
      currentProgress = () => {};
      el.stage.classList.remove("is-scanning");
      updateStats();
    }
    if (problems.length) T.setStatus(el.status, problems.join("; "), "error");
    else T.setStatus(el.status, `Done. Read ${done.length} file${done.length === 1 ? "" : "s"}. Review the text, then copy it.`, "ok");
  }

  function enqueue(files) {
    const list = Array.from(files);
    if (!list.length) return;
    queue.push(...list);
    updateStats();
    run();
  }

  // ---------- Input handling ----------

  T.mountDropZone(el.drop, {
    accept: ACCEPT,
    multiple: true,
    onFiles: enqueue,
    onReject: (msg) => T.setStatus(el.status, `Unsupported file: ${msg}`, "error"),
  });

  document.addEventListener("paste", (e) => {
    if (panel.classList.contains("is-hidden")) return;
    const items = Array.from((e.clipboardData && e.clipboardData.items) || []).filter((i) => i.kind === "file" && i.type.startsWith("image/"));
    if (!items.length) return;
    e.preventDefault();
    const files = items.map((i) => i.getAsFile()).filter(Boolean).map((f) => {
      const ext = (f.type.split("/")[1] || "png").replace("jpeg", "jpg");
      return new File([f], `pasted-image-${++pasteCount}.${ext}`, { type: f.type });
    });
    el.paste.classList.add("is-flash");
    setTimeout(() => el.paste.classList.remove("is-flash"), 600);
    enqueue(files);
  });

  // ---------- Output actions ----------

  el.out.addEventListener("input", updateStats);

  el.copy.addEventListener("click", async () => {
    const text = el.out.value;
    try {
      await navigator.clipboard.writeText(text);
      T.setStatus(el.status, "Copied to the clipboard.", "ok");
    } catch (e) {
      el.out.focus();
      el.out.select();
      T.setStatus(el.status, "Automatic copy was blocked. The text is selected; press Ctrl+C to copy it.", "error");
    }
  });

  el.save.addEventListener("click", () => {
    T.download(el.out.value, "extracted-text.txt", "text/plain;charset=utf-8");
  });

  el.clear.addEventListener("click", () => {
    queue.length = 0;
    el.out.value = "";
    confidences = [];
    showPreview(null);
    el.stage.innerHTML = '<p class="hint" style="padding:16px;margin:0">The image being read appears here.</p>';
    setBar(0);
    T.setStatus(el.status, busy ? "Finishing the current file." : "", "idle");
    updateStats();
  });

  updateStats();
})();
