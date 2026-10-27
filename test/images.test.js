"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../js/images-core.js");

// ---------- fixtures ----------

/** Little-endian TIFF with Make, Model, Orientation, Exif IFD (DateTimeOriginal) and a GPS IFD. */
function buildTiff({ gps = true } = {}) {
  const buf = new Uint8Array(256);
  const v = new DataView(buf.buffer);
  const put = (o, s) => { for (let i = 0; i < s.length; i++) buf[o + i] = s.charCodeAt(i); };
  put(0, "II"); v.setUint16(2, 42, true); v.setUint32(4, 8, true);
  const entries = gps ? 5 : 4;
  v.setUint16(8, entries, true);
  const ent = (i, tag, type, count, val) => {
    const e = 10 + i * 12;
    v.setUint16(e, tag, true); v.setUint16(e + 2, type, true); v.setUint32(e + 4, count, true);
    if (type === 3) v.setUint16(e + 8, val, true); else v.setUint32(e + 8, val, true);
  };
  const ifdEnd = 8 + 2 + entries * 12 + 4;
  const makeOff = ifdEnd, modelOff = makeOff + 6, exifOff = modelOff + 6, dtOff = exifOff + 18, gpsOff = dtOff + 20;
  ent(0, 0x010f, 2, 6, makeOff);
  ent(1, 0x0110, 2, 6, modelOff);
  ent(2, 0x0112, 3, 1, 6);
  ent(3, 0x8769, 4, 1, exifOff);
  if (gps) ent(4, 0x8825, 4, 1, gpsOff);
  put(makeOff, "Canon\0"); put(modelOff, "EOS R\0");
  v.setUint16(exifOff, 1, true);
  v.setUint16(exifOff + 2, 0x9003, true); v.setUint16(exifOff + 4, 2, true); v.setUint32(exifOff + 6, 20, true); v.setUint32(exifOff + 10, dtOff, true);
  put(dtOff, "2024:05:06 07:08:09\0");
  if (gps) {
    v.setUint16(gpsOff, 1, true);
    v.setUint16(gpsOff + 2, 0, true); v.setUint16(gpsOff + 4, 1, true); v.setUint32(gpsOff + 6, 4, true);
    buf[gpsOff + 10] = 2; buf[gpsOff + 11] = 3;
  }
  return buf.subarray(0, gps ? gpsOff + 18 : dtOff + 20);
}

function seg(marker, payload) {
  const len = payload.length + 2;
  return [0xff, marker, len >> 8, len & 255, ...payload];
}
const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0));

function buildJpeg({ gps = true } = {}) {
  const exif = [...ascii("Exif\0\0"), ...buildTiff({ gps })];
  const icc = [...ascii("ICC_PROFILE\0"), 1, 1, 9, 9, 9];
  return new Uint8Array([
    0xff, 0xd8,
    ...seg(0xe0, [...ascii("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...seg(0xe1, exif),
    ...seg(0xe2, icc),
    ...seg(0xfe, ascii("hello comment")),
    ...seg(0xdb, new Array(65).fill(1)),
    ...seg(0xda, [1, 1, 0, 0, 63, 0]),
    0x12, 0x34, 0xff, 0x00, 0x56, // entropy data with a stuffed byte
    0xff, 0xd9,
  ]);
}

function buildPng() {
  const sig = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = new Uint8Array(13); ihdr[3] = 1; ihdr[7] = 1; ihdr[8] = 8; ihdr[9] = 2;
  const text = new Uint8Array([...ascii("Author\0Kathan")]);
  return C.concatBytes([
    sig,
    C.buildPngChunk("IHDR", ihdr),
    C.buildPngChunk("tEXt", text),
    C.buildPngChunk("tIME", new Uint8Array(7)),
    C.buildPngChunk("IDAT", new Uint8Array([1, 2, 3, 4])),
    C.buildPngChunk("iTXt", new Uint8Array([...ascii("Comment\0\0\0\0\0hi")])),
    C.buildPngChunk("IEND", new Uint8Array(0)),
  ]);
}

// ---------- savings / resize / crop ----------

test("savingsPercent: saving, growth and zero", () => {
  assert.equal(C.savingsPercent(1000, 250), 75);
  assert.equal(C.savingsPercent(1000, 1200), -20);
  assert.equal(C.savingsPercent(0, 10), 0);
  assert.equal(C.savingsPercent(300, 100), 66.7);
});

test("computeResize: width with locked aspect", () => {
  assert.deepEqual(C.computeResize({ width: 2000, height: 1000 }, { width: 500, lockAspect: true }), { width: 500, height: 250 });
});

test("computeResize: height with locked aspect", () => {
  assert.deepEqual(C.computeResize({ width: 2000, height: 1000 }, { height: 100, lockAspect: true }), { width: 200, height: 100 });
});

test("computeResize: unlocked dimensions distort and default missing side", () => {
  assert.deepEqual(C.computeResize({ width: 800, height: 600 }, { width: 100, height: 100 }), { width: 100, height: 100 });
  assert.deepEqual(C.computeResize({ width: 800, height: 600 }, { width: 400 }), { width: 400, height: 600 });
});

test("computeResize: percent", () => {
  assert.deepEqual(C.computeResize({ width: 801, height: 600 }, { mode: "percent", percent: 50 }), { width: 401, height: 300 });
});

test("computeResize: fit within box keeps aspect", () => {
  assert.deepEqual(C.computeResize({ width: 4000, height: 3000 }, { mode: "fit", width: 800, height: 800 }), { width: 800, height: 600 });
  assert.deepEqual(C.computeResize({ width: 3000, height: 4000 }, { mode: "fit", width: 800, height: 800 }), { width: 600, height: 800 });
});

test("computeResize: noEnlarge caps every mode at the source size", () => {
  const dims = { width: 400, height: 200 };
  assert.deepEqual(C.computeResize(dims, { width: 800, lockAspect: true, noEnlarge: true }), dims);
  assert.deepEqual(C.computeResize(dims, { mode: "percent", percent: 200, noEnlarge: true }), dims);
  assert.deepEqual(C.computeResize(dims, { mode: "fit", width: 1000, height: 1000, noEnlarge: true }), dims);
  assert.deepEqual(C.computeResize(dims, { width: 900, height: 100, noEnlarge: true }), { width: 400, height: 100 });
});

test("computeResize: rejects missing or invalid input", () => {
  assert.throws(() => C.computeResize({ width: 10, height: 10 }, {}), /width and\/or height/);
  assert.throws(() => C.computeResize({ width: 10, height: 10 }, { mode: "percent", percent: 0 }));
  assert.throws(() => C.computeResize({ width: 0, height: 10 }, { width: 5 }));
});

test("downscaleSteps: halves until within 2x then lands on target", () => {
  assert.deepEqual(C.downscaleSteps(1000, 1000, 100, 100).map((s) => s.width), [500, 250, 125, 100]);
  assert.deepEqual(C.downscaleSteps(150, 150, 100, 100), [{ width: 100, height: 100 }]);
  assert.deepEqual(C.downscaleSteps(100, 100, 400, 400), [{ width: 400, height: 400 }]);
});

test("computeCrop: centered presets", () => {
  assert.deepEqual(C.computeCrop({ width: 1000, height: 800 }, "1:1"), { x: 100, y: 0, width: 800, height: 800 });
  assert.deepEqual(C.computeCrop({ width: 1600, height: 1200 }, "16:9"), { x: 0, y: 150, width: 1600, height: 900 });
  assert.deepEqual(C.computeCrop({ width: 1000, height: 1000 }, "9:16"), { x: 218, y: 0, width: 563, height: 1000 });
  assert.deepEqual(C.computeCrop({ width: 900, height: 600 }, [3, 2]), { x: 0, y: 0, width: 900, height: 600 });
  assert.throws(() => C.computeCrop({ width: 10, height: 10 }, "nope"));
});

test("clampCrop: clamps free rectangles into the image", () => {
  assert.deepEqual(C.clampCrop({ width: 100, height: 50 }, { x: 90, y: 40, width: 50, height: 50 }), { x: 90, y: 40, width: 10, height: 10 });
  assert.deepEqual(C.clampCrop({ width: 100, height: 50 }, {}), { x: 0, y: 0, width: 100, height: 50 });
  assert.deepEqual(C.clampCrop({ width: 100, height: 50 }, { x: -5, y: 10, width: "20", height: "" }), { x: 0, y: 10, width: 20, height: 40 });
});

// ---------- target size search ----------

test("findTargetQuality: returns top quality when it already fits", async () => {
  const r = await C.findTargetQuality(async (q) => q * 1000, 5000, { maxQuality: 0.9 });
  assert.equal(r.met, true);
  assert.equal(r.quality, 0.9);
  assert.equal(r.iterations, 1);
});

test("findTargetQuality: binary search lands under the target within 8 encodes", async () => {
  let calls = 0;
  const r = await C.findTargetQuality(async (q) => { calls += 1; return Math.round(q * 100000); }, 40000, { maxQuality: 1 });
  assert.equal(r.met, true);
  assert.ok(r.size <= 40000);
  assert.ok(r.quality > 0.35 && r.quality <= 0.4, `quality ${r.quality}`);
  assert.ok(calls <= 8);
});

test("findTargetQuality: reports failure when even the minimum is too large", async () => {
  const r = await C.findTargetQuality(async () => 999999, 100, { minQuality: 0.1 });
  assert.equal(r.met, false);
  assert.equal(r.quality, 0.1);
});

// ---------- JPEG ----------

test("parseJpegSegments walks markers up to SOS", () => {
  const segs = C.parseJpegSegments(buildJpeg());
  assert.deepEqual(segs.map((s) => s.marker), [0xd8, 0xe0, 0xe1, 0xe2, 0xfe, 0xdb, 0xda]);
  assert.equal(segs[segs.length - 1].offset + segs[segs.length - 1].length, buildJpeg().length);
});

test("parseJpegSegments rejects non-JPEG data", () => {
  assert.throws(() => C.parseJpegSegments(new Uint8Array([1, 2, 3, 4])), /Not a JPEG/);
});

test("stripJpegMetadata removes APP1, APP2 and COM but keeps APP0 and image data", () => {
  const input = buildJpeg();
  const out = C.stripJpegMetadata(input);
  assert.deepEqual(C.parseJpegSegments(out).map((s) => s.marker), [0xd8, 0xe0, 0xdb, 0xda]);
  assert.ok(out.length < input.length);
  assert.deepEqual(Array.from(out.slice(-7)), [0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd9]);
  assert.equal(C.readExifSummary(out).hasExif, false);
});

test("stripJpegMetadata keeps the ICC profile on request", () => {
  const out = C.stripJpegMetadata(buildJpeg(), { keepIcc: true });
  assert.deepEqual(C.parseJpegSegments(out).map((s) => s.marker), [0xd8, 0xe0, 0xe2, 0xdb, 0xda]);
});

test("stripJpegMetadata keeps Adobe APP14 colour-transform segment", () => {
  const base = buildJpeg();
  const adobe = seg(0xee, [...ascii("Adobe"), 0, 100, 0, 0, 0, 0, 2]);
  const input = new Uint8Array([...base.slice(0, 2), ...adobe, ...base.slice(2)]);
  const out = C.stripJpegMetadata(input);
  assert.ok(C.parseJpegSegments(out).some((s) => s.marker === 0xee));
});

test("listJpegMetadata labels segments", () => {
  assert.deepEqual(C.listJpegMetadata(buildJpeg()).map((s) => s.label), ["EXIF", "ICC colour profile", "Comment"]);
});

test("readExifSummary reads make, model, date, orientation and GPS", () => {
  const s = C.readExifSummary(buildJpeg());
  assert.equal(s.hasExif, true);
  assert.equal(s.hasGps, true);
  assert.equal(s.make, "Canon");
  assert.equal(s.model, "EOS R");
  assert.equal(s.dateTimeOriginal, "2024:05:06 07:08:09");
  assert.equal(s.orientation, 6);
});

test("readExifSummary: no GPS pointer means hasGps false; non-EXIF data is safe", () => {
  assert.equal(C.readExifSummary(buildJpeg({ gps: false })).hasGps, false);
  assert.equal(C.readExifSummary(new Uint8Array([1, 2, 3])).hasExif, false);
  const truncated = buildJpeg().slice(0, 60);
  assert.doesNotThrow(() => C.readExifSummary(truncated));
});

// ---------- PNG ----------

test("parsePngChunks lists chunks with valid CRCs", () => {
  const png = buildPng();
  const chunks = C.parsePngChunks(png);
  assert.deepEqual(chunks.map((c) => c.type), ["IHDR", "tEXt", "tIME", "IDAT", "iTXt", "IEND"]);
  const view = new DataView(png.buffer, png.byteOffset);
  for (const c of chunks) {
    assert.equal(view.getUint32(c.offset + 8 + c.length), C.crc32(png, c.offset + 4, c.offset + 8 + c.length));
  }
});

test("crc32 matches the known IEND checksum", () => {
  assert.equal(C.crc32(Uint8Array.from([0x49, 0x45, 0x4e, 0x44])), 0xae426082);
});

test("stripPngMetadata drops text, time and exif chunks only", () => {
  const png = buildPng();
  const out = C.stripPngMetadata(png);
  assert.deepEqual(C.parsePngChunks(out).map((c) => c.type), ["IHDR", "IDAT", "IEND"]);
  assert.deepEqual(Array.from(out.slice(0, 8)), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});

test("listPngMetadata reports keywords", () => {
  const list = C.listPngMetadata(buildPng());
  assert.deepEqual(list.map((c) => `${c.type}:${c.keyword}`), ["tEXt:Author", "tIME:null", "iTXt:Comment"]);
});

test("readExifSummary reads an eXIf chunk in a PNG", () => {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const png = C.concatBytes([
    Uint8Array.from(sig),
    C.buildPngChunk("eXIf", buildTiff()),
    C.buildPngChunk("IEND", new Uint8Array(0)),
  ]);
  const s = C.readExifSummary(png);
  assert.equal(s.make, "Canon");
  assert.equal(s.hasGps, true);
});

// ---------- ICO ----------

test("buildIco writes a valid header and directory", () => {
  const a = Uint8Array.from([1, 2, 3]);
  const b = Uint8Array.from([4, 5, 6, 7, 8]);
  const ico = C.buildIco([{ size: 16, pngBytes: a }, { size: 256, pngBytes: b }]);
  const v = new DataView(ico.buffer);
  assert.equal(v.getUint16(0, true), 0);
  assert.equal(v.getUint16(2, true), 1);
  assert.equal(v.getUint16(4, true), 2);
  assert.equal(ico[6], 16);
  assert.equal(ico[22], 0, "256 is stored as 0");
  assert.equal(v.getUint16(6 + 4, true), 1, "planes");
  assert.equal(v.getUint16(6 + 6, true), 32, "bpp");
  assert.equal(v.getUint32(6 + 8, true), 3);
  assert.equal(v.getUint32(6 + 12, true), 38);
  assert.equal(v.getUint32(22 + 8, true), 5);
  assert.equal(v.getUint32(22 + 12, true), 41);
  assert.deepEqual(Array.from(ico.slice(38)), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.throws(() => C.buildIco([]));
  assert.throws(() => C.buildIco([{ size: 512, pngBytes: a }]));
});

// ---------- Base64 / sniffing ----------

test("parseBase64Input handles data URLs, raw text and bad input", () => {
  assert.deepEqual(C.parseBase64Input("data:image/png;base64,iVBO\nRw0K"), { mime: "image/png", base64: "iVBORw0K" });
  assert.deepEqual(C.parseBase64Input("  QUJD  "), { mime: null, base64: "QUJD" });
  assert.equal(C.parseBase64Input("QUI").base64, "QUI=");
  assert.throws(() => C.parseBase64Input("data:text/plain,hello"), /base64/);
  assert.throws(() => C.parseBase64Input("***"), /valid base64/);
  assert.throws(() => C.parseBase64Input("   "));
});

test("sniffImageType recognises common formats", () => {
  assert.equal(C.sniffImageType(buildJpeg()), "image/jpeg");
  assert.equal(C.sniffImageType(buildPng()), "image/png");
  assert.equal(C.sniffImageType(Uint8Array.from(ascii("GIF89a"))), "image/gif");
  assert.equal(C.sniffImageType(Uint8Array.from(ascii('<?xml version="1.0"?><svg xmlns=""/>'))), "image/svg+xml");
  assert.equal(C.sniffImageType(Uint8Array.from([9, 9, 9, 9])), null);
  assert.equal(C.extensionForMime("image/jpeg"), "jpg");
});
