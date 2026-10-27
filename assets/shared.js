/*
 * Shared helpers for every converter page. Exposes a single global: window.Tools.
 * Everything runs locally in the browser; nothing here performs network requests.
 */
(function () {
  "use strict";

  const MAX_FILE_BYTES = 200 * 1024 * 1024; // 200 MB per file; larger files usually exhaust tab memory.

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return "-";
    const units = ["B", "KB", "MB", "GB"];
    let i = 0;
    let n = bytes;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
    return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  /** "report.final.json" -> "report.final" */
  function baseName(filename) {
    const name = String(filename || "file").split(/[\\/]/).pop();
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(0, dot) : name;
  }

  function extension(filename) {
    const name = String(filename || "");
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  }

  /** Strip characters that are illegal or risky in download names. */
  function safeFilename(name, fallback = "output") {
    const cleaned = String(name || "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").replace(/^\.+/, "").trim();
    return (cleaned || fallback).slice(0, 180);
  }

  function replaceExt(filename, newExt) {
    return `${safeFilename(baseName(filename))}.${newExt}`;
  }

  /** Download a Blob, ArrayBuffer, Uint8Array or string. */
  function download(data, filename, mime = "application/octet-stream") {
    const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = safeFilename(filename);
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function setStatus(el, text, state = "idle") {
    if (!el) return;
    el.textContent = text;
    el.dataset.state = state;
  }

  const readAsText = (file) => file.text();
  const readAsArrayBuffer = (file) => file.arrayBuffer();
  function readAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  /**
   * Turn an element into a drop zone + file picker.
   * opts: { accept: ".json,.csv", multiple: bool, onFiles: (File[]) => void, onReject: (msg) => void }
   */
  function mountDropZone(zone, opts) {
    const input = document.createElement("input");
    input.type = "file";
    input.className = "hidden-file-input";
    if (opts.accept) input.accept = opts.accept;
    input.multiple = Boolean(opts.multiple);
    zone.after(input);
    zone.setAttribute("role", "button");
    zone.tabIndex = 0;

    const accepted = (opts.accept || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    function matches(file) {
      if (!accepted.length) return true;
      const name = file.name.toLowerCase();
      const type = (file.type || "").toLowerCase();
      return accepted.some((rule) => {
        if (rule.startsWith(".")) return name.endsWith(rule);
        if (rule.endsWith("/*")) return type.startsWith(rule.slice(0, -1));
        return type === rule;
      });
    }

    function deliver(list) {
      let files = Array.from(list || []);
      if (!opts.multiple) files = files.slice(0, 1);
      const rejected = [];
      files = files.filter((f) => {
        if (!matches(f)) { rejected.push(`${f.name}: unsupported type`); return false; }
        if (f.size > MAX_FILE_BYTES) { rejected.push(`${f.name}: larger than ${formatBytes(MAX_FILE_BYTES)}`); return false; }
        return true;
      });
      if (rejected.length && opts.onReject) opts.onReject(rejected.join("; "));
      if (files.length) opts.onFiles(files);
    }

    zone.addEventListener("click", () => input.click());
    zone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); }
    });
    zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("is-over"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("is-over"));
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      zone.classList.remove("is-over");
      deliver(e.dataTransfer.files);
    });
    input.addEventListener("change", () => { deliver(input.files); input.value = ""; });
    return { open: () => input.click() };
  }

  /**
   * Wire tab buttons to panels. Markup:
   *   <div class="tool-tabs" role="tablist"><button data-tab="a">A</button>...</div>
   *   <section data-panel="a">...</section>
   * The active tab is kept in location.hash so tools can be deep-linked (page.html#csv-to-json).
   */
  function mountTabs(tablist) {
    const buttons = Array.from(tablist.querySelectorAll("button[data-tab]"));
    const panels = Array.from(document.querySelectorAll("[data-panel]"));
    tablist.setAttribute("role", "tablist");
    function show(id, updateHash) {
      if (!buttons.some((b) => b.dataset.tab === id)) id = buttons[0].dataset.tab;
      buttons.forEach((b) => {
        const on = b.dataset.tab === id;
        b.setAttribute("role", "tab");
        b.setAttribute("aria-selected", String(on));
        b.tabIndex = on ? 0 : -1;
      });
      panels.forEach((p) => p.classList.toggle("is-hidden", p.dataset.panel !== id));
      if (updateHash) history.replaceState(null, "", `#${id}`);
    }
    buttons.forEach((b) => b.addEventListener("click", () => show(b.dataset.tab, true)));
    tablist.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const i = buttons.findIndex((b) => b.getAttribute("aria-selected") === "true");
      const next = buttons[(i + (e.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length];
      show(next.dataset.tab, true);
      next.focus();
    });
    show(location.hash.slice(1), false);
    window.addEventListener("hashchange", () => show(location.hash.slice(1), false));
    return { show };
  }

  /** Render an array of row objects as a safe HTML table (escaped), capped for preview. */
  function renderTable(container, rows, maxRows = 200) {
    if (!Array.isArray(rows) || !rows.length) {
      container.innerHTML = '<p class="hint">Nothing to preview.</p>';
      return;
    }
    const columns = [];
    const seen = new Set();
    rows.slice(0, maxRows).forEach((r) => {
      Object.keys(r || {}).forEach((k) => { if (!seen.has(k)) { seen.add(k); columns.push(k); } });
    });
    const head = columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("");
    const body = rows.slice(0, maxRows).map((r) =>
      `<tr>${columns.map((c) => {
        const v = r ? r[c] : "";
        return `<td>${escapeHtml(v !== null && typeof v === "object" ? JSON.stringify(v) : v ?? "")}</td>`;
      }).join("")}</tr>`).join("");
    const more = rows.length > maxRows ? `<p class="hint">Showing ${maxRows} of ${rows.length} rows.</p>` : "";
    container.innerHTML = `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>${more}`;
  }

  // ---------- Minimal ZIP writer (store, no compression) for batch downloads ----------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /** files: [{ name: string, data: Blob|ArrayBuffer|Uint8Array|string }] -> Promise<Blob> */
  async function zip(files) {
    const enc = new TextEncoder();
    const chunks = [];
    const central = [];
    let offset = 0;
    const used = new Set();
    for (const f of files) {
      let name = safeFilename(f.name);
      for (let i = 2; used.has(name); i++) name = `${baseName(f.name)}-${i}.${extension(f.name)}`;
      used.add(name);
      let data = f.data;
      if (data instanceof Blob) data = new Uint8Array(await data.arrayBuffer());
      else if (typeof data === "string") data = enc.encode(data);
      else if (data instanceof ArrayBuffer) data = new Uint8Array(data);
      const nameBytes = enc.encode(name);
      const crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true); // UTF-8 names
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, nameBytes.length, true);
      chunks.push(local.buffer, nameBytes, data);
      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true);
      cen.setUint16(4, 20, true);
      cen.setUint16(6, 20, true);
      cen.setUint16(8, 0x0800, true);
      cen.setUint32(16, crc, true);
      cen.setUint32(20, data.length, true);
      cen.setUint32(24, data.length, true);
      cen.setUint16(28, nameBytes.length, true);
      cen.setUint32(42, offset, true);
      central.push(cen.buffer, nameBytes);
      offset += 30 + nameBytes.length + data.length;
    }
    const centralSize = central.reduce((s, c) => s + (c.byteLength ?? c.length), 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...chunks, ...central, end.buffer], { type: "application/zip" });
  }

  window.Tools = Object.freeze({
    escapeHtml,
    formatBytes,
    baseName,
    extension,
    safeFilename,
    replaceExt,
    download,
    setStatus,
    readAsText,
    readAsArrayBuffer,
    readAsDataURL,
    mountDropZone,
    mountTabs,
    renderTable,
    zip,
    crc32,
    MAX_FILE_BYTES,
  });
})();
