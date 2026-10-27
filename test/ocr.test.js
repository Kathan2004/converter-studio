const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../js/ocr-core.js");

test("chooseScale leaves wide images alone", () => {
  assert.equal(C.chooseScale(1200, 800), 1);
  assert.equal(C.chooseScale(3000, 2000), 1);
});
test("chooseScale upscales small screenshots to about 2000px wide", () => {
  assert.equal(C.chooseScale(1000, 500), 2);
  assert.equal(C.chooseScale(500, 300), 4);
});
test("chooseScale caps total pixels at 16 MP", () => {
  const s = C.chooseScale(1100, 5000);
  assert.ok(s >= 1 && 1100 * s * 5000 * s <= 16e6);
  assert.equal(C.chooseScale(1100, 20000), 1);
});
test("chooseScale handles invalid sizes", () => {
  assert.equal(C.chooseScale(0, 10), 1);
  assert.equal(C.chooseScale(NaN, NaN), 1);
});
test("cleanText rejoins hyphenated line ends", () => {
  assert.equal(C.cleanText("inter-\nnational trade"), "international trade");
  assert.equal(C.cleanText("well-\nKnown"), "well-\nKnown");
});
test("cleanText collapses spaces and trims line ends", () => {
  assert.equal(C.cleanText("a   b \t c  \nnext   "), "a b c\nnext");
});
test("cleanText respects disabled options", () => {
  assert.equal(C.cleanText("in-\nter", { joinHyphens: false }), "in-\nter");
  assert.equal(C.cleanText("a   b", { collapseSpaces: false }), "a   b");
});
test("cleanText limits blank lines to two", () => {
  assert.equal(C.cleanText("a\n\n\n\n\n\nb"), "a\n\n\nb");
  assert.equal(C.cleanText("a\n\nb"), "a\n\nb");
});
test("cleanText without keepLineBreaks joins lines but keeps paragraphs", () => {
  assert.equal(C.cleanText("one\ntwo\n\nthree\nfour", { keepLineBreaks: false }), "one two\n\nthree four");
});
test("cleanText normalizes CRLF and null input", () => {
  assert.equal(C.cleanText("a\r\nb"), "a\nb");
  assert.equal(C.cleanText(null), "");
});
test("countWords", () => {
  assert.equal(C.countWords("  hello   world\nfoo "), 3);
  assert.equal(C.countWords(""), 0);
  assert.equal(C.countWords(undefined), 0);
});
test("formatConfidence", () => {
  assert.equal(C.formatConfidence(87.4), "87%");
  assert.equal(C.formatConfidence(0), "0%");
  assert.equal(C.formatConfidence(140), "100%");
  assert.equal(C.formatConfidence(null), "n/a");
  assert.equal(C.formatConfidence(NaN), "n/a");
});
test("parsePages with ranges and lists", () => {
  assert.deepEqual(C.parsePages("1-3,5", 10), [1, 2, 3, 5]);
  assert.deepEqual(C.parsePages(" 5 , 2-3, 3 ", 10), [2, 3, 5]);
});
test("parsePages empty selects all", () => {
  assert.deepEqual(C.parsePages("", 3), [1, 2, 3]);
  assert.deepEqual(C.parsePages("  ", 2), [1, 2]);
});
test("parsePages rejects bad input", () => {
  assert.throws(() => C.parsePages("0", 5), /Invalid/);
  assert.throws(() => C.parsePages("3-1", 5), /Invalid/);
  assert.throws(() => C.parsePages("a", 5), /Invalid/);
  assert.throws(() => C.parsePages("2-9", 5), /out of range/);
  assert.throws(() => C.parsePages("1", 0), /no pages/);
});
test("enhancePixels converts to grayscale and keeps alpha", () => {
  const px = new Uint8ClampedArray([255, 0, 0, 128, 0, 255, 0, 255]);
  C.enhancePixels(px);
  assert.equal(px[0], px[1]);
  assert.equal(px[1], px[2]);
  assert.equal(px[3], 128);
  assert.equal(px[7], 255);
});
test("enhancePixels stretches contrast of a dull image", () => {
  const n = 1000;
  const px = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const v = i % 2 ? 100 : 160; // low-contrast gray text on gray
    px.set([v, v, v, 255], i * 4);
  }
  C.enhancePixels(px);
  assert.equal(px[0], 255);
  assert.equal(px[4], 0);
});
test("enhancePixels leaves a flat image flat", () => {
  const px = new Uint8ClampedArray([120, 120, 120, 255, 120, 120, 120, 255]);
  C.enhancePixels(px);
  assert.deepEqual(Array.from(px), [120, 120, 120, 255, 120, 120, 120, 255]);
  assert.doesNotThrow(() => C.enhancePixels(new Uint8ClampedArray(0)));
});
test("separator and appendBlock", () => {
  assert.equal(C.separator("a  b.png"), "--- a b.png ---");
  assert.equal(C.appendBlock("", "text", "f.png"), "--- f.png ---\ntext");
  assert.equal(C.appendBlock("one\n", "two"), "one\n\ntwo");
});
test("averageConfidence ignores non-finite values", () => {
  assert.equal(C.averageConfidence([80, 90, NaN]), 85);
  assert.equal(C.averageConfidence([]), null);
});
