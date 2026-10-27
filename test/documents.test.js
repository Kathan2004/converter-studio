const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../js/documents-core.js");

// Fake docx: constructors record their args.
function makeDocx() {
  const d = {};
  for (const n of ["Paragraph", "TextRun", "ExternalHyperlink", "Table", "TableRow", "TableCell"]) {
    d[n] = class { constructor(args) { this.kind = n; this.args = args; } };
  }
  d.HeadingLevel = { HEADING_1: "h1", HEADING_2: "h2", HEADING_3: "h3", HEADING_4: "h4", HEADING_5: "h5", HEADING_6: "h6" };
  d.ShadingType = { CLEAR: "clear" };
  d.BorderStyle = { SINGLE: "single" };
  d.WidthType = { PERCENTAGE: "pct" };
  d.AlignmentType = { START: "start" };
  d.LevelFormat = { DECIMAL: "decimal", LOWER_LETTER: "lowerLetter", LOWER_ROMAN: "lowerRoman" };
  return d;
}
const txt = (t) => ({ type: "text", text: t });

test("slugify basics and accents", () => {
  assert.equal(C.slugify("Hello, World!"), "hello-world");
  assert.equal(C.slugify("Café  Déjà-vu"), "cafe-deja-vu");
  assert.equal(C.slugify("!!!"), "section");
});

test("slugify dedupes with a used set", () => {
  const used = new Set();
  assert.equal(C.slugify("Intro", used), "intro");
  assert.equal(C.slugify("Intro", used), "intro-2");
  assert.equal(C.slugify("Intro", used), "intro-3");
});

test("extractHeadings handles ATX, setext, closing hashes, inline markup", () => {
  const h = C.extractHeadings("# Title #\n\nSome **bold** text\n\n## `Code` and [link](http://x)\n\nSetext\n======\n");
  assert.deepEqual(h.map((x) => [x.level, x.text]), [[1, "Title"], [2, "Code and link"], [1, "Setext"]]);
});

test("extractHeadings ignores fenced code", () => {
  const h = C.extractHeadings("```\n# not a heading\n```\n# Real\n");
  assert.equal(h.length, 1);
  assert.equal(h[0].text, "Real");
});

test("buildToc nests levels and escapes text", () => {
  const html = C.buildToc([
    { level: 1, text: "A <b>", slug: "a" },
    { level: 2, text: "B", slug: "b" },
    { level: 2, text: "C", slug: "c" },
    { level: 1, text: "D", slug: "d" },
  ]);
  assert.match(html, /A &lt;b&gt;/);
  assert.equal((html.match(/<ul>/g) || []).length, 2);
  assert.equal((html.match(/<\/ul>/g) || []).length, 2);
  assert.equal((html.match(/<li>/g) || []).length, (html.match(/<\/li>/g) || []).length);
});

test("buildToc respects maxLevel and returns empty for none", () => {
  assert.equal(C.buildToc([]), "");
  const html = C.buildToc([{ level: 1, text: "A", slug: "a" }, { level: 4, text: "Deep", slug: "deep" }], { maxLevel: 2 });
  assert.ok(!html.includes("Deep"));
});

test("buildHtmlDocument escapes title and embeds body", () => {
  const out = C.buildHtmlDocument("<p>x</p>", { title: "<T>" });
  assert.match(out, /<title>&lt;T&gt;<\/title>/);
  assert.match(out, /<p>x<\/p>/);
  assert.match(out, /<style>/);
});

test("case converters", () => {
  assert.equal(C.toUpper("abc"), "ABC");
  assert.equal(C.toLower("ABC"), "abc");
  assert.equal(C.toTitle("the lord of the rings"), "The Lord of the Rings");
  assert.equal(C.toSentence("hello world. this is it! ok? yes"), "Hello world. This is it! Ok? Yes");
});

test("identifier case converters", () => {
  assert.equal(C.toCamel("hello big_world-now"), "helloBigWorldNow");
  assert.equal(C.toSnake("Hello Big World"), "hello_big_world");
  assert.equal(C.toKebab("helloBigWorld"), "hello-big-world");
  assert.equal(C.toPascal("hello big world"), "HelloBigWorld");
});

test("convertCase handles multi-line identifiers and rejects unknown modes", () => {
  assert.equal(C.convertCase("a b\nc d", "snake"), "a_b\nc_d");
  assert.throws(() => C.convertCase("x", "nope"));
});

test("dedupeLines options", () => {
  assert.equal(C.dedupeLines("a\nb\na\nB"), "a\nb\nB");
  assert.equal(C.dedupeLines("a\nb\nA", { ignoreCase: true }), "a\nb");
  assert.equal(C.dedupeLines("a\n a\na", { trim: true }), "a");
});

test("sortLines asc, desc, numeric", () => {
  assert.equal(C.sortLines("b\na\nc"), "a\nb\nc");
  assert.equal(C.sortLines("b\na\nc", { order: "desc" }), "c\nb\na");
  assert.equal(C.sortLines("10\n9\n100", { numeric: true }), "9\n10\n100");
});

test("trimWhitespace", () => {
  assert.equal(C.trimWhitespace("  a  b  \n\n  c "), "a  b\n\nc");
  assert.equal(C.trimWhitespace("  a   b  \n\n c", { collapse: true, removeEmpty: true }), "a b\nc");
});

test("countText", () => {
  const c = C.countText("Hello world. Two sentences here!\nNext line");
  assert.equal(c.words, 7);
  assert.equal(c.lines, 2);
  assert.equal(c.sentences, 2);
  assert.equal(c.readingMinutes, 1);
  assert.deepEqual(C.countText(""), { words: 0, characters: 0, charactersNoSpaces: 0, lines: 0, sentences: 0, readingMinutes: 0 });
});

test("base64 utf8 round trip", () => {
  const s = "Héllo 世界 😀";
  assert.equal(C.base64Encode("hello"), "aGVsbG8=");
  assert.equal(C.base64Decode(C.base64Encode(s)), s);
  assert.equal(C.base64Decode("aGVsbG8"), "hello");
});

test("base64Decode rejects invalid input", () => {
  assert.throws(() => C.base64Decode("!!!notbase64***"));
});

test("url encode/decode", () => {
  assert.equal(C.urlEncode("a b&c=d/é"), "a%20b%26c%3Dd%2F%C3%A9");
  assert.equal(C.urlDecode("a%20b+c"), "a b c");
});

test("itemsToLines groups by y and sorts by x", () => {
  const it = (str, x, y, width) => ({ str, transform: [10, 0, 0, 10, x, y], width });
  const lines = C.itemsToLines([
    it("world", 60, 700, 30),
    it("Hello", 10, 700.5, 40),
    it("Second line", 10, 680, 80),
  ]);
  assert.deepEqual(lines, ["Hello world", "Second line"]);
});

test("itemsToLines does not add spaces between touching items and skips empties", () => {
  const it = (str, x, y, width) => ({ str, transform: [10, 0, 0, 10, x, y], width });
  assert.deepEqual(C.itemsToLines([it("Hel", 10, 500, 20), it("lo", 30, 500, 12), it("", 50, 500, 0)]), ["Hello"]);
});

test("pagesToText separators", () => {
  const pages = [["a"], ["b"]];
  assert.equal(C.pagesToText(pages), "a\n\nb");
  assert.equal(C.pagesToText(pages, { separator: "marker" }), "--- Page 1 ---\na\n\n--- Page 2 ---\nb");
  assert.equal(C.pagesToText(pages, { separator: "rule" }), "a\n\n---\n\nb");
});

test("rowsToMarkdownTable pads ragged rows, escapes pipes, applies alignment", () => {
  const md = C.rowsToMarkdownTable([["A", "B"], ["x|y", "1", "extra"]], ["left", "right"]);
  assert.equal(md, "| A | B |  |\n| :--- | ---: | --- |\n| x\\|y | 1 | extra |");
});

test("tokensToDocx headings and inline styles", () => {
  const docx = makeDocx();
  const out = C.tokensToDocx([
    { type: "heading", depth: 2, tokens: [txt("Title")] },
    { type: "paragraph", tokens: [txt("a "), { type: "strong", tokens: [txt("b")] }, { type: "em", tokens: [txt("c")] }, { type: "codespan", text: "d" }] },
  ], docx);
  assert.equal(out.length, 2);
  assert.equal(out[0].args.heading, "h2");
  const runs = out[1].args.children;
  assert.equal(runs[1].args.bold, true);
  assert.equal(runs[2].args.italics, true);
  assert.equal(runs[3].args.font, "Courier New");
});

test("tokensToDocx link becomes ExternalHyperlink", () => {
  const out = C.tokensToDocx([{ type: "paragraph", tokens: [{ type: "link", href: "https://x.test", tokens: [txt("go")] }] }], makeDocx());
  const link = out[0].args.children[0];
  assert.equal(link.kind, "ExternalHyperlink");
  assert.equal(link.args.link, "https://x.test");
});

test("tokensToDocx bullet and ordered nested lists", () => {
  const item = (t, extra) => ({ type: "list_item", tokens: [txt(t), ...(extra || [])] });
  const out = C.tokensToDocx([
    { type: "list", ordered: false, items: [item("one", [{ type: "list", ordered: true, items: [item("nested")] }])] },
    { type: "list", ordered: true, items: [item("first"), item("second")] },
  ], makeDocx());
  assert.equal(out.length, 4);
  assert.deepEqual(out[0].args.bullet, { level: 0 });
  assert.deepEqual(out[1].args.numbering, { reference: "md-numbered", level: 1, instance: 1 });
  assert.equal(out[2].args.numbering.instance, 2);
  assert.equal(out[3].args.numbering.level, 0);
});

test("tokensToDocx code block is monospace and shaded with line breaks", () => {
  const out = C.tokensToDocx([{ type: "code", text: "a\nb" }], makeDocx());
  assert.equal(out[0].args.shading.fill, "F3F4F6");
  assert.equal(out[0].args.children.length, 2);
  assert.equal(out[0].args.children[1].args.break, 1);
  assert.equal(out[0].args.children[0].args.font, "Courier New");
});

test("tokensToDocx blockquote and hr", () => {
  const out = C.tokensToDocx([{ type: "blockquote", tokens: [{ type: "paragraph", tokens: [txt("q")] }] }, { type: "hr" }], makeDocx());
  assert.ok(out[0].args.border.left);
  assert.ok(out[0].args.indent.left > 0);
  assert.ok(out[1].args.border.bottom);
});

test("tokensToDocx table has header row and body rows", () => {
  const cell = (t) => ({ text: t, tokens: [txt(t)] });
  const out = C.tokensToDocx([{ type: "table", header: [cell("H1"), cell("H2")], rows: [[cell("a"), cell("b")]] }], makeDocx());
  const table = out[0];
  assert.equal(table.kind, "Table");
  assert.equal(table.args.rows.length, 2);
  assert.equal(table.args.rows[0].args.tableHeader, true);
  assert.equal(table.args.rows[0].args.children[0].args.children[0].args.children[0].args.bold, true);
});

test("tokensToDocx strips raw HTML and ignores space tokens", () => {
  const out = C.tokensToDocx([{ type: "space" }, { type: "html", text: "<script>x</script><b>hi</b>" }], makeDocx());
  assert.equal(out.length, 1);
  assert.equal(out[0].args.children[0].args.text, "xhi");
});

test("numberingConfig defines nine levels", () => {
  const cfg = C.numberingConfig(makeDocx());
  assert.equal(cfg.config[0].reference, "md-numbered");
  assert.equal(cfg.config[0].levels.length, 9);
});
