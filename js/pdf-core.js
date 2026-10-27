/* Pure logic for the PDF tools page. No DOM, no libraries. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PdfCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const PAGE_SIZES = Object.freeze({
    a4: Object.freeze({ width: 595.28, height: 841.89 }),
    letter: Object.freeze({ width: 612, height: 792 }),
  });

  /**
   * "1-3, 5, 8-" -> [[0,1,2],[4],[7,8,...]] (0-based indices, one array per range).
   * Supports "a-b", "a", "a-" (to the end) and "-b" (from the start). Throws Error on bad input.
   */
  function parseRanges(input, pageCount) {
    if (!Number.isInteger(pageCount) || pageCount < 1) throw new Error("The document has no pages.");
    const text = String(input == null ? "" : input).trim();
    if (!text) throw new Error("Enter at least one page or range.");
    const parts = text.split(",").map((p) => p.trim());
    const result = [];
    for (const part of parts) {
      if (!part) throw new Error("Empty entry in the range list (check for stray commas).");
      const m = /^(\d*)\s*(-)?\s*(\d*)$/.exec(part);
      if (!m || (!m[1] && !m[3])) throw new Error(`"${part}" is not a valid page or range.`);
      let start;
      let end;
      if (!m[2]) {
        if (!m[1]) throw new Error(`"${part}" is not a valid page or range.`);
        start = end = Number(m[1]);
      } else {
        start = m[1] ? Number(m[1]) : 1;
        end = m[3] ? Number(m[3]) : pageCount;
      }
      if (start < 1 || end < 1) throw new Error(`Page numbers start at 1 (got "${part}").`);
      if (start > pageCount || end > pageCount) {
        throw new Error(`"${part}" is out of range; the document has ${pageCount} page${pageCount === 1 ? "" : "s"}.`);
      }
      if (start > end) throw new Error(`"${part}" is a reversed range.`);
      const run = [];
      for (let i = start; i <= end; i++) run.push(i - 1);
      result.push(run);
    }
    return result;
  }

  /** Flatten ranges to a sorted list of unique 0-based indices. */
  function flattenRanges(ranges) {
    return Array.from(new Set(ranges.flat())).sort((a, b) => a - b);
  }

  /** Every n pages -> [[0..n-1],[n..2n-1],...] */
  function chunkPages(total, n) {
    if (!Number.isInteger(total) || total < 0) throw new Error("Invalid page count.");
    if (!Number.isInteger(n) || n < 1) throw new Error("Pages per file must be a whole number of at least 1.");
    const out = [];
    for (let start = 0; start < total; start += n) {
      const run = [];
      for (let i = start; i < Math.min(start + n, total); i++) run.push(i);
      out.push(run);
    }
    return out;
  }

  /** Centered, aspect-preserving fit of an image into a page minus margin. Never upscales beyond the box. */
  function computeFit(imgW, imgH, pageW, pageH, margin = 0) {
    const boxW = pageW - 2 * margin;
    const boxH = pageH - 2 * margin;
    if (!(imgW > 0 && imgH > 0)) throw new Error("Image has no size.");
    if (!(boxW > 0 && boxH > 0)) throw new Error("Margin is too large for this page.");
    const scale = Math.min(boxW / imgW, boxH / imgH);
    const width = imgW * scale;
    const height = imgH * scale;
    return { x: (pageW - width) / 2, y: (pageH - height) / 2, width, height };
  }

  /**
   * Resolve page dimensions. size: "fit" | "a4" | "letter"; orientation: "auto" | "portrait" | "landscape".
   * "fit" uses the image size in points (1 px = 1 pt) plus margins on every side.
   */
  function pageDimensions(size, orientation, imgW, imgH, margin = 0) {
    if (size === "fit") {
      const w = imgW + 2 * margin;
      const h = imgH + 2 * margin;
      if (orientation === "portrait") return { width: Math.min(w, h), height: Math.max(w, h) };
      if (orientation === "landscape") return { width: Math.max(w, h), height: Math.min(w, h) };
      return { width: w, height: h };
    }
    const base = PAGE_SIZES[size];
    if (!base) throw new Error(`Unknown page size "${size}".`);
    const landscape = orientation === "auto" ? imgW > imgH : orientation === "landscape";
    return landscape ? { width: base.height, height: base.width } : { width: base.width, height: base.height };
  }

  function formatPageLabel(template, n, total) {
    return String(template).replace(/\{n\}/g, String(n)).replace(/\{total\}/g, String(total));
  }

  function dpiToScale(dpi) {
    if (!(dpi > 0)) throw new Error("DPI must be positive.");
    return dpi / 72;
  }

  /** { saved, percent, smaller } where saved may be negative if output grew. */
  function savings(originalBytes, outputBytes) {
    const saved = originalBytes - outputBytes;
    const percent = originalBytes > 0 ? (saved / originalBytes) * 100 : 0;
    return { saved, percent, smaller: outputBytes < originalBytes };
  }

  /** Immutable move of one item. Indices are clamped to the array. */
  function moveItem(array, from, to) {
    const copy = array.slice();
    if (from < 0 || from >= copy.length) return copy;
    const target = Math.max(0, Math.min(copy.length - 1, to));
    const [item] = copy.splice(from, 1);
    copy.splice(target, 0, item);
    return copy;
  }

  /**
   * Validate a "3,1,2" page order. Returns 0-based indices. Pages may be omitted (they are dropped)
   * but not repeated or out of range.
   */
  function applyOrder(input, count) {
    const text = String(input == null ? "" : input).trim();
    if (!text) throw new Error("Enter a page order such as 3,1,2.");
    const seen = new Set();
    return text.split(/[,\s]+/).filter(Boolean).map((tok) => {
      if (!/^\d+$/.test(tok)) throw new Error(`"${tok}" is not a page number.`);
      const n = Number(tok);
      if (n < 1 || n > count) throw new Error(`Page ${n} is out of range (1-${count}).`);
      if (seen.has(n)) throw new Error(`Page ${n} appears more than once.`);
      seen.add(n);
      return n - 1;
    });
  }

  /** Rotation helper: normalise to 0/90/180/270. */
  function addRotation(current, delta) {
    return ((((current + delta) % 360) + 360) % 360);
  }

  /** Indices 0..count-1 not in the selection set. */
  function invertSelection(selected, count) {
    const out = [];
    for (let i = 0; i < count; i++) if (!selected.has(i)) out.push(i);
    return out;
  }

  /** Position of page-number text: x,y for text of given width on a page. */
  function numberPosition(position, pageW, textW, margin = 28) {
    if (position === "bottom-right") return { x: pageW - margin - textW, y: margin };
    return { x: (pageW - textW) / 2, y: margin };
  }

  /** Parse a PDF date string "D:YYYYMMDDHHmmSS" or ISO into a datetime-local value (or ""). */
  function toDateInput(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
    const p = (v) => String(v).padStart(2, "0");
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}`;
  }

  function fromDateInput(value) {
    if (!value) return undefined;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }

  /** Split "a, b; c" keywords into a trimmed list. */
  function splitKeywords(text) {
    return String(text || "").split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
  }

  return {
    PAGE_SIZES, parseRanges, flattenRanges, chunkPages, computeFit, pageDimensions, formatPageLabel,
    dpiToScale, savings, moveItem, applyOrder, addRotation, invertSelection, numberPosition,
    toDateInput, fromDateInput, splitKeywords,
  };
});
