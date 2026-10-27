/*
 * Pure logic for the Files page: zip options, safe paths, archive limits, central directory
 * reader, gzip names, MD5 and hash helpers. No DOM access. fflate is injected where needed.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FilesCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const GB = 1024 * 1024 * 1024;
  const MB = 1024 * 1024;
  const LIMITS = Object.freeze({
    maxTotalBytes: 2 * GB,
    maxEntries: 20000,
    maxRatio: 1000,
    ratioMinBytes: 100 * MB,
  });

  const ALREADY_COMPRESSED = new Set([
    "jpg", "jpeg", "png", "gif", "webp", "avif", "mp4", "mov", "mp3",
    "zip", "gz", "7z", "rar", "docx", "xlsx", "pptx", "pdf",
  ]);

  function extOf(name) {
    const base = String(name || "").split(/[\\/]/).pop();
    const dot = base.lastIndexOf(".");
    return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  }

  /** Compression level for one file: 0 (store) for already-compressed types when skipping is on. */
  function levelForFile(name, level, skipCompressed) {
    const n = Number(level);
    const lvl = Number.isInteger(n) && n >= 0 && n <= 9 ? n : 6;
    return skipCompressed && ALREADY_COMPRESSED.has(extOf(name)) ? 0 : lvl;
  }

  /**
   * Make an archive entry name safe for extraction or re-zipping: backslashes become slashes,
   * control characters, drive letters, leading slashes and "." / ".." segments are removed.
   * Returns "" when nothing usable remains.
   */
  function safeEntryPath(name) {
    let s = String(name == null ? "" : name).replace(/[\u0000-\u001f\u007f]/g, "");
    s = s.replace(/\\/g, "/").replace(/^[a-zA-Z]:/, "");
    const parts = s.split("/").filter((p) => p !== "" && p !== "." && p !== ".." && p.trim() !== "");
    return parts.join("/");
  }

  /** Return a path not yet in `used` (a Set) by adding " (2)" etc. before the extension; registers it. */
  function uniquePath(used, path) {
    let candidate = path;
    if (used.has(candidate)) {
      const slash = path.lastIndexOf("/") + 1;
      const dot = path.lastIndexOf(".");
      const hasExt = dot > slash;
      const stem = hasExt ? path.slice(0, dot) : path;
      const ext = hasExt ? path.slice(dot) : "";
      for (let i = 2; used.has(candidate); i++) candidate = `${stem} (${i})${ext}`;
    }
    used.add(candidate);
    return candidate;
  }

  function formatSize(n) {
    if (n >= GB) return `${(n / GB).toFixed(1)} GB`;
    if (n >= MB) return `${(n / MB).toFixed(0)} MB`;
    return `${Math.round(n / 1024)} KB`;
  }

  /**
   * Zip-bomb guard over the declared sizes. entries: [{ name, size, compressedSize, isDir }].
   * Returns { ok: true, totalSize, count } or { ok: false, reason, message }.
   */
  function checkArchiveLimits(entries, limits) {
    const lim = Object.assign({}, LIMITS, limits || {});
    const list = entries || [];
    if (list.length > lim.maxEntries) {
      return { ok: false, reason: "entries", message: `Refused: the archive has ${list.length} entries (limit ${lim.maxEntries}).` };
    }
    let total = 0;
    for (const e of list) {
      const size = Number(e.size) || 0;
      const comp = Number(e.compressedSize) || 0;
      total += size;
      if (size > lim.ratioMinBytes) {
        const ratio = comp > 0 ? size / comp : Infinity;
        if (ratio > lim.maxRatio) {
          return {
            ok: false,
            reason: "ratio",
            message: `Refused: "${e.name}" expands ${formatSize(size)} from ${formatSize(comp)} (over ${lim.maxRatio}:1), which looks like a zip bomb.`,
          };
        }
      }
    }
    if (total > lim.maxTotalBytes) {
      return { ok: false, reason: "size", message: `Refused: the archive would expand to ${formatSize(total)} (limit ${formatSize(lim.maxTotalBytes)}).` };
    }
    return { ok: true, totalSize: total, count: list.length };
  }

  /** Name a new archive: the single top-level folder if all paths share one, else "archive". */
  function defaultArchiveName(paths) {
    const tops = new Set();
    let anyRoot = false;
    for (const p of paths || []) {
      const clean = safeEntryPath(p);
      if (!clean) continue;
      const i = clean.indexOf("/");
      if (i < 0) anyRoot = true;
      else tops.add(clean.slice(0, i));
    }
    if (!anyRoot && tops.size === 1) return [...tops][0];
    return "archive";
  }

  function zipFileName(name) {
    const cleaned = String(name || "").trim().replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").replace(/^\.+/, "").replace(/\.zip$/i, "");
    return `${cleaned.slice(0, 120) || "archive"}.zip`;
  }

  /**
   * Build the object for fflate.zip / zipSync. items: [{ path, data: Uint8Array, mtime }].
   * Duplicate paths are renamed rather than overwritten.
   */
  function buildZipInput(items, level, skipCompressed) {
    const out = {};
    const used = new Set();
    items.forEach((it, i) => {
      const clean = safeEntryPath(it.path) || `file-${i + 1}`;
      const path = uniquePath(used, clean);
      const opts = { level: levelForFile(path, level, skipCompressed) };
      if (it.mtime != null) opts.mtime = it.mtime;
      out[path] = [it.data, opts];
    });
    return out;
  }

  function savedPercent(original, output) {
    if (!(original > 0)) return 0;
    return Math.round((1 - output / original) * 1000) / 10;
  }

  function ratioText(original, output) {
    if (!(original > 0)) return "-";
    const pct = savedPercent(original, output);
    return pct >= 0 ? `${pct.toFixed(1)}% smaller` : `${Math.abs(pct).toFixed(1)}% larger`;
  }

  // ---------- ZIP central directory reader (names, sizes, flags) ----------

  function dosToDate(dosDate, dosTime) {
    const y = ((dosDate >>> 9) & 0x7f) + 1980;
    const mo = ((dosDate >>> 5) & 0x0f) || 1;
    const d = (dosDate & 0x1f) || 1;
    return new Date(y, mo - 1, d, (dosTime >>> 11) & 0x1f, (dosTime >>> 5) & 0x3f, (dosTime & 0x1f) * 2);
  }

  /**
   * Read the central directory of a ZIP held in a Uint8Array.
   * Returns [{ name, size, compressedSize, method, encrypted, isDir, mtime }]. Throws on malformed input.
   */
  function readCentralDirectory(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65535); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("Not a valid ZIP file (end of central directory not found).");
    let count = dv.getUint16(eocd + 10, true);
    let cdOffset = dv.getUint32(eocd + 16, true);
    if (count === 0xffff || cdOffset === 0xffffffff) {
      // ZIP64: the locator sits just before the EOCD record.
      const loc = eocd - 20;
      if (loc < 0 || dv.getUint32(loc, true) !== 0x07064b50) throw new Error("Corrupt ZIP64 archive.");
      const z64 = Number(dv.getBigUint64(loc + 8, true));
      if (z64 + 56 > u8.length || dv.getUint32(z64, true) !== 0x06064b50) throw new Error("Corrupt ZIP64 archive.");
      count = Number(dv.getBigUint64(z64 + 32, true));
      cdOffset = Number(dv.getBigUint64(z64 + 48, true));
    }
    if (count > 1000000) throw new Error("Refused: the archive declares an unreasonable number of entries.");
    const dec = new TextDecoder("utf-8");
    const entries = [];
    let p = cdOffset;
    for (let n = 0; n < count; n++) {
      if (p + 46 > u8.length || dv.getUint32(p, true) !== 0x02014b50) throw new Error("Corrupt ZIP central directory.");
      const flags = dv.getUint16(p + 8, true);
      const method = dv.getUint16(p + 10, true);
      const mtime = dosToDate(dv.getUint16(p + 14, true), dv.getUint16(p + 12, true));
      let compressedSize = dv.getUint32(p + 20, true);
      let size = dv.getUint32(p + 24, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      if (p + 46 + nameLen + extraLen + commentLen > u8.length) throw new Error("Corrupt ZIP central directory.");
      const rawName = u8.subarray(p + 46, p + 46 + nameLen);
      const name = dec.decode(rawName);
      if (size === 0xffffffff || compressedSize === 0xffffffff) {
        let q = p + 46 + nameLen;
        const end = q + extraLen;
        while (q + 4 <= end) {
          const id = dv.getUint16(q, true);
          const len = dv.getUint16(q + 2, true);
          if (id === 0x0001) {
            let r = q + 4;
            if (size === 0xffffffff && r + 8 <= end) { size = Number(dv.getBigUint64(r, true)); r += 8; }
            if (compressedSize === 0xffffffff && r + 8 <= end) { compressedSize = Number(dv.getBigUint64(r, true)); }
            break;
          }
          q += 4 + len;
        }
      }
      entries.push({
        name,
        size,
        compressedSize,
        method,
        encrypted: (flags & 1) === 1,
        isDir: /\/$/.test(name) || /\\$/.test(name),
        mtime,
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  // ---------- gzip names ----------

  function isGzipBytes(u8) {
    return Boolean(u8 && u8.length >= 2 && u8[0] === 0x1f && u8[1] === 0x8b);
  }

  function gzipName(name) {
    const n = String(name || "").split(/[\\/]/).pop() || "file";
    return `${n}.gz`;
  }

  function gunzipName(name) {
    const n = String(name || "").split(/[\\/]/).pop() || "file";
    if (/\.tgz$/i.test(n)) return n.replace(/\.tgz$/i, ".tar");
    if (/\.gz$/i.test(n) && n.length > 3) return n.slice(0, -3);
    if (/\.gz$/i.test(n)) return "file";
    return `${n}.out`;
  }

  // ---------- hashing ----------

  function toHex(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let s = "";
    for (let i = 0; i < u8.length; i++) s += (u8[i] < 16 ? "0" : "") + u8[i].toString(16);
    return s;
  }

  /** Lowercase and drop all whitespace so pasted hashes compare reliably. */
  function normalizeHash(s) {
    return String(s == null ? "" : s).replace(/\s+/g, "").toLowerCase();
  }

  function hashesMatch(a, b) {
    const x = normalizeHash(a);
    return x !== "" && x === normalizeHash(b);
  }

  const MD5_S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const MD5_K = new Int32Array(64);
  for (let i = 0; i < 64; i++) MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;

  /** Incremental MD5 (RFC 1321). update(Uint8Array) any number of times, then digest() -> lowercase hex. */
  function createMD5() {
    let a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
    const buf = new Uint8Array(64);
    let bufLen = 0;
    let total = 0;
    let done = false;
    const M = new Int32Array(16);

    function block(src, off) {
      for (let i = 0; i < 16; i++) {
        const j = off + i * 4;
        M[i] = src[j] | (src[j + 1] << 8) | (src[j + 2] << 16) | (src[j + 3] << 24);
      }
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) & 15; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) & 15; }
        else { F = C ^ (B | ~D); g = (7 * i) & 15; }
        F = (F + A + MD5_K[i] + M[g]) | 0;
        A = D; D = C; C = B;
        const s = MD5_S[i];
        B = (B + ((F << s) | (F >>> (32 - s)))) | 0;
      }
      a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
    }

    function update(data) {
      if (done) throw new Error("MD5 already finalised.");
      const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
      total += u8.length;
      let i = 0;
      if (bufLen > 0) {
        const take = Math.min(64 - bufLen, u8.length);
        buf.set(u8.subarray(0, take), bufLen);
        bufLen += take;
        i = take;
        if (bufLen === 64) { block(buf, 0); bufLen = 0; }
      }
      for (; i + 64 <= u8.length; i += 64) block(u8, i);
      if (i < u8.length) { buf.set(u8.subarray(i), 0); bufLen = u8.length - i; }
    }

    function digest() {
      if (!done) {
        done = true;
        const bits = total * 8;
        buf[bufLen++] = 0x80;
        if (bufLen > 56) { buf.fill(0, bufLen, 64); block(buf, 0); bufLen = 0; }
        buf.fill(0, bufLen, 64);
        const dv = new DataView(buf.buffer);
        dv.setUint32(56, bits >>> 0, true);
        dv.setUint32(60, Math.floor(total / 536870912) >>> 0, true);
        block(buf, 0);
      }
      const out = new Uint8Array(16);
      const dv = new DataView(out.buffer);
      dv.setInt32(0, a0, true); dv.setInt32(4, b0, true); dv.setInt32(8, c0, true); dv.setInt32(12, d0, true);
      return toHex(out);
    }

    return { update, digest };
  }

  function md5Hex(u8) {
    const h = createMD5();
    h.update(u8);
    return h.digest();
  }

  return {
    LIMITS,
    ALREADY_COMPRESSED,
    extOf,
    levelForFile,
    safeEntryPath,
    uniquePath,
    checkArchiveLimits,
    defaultArchiveName,
    zipFileName,
    buildZipInput,
    savedPercent,
    ratioText,
    readCentralDirectory,
    isGzipBytes,
    gzipName,
    gunzipName,
    toHex,
    normalizeHash,
    hashesMatch,
    createMD5,
    md5Hex,
  };
});
