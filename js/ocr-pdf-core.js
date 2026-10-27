/*
 * Pure maths for building a searchable PDF from OCR output (no DOM access).
 * Used by js/ocr-pdf.js in the browser and by Node tests.
 * Tesseract boxes are in render pixels with the origin at the top left; PDF space is in points
 * with the origin at the bottom left.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.OcrPdfCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const HEIGHT_FACTOR = 0.9; // glyph em size as a share of the word box height
  const DESCENT = 0.2; // Helvetica descender, as a share of the font size
  const MIN_SIZE = 1;

  /** PDF points per render pixel on each axis, given the page size in points. */
  function scaleFor(pageWidthPt, pageHeightPt, renderWidthPx, renderHeightPx) {
    if (!(renderWidthPx > 0) || !(renderHeightPx > 0)) throw new Error("Invalid render size");
    return { sx: pageWidthPt / renderWidthPx, sy: pageHeightPt / renderHeightPx };
  }

  /** Keep only characters the font can encode (Helvetica/WinAnsi); drop control chars. */
  function encodable(text, canEncode) {
    let out = "";
    for (const ch of String(text)) {
      if (/[\u0000-\u001f\u007f]/.test(ch)) continue;
      if (canEncode && !canEncode(ch)) continue;
      out += ch;
    }
    return out.trim();
  }

  /**
   * Place one recognised word.
   * word: { text, bbox: {x0,y0,x1,y1} } in pixels (top-left origin).
   * widthAt1: width of the (already filtered) text at font size 1.
   * Returns { text, x, y, size } in points (y is the baseline) or null if the word cannot be placed.
   */
  function placeWord(word, scale, pageHeightPt, widthAt1) {
    const text = word && word.text;
    const b = word && word.bbox;
    if (!text || !b || !(widthAt1 > 0)) return null;
    const boxW = (b.x1 - b.x0) * scale.sx;
    const boxH = (b.y1 - b.y0) * scale.sy;
    if (!(boxW > 0) || !(boxH > 0)) return null;
    // Font size limited by height and by width so the text spans no more than its box.
    const size = Math.max(MIN_SIZE, Math.min(boxH * HEIGHT_FACTOR, boxW / widthAt1));
    const x = b.x0 * scale.sx;
    // y flips: the box bottom (y1) is measured from the top; the baseline sits a descent above it.
    const y = pageHeightPt - b.y1 * scale.sy + size * DESCENT;
    return { text, x, y, size };
  }

  /** "1-3,5" -> [1,2,3,5] (1-based, sorted, unique). Empty input selects every page. */
  function parsePages(spec, total) {
    const n = Math.floor(Number(total));
    if (!(n >= 1)) throw new Error("The document has no pages");
    const str = String(spec == null ? "" : spec).trim();
    if (!str) return Array.from({ length: n }, (_, i) => i + 1);
    const set = new Set();
    for (const raw of str.split(",")) {
      const part = raw.trim();
      if (!part) continue;
      const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
      if (!m) throw new Error(`Invalid page range "${part}"`);
      const a = Number(m[1]);
      const b = m[2] === undefined ? a : Number(m[2]);
      if (a < 1 || b < a) throw new Error(`Invalid page range "${part}"`);
      if (b > n) throw new Error(`Page ${b} is out of range (the document has ${n} page${n === 1 ? "" : "s"})`);
      for (let p = a; p <= b; p++) set.add(p);
    }
    if (!set.size) throw new Error("No pages selected");
    return Array.from(set).sort((x, y) => x - y);
  }

  return { scaleFor, encodable, placeWord, parsePages, HEIGHT_FACTOR, DESCENT };
});
