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
      showToolHeader(id);
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

  // =====================================================================
  // Site chrome: header, tool sidebar, search palette, page-wide drop and
  // the file handoff from the home page. Built from window.Catalog.
  // =====================================================================
  const Cat = window.Catalog || null;
  const PAGE = location.pathname.split("/").pop() || "index.html";
  const LOGO_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M4 7l8-4 8 4-8 4-8-4z"/><path d="M4 12l8 4 8-4"/><path d="M4 17l8 4 8-4"/></svg>';
  // Tool icons: 24px stroke glyphs drawn in white on a tinted rounded square (see .app-icon).
  const ICON_PATHS = {
    compress: '<path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="M14 10l7-7"/><path d="M3 21l7-7"/>',
    merge: '<path d="M6 3v5c0 3 6 4 6 8v5"/><path d="M18 3v5c0 3-6 4-6 8"/>',
    split: '<path d="M12 3v6"/><path d="M12 9c0 4-6 4-6 8v4"/><path d="M12 9c0 4 6 4 6 8v4"/>',
    pages: '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>',
    topdf: '<path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4"/><path d="M12 11v6"/><path d="M9 14h6"/>',
    image: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M21 16l-5-5-8 8"/>',
    drop: '<path d="M12 3c3 4 6 7 6 11a6 6 0 01-12 0c0-4 3-7 6-11z"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><path d="M12 7.5v.5"/>',
    convert: '<path d="M4 8h13l-3-3"/><path d="M20 16H7l3 3"/>',
    resize: '<path d="M4 10V4h6"/><path d="M20 14v6h-6"/><path d="M4 4l7 7"/><path d="M20 20l-7-7"/>',
    crop: '<path d="M6 2v16h16"/><path d="M2 6h16v16"/>',
    scan: '<path d="M3 7V4h3"/><path d="M21 7V4h-3"/><path d="M3 17v3h3"/><path d="M21 17v3h-3"/><path d="M8 9h8"/><path d="M12 9v7"/>',
    shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
    code: '<path d="M8 8l-4 4 4 4"/><path d="M16 8l4 4-4 4"/><path d="M13.5 6l-3 12"/>',
    braces: '<path d="M8 4C6 4 5 5 5 7v2c0 1-1 2-2 3 1 1 2 2 2 3v2c0 2 1 3 3 3"/><path d="M16 4c2 0 3 1 3 3v2c0 1 1 2 2 3-1 1-2 2-2 3v2c0 2-1 3-3 3"/>',
    table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M10 4v16"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
    diff: '<rect x="3" y="4" width="7" height="16" rx="1.5"/><rect x="14" y="4" width="7" height="16" rx="1.5"/><path d="M6.5 9v4"/><path d="M15.5 11h4"/>',
    doc: '<path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4"/><path d="M9 13h6"/><path d="M9 17h4"/>',
    lines: '<path d="M4 6h16"/><path d="M4 12h10"/><path d="M4 18h14"/>',
    type: '<path d="M4 18l4.5-12L13 18"/><path d="M5.7 14h5.6"/><path d="M15 12.5c.8-.8 1.8-1 2.7-1 1.5 0 2.3.9 2.3 2.3V18"/><path d="M20 15.3c-2.6 0-4.6.5-4.6 1.7 0 .8.6 1.2 1.6 1.2 1.6 0 3-1.2 3-2.9"/>',
    zip: '<rect x="4" y="8" width="16" height="12" rx="1.5"/><path d="M3 4h18v4H3z"/><path d="M10 12h4"/>',
    unzip: '<rect x="4" y="10" width="16" height="10" rx="1.5"/><path d="M12 3v9"/><path d="M8.5 6.5L12 3l3.5 3.5"/>',
    hash: '<path d="M9 3L7 21"/><path d="M17 3l-2 18"/><path d="M4 8.5h17"/><path d="M3 15.5h17"/>',
  };
  /** A tool's icon as a tinted rounded square (static catalog markup only). */
  function toolIcon(tool, size) {
    const px = size || 56;
    const glyph = ICON_PATHS[tool.icon] || ICON_PATHS.doc;
    return `<span class="app-icon tint-${tool.tint}" style="--s:${px}px" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${glyph}</svg></span>`;
  }

  const SEARCH_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>';
  const make = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const isTyping = (t) => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  let toolHead = null;

  function buildHeader() {
    const inner = document.querySelector(".site-nav-inner");
    if (!inner || !Cat) return;
    // Static markup only (catalog constants), no user input.
    // A floating glass capsule: logo, categories, search. Static markup only (catalog constants).
    inner.innerHTML =
      `<a class="site-brand" href="index.html" aria-label="Converter Studio home">${LOGO_SVG}</a>` +
      `<nav class="site-links" aria-label="Categories">${Cat.CATEGORIES.map((c) =>
        `<a href="${c.page}"${c.page === PAGE ? ' aria-current="page"' : ""}>${escapeHtml(c.name)}</a>`).join("")}</nav>` +
      `<button type="button" class="site-search" id="openSearch" aria-haspopup="dialog" aria-label="Search tools (Ctrl K)" title="Search (Ctrl K)">${SEARCH_SVG}</button>` +
      '<button type="button" class="site-search theme-toggle" id="themeToggle"></button>';
    mountThemeToggle(document.getElementById("themeToggle"));
  }

  // ---------- Theme: System -> Light -> Dark, remembered on this device ----------
  const THEME_KEY = "converter-studio-theme";
  const THEME_ICONS = {
    system: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17" /><path d="M12 3.5a8.5 8.5 0 010 17z" fill="currentColor"/></svg>',
    light: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    dark: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z"/></svg>',
  };
  const THEME_NEXT = { system: "light", light: "dark", dark: "system" };
  function currentTheme() {
    const t = document.documentElement.dataset.theme;
    return t === "light" || t === "dark" ? t : "system";
  }
  function applyTheme(theme) {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    try {
      if (theme === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, theme);
    } catch (e) { /* storage blocked: the choice lasts for this page only */ }
  }
  function mountThemeToggle(btn) {
    if (!btn) return;
    const label = { system: "Theme: follows device", light: "Theme: light", dark: "Theme: dark" };
    const render = () => {
      const t = currentTheme();
      btn.innerHTML = THEME_ICONS[t]; // static icon markup
      btn.setAttribute("aria-label", `${label[t]}. Click to change.`);
      btn.title = label[t];
    };
    btn.addEventListener("click", () => { applyTheme(THEME_NEXT[currentTheme()]); render(); });
    render();
  }

  /** Turn "hero + tab bar + panels" into "sidebar + per-tool header + panel". */
  function buildToolLayout() {
    const tabs = document.getElementById("tabs");
    const app = document.querySelector(".tool-app");
    if (!tabs || !app || !Cat) return;
    const cat = Cat.CATEGORIES.find((c) => c.page === PAGE);
    const layout = make("div", "tool-layout");
    const aside = make("aside", "tool-sidebar");
    aside.setAttribute("aria-label", `${cat ? cat.name : "Page"} tools`);
    aside.append(tabs);
    const main = make("div", "tool-main");
    const head = make("header", "tool-head");
    const icon = make("span");
    const h1 = make("h1");
    head.append(icon, h1);
    if (cat) document.body.dataset.tint = cat.tint; // tints the page glow
    const glows = make("div", "glows glows-tool");
    glows.setAttribute("aria-hidden", "true");
    glows.append(make("div", "glow g1"), make("div", "glow g2"));
    document.body.prepend(glows);
    // The per-tool header replaces the old page hero (one <h1> per page).
    Array.from(app.children).forEach((child) => {
      if (child.classList.contains("tool-hero")) child.remove();
      else main.appendChild(child);
    });
    layout.append(head, aside, main);
    app.appendChild(layout);
    // Label tabs from the catalog and order them as the catalog does, so every page reads the same way.
    const rank = (b) => {
      const i = Cat.TOOLS.indexOf(Cat.find(PAGE, b.dataset.tab));
      return i < 0 ? Infinity : i;
    };
    Array.from(tabs.querySelectorAll("button[data-tab]"))
      .sort((a, b) => rank(a) - rank(b))
      .forEach((b) => {
        const t = Cat.find(PAGE, b.dataset.tab);
        if (t) { b.textContent = t.short; b.title = t.name; }
        tabs.appendChild(b);
      });
    toolHead = { h1, icon };
  }

  function showToolHeader(id) {
    const t = Cat && Cat.find(PAGE, id);
    if (!t) return;
    if (toolHead) {
      toolHead.h1.textContent = t.name;
      toolHead.icon.innerHTML = toolIcon(t, 40); // catalog constants only
    }
    document.title = `${t.name} - Converter Studio`;
  }

  function buildPalette() {
    if (!Cat || typeof HTMLDialogElement === "undefined") return null;
    const dlg = make("dialog", "palette");
    dlg.setAttribute("aria-label", "Search tools");
    dlg.innerHTML =
      `<div class="palette-input-row">${SEARCH_SVG}<input type="search" placeholder="Search tools: compress pdf, ocr, json to excel..." aria-label="Search tools" autocomplete="off" spellcheck="false"><span class="kbd">Esc</span></div>` +
      '<ul class="palette-list" role="listbox" aria-label="Tools"></ul>' +
      '<div class="palette-foot"><span>Up / Down to move</span><span>Enter to open</span></div>';
    document.body.appendChild(dlg);
    const input = dlg.querySelector("input");
    const list = dlg.querySelector(".palette-list");
    let results = [];
    let active = 0;

    function go(t) {
      dlg.close();
      if (t.page === PAGE) location.hash = t.tab;
      else location.href = t.href;
    }
    function render() {
      results = Cat.search(input.value);
      active = Math.max(0, Math.min(active, results.length - 1));
      list.textContent = "";
      if (!results.length) {
        list.appendChild(make("li", "palette-empty", "No tool matches. Try a format, like pdf, png or json."));
        return;
      }
      results.forEach((t, i) => {
        const li = make("li");
        const a = make("a");
        a.href = t.href;
        a.setAttribute("role", "option");
        a.setAttribute("aria-selected", String(i === active));
        a.append(make("span", "", t.name), make("span", "p-desc", t.desc), make("span", "p-cat", Cat.byCat[t.cat].name));
        a.addEventListener("click", (e) => { e.preventDefault(); go(t); });
        a.addEventListener("mousemove", () => { if (active !== i) { active = i; render(); } });
        li.appendChild(a);
        list.appendChild(li);
      });
      const sel = list.querySelector('[aria-selected="true"]');
      if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: "nearest" });
    }
    input.addEventListener("input", () => { active = 0; render(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { active = Math.min(active + 1, results.length - 1); render(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { active = Math.max(active - 1, 0); render(); e.preventDefault(); }
      else if (e.key === "Enter") { if (results[active]) go(results[active]); e.preventDefault(); }
    });
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
    function open(prefill) {
      if (dlg.open) return;
      input.value = prefill || "";
      active = 0;
      render();
      dlg.showModal();
      input.focus();
    }
    document.addEventListener("keydown", (e) => {
      if ((e.key === "k" || e.key === "K") && (e.ctrlKey || e.metaKey)) { e.preventDefault(); open(); }
      else if (e.key === "/" && !isTyping(e.target) && !dlg.open) { e.preventDefault(); open(); }
    });
    const btn = document.getElementById("openSearch");
    if (btn) btn.addEventListener("click", () => open());
    return { open };
  }

  // ---------- Feeding files into a tool ----------
  function fileInputIn(scope) {
    return (scope || document).querySelector("input[type=file][data-handoff]")
      || (scope || document).querySelector(".drop-zone + input[type=file]");
  }
  function visiblePanel() {
    return document.querySelector("[data-panel]:not(.is-hidden)");
  }
  function injectFiles(input, files) {
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /** Dropping files anywhere on a tool page loads them into the visible tool. */
  function mountPageDrop() {
    if (document.body.dataset.pageDrop === "off") return;
    const overlay = make("div", "page-drop");
    overlay.setAttribute("aria-hidden", "true");
    const box = make("div");
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    let depth = 0;
    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
    const hide = () => { depth = 0; overlay.classList.remove("is-active"); };
    document.addEventListener("dragenter", (e) => {
      if (!hasFiles(e)) return;
      depth += 1;
      const panel = visiblePanel();
      const t = Cat && panel ? Cat.find(PAGE, panel.dataset.panel) : null;
      box.textContent = "";
      box.append("Drop to load into ", make("b", "", t ? t.name : "this tool"));
      overlay.classList.add("is-active");
    });
    document.addEventListener("dragleave", (e) => { if (hasFiles(e) && --depth <= 0) hide(); });
    document.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
    document.addEventListener("drop", (e) => {
      hide();
      if (!hasFiles(e) || e.defaultPrevented) return; // a drop zone already took it
      e.preventDefault();
      const input = fileInputIn(visiblePanel() || document);
      if (input && e.dataTransfer.files.length) injectFiles(input, Array.from(e.dataTransfer.files));
    });
    window.addEventListener("blur", hide);
  }

  // Files chosen on the home page travel to the tool page through IndexedDB (same origin, this
  // device only) and are deleted as soon as the tool page reads them.
  const HANDOFF_DB = "converter-studio-handoff";
  const HANDOFF_TTL_MS = 2 * 60 * 1000;
  function openHandoffDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(HANDOFF_DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("pending");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function handoffSave(files, toolId) {
    const db = await openHandoffDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("pending", "readwrite");
      tx.objectStore("pending").put({ files: Array.from(files), target: toolId, at: Date.now() }, "files");
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }
  async function handoffTake() {
    let db;
    try {
      db = await openHandoffDb();
      const value = await new Promise((resolve, reject) => {
        const tx = db.transaction("pending", "readwrite");
        const store = tx.objectStore("pending");
        const get = store.get("files");
        store.delete("files");
        tx.oncomplete = () => resolve(get.result);
        tx.onerror = () => reject(tx.error);
      });
      return value && Date.now() - value.at < HANDOFF_TTL_MS ? value : null;
    } catch (e) {
      return null;
    } finally {
      if (db) db.close();
    }
  }
  async function consumeHandoff() {
    if (!Cat || !window.indexedDB) return;
    const pending = await handoffTake();
    if (!pending || !pending.files || !pending.files.length) return;
    const t = Cat.TOOLS.find((x) => x.id === pending.target);
    if (!t || t.page !== PAGE) return;
    if (location.hash.slice(1) !== t.tab) {
      location.hash = t.tab;
      await new Promise((r) => setTimeout(r, 0));
    }
    const input = fileInputIn(document.querySelector(`[data-panel="${t.tab}"]`) || document);
    if (input) injectFiles(input, pending.files);
  }

  buildHeader();
  buildToolLayout();
  buildPalette();
  if (document.querySelector("[data-panel]")) mountPageDrop();
  window.addEventListener("load", () => { setTimeout(consumeHandoff, 0); });

  window.Tools = Object.freeze({
    handoff: Object.freeze({ save: handoffSave }),
    toolIcon,
    injectFiles,
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
