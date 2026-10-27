/* UI wiring for files.html: ZIP, unzip, gzip and hashes. Everything is local (fflate, Web Crypto). */
(function () {
  "use strict";

  const C = window.FilesCore;
  const T = window.Tools;
  const $ = (id) => document.getElementById(id);
  const errMsg = (e) => (e && e.message ? e.message : String(e));
  const fmt = T.formatBytes;
  const tick = () => new Promise((r) => setTimeout(r, 0));

  T.mountTabs($("tabs"));

  let fflatePromise = null;
  function lib() {
    if (window.fflate) return Promise.resolve(window.fflate);
    if (!fflatePromise) {
      fflatePromise = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "vendor/fflate.min.js";
        s.onload = () => resolve(window.fflate);
        s.onerror = () => { fflatePromise = null; reject(new Error("Could not load the compression library.")); };
        document.head.appendChild(s);
      });
    }
    return fflatePromise;
  }

  /** Promise wrapper over fflate's async (worker) API, falling back to the sync API if workers fail. */
  function runAsync(asyncFn, syncFn, data, opts) {
    return new Promise((resolve, reject) => {
      try {
        asyncFn(data, opts || {}, (err, out) => {
          if (!err) { resolve(out); return; }
          try { resolve(syncFn(data, opts || {})); } catch (e) { reject(e); }
        });
      } catch (e) {
        try { resolve(syncFn(data, opts || {})); } catch (e2) { reject(e2); }
      }
    });
  }

  function statRow(el, parts) {
    el.textContent = "";
    parts.forEach(([label, value], i) => {
      if (i) el.append("  /  ");
      const b = document.createElement("b");
      b.textContent = label;
      el.append(b, ` ${value}`);
    });
  }

  function cell(tag, text, cls) {
    const c = document.createElement(tag);
    if (cls) c.className = cls;
    c.textContent = text;
    return c;
  }

  // =====================================================================
  // Compress to ZIP
  // =====================================================================
  (function zipTool() {
    const items = []; // { path, file }
    const list = $("zip-list");
    const status = $("zip-status");
    const runBtn = $("zip-run");
    const dlBtn = $("zip-download");
    const nameInput = $("zip-name");
    let nameTouched = false;
    let result = null;

    nameInput.addEventListener("input", () => { nameTouched = true; });

    function render() {
      list.textContent = "";
      const shown = items.slice(0, 300);
      shown.forEach((it) => {
        const li = document.createElement("li");
        li.className = "file-item";
        const rm = document.createElement("button");
        rm.type = "button";
        rm.className = "ghost";
        rm.textContent = "Remove";
        rm.setAttribute("aria-label", `Remove ${it.path}`);
        rm.addEventListener("click", () => { items.splice(items.indexOf(it), 1); changed(); });
        li.append(cell("span", it.path, "name"), cell("span", fmt(it.file.size), "meta"), rm);
        list.appendChild(li);
      });
      if (items.length > shown.length) {
        const li = document.createElement("li");
        li.className = "hint";
        li.textContent = `and ${items.length - shown.length} more files`;
        list.appendChild(li);
      }
      const total = items.reduce((s, it) => s + it.file.size, 0);
      if (items.length) statRow($("zip-total"), [["Files", items.length], ["Total", fmt(total)]]);
      else $("zip-total").textContent = "";
      runBtn.disabled = !items.length;
    }

    function changed() {
      result = null;
      dlBtn.classList.add("is-hidden");
      $("zip-result").classList.add("is-hidden");
      $("zip-summary").textContent = "";
      if (!nameTouched) nameInput.value = C.defaultArchiveName(items.map((i) => i.path));
      render();
    }

    function add(entries) {
      const used = new Set(items.map((i) => i.path));
      for (const { file, path } of entries) {
        const p = C.uniquePath(used, C.safeEntryPath(path || file.webkitRelativePath || file.name) || file.name);
        items.push({ path: p, file });
      }
      T.setStatus(status, `${items.length} file${items.length === 1 ? "" : "s"} ready.`, "idle");
      changed();
    }

    // Walk dropped folders (webkitGetAsEntry) so their structure is kept.
    function readEntry(entry, prefix) {
      return new Promise((resolve) => {
        if (entry.isFile) {
          entry.file((f) => resolve([{ file: f, path: prefix + f.name }]), () => resolve([]));
          return;
        }
        if (!entry.isDirectory) { resolve([]); return; }
        const reader = entry.createReader();
        const out = [];
        const readBatch = () => reader.readEntries(async (batch) => {
          if (!batch.length) { resolve(out); return; }
          for (const child of batch) out.push(...(await readEntry(child, `${prefix}${entry.name}/`)));
          readBatch();
        }, () => resolve(out));
        readBatch();
      });
    }

    const zone = $("zip-drop");
    const picker = document.createElement("input");
    picker.type = "file";
    picker.multiple = true;
    picker.className = "hidden-file-input";
    picker.dataset.handoff = "";
    const folderPicker = document.createElement("input");
    folderPicker.type = "file";
    folderPicker.multiple = true;
    folderPicker.setAttribute("webkitdirectory", "");
    folderPicker.className = "hidden-file-input";
    zone.after(picker, folderPicker);
    zone.setAttribute("role", "button");
    zone.tabIndex = 0;

    picker.addEventListener("change", () => { add(Array.from(picker.files).map((f) => ({ file: f, path: f.name }))); picker.value = ""; });
    folderPicker.addEventListener("change", () => {
      add(Array.from(folderPicker.files).map((f) => ({ file: f, path: f.webkitRelativePath || f.name })));
      folderPicker.value = "";
    });
    zone.addEventListener("click", () => picker.click());
    zone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); picker.click(); } });
    zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("is-over"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("is-over"));
    zone.addEventListener("drop", async (e) => {
      e.preventDefault();
      zone.classList.remove("is-over");
      const dtItems = Array.from(e.dataTransfer.items || []);
      const entries = dtItems.map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
      if (entries.length) {
        T.setStatus(status, "Reading folders...", "busy");
        const found = [];
        for (const en of entries) found.push(...(await readEntry(en, "")));
        add(found);
      } else {
        add(Array.from(e.dataTransfer.files).map((f) => ({ file: f, path: f.name })));
      }
    });
    $("zip-pick-files").addEventListener("click", () => picker.click());
    $("zip-pick-folder").addEventListener("click", () => folderPicker.click());
    $("zip-clear").addEventListener("click", () => { items.length = 0; T.setStatus(status, "", "idle"); changed(); });

    runBtn.addEventListener("click", async () => {
      if (!items.length) return;
      runBtn.disabled = true;
      dlBtn.classList.add("is-hidden");
      const started = performance.now();
      try {
        const f = await lib();
        const level = Number($("zip-level").value);
        const skip = $("zip-skip").checked;
        const loaded = [];
        for (let i = 0; i < items.length; i++) {
          if (i % 20 === 0) { T.setStatus(status, `Reading ${i + 1} of ${items.length}...`, "busy"); await tick(); }
          const it = items[i];
          loaded.push({ path: it.path, data: new Uint8Array(await it.file.arrayBuffer()), mtime: it.file.lastModified ? new Date(it.file.lastModified) : undefined });
        }
        T.setStatus(status, `Compressing ${items.length} file${items.length === 1 ? "" : "s"}...`, "busy");
        await tick();
        const input = C.buildZipInput(loaded, level, skip);
        const zipped = await runAsync(f.zip, f.zipSync, input, {});
        const original = loaded.reduce((s, it) => s + it.data.length, 0);
        const seconds = ((performance.now() - started) / 1000).toFixed(1);
        const name = C.zipFileName(nameInput.value);
        result = { blob: new Blob([zipped], { type: "application/zip" }), name };
        statRow($("zip-summary"), [
          ["Original", fmt(original)], ["ZIP", fmt(zipped.length)],
          ["Result", C.ratioText(original, zipped.length)], ["Time", `${seconds} s`],
        ]);
        renderRatios(zipped, input);
        dlBtn.textContent = `Download ${name}`;
        dlBtn.classList.remove("is-hidden");
        T.download(result.blob, name, "application/zip");
        T.setStatus(status, `Created ${name}.`, "ok");
      } catch (e) {
        T.setStatus(status, errMsg(e), "error");
      } finally {
        runBtn.disabled = !items.length;
      }
    });
    dlBtn.addEventListener("click", () => { if (result) T.download(result.blob, result.name, "application/zip"); });

    function renderRatios(zipped, input) {
      const wrap = $("zip-result");
      let entries;
      try { entries = C.readCentralDirectory(zipped); } catch (e) { wrap.classList.add("is-hidden"); return; }
      const table = document.createElement("table");
      const head = document.createElement("tr");
      ["File", "Original", "Compressed", "Result", "Method"].forEach((h, i) => head.appendChild(cell("th", h, i && i < 3 ? "num" : "")));
      table.appendChild(head);
      entries.slice(0, 500).forEach((en) => {
        const tr = document.createElement("tr");
        tr.append(
          cell("td", en.name, "wrap"),
          cell("td", fmt(en.size), "num"),
          cell("td", fmt(en.compressedSize), "num"),
          cell("td", C.ratioText(en.size, en.compressedSize)),
          cell("td", en.method === 0 ? "stored" : "deflate"),
        );
        table.appendChild(tr);
      });
      wrap.textContent = "";
      wrap.appendChild(table);
      wrap.classList.remove("is-hidden");
      void input;
    }
  })();

  // =====================================================================
  // Extract ZIP
  // =====================================================================
  (function unzipTool() {
    const status = $("unzip-status");
    const runBtn = $("unzip-run");
    const tableWrap = $("unzip-table");
    const preview = $("unzip-preview");
    let current = null; // { file, bytes, entries: [{...entry, checked}] }

    T.mountDropZone($("unzip-drop"), {
      accept: ".zip,application/zip,application/x-zip-compressed",
      multiple: false,
      onReject: (m) => T.setStatus(status, m, "error"),
      onFiles: (files) => open(files[0]),
    });

    async function open(file) {
      current = null;
      tableWrap.classList.add("is-hidden");
      preview.classList.add("is-hidden");
      runBtn.disabled = true;
      $("unzip-info").textContent = "";
      try {
        T.setStatus(status, `Reading ${file.name}...`, "busy");
        const bytes = new Uint8Array(await file.arrayBuffer());
        const entries = C.readCentralDirectory(bytes).filter((en) => !en.isDir);
        const verdict = C.checkArchiveLimits(entries);
        if (!verdict.ok) throw new Error(verdict.message);
        const used = new Set();
        entries.forEach((en) => { en.safe = C.uniquePath(used, C.safeEntryPath(en.name) || "unnamed"); en.checked = true; });
        current = { file, bytes, entries };
        const packed = entries.reduce((s, en) => s + en.compressedSize, 0);
        statRow($("unzip-info"), [["Entries", entries.length], ["Packed", fmt(packed)], ["Unpacked", fmt(verdict.totalSize)]]);
        render();
        T.setStatus(status, entries.some((en) => en.encrypted)
          ? "Some entries are password-protected and cannot be extracted here."
          : `Ready. Click a name to preview it.`, entries.some((en) => en.encrypted) ? "error" : "ok");
      } catch (e) {
        T.setStatus(status, errMsg(e), "error");
      }
    }

    function visible() {
      const q = $("unzip-filter").value.trim().toLowerCase();
      return current ? current.entries.filter((en) => !q || en.safe.toLowerCase().includes(q)) : [];
    }

    function render() {
      if (!current) return;
      const rows = visible();
      const table = document.createElement("table");
      const head = document.createElement("tr");
      ["", "File", "Size", "Packed", "Ratio"].forEach((h, i) => head.appendChild(cell("th", h, i >= 2 ? "num" : "")));
      table.appendChild(head);
      rows.slice(0, 2000).forEach((en) => {
        const tr = document.createElement("tr");
        const cbCell = document.createElement("td");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = en.checked;
        cb.disabled = en.encrypted;
        cb.setAttribute("aria-label", `Select ${en.safe}`);
        cb.addEventListener("change", () => { en.checked = cb.checked; updateRun(); });
        cbCell.appendChild(cb);
        const nameCell = document.createElement("td");
        nameCell.className = "wrap";
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "name-btn";
        btn.textContent = en.safe + (en.encrypted ? " (encrypted)" : "");
        btn.addEventListener("click", () => showPreview(en, tr));
        nameCell.appendChild(btn);
        const ratio = en.size > 0 ? `${Math.max(0, C.savedPercent(en.size, en.compressedSize)).toFixed(0)}%` : "-";
        tr.append(cbCell, nameCell, cell("td", fmt(en.size), "num"), cell("td", fmt(en.compressedSize), "num"), cell("td", ratio, "num"));
        table.appendChild(tr);
      });
      tableWrap.textContent = "";
      tableWrap.appendChild(table);
      if (rows.length > 2000) tableWrap.appendChild(cell("p", `Showing 2000 of ${rows.length}. Use the filter to narrow down.`, "hint"));
      tableWrap.classList.remove("is-hidden");
      updateRun();
    }

    function updateRun() {
      const n = current ? current.entries.filter((en) => en.checked && !en.encrypted).length : 0;
      runBtn.disabled = n === 0;
      runBtn.textContent = n ? `Download selected (${n})` : "Download selected";
    }

    /** Decompress only the named entries. */
    async function extract(names) {
      const f = await lib();
      const wanted = new Set(names);
      return runAsync(f.unzip, f.unzipSync, current.bytes, { filter: (info) => wanted.has(info.name) });
    }

    async function showPreview(en, tr) {
      tableWrap.querySelectorAll("tr.is-active").forEach((r) => r.classList.remove("is-active"));
      tr.classList.add("is-active");
      preview.textContent = "";
      preview.classList.remove("is-hidden");
      if (en.encrypted) { preview.appendChild(cell("p", "This entry is encrypted.", "hint")); return; }
      if (en.size > 50 * 1024 * 1024) { preview.appendChild(cell("p", "Too large to preview. Download it instead.", "hint")); return; }
      try {
        const out = await extract([en.name]);
        const data = out[en.name];
        const ext = C.extOf(en.safe);
        const imgTypes = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", avif: "image/avif" };
        preview.appendChild(cell("strong", en.safe));
        if (imgTypes[ext]) {
          const img = document.createElement("img");
          img.alt = en.safe;
          img.src = URL.createObjectURL(new Blob([data], { type: imgTypes[ext] }));
          img.onload = () => URL.revokeObjectURL(img.src);
          preview.appendChild(img);
        } else {
          const head = data.subarray(0, 65536);
          const binary = head.some((b) => b === 0);
          if (binary) preview.appendChild(cell("p", "Binary file; no text preview.", "hint"));
          else {
            const pre = document.createElement("pre");
            pre.textContent = new TextDecoder().decode(head) + (data.length > head.length ? "\n..." : "");
            preview.appendChild(pre);
          }
        }
        const dl = document.createElement("button");
        dl.type = "button";
        dl.className = "ghost";
        dl.textContent = "Download this file";
        dl.addEventListener("click", () => T.download(new Blob([data]), en.safe.split("/").pop()));
        preview.appendChild(dl);
      } catch (e) {
        preview.appendChild(cell("p", errMsg(e), "hint"));
      }
    }

    $("unzip-filter").addEventListener("input", render);
    $("unzip-all").addEventListener("click", () => { visible().forEach((en) => { if (!en.encrypted) en.checked = true; }); render(); });
    $("unzip-none").addEventListener("click", () => { visible().forEach((en) => { en.checked = false; }); render(); });

    runBtn.addEventListener("click", async () => {
      if (!current) return;
      const chosen = current.entries.filter((en) => en.checked && !en.encrypted);
      if (!chosen.length) return;
      runBtn.disabled = true;
      try {
        T.setStatus(status, `Extracting ${chosen.length} file${chosen.length === 1 ? "" : "s"}...`, "busy");
        const out = await extract(chosen.map((en) => en.name));
        const files = chosen.map((en) => ({ name: en.safe, data: out[en.name] })).filter((x) => x.data);
        if (files.length === 1 || $("unzip-separate").checked) {
          for (const x of files) { T.download(new Blob([x.data]), x.name.split("/").pop()); await new Promise((r) => setTimeout(r, 150)); }
          T.setStatus(status, `Downloaded ${files.length} file${files.length === 1 ? "" : "s"}.`, "ok");
        } else {
          const f = await lib();
          const input = {};
          files.forEach((x) => { input[x.name] = [x.data, { level: 0 }]; });
          const zipped = await runAsync(f.zip, f.zipSync, input, {});
          const name = `${T.baseName(current.file.name)}-selection.zip`;
          T.download(new Blob([zipped], { type: "application/zip" }), name, "application/zip");
          T.setStatus(status, `Downloaded ${files.length} files as ${name}.`, "ok");
        }
      } catch (e) {
        T.setStatus(status, errMsg(e), "error");
      } finally {
        updateRun();
      }
    });
  })();

  // =====================================================================
  // Gzip and gunzip
  // =====================================================================
  (function gzipTool() {
    const status = $("gzip-status");
    const runBtn = $("gzip-run");
    const dlBtn = $("gzip-download");
    const mode = $("gzip-mode");
    let file = null;
    let result = null;

    function syncMode() { $("gzip-level-field").classList.toggle("is-hidden", mode.value !== "compress"); }
    mode.addEventListener("change", syncMode);

    T.mountDropZone($("gzip-drop"), {
      multiple: false,
      onReject: (m) => T.setStatus(status, m, "error"),
      async onFiles(files) {
        file = files[0];
        result = null;
        dlBtn.classList.add("is-hidden");
        $("gzip-summary").textContent = "";
        const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
        mode.value = C.isGzipBytes(head) || /\.(gz|tgz)$/i.test(file.name) ? "decompress" : "compress";
        syncMode();
        statRow($("gzip-info"), [["File", file.name], ["Size", fmt(file.size)]]);
        runBtn.disabled = false;
        T.setStatus(status, mode.value === "decompress" ? "Gzip data detected; ready to decompress." : "Ready to compress.", "idle");
      },
    });

    runBtn.addEventListener("click", async () => {
      if (!file) return;
      runBtn.disabled = true;
      dlBtn.classList.add("is-hidden");
      const started = performance.now();
      try {
        const f = await lib();
        const data = new Uint8Array(await file.arrayBuffer());
        let out;
        let name;
        if (mode.value === "compress") {
          T.setStatus(status, "Compressing...", "busy");
          out = await runAsync(f.gzip, f.gzipSync, data, { level: Number($("gzip-level").value), filename: file.name, mtime: file.lastModified || Date.now() });
          name = C.gzipName(file.name);
        } else {
          if (!C.isGzipBytes(data)) throw new Error("This file is not gzip data.");
          T.setStatus(status, "Decompressing...", "busy");
          out = await runAsync(f.gunzip, f.gunzipSync, data, {});
          name = C.gunzipName(file.name);
        }
        const seconds = ((performance.now() - started) / 1000).toFixed(1);
        result = { blob: new Blob([out]), name };
        statRow($("gzip-summary"), [["Input", fmt(data.length)], ["Output", fmt(out.length)], ["Result", C.ratioText(data.length, out.length)], ["Time", `${seconds} s`]]);
        dlBtn.textContent = `Download ${name}`;
        dlBtn.classList.remove("is-hidden");
        T.download(result.blob, name);
        T.setStatus(status, `Created ${name}.`, "ok");
      } catch (e) {
        T.setStatus(status, /invalid|unexpected|header/i.test(errMsg(e)) ? `Could not decompress: ${errMsg(e)}` : errMsg(e), "error");
      } finally {
        runBtn.disabled = !file;
      }
    });
    dlBtn.addEventListener("click", () => { if (result) T.download(result.blob, result.name); });
    syncMode();
  })();

  // =====================================================================
  // File hash
  // =====================================================================
  (function hashTool() {
    const status = $("hash-status");
    const results = $("hash-results");
    const expected = $("hash-expected");
    const SUBTLE_MAX = 512 * 1024 * 1024;
    const CHUNK = 4 * 1024 * 1024;
    let rows = []; // { el, hex }
    let runId = 0;

    function highlight() {
      const want = C.normalizeHash(expected.value);
      let matches = 0;
      rows.forEach(({ el, hex }) => {
        const tag = el.querySelector(".tag");
        el.classList.remove("is-match", "is-miss");
        tag.textContent = "";
        if (!want || !hex) return;
        if (C.hashesMatch(want, hex)) { el.classList.add("is-match"); tag.textContent = "MATCH"; matches += 1; }
        else if (want.length === hex.length) { el.classList.add("is-miss"); tag.textContent = "differs"; }
      });
      if (want && rows.length) {
        T.setStatus(status, matches ? `Expected hash matches ${matches} result${matches === 1 ? "" : "s"}.` : "Expected hash does not match any result.", matches ? "ok" : "error");
      }
    }
    expected.addEventListener("input", highlight);

    function addRow(card, algo) {
      const row = document.createElement("div");
      row.className = "hash-row";
      const code = document.createElement("code");
      code.textContent = "computing...";
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "ghost";
      copy.textContent = "Copy";
      copy.disabled = true;
      copy.setAttribute("aria-label", `Copy ${algo}`);
      const tag = cell("span", "", "tag");
      row.append(cell("span", algo, "al"), code, copy);
      row.appendChild(tag);
      card.appendChild(row);
      const entry = { el: row, hex: "" };
      rows.push(entry);
      return {
        set(hex) {
          entry.hex = hex;
          code.textContent = hex;
          copy.disabled = false;
          copy.onclick = async () => {
            try { await navigator.clipboard.writeText(hex); copy.textContent = "Copied"; setTimeout(() => { copy.textContent = "Copy"; }, 1200); }
            catch (e) { T.setStatus(status, "Clipboard blocked; select the hash and copy it manually.", "error"); }
          };
        },
        fail(msg) { code.textContent = msg; },
      };
    }

    async function hashFile(file, id) {
      const card = document.createElement("div");
      card.className = "hash-card";
      const head = document.createElement("div");
      head.className = "hash-head";
      head.append(cell("span", file.name, "hn"), cell("span", fmt(file.size), "hm"));
      card.appendChild(head);
      results.appendChild(card);
      const md5Row = addRow(card, "MD5");
      const subtleRows = ["SHA-1", "SHA-256", "SHA-512"].map((a) => [a, addRow(card, a)]);

      // MD5 incrementally, in slices, so large files are never held whole.
      const md5 = C.createMD5();
      for (let off = 0; off < file.size || off === 0; off += CHUNK) {
        if (id !== runId) return;
        md5.update(new Uint8Array(await file.slice(off, off + CHUNK).arrayBuffer()));
        if (file.size > CHUNK) T.setStatus(status, `Hashing ${file.name}: ${Math.min(100, Math.round(((off + CHUNK) / file.size) * 100))}%`, "busy");
        if (file.size === 0) break;
      }
      md5Row.set(md5.digest());

      if (file.size > SUBTLE_MAX) {
        subtleRows.forEach(([, r]) => r.fail("too large for SHA in the browser (over 512 MB)"));
        return;
      }
      if (!(window.crypto && crypto.subtle)) {
        subtleRows.forEach(([, r]) => r.fail("needs a secure (https) page"));
        return;
      }
      const buf = await file.arrayBuffer();
      for (const [algo, r] of subtleRows) {
        if (id !== runId) return;
        r.set(C.toHex(await crypto.subtle.digest(algo, buf)));
      }
    }

    T.mountDropZone($("hash-drop"), {
      multiple: true,
      onReject: (m) => T.setStatus(status, m, "error"),
      async onFiles(files) {
        const id = ++runId;
        results.textContent = "";
        rows = [];
        try {
          for (let i = 0; i < files.length; i++) {
            T.setStatus(status, `Hashing ${i + 1} of ${files.length}: ${files[i].name}`, "busy");
            await hashFile(files[i], id);
            if (id !== runId) return;
          }
          T.setStatus(status, `Hashed ${files.length} file${files.length === 1 ? "" : "s"}.`, "ok");
          highlight();
        } catch (e) {
          if (id === runId) T.setStatus(status, errMsg(e), "error");
        }
      },
    });
    $("hash-clear").addEventListener("click", () => { runId += 1; results.textContent = ""; rows = []; expected.value = ""; T.setStatus(status, "", "idle"); });
  })();
})();
