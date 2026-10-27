const test = require("node:test");
const assert = require("node:assert/strict");
const D = require("../js/data-core.js");

test("detectFormat uses extension then sniffs content", () => {
  assert.equal(D.detectFormat("", "a.yml"), "yaml");
  assert.equal(D.detectFormat("", "a.XLSX"), "excel");
  assert.equal(D.detectFormat('{"a":1}', "x.txt"), "json");
  assert.equal(D.detectFormat("a\tb\n1\t2", "x.txt"), "tsv");
  assert.equal(D.detectFormat("a,b\n1,2", "x.txt"), "csv");
  assert.equal(D.detectFormat("| a | b |\n|---|---|\n| 1 | 2 |", "x.txt"), "markdown");
  assert.equal(D.detectFormat("<table><tr><td>1</td></tr></table>", "x.txt"), "html");
  assert.equal(D.detectFormat('<?xml version="1.0"?><a/>', "x.txt"), "xml");
  assert.equal(D.detectFormat("name: x\nage: 3", "x.txt"), "yaml");
});

test("CSV parser handles quotes, escaped quotes and embedded newlines", () => {
  const m = D.parseCSVMatrix('a,b\n"x, y","he said ""hi"""\n"line1\nline2",z\r\n');
  assert.deepEqual(m, [["a", "b"], ["x, y", 'he said "hi"'], ["line1\nline2", "z"]]);
});

test("CSV parser strips BOM, keeps empty trailing fields, rejects unterminated quotes", () => {
  assert.deepEqual(D.parseCSVMatrix("﻿a,b\n1,\n"), [["a", "b"], ["1", ""]]);
  assert.throws(() => D.parseCSVMatrix('a\n"oops'), /Unterminated/);
});

test("parseCSV builds objects, dedupes and fills headers", () => {
  const rows = D.parseCSV("a,a,\n1,2,3\n4,5\n");
  assert.deepEqual(rows, [{ a: "1", a_2: "2", column_3: "3" }, { a: "4", a_2: "5", column_3: "" }]);
});

test("delimiter auto-detection ignores delimiters inside quotes", () => {
  assert.equal(D.detectDelimiter('"a,b,c";d;e'), ";");
  assert.equal(D.detectDelimiter("a\tb\tc"), "\t");
  assert.deepEqual(D.parseCSV("x;y\n1;2"), [{ x: "1", y: "2" }]);
});

test("type inference keeps leading zeros and long ids as strings", () => {
  assert.equal(D.inferValue("42"), 42);
  assert.equal(D.inferValue("-3.5"), -3.5);
  assert.equal(D.inferValue("007"), "007");
  assert.equal(D.inferValue("12345678901234567890"), "12345678901234567890");
  assert.deepEqual(D.parseCSV("n\n5", { inferTypes: true }), [{ n: 5 }]);
});

test("CSV round trip with special characters", () => {
  const rows = [{ a: 'q"uote', b: "x,y", c: "l1\nl2", d: 5 }];
  const csv = D.serializeCSV(rows, { delimiter: "," });
  assert.deepEqual(D.parseCSV(csv), [{ a: 'q"uote', b: "x,y", c: "l1\nl2", d: "5" }]);
});

test("CSV injection guard prefixes dangerous leading characters", () => {
  const rows = [{ a: "=SUM(A1)", b: "+1", c: "-x", d: "@cmd", e: "\tTab", f: "safe", g: -5 }];
  const out = D.serializeCSV(rows, { escapeFormulas: true }).split("\n")[1];
  assert.equal(out, "'=SUM(A1),'+1,'-x,'@cmd,'\tTab,safe,-5");
  const raw = D.serializeCSV(rows, { escapeFormulas: false }).split("\n")[1];
  assert.ok(raw.startsWith("=SUM(A1)"));
});

test("flattenObject uses dot notation and indexes arrays", () => {
  assert.deepEqual(D.flattenObject({ a: { b: { c: 1 } }, t: ["x", { y: 2 }], e: [], o: {} }),
    { "a.b.c": 1, "t.0": "x", "t.1.y": 2, e: "[]", o: "{}" });
});

test("normalizeRows: single array property, single object, primitives", () => {
  assert.deepEqual(D.normalizeRows({ value: [{ a: 1 }, { a: 2 }] }), [{ a: 1 }, { a: 2 }]);
  assert.deepEqual(D.normalizeRows({ a: 1, b: 2 }), [{ a: 1, b: 2 }]);
  assert.deepEqual(D.normalizeRows([1, { a: 2 }]), [{ value: 1 }, { a: 2 }]);
  assert.deepEqual(D.normalizeRows({ a: 1, list: [1] }), [{ a: 1, list: [1] }]);
});

test("parse json supports NDJSON fallback", () => {
  assert.deepEqual(D.parse('{"a":1}\n{"a":2}', "json"), [{ a: 1 }, { a: 2 }]);
  assert.throws(() => D.parse("{bad", "json"));
});

test("serialize json pretty vs minified", () => {
  const rows = [{ a: 1 }];
  assert.equal(D.serialize(rows, "json", { pretty: true }), '[\n  {\n    "a": 1\n  }\n]\n');
  assert.equal(D.serialize(rows, "json", { pretty: false }), '[{"a":1}]\n');
});

test("tabular serialize flattens by default and can keep JSON text", () => {
  const rows = [{ id: 1, meta: { k: "v" }, tags: ["a", "b"] }];
  assert.equal(D.serialize(rows, "csv"), "id,meta.k,tags.0,tags.1\n1,v,a,b\n");
  assert.equal(D.serialize(rows, "csv", { flatten: false }), 'id,meta,tags\n1,"{""k"":""v""}","[""a"",""b""]"\n');
  assert.equal(D.serialize([{ a: 1, b: 2 }], "tsv"), "a\tb\n1\t2\n");
});

test("markdown table serialize and parse round trip, escaping pipes", () => {
  const rows = [{ name: "a|b", n: "1" }, { name: "c", n: "22" }];
  const md = D.serializeMarkdown(rows);
  assert.match(md, /a\\\|b/);
  assert.deepEqual(D.parseMarkdownTable("intro text\n\n" + md + "\nafter"), rows);
  assert.throws(() => D.parseMarkdownTable("no table here"), /No Markdown table/);
});

test("html serialize escapes cell content", () => {
  const html = D.serializeHTML([{ a: "<script>alert(1)</script>" }]);
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
});

test("xml serialize handles attributes, nesting, arrays, escaping", () => {
  const xml = D.serialize([{ "@id": "7", name: "A & B", tags: ["x", "y"], "1bad key": 1 }], "xml");
  assert.match(xml, /<row id="7">/);
  assert.match(xml, /<name>A &amp; B<\/name>/);
  assert.match(xml, /<tags>x<\/tags>\n\s+<tags>y<\/tags>/);
  assert.match(xml, /<_1bad_key>1<\/_1bad_key>/);
});

test("xmlToRows unwraps wrappers to repeated record elements", () => {
  const v = { catalog: { item: [{ id: "1" }, { id: "2" }] } };
  assert.deepEqual(D.xmlToRows(v), [{ id: "1" }, { id: "2" }]);
});

test("yaml and xml parse require their library, injected stubs are used", () => {
  const rows = D.parse("ignored", "yaml", { jsyaml: { load: () => [{ a: 1 }] } });
  assert.deepEqual(rows, [{ a: 1 }]);
  assert.equal(D.serialize([{ a: 1 }], "yaml", {}, { jsyaml: { dump: () => "STUB" } }), "STUB");
});

test("sanitizeSheetName strips illegal chars, truncates and de-duplicates", () => {
  const used = new Set();
  assert.equal(D.sanitizeSheetName("a/b:c*d?[e]\\f", used), "a b c d e f");
  const long = "x".repeat(40);
  const first = D.sanitizeSheetName(long, used);
  const second = D.sanitizeSheetName(long, used);
  assert.equal(first.length, 31);
  assert.equal(second.length, 31);
  assert.notEqual(first, second);
  assert.equal(D.sanitizeSheetName("Report", used), "Report");
  assert.equal(D.sanitizeSheetName("REPORT", used), "REPORT (2)");
  assert.equal(D.sanitizeSheetName("", new Set()), "Sheet");
  assert.equal(D.sanitizeSheetName("'quoted'"), "quoted");
});

test("sortRows sorts numbers numerically, text naturally, blanks last, desc supported", () => {
  const rows = [{ n: 10 }, { n: 2 }, { n: null }, { n: 33 }];
  assert.deepEqual(D.sortRows(rows, "n").map((r) => r.n), [2, 10, 33, null]);
  assert.deepEqual(D.sortRows(rows, "n", true).map((r) => r.n), [33, 10, 2, null]);
  assert.deepEqual(D.sortRows([{ s: "t10" }, { s: "t9" }], "s").map((r) => r.s), ["t9", "t10"]);
});

test("summarize counts low-cardinality columns and skips identifiers", () => {
  const rows = [
    { TableName: "A", Plan: "Analytics" }, { TableName: "B", Plan: "Basic" },
    { TableName: "C", Plan: "Analytics" },
  ];
  const s = D.summarize(rows);
  assert.equal(s.rowCount, 3);
  assert.deepEqual(s.columns.map((c) => c.name), ["Plan"]);
  assert.deepEqual(s.columns[0].values, [{ value: "Analytics", count: 2 }, { value: "Basic", count: 1 }]);
});

test("summarize skips columns with more than 20 distinct values", () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ id: i, bucket: i % 25, flag: i % 2 }));
  assert.deepEqual(D.summarize(rows).columns.map((c) => c.name), ["flag"]);
});

test("cellToPlain extracts rich text, formula, hyperlink, dates, errors", () => {
  assert.equal(D.cellToPlain({ richText: [{ text: "He" }, { text: "llo" }] }), "Hello");
  assert.equal(D.cellToPlain({ formula: "A1+1", result: 5 }), 5);
  assert.equal(D.cellToPlain({ text: "site", hyperlink: "http://x" }), "site");
  assert.equal(D.cellToPlain({ text: { richText: [{ text: "rt" }] }, hyperlink: "http://x" }), "rt");
  assert.equal(D.cellToPlain(new Date("2024-03-01T00:00:00Z")), "2024-03-01");
  assert.equal(D.cellToPlain(new Date("2024-03-01T10:30:00Z")), "2024-03-01T10:30:00.000Z");
  assert.equal(D.cellToPlain({ error: "#N/A" }), "#N/A");
  assert.equal(D.cellToPlain(null), null);
});

test("matrixToRows with and without header row", () => {
  assert.deepEqual(D.matrixToRows([["a", "b"], [1, 2]], true), [{ a: 1, b: 2 }]);
  assert.deepEqual(D.matrixToRows([[1, 2]], false), [{ column_1: 1, column_2: 2 }]);
});

test("validate reports line and column for JSON errors", () => {
  const ok = D.validate('{"a":1}', "json");
  assert.equal(ok.valid, true);
  const bad = D.validate('{\n  "a": 1,\n  "b": oops\n}', "json");
  assert.equal(bad.valid, false);
  assert.equal(bad.line, 3);
  assert.ok(bad.column >= 8);
});

test("validate maps js-yaml style error marks", () => {
  const stub = { load: () => { const e = new Error("bad"); e.mark = { line: 4, column: 2 }; throw e; } };
  assert.deepEqual(D.validate("x", "yaml", { jsyaml: stub }), { valid: false, error: "bad", line: 5, column: 3 });
});

test("formatText pretty, minify and sort keys for JSON", () => {
  assert.equal(D.formatText('{"b":1,"a":{"d":1,"c":2}}', "json", { sortKeys: true, mode: "minify" }), '{"a":{"c":2,"d":1},"b":1}\n');
  assert.equal(D.formatText('{"a":1}', "json", { mode: "pretty", indent: 4 }), '{\n    "a": 1\n}\n');
});

test("diff lists added, removed and changed paths", () => {
  const a = { name: "x", n: 1, gone: true, list: [1, 2], nest: { k: "v" } };
  const b = { name: "y", n: 1, list: [1, 3, 4], nest: { k: "v", z: 0 }, fresh: "new" };
  const d = D.diff(a, b);
  const by = Object.fromEntries(d.map((x) => [x.path, x]));
  assert.equal(by["name"].type, "changed");
  assert.equal(by["name"].oldValue, "x");
  assert.equal(by["name"].newValue, "y");
  assert.equal(by["gone"].type, "removed");
  assert.equal(by["list[1]"].type, "changed");
  assert.equal(by["list[2]"].type, "added");
  assert.equal(by["nest.z"].type, "added");
  assert.equal(by["fresh"].type, "added");
  assert.equal(d.length, 6);
});

test("diff of identical values is empty and type changes are detected", () => {
  assert.deepEqual(D.diff({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), []);
  assert.equal(D.diff({ a: 1 }, { a: "1" })[0].type, "changed");
  assert.equal(D.diff(1, 2)[0].path, "(root)");
});

test("buildWorkbook with a stub ExcelJS sorts, flattens, names sheets uniquely and adds summary", () => {
  const sheets = [];
  class WB {
    constructor() { this.xlsx = {}; }
    addWorksheet(name) {
      const ws = { name, rows: [], addRow(r) { this.rows.push(r); return r; }, getColumn: () => ({}), eachRow() {}, };
      sheets.push(ws);
      return ws;
    }
  }
  D.buildWorkbook({ Workbook: WB }, [
    { name: "data", rows: [{ n: 2, o: { x: 1 } }, { n: 1, o: { x: 2 } }] },
    { name: "DATA", rows: [{ n: 1 }] },
  ], { sortBy: "n", summary: true });
  assert.deepEqual(sheets.map((s) => s.name), ["data", "DATA (2)", "Summary"]);
  assert.deepEqual(sheets[0].rows, [["n", "o.x"], [1, 2], [2, 1]]);
  assert.deepEqual(sheets[2].rows[1], ["data", "Row count", 2]);
});
