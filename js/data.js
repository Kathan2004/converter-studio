/* UI wiring for data.html. All processing is local; libraries are lazy-loaded from /vendor. */
(function () {
  "use strict";

  const D = window.DataCore;
  const T = window.Tools;
  const $ = (id) => document.getElementById(id);
  const XLSX_MIME = D.MIME_FOR.excel;

  // ---------- helpers ----------
  const loading = {};
  function loadScript(src) {
    if (!loading[src]) {
      loading[src] = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = src;
        s.onload = resolve;
        s.onerror = () => { delete loading[src]; reject(new Error(`Could not load ${src}`)); };
        document.head.appendChild(s);
      });
    }
    return loading[src];
  }
  const needExcel = () => (window.ExcelJS ? Promise.resolve() : loadScript("vendor/exceljs.min.js"));
  const needYaml = () => (window.jsyaml ? Promise.resolve() : loadScript("vendor/js-yaml.min.js"));
  const libs = () => ({ jsyaml: window.jsyaml, DOMParser: window.DOMParser });

  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  function errMsg(e) { return (e && e.message) || String(e); }

  /** Read an .xlsx buffer into [{ name, matrix }] with plain cell values. */
  async function readXlsx(buffer) {
    await needExcel();
    const wb = new window.ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const sheets = [];
    wb.eachSheet((ws) => {
      const matrix = [];
      const cols = ws.columnCount;
      ws.eachRow({ includeEmpty: true }, (row) => {
        const arr = [];
        for (let c = 1; c <= cols; c++) arr.push(D.cellToPlain(row.getCell(c).value));
        matrix.push(arr);
      });
      while (matrix.length && matrix[matrix.length - 1].every((v) => v === null || v === "")) matrix.pop();
      sheets.push({ name: ws.name, matrix });
    });
    return sheets;
  }

  /** Render a download list. outputs: [{ name, data, mime, note }]. Returns nothing; wires the zip button. */
  function showOutputs(listEl, zipBtn, outputs) {
    listEl.textContent = "";
    for (const out of outputs) {
      const li = document.createElement("li");
      li.className = "file-item";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = out.name;
      const meta = document.createElement("span");
      meta.className = "meta";
      const size = out.data.size !== undefined ? out.data.size : new Blob([out.data]).size;
      meta.textContent = out.note ? `${out.note} - ${T.formatBytes(size)}` : T.formatBytes(size);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ghost";
      btn.textContent = "Download";
      btn.addEventListener("click", () => T.download(out.data, out.name, out.mime));
      li.append(name, meta, btn);
      listEl.appendChild(li);
    }
    zipBtn.disabled = outputs.length < 2;
    zipBtn.onclick = async () => {
      try {
        T.download(await T.zip(outputs.map((o) => ({ name: o.name, data: o.data }))), "converted-files.zip", "application/zip");
      } catch (e) { alert(errMsg(e)); }
    };
  }

  function uniqueName(name, used) {
    let n = name;
    for (let i = 2; used.has(n.toLowerCase()); i++) {
      const dot = name.lastIndexOf(".");
      n = `${name.slice(0, dot)}-${i}${name.slice(dot)}`;
    }
    used.add(n.toLowerCase());
    return n;
  }

  async function workbookBlob(sheets, options) {
    await needExcel();
    const wb = D.buildWorkbook(window.ExcelJS, sheets, options);
    const buf = await wb.xlsx.writeBuffer();
    return new Blob([buf], { type: XLSX_MIME });
  }

  // ---------- 1. Convert ----------
  const cv = { files: [] };

  async function cvRows(item, format, o) {
    if (format === "excel") {
      const sheets = await readXlsx(item.buffer);
      if (!sheets.length) throw new Error("The workbook has no sheets.");
      return D.matrixToRows(sheets[0].matrix, true, false);
    }
    if (format === "yaml") await needYaml();
    return D.parse(item.text, format, libs(), { inferTypes: o.infer });
  }

  async function cvRun() {
    const status = $("cv-status");
    try {
      const pasted = $("cv-text").value;
      const items = cv.files.length ? cv.files : pasted.trim() ? [{ name: "pasted", text: pasted }] : [];
      if (!items.length) { T.setStatus(status, "Drop a file or paste some text first.", "idle"); return; }
      T.setStatus(status, "Converting...", "busy");
      const outFmt = $("cv-out").value;
      const o = {
        flatten: $("cv-flatten").checked,
        infer: $("cv-infer").checked,
        escapeFormulas: $("cv-escape").checked,
        pretty: $("cv-json-style").value === "pretty",
        delimiter: $("cv-delim").value,
      };
      if (outFmt === "yaml") await needYaml();
      const outputs = [];
      const errors = [];
      const used = new Set();
      let firstRows = null;
      let firstText = null;
      for (const item of items) {
        try {
          let fmt = $("cv-in").value;
          if (fmt === "auto") fmt = item.buffer ? "excel" : D.detectFormat(item.text, item.name === "pasted" ? "" : item.name);
          const rows = await cvRows(item, fmt, o);
          let data;
          if (outFmt === "excel") data = await workbookBlob([{ name: T.baseName(item.name), rows }], { flatten: o.flatten, escapeFormulas: o.escapeFormulas });
          else data = D.serialize(rows, outFmt, o, libs());
          const fileName = uniqueName(`${T.safeFilename(T.baseName(item.name), "output")}.${D.EXT_FOR[outFmt]}`, used);
          outputs.push({ name: fileName, data, mime: D.MIME_FOR[outFmt], note: `${rows.length} rows` });
          if (!firstRows) { firstRows = rows; firstText = typeof data === "string" ? data : null; }
        } catch (e) {
          errors.push(`${item.name}: ${errMsg(e)}`);
        }
      }
      showOutputs($("cv-list"), $("cv-zip"), outputs);
      if (firstRows) {
        T.renderTable($("cv-table"), o.flatten && D.TABULAR.has(outFmt) ? D.flattenRows(firstRows) : firstRows, 100);
        $("cv-text-out").textContent = firstText === null ? "Binary Excel workbook - use Download." : firstText.length > 20000 ? `${firstText.slice(0, 20000)}\n... (preview truncated)` : firstText;
      } else {
        $("cv-table").textContent = "";
        $("cv-text-out").textContent = "";
      }
      if (errors.length) T.setStatus(status, `${outputs.length} converted, ${errors.length} failed. ${errors.join(" | ")}`, "error");
      else T.setStatus(status, `Converted ${outputs.length} ${outputs.length === 1 ? "input" : "inputs"} to ${outFmt.toUpperCase()}.`, "ok");
    } catch (e) {
      T.setStatus(status, errMsg(e), "error");
    }
  }

  async function loadCvFiles(files) {
    const items = [];
    for (const f of files) {
      const ext = T.extension(f.name);
      if (ext === "xlsx" || ext === "xlsm") items.push({ name: f.name, buffer: await T.readAsArrayBuffer(f) });
      else items.push({ name: f.name, text: await T.readAsText(f) });
    }
    cv.files = items;
    const fmt = items.length === 1 && !items[0].buffer ? D.detectFormat(items[0].text, items[0].name) : null;
    if (fmt && $("cv-in").value === "auto") $("cv-in").title = `Detected: ${fmt}`;
    cvRun();
  }

  T.mountDropZone($("cv-drop"), {
    accept: ".json,.csv,.tsv,.xlsx,.xlsm,.yaml,.yml,.xml,.md,.markdown,.txt,.html,.htm",
    multiple: true,
    onFiles: (files) => loadCvFiles(files).catch((e) => T.setStatus($("cv-status"), errMsg(e), "error")),
    onReject: (m) => T.setStatus($("cv-status"), m, "error"),
  });
  $("cv-run").addEventListener("click", cvRun);
  $("cv-clear").addEventListener("click", () => {
    cv.files = [];
    $("cv-text").value = "";
    $("cv-list").textContent = "";
    $("cv-table").textContent = "";
    $("cv-text-out").textContent = "";
    $("cv-zip").disabled = true;
    T.setStatus($("cv-status"), "", "idle");
  });
  const cvAgain = debounce(() => { if (cv.files.length || $("cv-text").value.trim()) cvRun(); }, 250);
  ["cv-in", "cv-out", "cv-json-style", "cv-delim", "cv-flatten", "cv-infer", "cv-escape"].forEach((id) => $(id).addEventListener("change", cvAgain));
  $("cv-text").addEventListener("input", () => { if (cv.files.length) { cv.files = []; } });

  // ---------- 2. JSON to Excel ----------
  const je = { files: [] }; // [{ name, rows }]

  function jeSources() {
    const list = je.files.slice();
    const pasted = $("je-text").value.trim();
    if (pasted) {
      try { list.push({ name: "pasted", rows: D.parse(pasted, "json") }); }
      catch (e) { throw new Error(`Pasted JSON: ${errMsg(e)}`); }
    }
    return list;
  }

  function jeRefresh() {
    const status = $("je-status");
    try {
      const sources = jeSources();
      const flat = $("je-flatten").checked;
      const cols = [];
      const seen = new Set();
      sources.forEach((s) => D.columnsOf(flat ? D.flattenRows(s.rows) : s.rows).forEach((c) => { if (!seen.has(c)) { seen.add(c); cols.push(c); } }));
      const sel = $("je-sort");
      const prev = sel.value;
      sel.textContent = "";
      sel.add(new Option("No sorting", ""));
      cols.forEach((c) => sel.add(new Option(c, c)));
      if (seen.has(prev)) sel.value = prev;
      if (sources.length) {
        const first = sources[0].rows;
        T.renderTable($("je-table"), flat ? D.flattenRows(first) : first, 50);
        T.setStatus(status, `${sources.length} source${sources.length > 1 ? "s" : ""} loaded (${sources.reduce((n, s) => n + s.rows.length, 0)} rows). Ready to build.`, "idle");
      } else $("je-table").textContent = "";
    } catch (e) {
      T.setStatus(status, errMsg(e), "error");
    }
  }

  async function jeRun() {
    const status = $("je-status");
    try {
      const sources = jeSources();
      if (!sources.length) { T.setStatus(status, "Drop a JSON file or paste JSON first.", "idle"); return; }
      T.setStatus(status, "Building workbook...", "busy");
      const opts = {
        sortBy: $("je-sort").value,
        descending: $("je-dir").value === "desc",
        summary: $("je-summary").checked,
        flatten: $("je-flatten").checked,
        escapeFormulas: $("je-escape").checked,
      };
      const outputs = [];
      const used = new Set();
      if ($("je-mode").value === "one" || sources.length === 1) {
        const name = sources.length === 1 ? T.baseName(sources[0].name) : "combined";
        const blob = await workbookBlob(sources.map((s) => ({ name: T.baseName(s.name), rows: s.rows })), opts);
        outputs.push({ name: uniqueName(`${T.safeFilename(name, "workbook")}.xlsx`, used), data: blob, mime: XLSX_MIME, note: `${sources.length} sheet${sources.length > 1 ? "s" : ""}` });
      } else {
        for (const s of sources) {
          const blob = await workbookBlob([{ name: T.baseName(s.name), rows: s.rows }], opts);
          outputs.push({ name: uniqueName(`${T.safeFilename(T.baseName(s.name), "workbook")}.xlsx`, used), data: blob, mime: XLSX_MIME, note: `${s.rows.length} rows` });
        }
      }
      showOutputs($("je-list"), $("je-zip"), outputs);
      T.setStatus(status, `Built ${outputs.length} workbook${outputs.length > 1 ? "s" : ""}.`, "ok");
    } catch (e) {
      T.setStatus(status, errMsg(e), "error");
    }
  }

  T.mountDropZone($("je-drop"), {
    accept: ".json,.txt,.ndjson",
    multiple: true,
    onFiles: async (files) => {
      try {
        const loaded = [];
        for (const f of files) {
          try { loaded.push({ name: f.name, rows: D.parse(await T.readAsText(f), "json") }); }
          catch (e) { throw new Error(`${f.name}: ${errMsg(e)}`); }
        }
        je.files = loaded;
        jeRefresh();
      } catch (e) {
        T.setStatus($("je-status"), errMsg(e), "error");
      }
    },
    onReject: (m) => T.setStatus($("je-status"), m, "error"),
  });
  $("je-run").addEventListener("click", jeRun);
  $("je-text").addEventListener("input", debounce(jeRefresh, 400));
  $("je-flatten").addEventListener("change", jeRefresh);
  $("je-clear").addEventListener("click", () => {
    je.files = [];
    $("je-text").value = "";
    $("je-list").textContent = "";
    $("je-table").textContent = "";
    $("je-zip").disabled = true;
    jeRefresh();
    T.setStatus($("je-status"), "", "idle");
  });

  // ---------- 3. Excel to JSON/CSV ----------
  const ex = { files: [] }; // [{ name, sheets }]

  function exRun() {
    const status = $("ex-status");
    try {
      if (!ex.files.length) return;
      const header = $("ex-header").checked;
      const pick = $("ex-sheet").value;
      const fmt = $("ex-out").value;
      const outputs = [];
      const skipped = [];
      const used = new Set();
      let preview = null;
      for (const f of ex.files) {
        const chosen = pick === "__all__" ? f.sheets : f.sheets.filter((s) => s.name === pick);
        if (!chosen.length) { skipped.push(f.name); continue; }
        for (const s of chosen) {
          const rows = D.matrixToRows(s.matrix, header, false);
          const text = D.serialize(rows, fmt, { pretty: true, delimiter: $("ex-delim").value, escapeFormulas: $("ex-escape").checked, flatten: true });
          const base = T.safeFilename(T.baseName(f.name), "workbook");
          const name = chosen.length > 1 || ex.files.length > 1 && pick === "__all__" ? `${base}-${T.safeFilename(s.name, "sheet")}` : base;
          outputs.push({ name: uniqueName(`${name}.${D.EXT_FOR[fmt]}`, used), data: text, mime: D.MIME_FOR[fmt], note: `${rows.length} rows` });
          if (!preview) preview = rows;
        }
      }
      showOutputs($("ex-list"), $("ex-zip"), outputs);
      if (preview) T.renderTable($("ex-table"), D.flattenRows(preview), 100); else $("ex-table").textContent = "";
      const msg = `Exported ${outputs.length} file${outputs.length === 1 ? "" : "s"}.` + (skipped.length ? ` No matching sheet in: ${skipped.join(", ")}.` : "");
      T.setStatus(status, msg, skipped.length && !outputs.length ? "error" : "ok");
    } catch (e) {
      T.setStatus(status, errMsg(e), "error");
    }
  }

  T.mountDropZone($("ex-drop"), {
    accept: ".xlsx,.xlsm",
    multiple: true,
    onFiles: async (files) => {
      const status = $("ex-status");
      try {
        T.setStatus(status, "Reading workbooks...", "busy");
        const loaded = [];
        for (const f of files) {
          try { loaded.push({ name: f.name, sheets: await readXlsx(await T.readAsArrayBuffer(f)) }); }
          catch (e) { throw new Error(`${f.name}: ${errMsg(e)}`); }
        }
        ex.files = loaded;
        const sel = $("ex-sheet");
        sel.textContent = "";
        sel.add(new Option("All sheets", "__all__"));
        const names = new Set();
        loaded.forEach((f) => f.sheets.forEach((s) => names.add(s.name)));
        names.forEach((n) => sel.add(new Option(n, n)));
        $("ex-run").disabled = false;
        exRun();
      } catch (e) {
        T.setStatus(status, errMsg(e), "error");
      }
    },
    onReject: (m) => T.setStatus($("ex-status"), m, "error"),
  });
  $("ex-run").addEventListener("click", exRun);
  ["ex-sheet", "ex-out", "ex-delim", "ex-header", "ex-escape"].forEach((id) => $(id).addEventListener("change", () => ex.files.length && exRun()));
  $("ex-clear").addEventListener("click", () => {
    ex.files = [];
    $("ex-sheet").textContent = "";
    $("ex-sheet").add(new Option("All sheets", "__all__"));
    $("ex-list").textContent = "";
    $("ex-table").textContent = "";
    $("ex-run").disabled = true;
    $("ex-zip").disabled = true;
    T.setStatus($("ex-status"), "", "idle");
  });

  // ---------- 4. Format & validate ----------
  let fmLastExt = "json";

  async function fmFormat() {
    const text = $("fm-in").value;
    if (!text.trim()) throw new Error("Paste or drop some text first.");
    let fmt = $("fm-format").value;
    if (fmt === "auto") {
      fmt = D.sniffFormat(text);
      if (!["json", "yaml", "xml"].includes(fmt)) throw new Error("Could not detect the format. Choose JSON, YAML or XML.");
    }
    if (fmt === "yaml") await needYaml();
    return fmt;
  }

  function fmShowResult(text, fmt, res) {
    const status = $("fm-status");
    const ctx = $("fm-context");
    if (res.valid) {
      ctx.classList.add("is-hidden");
      T.setStatus(status, `Valid ${fmt.toUpperCase()}.`, "ok");
      return;
    }
    const where = res.line ? ` at line ${res.line}, column ${res.column}` : "";
    T.setStatus(status, `Invalid ${fmt.toUpperCase()}${where}: ${res.error.slice(0, 300)}`, "error");
    if (res.line) {
      const lines = text.split(/\r?\n/);
      const from = Math.max(0, res.line - 3);
      const out = [];
      for (let i = from; i < Math.min(lines.length, res.line + 1); i++) {
        out.push(`${String(i + 1).padStart(4)} | ${lines[i].slice(0, 200)}`);
        if (i + 1 === res.line) out.push(`${" ".repeat(7 + Math.min(Math.max(res.column - 1, 0), 200))}^`);
      }
      ctx.textContent = out.join("\n");
      ctx.classList.remove("is-hidden");
    } else ctx.classList.add("is-hidden");
  }

  async function fmAct(mode) {
    const status = $("fm-status");
    try {
      const fmt = await fmFormat();
      const text = $("fm-in").value;
      const res = D.validate(text, fmt, libs());
      fmShowResult(text, fmt, res);
      if (mode === "validate" || !res.valid) return;
      const out = D.formatText(text, fmt, { mode, sortKeys: $("fm-sort").checked, indent: Number($("fm-indent").value) }, libs());
      $("fm-out-text").value = out;
      fmLastExt = D.EXT_FOR[fmt];
      T.setStatus(status, `Valid ${fmt.toUpperCase()}. ${mode === "minify" ? "Minified" : "Formatted"}: ${T.formatBytes(new Blob([text]).size)} in, ${T.formatBytes(new Blob([out]).size)} out.`, "ok");
    } catch (e) {
      T.setStatus(status, errMsg(e), "error");
    }
  }

  T.mountDropZone($("fm-drop"), {
    accept: ".json,.yaml,.yml,.xml,.txt",
    multiple: false,
    onFiles: async (files) => {
      try {
        $("fm-in").value = await T.readAsText(files[0]);
        const f = D.detectFormat($("fm-in").value, files[0].name);
        if (["json", "yaml", "xml"].includes(f)) $("fm-format").value = f;
        fmAct("validate");
      } catch (e) { T.setStatus($("fm-status"), errMsg(e), "error"); }
    },
    onReject: (m) => T.setStatus($("fm-status"), m, "error"),
  });
  $("fm-validate").addEventListener("click", () => fmAct("validate"));
  $("fm-pretty").addEventListener("click", () => fmAct("pretty"));
  $("fm-minify").addEventListener("click", () => fmAct("minify"));
  $("fm-copy").addEventListener("click", async () => {
    const v = $("fm-out-text").value;
    if (!v) { T.setStatus($("fm-status"), "Nothing to copy yet.", "idle"); return; }
    try { await navigator.clipboard.writeText(v); T.setStatus($("fm-status"), "Copied to clipboard.", "ok"); }
    catch (_) { $("fm-out-text").select(); T.setStatus($("fm-status"), "Clipboard unavailable; the output is selected, press Ctrl+C.", "idle"); }
  });
  $("fm-download").addEventListener("click", () => {
    const v = $("fm-out-text").value;
    if (!v) { T.setStatus($("fm-status"), "Nothing to download yet.", "idle"); return; }
    T.download(v, `formatted.${fmLastExt}`, "text/plain");
  });
  $("fm-clear").addEventListener("click", () => {
    $("fm-in").value = "";
    $("fm-out-text").value = "";
    $("fm-context").classList.add("is-hidden");
    T.setStatus($("fm-status"), "", "idle");
  });

  // ---------- 5. JSON diff ----------
  function dfParse(text, label) {
    if (!text.trim()) throw new Error(`${label} is empty.`);
    try { return D.parseValue(text, "json"); }
    catch (jsonErr) {
      if (window.jsyaml) {
        try { return D.parseValue(text, "yaml", libs()); } catch (_) { /* report JSON error below */ }
      }
      throw new Error(`${label} is not valid JSON or YAML: ${errMsg(jsonErr)}`);
    }
  }

  const short = (v) => {
    if (v === undefined) return "";
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s.length > 300 ? `${s.slice(0, 300)}...` : s;
  };

  async function dfRun() {
    const status = $("df-status");
    try {
      await needYaml();
      const a = dfParse($("df-a").value, "Input A");
      const b = dfParse($("df-b").value, "Input B");
      const changes = D.diff(a, b);
      if (!changes.length) {
        $("df-table").textContent = "";
        T.setStatus(status, "No differences: both inputs are structurally identical.", "ok");
        return;
      }
      const count = (t) => changes.filter((c) => c.type === t).length;
      T.renderTable($("df-table"), changes.map((c) => ({ Path: c.path, Change: c.type, Old: short(c.oldValue), New: short(c.newValue) })), 1000);
      T.setStatus(status, `${changes.length} difference${changes.length > 1 ? "s" : ""}: ${count("added")} added, ${count("removed")} removed, ${count("changed")} changed.`, "ok");
    } catch (e) {
      T.setStatus(status, errMsg(e), "error");
    }
  }

  ["a", "b"].forEach((side) => {
    T.mountDropZone($(`df-drop-${side}`), {
      accept: ".json,.yaml,.yml,.txt",
      multiple: false,
      onFiles: async (files) => {
        try { $(`df-${side}`).value = await T.readAsText(files[0]); }
        catch (e) { T.setStatus($("df-status"), errMsg(e), "error"); }
      },
      onReject: (m) => T.setStatus($("df-status"), m, "error"),
    });
  });
  $("df-run").addEventListener("click", dfRun);
  $("df-clear").addEventListener("click", () => {
    $("df-a").value = "";
    $("df-b").value = "";
    $("df-table").textContent = "";
    T.setStatus($("df-status"), "", "idle");
  });

  T.mountTabs($("tabs"));
})();
