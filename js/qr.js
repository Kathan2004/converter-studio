/* UI wiring for the QR code tab (images.html): make QR codes (PNG/SVG) and read them from images. */
(function () {
  "use strict";

  const Q = window.QrCore;
  const T = window.Tools;
  const panel = document.querySelector('[data-panel="qr"]');
  if (!panel || !Q) return;
  const $ = (id) => document.getElementById(id);

  const status = $("qr-status");
  const makePane = $("qr-make");
  const readPane = $("qr-read");
  const modeBtns = Array.from(panel.querySelectorAll("[data-qr-mode]"));
  let current = null; // { svg, matrix, text }

  // ---------- script loading ----------
  const loading = {};
  function loadScript(src, ready) {
    if (ready()) return Promise.resolve();
    if (!loading[src]) {
      loading[src] = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = src;
        s.onload = resolve;
        s.onerror = () => { delete loading[src]; reject(new Error("Could not load a QR library.")); };
        document.head.appendChild(s);
      });
    }
    return loading[src];
  }
  const loadGenerator = () => loadScript("vendor/qrcode-generator.js", () => typeof window.qrcode === "function")
    .then(() => { window.qrcode.stringToBytes = window.qrcode.stringToBytesFuncs["UTF-8"]; });
  const loadReader = () => loadScript("vendor/jsQR.js", () => typeof window.jsQR === "function");

  // ---------- mode switch ----------
  function setMode(mode) {
    modeBtns.forEach((b) => {
      const on = b.dataset.qrMode === mode;
      b.setAttribute("aria-checked", String(on));
      b.classList.toggle("is-on", on);
      b.tabIndex = on ? 0 : -1;
    });
    makePane.classList.toggle("is-hidden", mode !== "make");
    readPane.classList.toggle("is-hidden", mode !== "read");
    T.setStatus(status, "", "idle");
    if (mode === "make") renderMake();
  }
  modeBtns.forEach((b, i) => {
    b.addEventListener("click", () => setMode(b.dataset.qrMode));
    b.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        const n = modeBtns[(i + 1) % modeBtns.length];
        n.focus();
        setMode(n.dataset.qrMode);
      }
    });
  });

  // ---------- make ----------
  const kind = $("qr-kind");
  function syncKind() {
    panel.querySelectorAll("[data-qr-kind]").forEach((el) => el.classList.toggle("is-hidden", el.dataset.qrKind !== kind.value));
    $("qr-wifi-pass-field").classList.toggle("is-hidden", kind.value === "wifi" && $("qr-wifi-sec").value === "nopass");
  }

  function payload() {
    if (kind.value === "wifi") {
      const ssid = $("qr-wifi-ssid").value;
      if (!ssid) return "";
      return Q.wifiPayload({ ssid, password: $("qr-wifi-pass").value, security: $("qr-wifi-sec").value, hidden: $("qr-wifi-hidden").checked });
    }
    if (kind.value === "email") {
      const to = $("qr-mail-to").value.trim();
      if (!to) return "";
      return Q.emailPayload({ to, subject: $("qr-mail-subject").value, body: $("qr-mail-body").value });
    }
    return $("qr-text").value;
  }

  async function renderMake() {
    const text = payload();
    const preview = $("qr-preview");
    const dl = [$("qr-png"), $("qr-svg")];
    current = null;
    if (!text) {
      preview.textContent = "";
      dl.forEach((b) => { b.disabled = true; });
      $("qr-meta").textContent = "";
      T.setStatus(status, "", "idle");
      return;
    }
    try {
      await loadGenerator();
      const qr = window.qrcode(0, $("qr-ecc").value);
      qr.addData(text, "Byte");
      qr.make();
      const matrix = Q.matrixFromQr(qr);
      const fg = $("qr-fg").value;
      const bg = $("qr-bg").value;
      const size = Math.min(2048, Math.max(64, Number($("qr-size").value) || 320));
      const svg = Q.matrixToSvg(matrix, { fg, bg, margin: 4, size });
      current = { svg, matrix, text, fg, bg, size };
      const img = document.createElement("img");
      img.alt = "QR code preview";
      img.width = Math.min(size, 360);
      img.height = img.width;
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      preview.textContent = "";
      preview.appendChild(img);
      dl.forEach((b) => { b.disabled = false; });
      $("qr-meta").textContent = `${matrix.length}x${matrix.length} modules`;
      T.setStatus(status, "", "idle");
    } catch (e) {
      preview.textContent = "";
      dl.forEach((b) => { b.disabled = true; });
      T.setStatus(status, /overflow|too long|length/i.test(String(e && e.message)) ? "Too much data for a QR code. Shorten it or lower the error correction." : "Could not create the QR code.", "error");
    }
  }

  function pngBlob() {
    const n = current.matrix.length + 8;
    const scale = Math.max(1, Math.floor(current.size / n));
    const canvas = document.createElement("canvas");
    canvas.width = n * scale;
    canvas.height = n * scale;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = current.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = current.fg;
    current.matrix.forEach((row, r) => row.forEach((dark, c) => {
      if (dark) ctx.fillRect((c + 4) * scale, (r + 4) * scale, scale, scale);
    }));
    return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode"))), "image/png"));
  }

  $("qr-png").addEventListener("click", async () => {
    if (!current) return;
    try { T.download(await pngBlob(), "qrcode.png", "image/png"); T.setStatus(status, "Saved qrcode.png.", "ok"); }
    catch (e) { T.setStatus(status, "Could not create the PNG.", "error"); }
  });
  $("qr-svg").addEventListener("click", () => {
    if (!current) return;
    T.download(new Blob([current.svg], { type: "image/svg+xml" }), "qrcode.svg", "image/svg+xml");
    T.setStatus(status, "Saved qrcode.svg.", "ok");
  });

  kind.addEventListener("change", () => { syncKind(); renderMake(); });
  $("qr-wifi-sec").addEventListener("change", () => { syncKind(); renderMake(); });
  panel.querySelectorAll("[data-qr-live]").forEach((el) => {
    el.addEventListener("input", renderMake);
    el.addEventListener("change", renderMake);
  });

  // ---------- read ----------
  const MAX_SIDE = 2400;

  async function decodeFile(file) {
    await loadReader();
    const bmp = await createImageBitmap(file);
    try {
      const attempts = [1, 0.5, 0.25].filter((f, i) => i === 0 || Math.max(bmp.width, bmp.height) * f >= 200);
      for (const f of attempts) {
        let scale = f;
        if (Math.max(bmp.width, bmp.height) * scale > MAX_SIDE) scale = MAX_SIDE / Math.max(bmp.width, bmp.height);
        const w = Math.max(1, Math.round(bmp.width * scale));
        const h = Math.max(1, Math.round(bmp.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(bmp, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h);
        const hit = window.jsQR(data.data, w, h, { inversionAttempts: "attemptBoth" });
        if (hit && hit.data !== undefined) return hit.data;
      }
      return null;
    } finally { bmp.close(); }
  }

  function showResult(text) {
    const box = $("qr-result");
    const out = $("qr-text-out");
    const open = $("qr-open");
    box.classList.toggle("is-hidden", text === null);
    if (text === null) return;
    out.value = text;
    if (Q.isHttpUrl(text)) {
      open.href = text.trim();
      open.classList.remove("is-hidden");
    } else {
      open.removeAttribute("href");
      open.classList.add("is-hidden");
    }
  }

  async function readFile(file) {
    setMode("read");
    showResult(null);
    const thumb = $("qr-source");
    if (thumb.dataset.url) URL.revokeObjectURL(thumb.dataset.url);
    thumb.dataset.url = URL.createObjectURL(file);
    thumb.src = thumb.dataset.url;
    thumb.classList.remove("is-hidden");
    T.setStatus(status, "Reading...", "busy");
    try {
      const text = await decodeFile(file);
      if (text === null) { T.setStatus(status, "No QR code found in this image.", "error"); return; }
      showResult(text);
      T.setStatus(status, "QR code read.", "ok");
    } catch (e) {
      T.setStatus(status, "Could not read this image.", "error");
    }
  }

  T.mountDropZone($("qr-drop"), {
    accept: ".png,.jpg,.jpeg,.webp,.gif,.bmp,.avif,image/*",
    multiple: false,
    onReject: (m) => T.setStatus(status, m, "error"),
    onFiles: (files) => readFile(files[0]),
  });

  document.addEventListener("paste", (e) => {
    if (panel.classList.contains("is-hidden")) return;
    const file = Array.from((e.clipboardData && e.clipboardData.files) || []).find((f) => f.type.startsWith("image/"));
    if (!file) return;
    e.preventDefault();
    readFile(file);
  });

  $("qr-copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("qr-text-out").value); T.setStatus(status, "Copied.", "ok"); }
    catch (e) { $("qr-text-out").select(); T.setStatus(status, "Clipboard blocked; the text is selected, press Ctrl+C.", "error"); }
  });

  syncKind();
  setMode("make");
})();
