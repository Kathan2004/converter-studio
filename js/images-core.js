/*
 * Pure image-tool logic (no DOM access). Used by js/images.js in the browser and by Node tests.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ImagesCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------- Generic helpers ----------

  /** Positive = smaller output (saving), negative = growth. Rounded to 1 decimal. */
  function savingsPercent(originalBytes, outputBytes) {
    if (!(originalBytes > 0) || !Number.isFinite(outputBytes)) return 0;
    const pct = ((originalBytes - outputBytes) / originalBytes) * 100;
    return Math.round(pct * 10) / 10;
  }

  function positiveInt(value, label) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${label} must be a positive number`);
    return Math.max(1, Math.round(n));
  }

  /**
   * dims: {width, height}
   * options: {
   *   mode: "dimensions" | "percent" | "fit",
   *   width, height,           // dimensions: either or both; fit: bounding box
   *   lockAspect,              // dimensions: when true, the first given of width/height drives the other
   *   percent,                 // percent mode
   *   noEnlarge                // never return something larger than the source
   * }
   * Returns {width, height} (integers >= 1).
   */
  function computeResize(dims, options = {}) {
    const sw = positiveInt(dims && dims.width, "Source width");
    const sh = positiveInt(dims && dims.height, "Source height");
    const mode = options.mode || "dimensions";
    const hasW = options.width !== undefined && options.width !== null && options.width !== "" && Number(options.width) > 0;
    const hasH = options.height !== undefined && options.height !== null && options.height !== "" && Number(options.height) > 0;
    let w;
    let h;

    if (mode === "percent") {
      const p = Number(options.percent);
      if (!Number.isFinite(p) || p <= 0) throw new Error("Percentage must be a positive number");
      let scale = p / 100;
      if (options.noEnlarge) scale = Math.min(scale, 1);
      w = sw * scale;
      h = sh * scale;
    } else if (mode === "fit") {
      if (!hasW && !hasH) throw new Error("Enter a maximum width and/or height");
      const bw = hasW ? Number(options.width) : Infinity;
      const bh = hasH ? Number(options.height) : Infinity;
      let scale = Math.min(bw / sw, bh / sh);
      if (options.noEnlarge) scale = Math.min(scale, 1);
      w = sw * scale;
      h = sh * scale;
    } else {
      if (!hasW && !hasH) throw new Error("Enter a width and/or height");
      if (options.lockAspect) {
        let scale = hasW ? Number(options.width) / sw : Number(options.height) / sh;
        if (options.noEnlarge) scale = Math.min(scale, 1);
        w = sw * scale;
        h = sh * scale;
      } else {
        w = hasW ? Number(options.width) : sw;
        h = hasH ? Number(options.height) : sh;
        if (options.noEnlarge) { w = Math.min(w, sw); h = Math.min(h, sh); }
      }
    }
    return { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) };
  }

  /**
   * Sizes to draw through for a high-quality downscale: halve while the reduction is more than 2x,
   * then land on the target. Always ends with the target size.
   */
  function downscaleSteps(srcW, srcH, dstW, dstH) {
    const steps = [];
    let w = srcW;
    let h = srcH;
    while (w > dstW * 2 || h > dstH * 2) {
      w = w > dstW * 2 ? Math.ceil(w / 2) : dstW;
      h = h > dstH * 2 ? Math.ceil(h / 2) : dstH;
      if (w === dstW && h === dstH) break;
      steps.push({ width: w, height: h });
    }
    steps.push({ width: dstW, height: dstH });
    return steps;
  }

  function parseRatio(ratio) {
    if (typeof ratio === "number" && ratio > 0) return ratio;
    if (Array.isArray(ratio) && ratio[0] > 0 && ratio[1] > 0) return ratio[0] / ratio[1];
    if (ratio && typeof ratio === "object" && ratio.w > 0 && ratio.h > 0) return ratio.w / ratio.h;
    const m = /^\s*(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)\s*$/.exec(String(ratio));
    if (m && Number(m[1]) > 0 && Number(m[2]) > 0) return Number(m[1]) / Number(m[2]);
    throw new Error(`Invalid aspect ratio: ${ratio}`);
  }

  /** Largest centered crop of the given aspect ratio ("16:9", [16, 9], {w,h} or a number). */
  function computeCrop(dims, ratio) {
    const sw = positiveInt(dims && dims.width, "Width");
    const sh = positiveInt(dims && dims.height, "Height");
    const r = parseRatio(ratio);
    let w = sw;
    let h = Math.round(sw / r);
    if (h > sh) { h = sh; w = Math.round(sh * r); }
    w = Math.min(sw, Math.max(1, w));
    h = Math.min(sh, Math.max(1, h));
    return { x: Math.floor((sw - w) / 2), y: Math.floor((sh - h) / 2), width: w, height: h };
  }

  /** Clamp a free crop rectangle into the image. Missing values default to the full remaining area. */
  function clampCrop(dims, rect = {}) {
    const sw = positiveInt(dims && dims.width, "Width");
    const sh = positiveInt(dims && dims.height, "Height");
    const num = (v, d) => (v === undefined || v === null || v === "" || !Number.isFinite(Number(v)) ? d : Number(v));
    const x = Math.min(sw - 1, Math.max(0, Math.round(num(rect.x, 0))));
    const y = Math.min(sh - 1, Math.max(0, Math.round(num(rect.y, 0))));
    const width = Math.min(sw - x, Math.max(1, Math.round(num(rect.width, sw - x))));
    const height = Math.min(sh - y, Math.max(1, Math.round(num(rect.height, sh - y))));
    return { x, y, width, height };
  }

  /**
   * Find the highest quality whose encoded size fits targetBytes.
   * encode(quality) -> Promise<number> (size in bytes). Sizes are assumed to grow with quality.
   * Returns {quality, size, met, iterations}. When even minQuality is too big, returns minQuality with met=false.
   */
  async function findTargetQuality(encode, targetBytes, options = {}) {
    const minQ = options.minQuality ?? 0.05;
    const maxQ = options.maxQuality ?? 1;
    const maxIter = options.maxIterations ?? 8;
    let iterations = 0;
    const probe = async (q) => { iterations += 1; return { quality: q, size: await encode(q) }; };

    const top = await probe(maxQ);
    if (top.size <= targetBytes) return { ...top, met: true, iterations };
    const bottom = await probe(minQ);
    if (bottom.size > targetBytes) return { ...bottom, met: false, iterations };

    let best = bottom;
    let lo = minQ;
    let hi = maxQ;
    while (iterations < maxIter && hi - lo > 0.005) {
      const mid = (lo + hi) / 2;
      const r = await probe(Math.round(mid * 1000) / 1000);
      if (r.size <= targetBytes) { best = r; lo = mid; } else { hi = mid; }
    }
    return { ...best, met: true, iterations };
  }

  // ---------- CRC32 ----------

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes, start = 0, end = bytes.length) {
    let c = 0xffffffff;
    for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // ---------- Byte helpers ----------

  function concatBytes(parts) {
    const total = parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  function matchesAscii(bytes, offset, text) {
    if (offset + text.length > bytes.length) return false;
    for (let i = 0; i < text.length; i++) if (bytes[offset + i] !== text.charCodeAt(i)) return false;
    return true;
  }

  function isJpeg(bytes) { return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8; }
  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  function isPng(bytes) { return bytes.length >= 8 && PNG_SIG.every((b, i) => bytes[i] === b); }

  /** Best-effort MIME sniffing from magic bytes; null when unknown. */
  function sniffImageType(bytes) {
    if (isJpeg(bytes)) return "image/jpeg";
    if (isPng(bytes)) return "image/png";
    if (matchesAscii(bytes, 0, "GIF8")) return "image/gif";
    if (matchesAscii(bytes, 0, "RIFF") && matchesAscii(bytes, 8, "WEBP")) return "image/webp";
    if (matchesAscii(bytes, 4, "ftyp") && (matchesAscii(bytes, 8, "avif") || matchesAscii(bytes, 8, "avis"))) return "image/avif";
    if (matchesAscii(bytes, 0, "BM")) return "image/bmp";
    if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return "image/x-icon";
    const head = String.fromCharCode.apply(null, bytes.subarray(0, Math.min(bytes.length, 512))).trimStart();
    if (/^(<\?xml[\s\S]*?)?<svg[\s>]/i.test(head)) return "image/svg+xml";
    return null;
  }

  // ---------- JPEG ----------

  /**
   * Walk JPEG segments up to and including SOS (everything after SOS is entropy-coded data).
   * Returns [{marker, offset, length}] where length includes the 2 marker bytes. The SOS entry spans to EOF.
   */
  function parseJpegSegments(bytes) {
    if (!isJpeg(bytes)) throw new Error("Not a JPEG file");
    const segs = [{ marker: 0xd8, offset: 0, length: 2 }];
    let pos = 2;
    while (pos + 1 < bytes.length) {
      if (bytes[pos] !== 0xff) throw new Error("Corrupt JPEG: expected a marker");
      while (pos < bytes.length && bytes[pos] === 0xff) pos += 1; // fill bytes
      const marker = bytes[pos];
      const offset = pos - 1;
      pos += 1;
      if (marker === 0xd9) { segs.push({ marker, offset, length: 2 }); break; }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { segs.push({ marker, offset, length: 2 }); continue; }
      if (marker === 0xda) { segs.push({ marker, offset, length: bytes.length - offset }); break; }
      if (pos + 1 >= bytes.length) break;
      const len = (bytes[pos] << 8) | bytes[pos + 1];
      if (len < 2) throw new Error("Corrupt JPEG: bad segment length");
      const length = Math.min(len + 2, bytes.length - offset);
      segs.push({ marker, offset, length });
      pos = offset + length;
    }
    return segs;
  }

  function isIccSegment(bytes, seg) { return seg.marker === 0xe2 && matchesAscii(bytes, seg.offset + 4, "ICC_PROFILE\0"); }
  // Adobe APP14 carries the colour transform for CMYK/YCCK files; dropping it changes the picture.
  function isAdobeSegment(bytes, seg) { return seg.marker === 0xee && matchesAscii(bytes, seg.offset + 4, "Adobe"); }

  function isRemovableJpegSegment(bytes, seg, keepIcc) {
    const m = seg.marker;
    if (m === 0xfe) return true;
    if (m < 0xe1 || m > 0xef) return false;
    if (keepIcc && isIccSegment(bytes, seg)) return false;
    if (isAdobeSegment(bytes, seg)) return false;
    return true;
  }

  /** Lossless removal of APP1-APP15 and COM segments. Keeps APP0, optionally the ICC profile (APP2). */
  function stripJpegMetadata(bytes, options = {}) {
    const keepIcc = Boolean(options.keepIcc);
    const segs = parseJpegSegments(bytes);
    const parts = [];
    for (const seg of segs) {
      if (isRemovableJpegSegment(bytes, seg, keepIcc)) continue;
      parts.push(bytes.subarray(seg.offset, seg.offset + seg.length));
    }
    // Anything after a stand-alone EOI is dropped; SOS already spans to end of file.
    return concatBytes(parts);
  }

  function jpegSegmentLabel(bytes, seg) {
    const m = seg.marker;
    if (m === 0xfe) return "Comment";
    if (m === 0xe0) return "JFIF";
    if (m === 0xe1) {
      if (matchesAscii(bytes, seg.offset + 4, "Exif\0\0")) return "EXIF";
      if (matchesAscii(bytes, seg.offset + 4, "http://ns.adobe.com/xap/1.0/")) return "XMP";
      return "APP1";
    }
    if (m === 0xe2) return isIccSegment(bytes, seg) ? "ICC colour profile" : "APP2";
    if (m === 0xed) return "Photoshop / IPTC";
    if (m === 0xee) return "Adobe";
    return `APP${m - 0xe0}`;
  }

  /** Metadata-carrying segments present in a JPEG: [{marker, label, size}]. */
  function listJpegMetadata(bytes) {
    return parseJpegSegments(bytes)
      .filter((s) => s.marker === 0xfe || (s.marker >= 0xe1 && s.marker <= 0xef))
      .map((s) => ({ marker: s.marker, label: jpegSegmentLabel(bytes, s), size: s.length }));
  }

  // ---------- EXIF ----------

  function emptySummary() {
    return { hasExif: false, hasGps: false, make: null, model: null, software: null, dateTimeOriginal: null, orientation: null };
  }

  function readTiffSummary(bytes, tiffStart) {
    const out = emptySummary();
    const size = bytes.length - tiffStart;
    if (size < 8) return out;
    const view = new DataView(bytes.buffer, bytes.byteOffset + tiffStart, size);
    let little;
    if (view.getUint8(0) === 0x49 && view.getUint8(1) === 0x49) little = true;
    else if (view.getUint8(0) === 0x4d && view.getUint8(1) === 0x4d) little = false;
    else return out;
    if (view.getUint16(2, little) !== 42) return out;
    out.hasExif = true;

    const u16 = (o) => (o >= 0 && o + 2 <= size ? view.getUint16(o, little) : 0);
    const u32 = (o) => (o >= 0 && o + 4 <= size ? view.getUint32(o, little) : 0);

    function readIfd(ifdOffset, onEntry) {
      if (ifdOffset < 8 || ifdOffset + 2 > size) return 0;
      const n = u16(ifdOffset);
      let seen = 0;
      for (let i = 0; i < n; i++) {
        const e = ifdOffset + 2 + i * 12;
        if (e + 12 > size) break;
        seen += 1;
        onEntry(u16(e), u16(e + 2), u32(e + 4), e);
      }
      return seen;
    }
    function ascii(count, e) {
      const start = count <= 4 ? e + 8 : u32(e + 8);
      if (start < 0 || start + count > size || count === 0) return null;
      let s = "";
      for (let i = 0; i < count; i++) {
        const c = view.getUint8(start + i);
        if (c === 0) break;
        s += String.fromCharCode(c);
      }
      return s.trim() || null;
    }

    let exifIfd = 0;
    let gpsIfd = 0;
    readIfd(u32(4), (tag, type, count, e) => {
      if (tag === 0x010f && type === 2) out.make = ascii(count, e);
      else if (tag === 0x0110 && type === 2) out.model = ascii(count, e);
      else if (tag === 0x0131 && type === 2) out.software = ascii(count, e);
      else if (tag === 0x0112 && type === 3) out.orientation = u16(e + 8);
      else if (tag === 0x8769) exifIfd = u32(e + 8);
      else if (tag === 0x8825) gpsIfd = u32(e + 8);
    });
    if (exifIfd) {
      readIfd(exifIfd, (tag, type, count, e) => {
        if (tag === 0x9003 && type === 2) out.dateTimeOriginal = ascii(count, e);
      });
    }
    if (gpsIfd) {
      const entries = readIfd(gpsIfd, () => {});
      out.hasGps = entries > 0;
    }
    return out;
  }

  /** Summary of EXIF in a JPEG (APP1) or PNG (eXIf chunk). Returns all-null fields when none. */
  function readExifSummary(bytes) {
    try {
      if (isJpeg(bytes)) {
        for (const seg of parseJpegSegments(bytes)) {
          if (seg.marker === 0xe1 && matchesAscii(bytes, seg.offset + 4, "Exif\0\0")) {
            return readTiffSummary(bytes, seg.offset + 10);
          }
        }
      } else if (isPng(bytes)) {
        const chunk = parsePngChunks(bytes).find((c) => c.type === "eXIf");
        if (chunk) return readTiffSummary(bytes.subarray(0, chunk.dataOffset + chunk.length), chunk.dataOffset);
      }
    } catch (e) { /* malformed metadata: report as none */ }
    return emptySummary();
  }

  // ---------- PNG ----------

  /** Returns [{type, offset, length, dataOffset, total}] ; length is the data length. Stops at truncation. */
  function parsePngChunks(bytes) {
    if (!isPng(bytes)) throw new Error("Not a PNG file");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const chunks = [];
    let pos = 8;
    while (pos + 12 <= bytes.length) {
      const length = view.getUint32(pos);
      const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
      const total = length + 12;
      if (pos + total > bytes.length) break;
      chunks.push({ type, offset: pos, length, dataOffset: pos + 8, total });
      pos += total;
      if (type === "IEND") break;
    }
    return chunks;
  }

  const PNG_METADATA_CHUNKS = new Set(["tEXt", "iTXt", "zTXt", "eXIf", "tIME"]);

  function stripPngMetadata(bytes) {
    const chunks = parsePngChunks(bytes);
    const parts = [bytes.subarray(0, 8)];
    for (const c of chunks) {
      if (PNG_METADATA_CHUNKS.has(c.type)) continue;
      parts.push(bytes.subarray(c.offset, c.offset + c.total));
    }
    return concatBytes(parts);
  }

  /** Metadata chunks in a PNG: [{type, keyword, size}] (keyword for text chunks). */
  function listPngMetadata(bytes) {
    const out = [];
    for (const c of parsePngChunks(bytes)) {
      if (!PNG_METADATA_CHUNKS.has(c.type)) continue;
      let keyword = null;
      if (c.type === "tEXt" || c.type === "iTXt" || c.type === "zTXt") {
        let s = "";
        for (let i = 0; i < Math.min(c.length, 80) && bytes[c.dataOffset + i] !== 0; i++) s += String.fromCharCode(bytes[c.dataOffset + i]);
        keyword = s;
      }
      out.push({ type: c.type, keyword, size: c.total });
    }
    return out;
  }

  /** Build a PNG chunk (length, type, data, CRC). Handy for tests and tooling. */
  function buildPngChunk(type, data) {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
    return out;
  }

  // ---------- ICO ----------

  /** entries: [{size, pngBytes}] -> .ico file bytes (PNG-compressed entries). size 256 is stored as 0. */
  function buildIco(entries) {
    if (!Array.isArray(entries) || !entries.length) throw new Error("ICO needs at least one image");
    const count = entries.length;
    const headerSize = 6 + 16 * count;
    const total = headerSize + entries.reduce((s, e) => s + e.pngBytes.length, 0);
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    view.setUint16(0, 0, true);
    view.setUint16(2, 1, true); // type: icon
    view.setUint16(4, count, true);
    let offset = headerSize;
    entries.forEach((e, i) => {
      if (!(e.size >= 1 && e.size <= 256)) throw new Error("ICO sizes must be between 1 and 256");
      const d = 6 + i * 16;
      const dim = e.size >= 256 ? 0 : e.size;
      out[d] = dim;
      out[d + 1] = dim;
      out[d + 2] = 0; // palette colours
      out[d + 3] = 0;
      view.setUint16(d + 4, 1, true); // planes
      view.setUint16(d + 6, 32, true); // bits per pixel
      view.setUint32(d + 8, e.pngBytes.length, true);
      view.setUint32(d + 12, offset, true);
      out.set(e.pngBytes, offset);
      offset += e.pngBytes.length;
    });
    return out;
  }

  // ---------- Base64 ----------

  /** Accepts a data URL or raw base64 text. Returns {mime, base64} (mime may be null for raw input). */
  function parseBase64Input(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) throw new Error("Paste a data URL or base64 text first");
    const m = /^data:([^;,]*)((?:;[^;,]*)*?),/i.exec(trimmed);
    let mime = null;
    let body = trimmed;
    if (m) {
      if (!/;base64/i.test(m[2])) throw new Error("Only base64 data URLs are supported");
      mime = m[1] || null;
      body = trimmed.slice(m[0].length);
    }
    body = body.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body)) throw new Error("This is not valid base64");
    while (body.length % 4) body += "=";
    return { mime, base64: body };
  }

  function extensionForMime(mime) {
    return ({
      "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/avif": "avif", "image/gif": "gif",
      "image/bmp": "bmp", "image/svg+xml": "svg", "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico",
    })[mime] || "bin";
  }

  return {
    savingsPercent, computeResize, downscaleSteps, computeCrop, clampCrop, findTargetQuality,
    crc32, concatBytes, isJpeg, isPng, sniffImageType,
    parseJpegSegments, stripJpegMetadata, listJpegMetadata, readExifSummary,
    parsePngChunks, stripPngMetadata, listPngMetadata, buildPngChunk,
    buildIco, parseBase64Input, extensionForMime,
  };
});
