const { test } = require("node:test");
const assert = require("node:assert/strict");
const C = require("../js/ocr-pdf-core.js");

test("scaleFor converts render pixels to points per axis", () => {
  const s = C.scaleFor(595, 842, 1190, 1684);
  assert.equal(s.sx, 0.5);
  assert.equal(s.sy, 0.5);
  assert.throws(() => C.scaleFor(595, 842, 0, 10));
});

test("placeWord flips the y axis and scales", () => {
  const scale = { sx: 0.5, sy: 0.5 };
  // 100 px wide, 40 px tall box at top-left (200, 100); page 842 pt tall.
  const w = C.placeWord({ text: "Hi", bbox: { x0: 200, y0: 100, x1: 300, y1: 140 } }, scale, 842, 1);
  assert.equal(w.x, 100);
  // box is 20 pt tall -> size 18 (height-limited); width allows 50 pt at size 1 -> not binding
  assert.ok(Math.abs(w.size - 18) < 1e-9);
  // bottom edge at 140 px -> 70 pt from the top -> 772 from the bottom, baseline 0.2*size above it
  assert.ok(Math.abs(w.y - (842 - 70 + 18 * 0.2)) < 1e-9);
});

test("a word nearer the top of the image gets a higher PDF y", () => {
  const scale = { sx: 1, sy: 1 };
  const top = C.placeWord({ text: "a", bbox: { x0: 0, y0: 10, x1: 20, y1: 30 } }, scale, 500, 0.5);
  const low = C.placeWord({ text: "a", bbox: { x0: 0, y0: 300, x1: 20, y1: 320 } }, scale, 500, 0.5);
  assert.ok(top.y > low.y);
});

test("placeWord fits the width when the text is too wide for the box", () => {
  const scale = { sx: 1, sy: 1 };
  // text is 10 units wide at size 1, box is 50 pt wide and 100 pt tall -> width-limited: size 5
  const w = C.placeWord({ text: "wide text", bbox: { x0: 0, y0: 0, x1: 50, y1: 100 } }, scale, 200, 10);
  assert.equal(w.size, 5);
});

test("placeWord rejects empty, degenerate or unmeasurable words", () => {
  const scale = { sx: 1, sy: 1 };
  assert.equal(C.placeWord({ text: "", bbox: { x0: 0, y0: 0, x1: 5, y1: 5 } }, scale, 100, 1), null);
  assert.equal(C.placeWord({ text: "a", bbox: { x0: 5, y0: 0, x1: 5, y1: 5 } }, scale, 100, 1), null);
  assert.equal(C.placeWord({ text: "a" }, scale, 100, 1), null);
  assert.equal(C.placeWord({ text: "a", bbox: { x0: 0, y0: 0, x1: 5, y1: 5 } }, scale, 100, 0), null);
});

test("encodable drops control characters and unsupported glyphs", () => {
  const can = (ch) => ch.charCodeAt(0) < 256;
  assert.equal(C.encodable("café\u0007 中", can), "café");
  assert.equal(C.encodable("  ok  "), "ok");
  assert.equal(C.encodable("中", can), "");
});

test("parsePages", () => {
  assert.deepEqual(C.parsePages("", 3), [1, 2, 3]);
  assert.deepEqual(C.parsePages("3, 1-2,2", 5), [1, 2, 3]);
  assert.throws(() => C.parsePages("9", 3), /out of range/);
  assert.throws(() => C.parsePages("x", 3), /Invalid/);
  assert.throws(() => C.parsePages("2-1", 3), /Invalid/);
});
