/* Sign PDF: draw or type a signature, place it on pages, embed it as PNG with pdf-lib. Local only. */
(function () {
  "use strict";

  const T = window.Tools;
  const U = window.PdfUi;
  const C = window.PdfSecureCore;
  const $ = (id) => document.getElementById(id);

  const FONT_STACK = '"Snell Roundhand", "Segoe Script", "Brush Script MT", cursive';
  const status = $("sign-status");
  const saveBtn = $("sign-save");

  let doc = null;            // pdf.js document
  let cur = null;            // { file, bytes, count }
  let pageNo = 1;
  let pageInfo = null;       // { view, rotate, width, height } for the displayed page, in points
  let renderToken = 0;
  let mode = "draw";
  let pad = null;
  let selected = -1;
  const placements = [];     // { page, rect, png: Uint8Array, url, aspect }
  let counter = 0;

  // ---------- Signature source ----------
  const penColor = () => $("sign-pen").value;

  function resizeDrawCanvas() {
    const canvas = $("sign-canvas");
    const w = canvas.clientWidth;
    if (!w) return;
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    const data = pad ? pad.toData() : null;
    canvas.width = Math.round(w * ratio);
    canvas.height = Math.round(canvas.clientHeight * ratio);
    canvas.getContext("2d").scale(ratio, ratio);
    if (pad) { pad.clear(); if (data && data.length) pad.fromData(data); }
  }

  async function ensurePad() {
    if (pad) return;
    await U.loadScript("vendor/signature_pad.umd.min.js");
    pad = new window.SignaturePad($("sign-canvas"), { penColor: penColor(), minWidth: 0.8, maxWidth: 2.6 });
    resizeDrawCanvas();
  }

  function setMode(m) {
    mode = m;
    $("sign-mode-draw").setAttribute("aria-pressed", String(m === "draw"));
    $("sign-mode-type").setAttribute("aria-pressed", String(m === "type"));
    $("sign-draw-box").classList.toggle("is-hidden", m !== "draw");
    $("sign-type-box").classList.toggle("is-hidden", m !== "type");
    if (m === "draw") resizeDrawCanvas(); else renderTypePreview();
  }

  function renderText(text, color) {
    const size = 110;
    const measure = document.createElement("canvas").getContext("2d");
    measure.font = `${size}px ${FONT_STACK}`;
    const w = Math.ceil(measure.measureText(text).width) + 40;
    const c = document.createElement("canvas");
    c.width = Math.min(w, 4000);
    c.height = Math.round(size * 1.7);
    const g = c.getContext("2d");
    g.font = `${size}px ${FONT_STACK}`;
    g.textBaseline = "alphabetic";
    g.fillStyle = color;
    g.fillText(text, 20, Math.round(size * 1.15));
    return c;
  }

  function renderTypePreview() {
    const text = $("sign-text").value;
    const c = $("sign-type-preview");
    const g = c.getContext("2d");
    g.clearRect(0, 0, c.width, c.height);
    if (!text.trim()) return;
    const src = renderText(text, penColor());
    const k = Math.min(c.width / src.width, c.height / src.height, 1);
    g.drawImage(src, 0, 0, src.width * k, src.height * k);
  }

  function recolor(canvas, color) {
    const g = canvas.getContext("2d");
    g.globalCompositeOperation = "source-in";
    g.fillStyle = color;
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.globalCompositeOperation = "source-over";
  }

  function trim(canvas, pad4) {
    const g = canvas.getContext("2d");
    const img = g.getImageData(0, 0, canvas.width, canvas.height);
    const b = C.inkBounds(img.data, canvas.width, canvas.height, pad4);
    if (!b) return null;
    const out = document.createElement("canvas");
    out.width = b.width;
    out.height = b.height;
    out.getContext("2d").drawImage(canvas, b.x, b.y, b.width, b.height, 0, 0, b.width, b.height);
    return out;
  }

  /** The signature (plus optional date line) as a tightly cropped canvas, or null when empty. */
  function buildSignature() {
    let base;
    if (mode === "draw") {
      if (!pad || pad.isEmpty()) return null;
      const copy = document.createElement("canvas");
      const src = $("sign-canvas");
      copy.width = src.width;
      copy.height = src.height;
      copy.getContext("2d").drawImage(src, 0, 0);
      recolor(copy, penColor());
      base = trim(copy, 6);
    } else {
      const text = $("sign-text").value;
      if (!text.trim()) return null;
      base = trim(renderText(text, penColor()), 6);
    }
    if (!base) return null;
    if (!$("sign-date").checked) return base;
    const fs = Math.max(18, Math.round(base.height * 0.22));
    const label = C.formatDate(new Date());
    const m = document.createElement("canvas").getContext("2d");
    m.font = `${fs}px sans-serif`;
    const tw = Math.ceil(m.measureText(label).width);
    const out = document.createElement("canvas");
    out.width = Math.max(base.width, tw + 8);
    out.height = base.height + fs + 10;
    const g = out.getContext("2d");
    g.drawImage(base, 0, 0);
    g.font = `${fs}px sans-serif`;
    g.fillStyle = penColor();
    g.textBaseline = "top";
    g.fillText(label, 4, base.height + 6);
    return out;
  }

  // ---------- Page preview ----------
  function stageWidth() {
    return Math.max(160, Math.min($("sign-stage-wrap").clientWidth || 600, 900));
  }

  async function renderPage() {
    if (!doc) return;
    const token = ++renderToken;
    const page = await doc.getPage(pageNo);
    if (token !== renderToken) return;
    const rotate = ((page.rotate % 360) + 360) % 360;
    const vp1 = page.getViewport({ scale: 1 });
    const view = { x0: page.view[0], y0: page.view[1], width: page.view[2] - page.view[0], height: page.view[3] - page.view[1] };
    const scale = C.previewScale(vp1.width, vp1.height, stageWidth(), 0);
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const vp = page.getViewport({ scale: scale * ratio });
    const canvas = $("sign-page");
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    canvas.style.width = Math.round(vp1.width * scale) + "px";
    canvas.style.height = Math.round(vp1.height * scale) + "px";
    const g = canvas.getContext("2d");
    g.fillStyle = "#fff";
    g.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: g, viewport: vp }).promise;
    if (token !== renderToken) return;
    pageInfo = { view, rotate };
    $("sign-stage").style.width = canvas.style.width;
    drawOverlays();
  }

  function drawOverlays() {
    const host = $("sign-overlays");
    host.textContent = "";
    placements.forEach((p, i) => {
      if (p.page !== pageNo) return;
      const el = document.createElement("div");
      el.className = "sig-ph" + (i === selected ? " is-selected" : "");
      el.style.left = p.rect.nx * 100 + "%";
      el.style.top = p.rect.ny * 100 + "%";
      el.style.width = p.rect.nw * 100 + "%";
      el.style.height = p.rect.nh * 100 + "%";
      el.dataset.index = String(i);
      const img = document.createElement("img");
      img.src = p.url;
      img.alt = "Signature";
      img.draggable = false;
      el.appendChild(img);
      host.appendChild(el);
    });
  }

  function renderList() {
    const ul = $("sign-list");
    ul.textContent = "";
    placements.forEach((p, i) => {
      const li = document.createElement("li");
      li.className = "file-item";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = `Signature ${p.n}`;
      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = `page ${p.page}`;
      const rm = document.createElement("button");
      rm.className = "ghost";
      rm.type = "button";
      rm.textContent = "Remove";
      rm.setAttribute("aria-label", `Remove signature ${p.n}`);
      rm.addEventListener("click", () => {
        placements.splice(i, 1);
        if (selected >= placements.length || selected === i) selected = -1;
        renderList();
        drawOverlays();
      });
      li.append(name, meta, rm);
      ul.appendChild(li);
    });
    saveBtn.disabled = !placements.length;
  }

  function widthFrac() { return Number($("sign-size").value) / 100; }

  async function placeAt(clientX, clientY) {
    const sig = buildSignature();
    if (!sig) { T.setStatus(status, "Draw or type your signature first.", "error"); return; }
    const box = $("sign-page").getBoundingClientRect();
    const rect = C.placementFromClick(clientX - box.left, clientY - box.top, box.width, box.height, sig.width / sig.height, widthFrac());
    const blob = await U.canvasToBlob(sig, "image/png");
    const png = new Uint8Array(await blob.arrayBuffer());
    placements.push({ page: pageNo, rect, png, url: sig.toDataURL("image/png"), aspect: sig.width / sig.height, n: ++counter });
    selected = placements.length - 1;
    T.setStatus(status, "", "idle");
    renderList();
    drawOverlays();
  }

  // Click/tap on the page places a signature; dragging a placed one moves it.
  function wireStage() {
    const stage = $("sign-stage");
    let drag = null;
    stage.addEventListener("pointerdown", (e) => {
      const el = e.target.closest(".sig-ph");
      if (!el) return;
      const i = Number(el.dataset.index);
      selected = i;
      const p = placements[i];
      const box = $("sign-page").getBoundingClientRect();
      drag = { i, sx: e.clientX, sy: e.clientY, nx: p.rect.nx, ny: p.rect.ny, box, moved: false };
      stage.setPointerCapture(e.pointerId);
      $("sign-size").value = String(Math.round(p.rect.nw * 100));
      drawOverlays();
      e.preventDefault();
    });
    stage.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const p = placements[drag.i];
      const dx = (e.clientX - drag.sx) / drag.box.width;
      const dy = (e.clientY - drag.sy) / drag.box.height;
      if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 3) drag.moved = true;
      p.rect.nx = Math.min(Math.max(drag.nx + dx, 0), 1 - p.rect.nw);
      p.rect.ny = Math.min(Math.max(drag.ny + dy, 0), 1 - p.rect.nh);
      drawOverlays();
    });
    const end = (e) => {
      if (!drag) return;
      try { stage.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
      drag = null;
    };
    stage.addEventListener("pointerup", end);
    stage.addEventListener("pointercancel", end);
    $("sign-page").addEventListener("click", (e) => { placeAt(e.clientX, e.clientY).catch((err) => T.setStatus(status, err.message, "error")); });
  }

  // ---------- Loading and saving ----------
  async function loadFile(file) {
    T.setStatus(status, "Reading...", "busy");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const lib = await U.pdfjs();
    let pdf;
    try {
      pdf = await lib.getDocument({ data: bytes.slice() }).promise;
    } catch (e) {
      throw U.friendlyError(e, file.name);
    }
    if (doc) { try { doc.destroy(); } catch (e) { /* ignore */ } }
    doc = pdf;
    cur = { file, bytes, count: pdf.numPages };
    placements.length = 0;
    selected = -1;
    counter = 0;
    pageNo = 1;
    const sel = $("sign-page-select");
    sel.textContent = "";
    for (let i = 1; i <= cur.count; i++) {
      const o = document.createElement("option");
      o.value = String(i);
      o.textContent = `Page ${i} of ${cur.count}`;
      sel.appendChild(o);
    }
    $("sign-work").classList.remove("is-hidden");
    await ensurePad();
    resizeDrawCanvas();
    renderList();
    await renderPage();
    T.setStatus(status, "Click the page to place your signature.", "idle");
  }

  async function save() {
    const L = await U.lib();
    const pdf = await L.PDFDocument.load(cur.bytes, { updateMetadata: false });
    const pages = pdf.getPages();
    for (const p of placements) {
      const page = pages[p.page - 1];
      const info = await doc.getPage(p.page);
      const view = { x0: info.view[0], y0: info.view[1], width: info.view[2] - info.view[0], height: info.view[3] - info.view[1] };
      const rotation = ((info.rotate % 360) + 360) % 360;
      const box = C.toPdfImageBox(p.rect, view, rotation);
      const img = await pdf.embedPng(p.png);
      page.drawImage(img, { x: box.x, y: box.y, width: box.width, height: box.height, rotate: L.degrees(box.rotate) });
    }
    const out = await pdf.save();
    T.download(out, C.outputName(cur.file.name, "signed"), "application/pdf");
    T.setStatus(status, `Saved with ${placements.length} signature${placements.length === 1 ? "" : "s"} (${T.formatBytes(out.length)})`, "ok");
  }

  // ---------- Wiring ----------
  U.pdfZone("sign-drop", (file) => U.run(status, [saveBtn], () => loadFile(file)), status);

  $("sign-mode-draw").addEventListener("click", () => setMode("draw"));
  $("sign-mode-type").addEventListener("click", () => setMode("type"));
  $("sign-clear").addEventListener("click", () => { if (pad) pad.clear(); });
  $("sign-text").addEventListener("input", renderTypePreview);
  $("sign-pen").addEventListener("change", () => { if (pad) pad.penColor = penColor(); renderTypePreview(); });
  $("sign-size").addEventListener("input", () => {
    $("sign-size-out").textContent = $("sign-size").value + "%";
    const p = placements[selected];
    if (!p || p.page !== pageNo) return;
    const box = $("sign-page").getBoundingClientRect();
    const cx = p.rect.nx + p.rect.nw / 2;
    const cy = p.rect.ny + p.rect.nh / 2;
    p.rect = C.placementFromClick(cx * box.width, cy * box.height, box.width, box.height, p.aspect, widthFrac());
    drawOverlays();
  });
  $("sign-page-select").addEventListener("change", (e) => { pageNo = Number(e.target.value); selected = -1; renderPage(); });
  $("sign-prev").addEventListener("click", () => { if (pageNo > 1) { pageNo--; $("sign-page-select").value = String(pageNo); selected = -1; renderPage(); } });
  $("sign-next").addEventListener("click", () => { if (cur && pageNo < cur.count) { pageNo++; $("sign-page-select").value = String(pageNo); selected = -1; renderPage(); } });
  saveBtn.addEventListener("click", () => U.run(status, [saveBtn], async () => {
    if (!cur || !placements.length) return;
    T.setStatus(status, "Saving...", "busy");
    await save();
  }));

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (doc) { resizeDrawCanvas(); renderPage(); } }, 150);
  });
  window.addEventListener("hashchange", () => { if (doc && location.hash === "#sign") { resizeDrawCanvas(); renderPage(); } });

  wireStage();
  $("sign-size-out").textContent = $("sign-size").value + "%";
  setMode("draw");
})();
