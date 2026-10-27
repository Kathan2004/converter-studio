/*
 * Pure data-conversion logic (no DOM access at load time).
 * Libraries are injectable: parse(text, format, { jsyaml, DOMParser }) so Node tests
 * can run the library-free paths (JSON, CSV, TSV, Markdown, flatten, diff, ...).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DataCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const FORMATS = ["json", "csv", "tsv", "excel", "yaml", "xml", "markdown", "html"];
  const EXT_FOR = { json: "json", csv: "csv", tsv: "tsv", excel: "xlsx", yaml: "yaml", xml: "xml", markdown: "md", html: "html" };
  const MIME_FOR = {
    json: "application/json", csv: "text/csv", tsv: "text/tab-separated-values",
    excel: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    yaml: "text/yaml", xml: "application/xml", markdown: "text/markdown", html: "text/html",
  };

  const isPlainObject = (v) => Object.prototype.toString.call(v) === "[object Object]";

  function libOf(libs, name) {
    const l = (libs && libs[name]) || (typeof globalThis !== "undefined" ? globalThis[name] : undefined);
    if (!l) throw new Error(`${name} is not available in this environment.`);
    return l;
  }

  // ---------- Format detection ----------
  function detectFormat(text, filename) {
    const name = String(filename || "").toLowerCase();
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 ? name.slice(dot + 1) : "";
    const byExt = { json: "json", csv: "csv", tsv: "tsv", xlsx: "excel", xlsm: "excel", yaml: "yaml", yml: "yaml", xml: "xml", md: "markdown", markdown: "markdown", html: "html", htm: "html" };
    if (byExt[ext]) return byExt[ext];
    return sniffFormat(text);
  }

  function sniffFormat(text) {
    const t = String(text || "").replace(/^﻿/, "").trim();
    if (!t) return "json";
    if (t[0] === "{" || t[0] === "[") return "json";
    if (t[0] === "<") return /<table[\s>]/i.test(t) && !/^<\?xml/i.test(t) ? "html" : "xml";
    const lines = t.split(/\r?\n/);
    if (lines.length >= 2 && lines[0].includes("|") && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[1])) return "markdown";
    if (lines[0].includes("\t")) return "tsv";
    if (/^---\s*$/m.test(lines[0]) || /^-\s+\S/.test(lines[0]) || (/^[\w"'.-]+\s*:(\s|$)/.test(lines[0]) && !lines[0].includes(","))) return "yaml";
    return "csv";
  }

  // ---------- Cell/row helpers ----------
  function cellText(v) {
    if (v === null || v === undefined) return "";
    if (v instanceof Date) return v.toISOString();
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  }

  /** Flatten nested objects/arrays with dot notation: {a:{b:1},c:[5]} -> {"a.b":1,"c.0":5}. */
  function flattenObject(obj, prefix, out) {
    out = out || {};
    prefix = prefix || "";
    const entries = Array.isArray(obj) ? obj.map((v, i) => [String(i), v]) : Object.entries(obj);
    for (const [k, v] of entries) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (Array.isArray(v)) {
        if (v.length) flattenObject(v, key, out); else out[key] = "[]";
      } else if (isPlainObject(v)) {
        if (Object.keys(v).length) flattenObject(v, key, out); else out[key] = "{}";
      } else out[key] = v;
    }
    return out;
  }

  const flattenRows = (rows) => rows.map((r) => (isPlainObject(r) ? flattenObject(r) : { value: r }));

  /** Union of keys in first-seen order. */
  function columnsOf(rows) {
    const seen = new Set();
    const cols = [];
    for (const r of rows) {
      if (!r) continue;
      for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); cols.push(k); }
    }
    return cols;
  }

  /**
   * Turn any parsed value into an array of row objects.
   * Arrays map element-wise (primitives become {value}); an object with a single array
   * property ({"value":[...]}) uses that array; any other object becomes one row.
   */
  function normalizeRows(value) {
    let v = value;
    for (let guard = 0; guard < 5 && isPlainObject(v); guard++) {
      const keys = Object.keys(v);
      if (keys.length === 1 && Array.isArray(v[keys[0]])) v = v[keys[0]]; else break;
    }
    if (Array.isArray(v)) return v.map((x) => (isPlainObject(x) ? x : { value: x }));
    if (isPlainObject(v)) return [v];
    if (v === null || v === undefined) return [];
    return [{ value: v }];
  }

  // ---------- CSV (RFC 4180) ----------
  /** Parse delimited text into a matrix of strings. Handles quotes, escaped quotes, embedded newlines. */
  function parseCSVMatrix(text, delimiter) {
    const d = delimiter || ",";
    const s = String(text || "").replace(/^﻿/, "");
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    let i = 0;
    const n = s.length;
    let sawAny = false;
    while (i < n) {
      const c = s[i];
      if (inQuotes) {
        if (c === '"') {
          if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"' && field === "") { inQuotes = true; sawAny = true; i++; continue; }
      if (c === d) { row.push(field); field = ""; sawAny = true; i++; continue; }
      if (c === "\r" || c === "\n") {
        if (c === "\r" && s[i + 1] === "\n") i++;
        i++;
        row.push(field);
        field = "";
        rows.push(row);
        row = [];
        sawAny = false;
        continue;
      }
      field += c; sawAny = true; i++;
    }
    if (inQuotes) throw new Error("Unterminated quoted field in CSV input.");
    if (sawAny || field !== "" || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => !(r.length === 1 && r[0] === ""));
  }

  function detectDelimiter(text) {
    const first = String(text || "").replace(/^﻿/, "").split(/\r?\n/).find((l) => l.trim()) || "";
    const counts = { ",": 0, ";": 0, "\t": 0, "|": 0 };
    let q = false;
    for (const c of first) {
      if (c === '"') q = !q;
      else if (!q && c in counts) counts[c]++;
    }
    let best = ",";
    for (const k of Object.keys(counts)) if (counts[k] > counts[best]) best = k;
    return best;
  }

  /** "42" -> 42, "3.5" -> 3.5; leaves "007", "1e5", long digit strings, and non-numerics alone. */
  function inferValue(str) {
    if (typeof str !== "string") return str;
    if (/^-?(0|[1-9]\d{0,14})(\.\d{1,15})?$/.test(str) && str.replace(/^-/, "").replace(".", "").length <= 15) return Number(str);
    return str;
  }

  function uniqueHeaders(raw) {
    const used = new Set();
    return raw.map((h, i) => {
      let name = String(h == null ? "" : h).trim() || `column_${i + 1}`;
      let base = name;
      for (let k = 2; used.has(name); k++) name = `${base}_${k}`;
      used.add(name);
      return name;
    });
  }

  /** 2-D array -> row objects. firstRowHeaders=false names columns column_1.. */
  function matrixToRows(matrix, firstRowHeaders, inferTypes) {
    if (!matrix.length) return [];
    const useHeader = firstRowHeaders !== false;
    const width = matrix.reduce((m, r) => Math.max(m, r.length), 0);
    const headers = useHeader ? uniqueHeaders(matrix[0].concat(Array(Math.max(0, width - matrix[0].length)).fill(""))) : uniqueHeaders(Array(width).fill(""));
    const body = useHeader ? matrix.slice(1) : matrix;
    return body.map((r) => {
      const o = {};
      headers.forEach((h, i) => {
        const v = i < r.length ? r[i] : "";
        o[h] = inferTypes ? inferValue(v) : v;
      });
      return o;
    });
  }

  function parseCSV(text, options) {
    const o = options || {};
    const delimiter = o.delimiter && o.delimiter !== "auto" ? o.delimiter : detectDelimiter(text);
    return matrixToRows(parseCSVMatrix(text, delimiter), o.header !== false, o.inferTypes);
  }

  /** CSV-injection guard: spreadsheet apps execute strings starting with = + - @ tab CR as formulas. */
  function escapeFormula(v) {
    return typeof v === "string" && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  }

  function serializeCSV(rows, options) {
    const o = options || {};
    const d = o.delimiter || ",";
    const cols = o.columns || columnsOf(rows);
    const quote = (s) => (s.includes('"') || s.includes("\n") || s.includes("\r") || s.includes(d) ? `"${s.replace(/"/g, '""')}"` : s);
    const cell = (v) => {
      let x = v;
      if (o.escapeFormulas && typeof x === "string") x = escapeFormula(x);
      return quote(cellText(x));
    };
    const lines = [cols.map((c) => cell(c)).join(d)];
    for (const r of rows) lines.push(cols.map((c) => cell(r[c])).join(d));
    return lines.join("\n") + "\n";
  }

  // ---------- Markdown table ----------
  function splitMdRow(line) {
    let s = line.trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
    const cells = [];
    let cur = "";
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "\\" && s[i + 1] === "|") { cur += "|"; i++; }
      else if (s[i] === "|") { cells.push(cur.trim()); cur = ""; }
      else cur += s[i];
    }
    cells.push(cur.trim());
    return cells;
  }

  function parseMarkdownTable(text, options) {
    const lines = String(text || "").split(/\r?\n/);
    const sep = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
    for (let i = 0; i < lines.length - 1; i++) {
      if (lines[i].includes("|") && sep.test(lines[i + 1]) && lines[i + 1].includes("-")) {
        const matrix = [splitMdRow(lines[i])];
        for (let j = i + 2; j < lines.length && lines[j].includes("|") && lines[j].trim(); j++) {
          matrix.push(splitMdRow(lines[j]).map((c) => c.replace(/<br\s*\/?>/gi, "\n")));
        }
        return matrixToRows(matrix, true, options && options.inferTypes);
      }
    }
    throw new Error("No Markdown table found (expected a header row followed by a |---| separator row).");
  }

  function serializeMarkdown(rows, options) {
    const o = options || {};
    const cols = o.columns || columnsOf(rows);
    if (!cols.length) return "";
    const esc = (v) => {
      let x = v;
      if (o.escapeFormulas && typeof x === "string") x = escapeFormula(x);
      return cellText(x).replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
    };
    const body = rows.map((r) => cols.map((c) => esc(r[c])));
    const head = cols.map(esc);
    const widths = head.map((h, i) => Math.max(3, h.length, ...body.map((r) => r[i].length)));
    const pad = (cells) => `| ${cells.map((c, i) => c.padEnd(widths[i])).join(" | ")} |`;
    return [pad(head), `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`, ...body.map(pad)].join("\n") + "\n";
  }

  // ---------- HTML table ----------
  const escHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  function serializeHTML(rows, options) {
    const o = options || {};
    const cols = o.columns || columnsOf(rows);
    const cell = (v) => escHtml(cellText(o.escapeFormulas ? escapeFormula(v) : v));
    const out = ["<table>", "  <thead>", "    <tr>" + cols.map((c) => `<th>${escHtml(c)}</th>`).join("") + "</tr>", "  </thead>", "  <tbody>"];
    for (const r of rows) out.push("    <tr>" + cols.map((c) => `<td>${cell(r[c])}</td>`).join("") + "</tr>");
    out.push("  </tbody>", "</table>");
    return out.join("\n") + "\n";
  }

  function parseHTMLTable(text, libs, options) {
    const DP = libOf(libs, "DOMParser");
    const doc = new DP().parseFromString(String(text), "text/html");
    const table = doc.querySelector("table");
    if (!table) throw new Error("No <table> element found in the HTML.");
    const trs = Array.from(table.querySelectorAll("tr"));
    const matrix = trs.map((tr) => Array.from(tr.children).filter((c) => /^(TD|TH)$/i.test(c.tagName)).map((c) => c.textContent.trim()));
    return matrixToRows(matrix.filter((r) => r.length), true, options && options.inferTypes);
  }

  // ---------- XML ----------
  function xmlName(key) {
    let n = String(key).replace(/[^A-Za-z0-9_.\-]/g, "_");
    if (!/^[A-Za-z_]/.test(n)) n = `_${n}`;
    return n;
  }
  const escXml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  function xmlNodeToValue(node) {
    const obj = {};
    let hasAttr = false;
    for (const a of Array.from(node.attributes || [])) { obj[`@${a.name}`] = a.value; hasAttr = true; }
    const kids = Array.from(node.childNodes).filter((c) => c.nodeType === 1);
    let text = Array.from(node.childNodes).filter((c) => c.nodeType === 3 || c.nodeType === 4).map((c) => c.nodeValue).join("").trim();
    if (!kids.length && !hasAttr) return text;
    for (const k of kids) {
      const v = xmlNodeToValue(k);
      if (k.nodeName in obj) {
        if (!Array.isArray(obj[k.nodeName])) obj[k.nodeName] = [obj[k.nodeName]];
        obj[k.nodeName].push(v);
      } else obj[k.nodeName] = v;
    }
    if (text && (kids.length || hasAttr)) obj["#text"] = text;
    return obj;
  }

  function parseXMLValue(text, libs) {
    const DP = libOf(libs, "DOMParser");
    const doc = new DP().parseFromString(String(text), "application/xml");
    const err = doc.getElementsByTagName("parsererror")[0];
    if (err) throw new Error(err.textContent.replace(/\s+/g, " ").trim().slice(0, 300));
    return xmlNodeToValue(doc.documentElement);
  }

  /** Walk down single-child wrappers (<root><items><item/>...) until an array of records appears. */
  function xmlToRows(value) {
    let v = value;
    for (let guard = 0; guard < 8 && isPlainObject(v); guard++) {
      const keys = Object.keys(v).filter((k) => !k.startsWith("@"));
      if (keys.length === 1 && Object.keys(v).length === 1) {
        const inner = v[keys[0]];
        if (Array.isArray(inner)) return normalizeRows(inner);
        v = inner;
      } else break;
    }
    return normalizeRows(v);
  }

  function xmlWrite(key, value, indent, out, depth) {
    const pad = "  ".repeat(depth);
    if (Array.isArray(value)) { for (const v of value) xmlWrite(key, v, indent, out, depth); return; }
    const name = xmlName(key);
    if (isPlainObject(value)) {
      const attrs = Object.keys(value).filter((k) => k.startsWith("@")).map((k) => ` ${xmlName(k.slice(1))}="${escXml(cellText(value[k]))}"`).join("");
      const kids = Object.keys(value).filter((k) => !k.startsWith("@") && k !== "#text");
      const text = value["#text"];
      if (!kids.length) {
        out.push(text !== undefined ? `${pad}<${name}${attrs}>${escXml(cellText(text))}</${name}>` : `${pad}<${name}${attrs}/>`);
        return;
      }
      out.push(`${pad}<${name}${attrs}>`);
      if (text !== undefined) out.push(`${pad}  ${escXml(cellText(text))}`);
      for (const k of kids) xmlWrite(k, value[k], indent, out, depth + 1);
      out.push(`${pad}</${name}>`);
    } else if (value === null || value === undefined || value === "") {
      out.push(`${pad}<${name}/>`);
    } else out.push(`${pad}<${name}>${escXml(cellText(value))}</${name}>`);
  }

  function serializeXML(rows, options) {
    const o = options || {};
    const out = ['<?xml version="1.0" encoding="UTF-8"?>', `<${xmlName(o.rootName || "rows")}>`];
    for (const r of rows) xmlWrite("row", r, 2, out, 1);
    out.push(`</${xmlName(o.rootName || "rows")}>`);
    return out.join("\n") + "\n";
  }

  // ---------- Generic parse / serialize ----------
  function parseJSONText(text) {
    const t = String(text).replace(/^﻿/, "");
    try {
      return JSON.parse(t);
    } catch (e) {
      // NDJSON fallback: one JSON value per line
      const lines = t.split(/\r?\n/).filter((l) => l.trim());
      if (lines.length > 1) {
        try { return lines.map((l) => JSON.parse(l)); } catch (_) { /* fall through */ }
      }
      throw e;
    }
  }

  /** Parse text of a structured format (json|yaml|xml) to its raw value. */
  function parseValue(text, format, libs) {
    switch (format) {
      case "json": return parseJSONText(text);
      case "yaml": return libOf(libs, "jsyaml").load(String(text));
      case "xml": return parseXMLValue(text, libs);
      default: throw new Error(`Not a structured format: ${format}`);
    }
  }

  /** Any supported text format -> array of row objects. */
  function parse(text, format, libs, options) {
    const o = options || {};
    switch (format) {
      case "json": return normalizeRows(parseJSONText(text));
      case "yaml": return normalizeRows(libOf(libs, "jsyaml").load(String(text)));
      case "xml": return xmlToRows(parseXMLValue(text, libs));
      case "csv": return parseCSV(text, { delimiter: o.delimiter, inferTypes: o.inferTypes });
      case "tsv": return parseCSV(text, { delimiter: "\t", inferTypes: o.inferTypes });
      case "markdown": return parseMarkdownTable(text, o);
      case "html": return parseHTMLTable(text, libs, o);
      default: throw new Error(`Unsupported input format: ${format}`);
    }
  }

  const TABULAR = new Set(["csv", "tsv", "excel", "markdown", "html"]);

  /**
   * Row objects -> text. options: { flatten, pretty, delimiter, escapeFormulas, rootName }.
   * flatten defaults to true for tabular outputs. Excel is built separately (buildWorkbook).
   */
  function serialize(rows, format, options, libs) {
    const o = options || {};
    const flat = o.flatten === undefined ? TABULAR.has(format) : o.flatten;
    const data = flat && TABULAR.has(format) ? flattenRows(rows) : rows;
    switch (format) {
      case "json": return JSON.stringify(rows, null, o.pretty === false ? 0 : o.indent || 2) + "\n";
      case "csv": return serializeCSV(data, { delimiter: o.delimiter || ",", escapeFormulas: o.escapeFormulas });
      case "tsv": return serializeCSV(data, { delimiter: "\t", escapeFormulas: o.escapeFormulas });
      case "markdown": return serializeMarkdown(data, o);
      case "html": return serializeHTML(data, o);
      case "yaml": return libOf(libs, "jsyaml").dump(rows, { lineWidth: -1, noRefs: true });
      case "xml": return serializeXML(rows, o);
      case "excel": throw new Error("Excel output is binary; use buildWorkbook().");
      default: throw new Error(`Unsupported output format: ${format}`);
    }
  }

  // ---------- Sorting, summary, sheet names ----------
  function sortRows(rows, column, descending) {
    if (!column) return rows.slice();
    const dir = descending ? -1 : 1;
    const isNil = (v) => v === null || v === undefined || v === "";
    return rows.map((r, i) => [r, i]).sort((a, b) => {
      const x = a[0][column], y = b[0][column];
      if (isNil(x) && isNil(y)) return a[1] - b[1];
      if (isNil(x)) return 1;
      if (isNil(y)) return -1;
      let c;
      if (typeof x === "number" && typeof y === "number") c = x - y;
      else c = cellText(x).localeCompare(cellText(y), undefined, { numeric: true, sensitivity: "base" });
      return c ? c * dir : a[1] - b[1];
    }).map((p) => p[0]);
  }

  /** Row count plus value counts for each column with <= maxDistinct distinct values. */
  function summarize(rows, maxDistinct) {
    const limit = maxDistinct || 20;
    const columns = [];
    for (const col of columnsOf(rows)) {
      const counts = new Map();
      let overflow = false;
      for (const r of rows) {
        const key = cellText(r[col]);
        counts.set(key, (counts.get(key) || 0) + 1);
        if (counts.size > limit) { overflow = true; break; }
      }
      // A column where every row is unique (an identifier) is not a useful breakdown.
      if (overflow || (rows.length > 1 && counts.size === rows.length) || !counts.size) continue;
      const values = Array.from(counts, ([value, count]) => ({ value: value === "" ? "(blank)" : value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
      columns.push({ name: col, values });
    }
    return { rowCount: rows.length, columns };
  }

  /** Excel-safe sheet name: strips []:*?/\, max 31 chars, unique (case-insensitive) within `used`. */
  function sanitizeSheetName(name, used) {
    let n = String(name == null ? "" : name).replace(/[\[\]:*?\/\\]/g, " ").replace(/\s+/g, " ").trim().replace(/^'+|'+$/g, "").trim();
    if (!n || n.toLowerCase() === "history") n = n ? `${n}_` : "Sheet";
    n = n.slice(0, 31).trim() || "Sheet";
    if (!used) return n;
    const taken = (x) => used.has(x.toLowerCase());
    let out = n;
    for (let i = 2; taken(out); i++) {
      const suffix = ` (${i})`;
      out = n.slice(0, 31 - suffix.length).trim() + suffix;
    }
    used.add(out.toLowerCase());
    return out;
  }

  // ---------- Excel (ExcelJS injected) ----------
  const NAVY = "FF1F3864";
  const THIN = { style: "thin", color: { argb: "FFBFBFBF" } };
  const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };

  function excelValue(v, escape) {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) return v;
    if (typeof v === "number" || typeof v === "boolean") return v;
    if (typeof v === "object") v = JSON.stringify(v);
    let s = String(v);
    if (escape) s = escapeFormula(s);
    return s.length > 32000 ? s.slice(0, 32000) : s;
  }

  function styleSheet(ws, headers, grid) {
    const widths = headers.map((h) => String(h).length);
    grid.forEach((row) => row.forEach((v, i) => {
      const len = v instanceof Date ? 10 : v === null ? 0 : String(v).split("\n").reduce((m, l) => Math.max(m, l.length), 0);
      if (len > widths[i]) widths[i] = len;
    }));
    widths.forEach((w, i) => { ws.getColumn(i + 1).width = Math.min(60, Math.max(8, w + 2)); });
    ws.eachRow((row, rowNumber) => {
      row.eachCell({ includeEmpty: true }, (cell) => {
        cell.border = BORDER;
        if (rowNumber === 1) {
          cell.font = { name: "Arial", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
          cell.alignment = { vertical: "middle", horizontal: "left" };
        } else {
          cell.font = { name: "Arial", size: 10 };
          cell.alignment = { vertical: "top", horizontal: typeof cell.value === "number" ? "right" : "left" };
        }
      });
    });
    ws.views = [{ state: "frozen", ySplit: 1 }];
    if (headers.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
  }

  function addDataSheet(wb, name, rows, opts) {
    const ws = wb.addWorksheet(name);
    const headers = opts.columns || columnsOf(rows);
    const grid = rows.map((r) => headers.map((h) => excelValue(r[h], opts.escapeFormulas)));
    ws.addRow(headers.map((h) => (opts.escapeFormulas ? escapeFormula(String(h)) : String(h))));
    grid.forEach((g) => ws.addRow(g));
    styleSheet(ws, headers, grid);
    return ws;
  }

  function addSummarySheet(wb, name, sheets) {
    const ws = wb.addWorksheet(name);
    const grid = [];
    for (const s of sheets) {
      const sum = summarize(s.rows, 20);
      grid.push([s.name, "Row count", sum.rowCount]);
      for (const col of sum.columns) for (const v of col.values) grid.push([s.name, `${col.name}: ${v.value}`, v.count]);
    }
    const headers = ["Sheet", "Metric", "Count"];
    ws.addRow(headers);
    grid.forEach((g) => ws.addRow(g));
    styleSheet(ws, headers, grid);
    return ws;
  }

  /**
   * sheets: [{ name, rows }]. options: { sortBy, descending, summary, escapeFormulas, flatten }.
   * Returns an ExcelJS Workbook; call workbook.xlsx.writeBuffer() to get the bytes.
   */
  function buildWorkbook(ExcelJS, sheets, options) {
    const o = options || {};
    const wb = new ExcelJS.Workbook();
    wb.creator = "Converter Studio";
    wb.created = new Date();
    const used = new Set();
    const prepared = sheets.map((s) => {
      let rows = o.flatten === false ? s.rows : flattenRows(s.rows);
      if (o.sortBy) rows = sortRows(rows, o.sortBy, o.descending);
      return { name: sanitizeSheetName(s.name, used), rows };
    });
    // Data sheets first so the workbook opens on the data; the summary goes last.
    for (const s of prepared) addDataSheet(wb, s.name, s.rows, { escapeFormulas: o.escapeFormulas });
    if (o.summary) addSummarySheet(wb, sanitizeSheetName("Summary", used), prepared);
    return wb;
  }

  /** Reduce an ExcelJS cell.value (rich text, formula, hyperlink, date, error) to a plain value. */
  function cellToPlain(v) {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) {
      const iso = v.toISOString();
      return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
    }
    if (typeof v !== "object") return v;
    if (Array.isArray(v.richText)) return v.richText.map((p) => p.text).join("");
    if ("result" in v || "formula" in v || "sharedFormula" in v) return "result" in v ? cellToPlain(v.result) : null;
    if ("hyperlink" in v) return cellToPlain(v.text !== undefined ? v.text : v.hyperlink);
    if ("error" in v) return String(v.error);
    if ("text" in v) return cellToPlain(v.text);
    return JSON.stringify(v);
  }

  // ---------- Validate & format ----------
  function positionToLineCol(text, pos) {
    const before = text.slice(0, pos);
    const line = before.split("\n").length;
    return { line, column: pos - before.lastIndexOf("\n") };
  }

  /** Minimal JSON scanner returning the offset of the first syntax error, or -1. Used when the engine message has no position. */
  function jsonErrorOffset(s) {
    let i = 0;
    const ws = () => { while (i < s.length && " \t\n\r".includes(s[i])) i++; };
    const fail = () => { throw i; };
    function value() {
      ws();
      const c = s[i];
      if (c === "{") {
        i++; ws();
        if (s[i] === "}") { i++; return; }
        for (;;) {
          ws(); if (s[i] !== '"') fail();
          str(); ws(); if (s[i] !== ":") fail();
          i++; value(); ws();
          if (s[i] === ",") { i++; continue; }
          if (s[i] === "}") { i++; return; }
          fail();
        }
      } else if (c === "[") {
        i++; ws();
        if (s[i] === "]") { i++; return; }
        for (;;) {
          value(); ws();
          if (s[i] === ",") { i++; continue; }
          if (s[i] === "]") { i++; return; }
          fail();
        }
      } else if (c === '"') str();
      else {
        const m = /^(-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?|true|false|null)/.exec(s.slice(i, i + 400));
        if (!m) fail();
        i += m[0].length;
      }
    }
    function str() {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\") i++;
        else if (s[i] < " ") fail();
        i++;
      }
      if (i >= s.length) fail();
      i++;
    }
    try { value(); ws(); if (i < s.length) fail(); return -1; } catch (e) { return typeof e === "number" ? e : -1; }
  }

  /** Returns { valid, error?, line?, column? }. */
  function validate(text, format, libs) {
    const src = String(text);
    try {
      if (format === "json") {
        JSON.parse(src.replace(/^﻿/, ""));
      } else if (format === "yaml") {
        libOf(libs, "jsyaml").load(src);
      } else if (format === "xml") {
        parseXMLValue(src, libs);
      } else throw new Error(`Cannot validate format: ${format}`);
      return { valid: true };
    } catch (e) {
      const res = { valid: false, error: String((e && e.message) || e) };
      const msg = res.error;
      let m;
      if (format === "json") {
        if ((m = /line (\d+) column (\d+)/i.exec(msg))) { res.line = +m[1]; res.column = +m[2]; }
        else if ((m = /position (\d+)/i.exec(msg))) Object.assign(res, positionToLineCol(src, +m[1]));
        else {
          const off = jsonErrorOffset(src.replace(/^\uFEFF/, ""));
          if (off >= 0) Object.assign(res, positionToLineCol(src.replace(/^\uFEFF/, ""), off));
        }
      } else if (format === "yaml" && e && e.mark) {
        res.line = e.mark.line + 1;
        res.column = e.mark.column + 1;
      } else if (format === "xml" && (m = /line (?:number )?(\d+)(?:,| at)? (?:column|char(?:acter)?) (\d+)/i.exec(msg))) {
        res.line = +m[1]; res.column = +m[2];
      }
      return res;
    }
  }

  function sortKeysDeep(v) {
    if (Array.isArray(v)) return v.map(sortKeysDeep);
    if (isPlainObject(v)) {
      const o = {};
      for (const k of Object.keys(v).sort()) o[k] = sortKeysDeep(v[k]);
      return o;
    }
    return v;
  }

  function prettyXml(text, libs, indentSize) {
    const DP = libOf(libs, "DOMParser");
    const doc = new DP().parseFromString(String(text), "application/xml");
    const err = doc.getElementsByTagName("parsererror")[0];
    if (err) throw new Error(err.textContent.replace(/\s+/g, " ").trim().slice(0, 300));
    const unit = " ".repeat(indentSize || 2);
    const out = [];
    const walk = (node, depth) => {
      const pad = unit.repeat(depth);
      if (node.nodeType === 3 || node.nodeType === 4) {
        const t = node.nodeValue.trim();
        if (t) out.push(pad + (node.nodeType === 4 ? `<![CDATA[${t}]]>` : escXml(t)));
        return;
      }
      if (node.nodeType === 8) { out.push(`${pad}<!--${node.nodeValue}-->`); return; }
      if (node.nodeType !== 1) return;
      const attrs = Array.from(node.attributes).map((a) => ` ${a.name}="${escXml(a.value)}"`).join("");
      const kids = Array.from(node.childNodes).filter((c) => !((c.nodeType === 3) && !c.nodeValue.trim()));
      if (!kids.length) { out.push(`${pad}<${node.nodeName}${attrs}/>`); return; }
      if (kids.every((c) => c.nodeType === 3)) { out.push(`${pad}<${node.nodeName}${attrs}>${escXml(node.textContent.trim())}</${node.nodeName}>`); return; }
      out.push(`${pad}<${node.nodeName}${attrs}>`);
      kids.forEach((c) => walk(c, depth + 1));
      out.push(`${pad}</${node.nodeName}>`);
    };
    const decl = /^\s*<\?xml[^>]*\?>/.exec(String(text));
    if (decl) out.push(decl[0].trim());
    walk(doc.documentElement, 0);
    return out.join("\n") + "\n";
  }

  /** options: { mode: "pretty"|"minify", sortKeys, indent } */
  function formatText(text, format, options, libs) {
    const o = options || {};
    const minify = o.mode === "minify";
    const indent = o.indent || 2;
    if (format === "json") {
      let v = parseJSONText(text);
      if (o.sortKeys) v = sortKeysDeep(v);
      return JSON.stringify(v, null, minify ? 0 : indent) + "\n";
    }
    if (format === "yaml") {
      const y = libOf(libs, "jsyaml");
      let v = y.load(String(text));
      if (o.sortKeys) v = sortKeysDeep(v);
      return minify ? JSON.stringify(v) + "\n" : y.dump(v, { indent, lineWidth: -1, noRefs: true });
    }
    if (format === "xml") {
      if (minify) {
        const DP = libOf(libs, "DOMParser");
        const doc = new DP().parseFromString(String(text), "application/xml");
        if (doc.getElementsByTagName("parsererror")[0]) throw new Error("Invalid XML.");
        return String(text).trim().replace(/>\s+</g, "><") + "\n";
      }
      return prettyXml(text, libs, indent);
    }
    throw new Error(`Cannot format: ${format}`);
  }

  // ---------- Structural diff ----------
  function diffPath(base, key) {
    if (typeof key === "number") return `${base}[${key}]`;
    return base ? `${base}.${key}` : String(key);
  }

  /** Returns [{ path, type: "added"|"removed"|"changed", oldValue, newValue }]. Arrays compare by index. */
  function diff(a, b, path, out) {
    out = out || [];
    path = path || "";
    const label = path || "(root)";
    if (Array.isArray(a) && Array.isArray(b)) {
      const n = Math.max(a.length, b.length);
      for (let i = 0; i < n; i++) {
        const p = diffPath(path, i);
        if (i >= a.length) out.push({ path: p, type: "added", newValue: b[i] });
        else if (i >= b.length) out.push({ path: p, type: "removed", oldValue: a[i] });
        else diff(a[i], b[i], p, out);
      }
    } else if (isPlainObject(a) && isPlainObject(b)) {
      for (const k of Object.keys(a)) {
        const p = diffPath(path, k);
        if (!(k in b)) out.push({ path: p, type: "removed", oldValue: a[k] });
        else diff(a[k], b[k], p, out);
      }
      for (const k of Object.keys(b)) if (!(k in a)) out.push({ path: diffPath(path, k), type: "added", newValue: b[k] });
    } else if (!Object.is(a, b) && JSON.stringify(a) !== JSON.stringify(b)) {
      out.push({ path: label, type: "changed", oldValue: a, newValue: b });
    }
    return out;
  }

  return {
    FORMATS, EXT_FOR, MIME_FOR, TABULAR,
    detectFormat, sniffFormat, detectDelimiter,
    parse, parseValue, serialize, normalizeRows, xmlToRows,
    parseCSV, parseCSVMatrix, serializeCSV, matrixToRows, inferValue,
    parseMarkdownTable, serializeMarkdown, serializeHTML, parseHTMLTable, serializeXML,
    flattenObject, flattenRows, columnsOf, cellText, escapeFormula,
    sortRows, summarize, sanitizeSheetName, buildWorkbook, cellToPlain,
    validate, formatText, sortKeysDeep, diff,
  };
});
