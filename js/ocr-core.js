/*
 * Pure OCR helpers (no DOM access). Used by js/ocr.js in the browser and by Node tests.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.OcrCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MAX_PIXELS = 16e6;

  /** Upscale factor for small screenshots: width below 1200 is scaled towards ~2000px, capped at 16 MP. */
  function chooseScale(width, height) {
    if (!(width > 0) || !(height > 0)) return 1;
    if (width >= 1200) return 1;
    let scale = 2000 / width;
    const cap = Math.sqrt(MAX_PIXELS / (width * height));
    scale = Math.min(scale, cap);
    if (!(scale > 1)) return 1;
    return Math.floor(scale * 100) / 100;
  }

  /**
   * options: { joinHyphens, collapseSpaces, keepLineBreaks } (all default true).
   * Rejoins words hyphenated across line ends, collapses spaces, trims line ends and
   * limits blank runs to two lines. Without keepLineBreaks, lines of a paragraph are joined.
   */
  function cleanText(text, options) {
    const o = Object.assign({ joinHyphens: true, collapseSpaces: true, keepLineBreaks: true }, options);
    let s = String(text == null ? "" : text).replace(/\r\n?/g, "\n");
    if (o.joinHyphens) s = s.replace(/([A-Za-z])-[ \t]*\n[ \t]*([a-z])/g, "$1$2");
    if (o.collapseSpaces) s = s.replace(/[ \t]{2,}/g, " ");
    s = s.replace(/[ \t]+$/gm, "");
    if (!o.keepLineBreaks) s = s.replace(/([^\n])\n(?=[^\n])/g, "$1 ");
    s = s.replace(/\n{4,}/g, "\n\n\n");
    return s.replace(/^\n+/, "").replace(/\s+$/, "");
  }

  function countWords(text) {
    const m = String(text == null ? "" : text).match(/\S+/g);
    return m ? m.length : 0;
  }

  /** Tesseract confidence (0..100) as "87%". */
  function formatConfidence(value) {
    const n = Number(value);
    if (value == null || value === "" || !Number.isFinite(n)) return "n/a";
    return `${Math.round(Math.min(100, Math.max(0, n)))}%`;
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

  /**
   * Grayscale + contrast stretch on RGBA bytes, in place (also returned).
   * Black and white points come from the 1st and 99th luminance percentiles.
   */
  function enhancePixels(rgba) {
    const hist = new Uint32Array(256);
    const count = Math.floor(rgba.length / 4);
    for (let i = 0; i < count; i++) {
      const j = i * 4;
      const y = Math.round(0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2]);
      rgba[j] = rgba[j + 1] = rgba[j + 2] = y;
      hist[y]++;
    }
    if (!count) return rgba;
    const edge = count * 0.01;
    let lo = 0, hi = 255, acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > edge) { lo = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > edge) { hi = v; break; } }
    if (hi - lo < 16) return rgba; // flat image: stretching would only amplify noise
    const range = hi - lo;
    for (let i = 0; i < count; i++) {
      const j = i * 4;
      const y = Math.min(255, Math.max(0, Math.round(((rgba[j] - lo) * 255) / range)));
      rgba[j] = rgba[j + 1] = rgba[j + 2] = y;
    }
    return rgba;
  }

  /** Heading line between results of different files or pages. */
  function separator(label) {
    return `--- ${String(label).replace(/\s+/g, " ").trim()} ---`;
  }

  /** Append a block of text to existing output, with a blank line between blocks. */
  function appendBlock(existing, block, label) {
    const body = label ? `${separator(label)}\n${block}` : block;
    if (!existing) return body;
    return `${existing.replace(/\s+$/, "")}\n\n${body}`;
  }

  function averageConfidence(values) {
    const v = values.filter((x) => Number.isFinite(x));
    if (!v.length) return null;
    return v.reduce((a, b) => a + b, 0) / v.length;
  }

  return { chooseScale, cleanText, countWords, formatConfidence, parsePages, enhancePixels, separator, appendBlock, averageConfidence };
});
