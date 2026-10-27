const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../js/pdf-core.js");

test("parseRanges handles mixed ranges and open end", () => {
  assert.deepEqual(C.parseRanges("1-3, 5, 8-", 10), [[0, 1, 2], [4], [7, 8, 9]]);
});
test("parseRanges single page and spaces", () => {
  assert.deepEqual(C.parseRanges(" 2 ", 3), [[1]]);
});
test("parseRanges open start", () => {
  assert.deepEqual(C.parseRanges("-2", 5), [[0, 1]]);
});
test("parseRanges rejects out of range", () => {
  assert.throws(() => C.parseRanges("1-11", 10), /out of range/);
  assert.throws(() => C.parseRanges("11", 10), /out of range/);
});
test("parseRanges rejects zero", () => {
  assert.throws(() => C.parseRanges("0", 10), /start at 1/);
});
test("parseRanges rejects garbage", () => {
  assert.throws(() => C.parseRanges("abc", 10), /not a valid/);
  assert.throws(() => C.parseRanges("1--3", 10), /not a valid/);
  assert.throws(() => C.parseRanges("-", 10), /not a valid/);
});
test("parseRanges rejects reversed, empty and stray commas", () => {
  assert.throws(() => C.parseRanges("5-3", 10), /reversed/);
  assert.throws(() => C.parseRanges("", 10), /at least one/);
  assert.throws(() => C.parseRanges("1,,2", 10), /Empty entry/);
});
test("parseRanges rejects empty document", () => {
  assert.throws(() => C.parseRanges("1", 0), /no pages/);
});
test("flattenRanges dedupes and sorts", () => {
  assert.deepEqual(C.flattenRanges([[3, 4], [0, 3]]), [0, 3, 4]);
});
test("chunkPages", () => {
  assert.deepEqual(C.chunkPages(5, 2), [[0, 1], [2, 3], [4]]);
  assert.deepEqual(C.chunkPages(3, 10), [[0, 1, 2]]);
  assert.deepEqual(C.chunkPages(0, 2), []);
});
test("chunkPages validates n", () => {
  assert.throws(() => C.chunkPages(5, 0));
  assert.throws(() => C.chunkPages(5, 1.5));
});
test("computeFit centers a wide image", () => {
  const r = C.computeFit(200, 100, 100, 100, 0);
  assert.deepEqual(r, { x: 0, y: 25, width: 100, height: 50 });
});
test("computeFit respects margin", () => {
  const r = C.computeFit(100, 100, 200, 100, 10);
  assert.equal(r.width, 80);
  assert.equal(r.height, 80);
  assert.equal(r.x, 60);
  assert.equal(r.y, 10);
});
test("computeFit rejects bad input", () => {
  assert.throws(() => C.computeFit(0, 10, 100, 100));
  assert.throws(() => C.computeFit(10, 10, 100, 100, 60), /Margin/);
});
test("page size table", () => {
  assert.equal(C.PAGE_SIZES.a4.width, 595.28);
  assert.equal(C.PAGE_SIZES.letter.height, 792);
});
test("pageDimensions auto orientation follows the image", () => {
  assert.deepEqual(C.pageDimensions("a4", "auto", 800, 600), { width: 841.89, height: 595.28 });
  assert.deepEqual(C.pageDimensions("a4", "auto", 600, 800), { width: 595.28, height: 841.89 });
});
test("pageDimensions forced orientation", () => {
  assert.deepEqual(C.pageDimensions("letter", "landscape", 10, 20), { width: 792, height: 612 });
  assert.deepEqual(C.pageDimensions("letter", "portrait", 20, 10), { width: 612, height: 792 });
});
test("pageDimensions fit adds margin and honours orientation", () => {
  assert.deepEqual(C.pageDimensions("fit", "auto", 300, 200, 10), { width: 320, height: 220 });
  assert.deepEqual(C.pageDimensions("fit", "portrait", 300, 200, 0), { width: 200, height: 300 });
  assert.deepEqual(C.pageDimensions("fit", "landscape", 200, 300, 0), { width: 300, height: 200 });
});
test("pageDimensions unknown size", () => {
  assert.throws(() => C.pageDimensions("a0", "auto", 1, 1));
});
test("formatPageLabel", () => {
  assert.equal(C.formatPageLabel("Page {n} of {total}", 2, 9), "Page 2 of 9");
  assert.equal(C.formatPageLabel("{n}/{n}", 3, 9), "3/3");
});
test("dpiToScale", () => {
  assert.equal(C.dpiToScale(72), 1);
  assert.equal(C.dpiToScale(144), 2);
  assert.throws(() => C.dpiToScale(0));
});
test("savings", () => {
  const s = C.savings(1000, 250);
  assert.equal(s.saved, 750);
  assert.equal(s.percent, 75);
  assert.equal(s.smaller, true);
  const g = C.savings(100, 150);
  assert.equal(g.percent, -50);
  assert.equal(g.smaller, false);
  assert.equal(C.savings(0, 0).percent, 0);
});
test("moveItem", () => {
  const a = [1, 2, 3, 4];
  assert.deepEqual(C.moveItem(a, 0, 2), [2, 3, 1, 4]);
  assert.deepEqual(C.moveItem(a, 3, 0), [4, 1, 2, 3]);
  assert.deepEqual(a, [1, 2, 3, 4]);
  assert.deepEqual(C.moveItem(a, 1, 99), [1, 3, 4, 2]);
  assert.deepEqual(C.moveItem(a, 9, 0), a);
});
test("applyOrder valid", () => {
  assert.deepEqual(C.applyOrder("3,1,2", 3), [2, 0, 1]);
  assert.deepEqual(C.applyOrder("2 1", 3), [1, 0]);
});
test("applyOrder invalid", () => {
  assert.throws(() => C.applyOrder("1,1", 3), /more than once/);
  assert.throws(() => C.applyOrder("4", 3), /out of range/);
  assert.throws(() => C.applyOrder("a", 3), /not a page number/);
  assert.throws(() => C.applyOrder("", 3));
});
test("addRotation normalises", () => {
  assert.equal(C.addRotation(270, 90), 0);
  assert.equal(C.addRotation(0, 270), 270);
  assert.equal(C.addRotation(90, -180), 270);
});
test("invertSelection", () => {
  assert.deepEqual(C.invertSelection(new Set([1]), 3), [0, 2]);
});
test("numberPosition", () => {
  assert.deepEqual(C.numberPosition("bottom-center", 200, 50, 20), { x: 75, y: 20 });
  assert.deepEqual(C.numberPosition("bottom-right", 200, 50, 20), { x: 130, y: 20 });
});
test("date input helpers and keywords", () => {
  assert.equal(C.toDateInput(undefined), "");
  assert.equal(C.fromDateInput(""), undefined);
  assert.equal(C.toDateInput(C.fromDateInput("2024-03-05T07:09")), "2024-03-05T07:09");
  assert.deepEqual(C.splitKeywords("a, b;; c "), ["a", "b", "c"]);
});
