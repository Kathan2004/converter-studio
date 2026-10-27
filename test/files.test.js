const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fflate = require("../vendor/fflate.min.js");
const C = require("../js/files-core.js");

const enc = (s) => new TextEncoder().encode(s);

// ---- levels ----
test("levelForFile stores already-compressed types when skipping", () => {
  for (const n of ["a.jpg", "B.PNG", "x/y.mp4", "r.docx", "d.pdf", "z.7z", "s.mp3", "p.webp"]) {
    assert.equal(C.levelForFile(n, 6, true), 0, n);
  }
});
test("levelForFile keeps the chosen level for text and when skipping is off", () => {
  assert.equal(C.levelForFile("notes.txt", 9, true), 9);
  assert.equal(C.levelForFile("photo.jpg", 9, false), 9);
  assert.equal(C.levelForFile("noext", 1, true), 1);
});
test("levelForFile falls back to 6 on bad levels and honours Store", () => {
  assert.equal(C.levelForFile("a.txt", "x", false), 6);
  assert.equal(C.levelForFile("a.txt", 12, false), 6);
  assert.equal(C.levelForFile("a.txt", 0, false), 0);
});

// ---- safeEntryPath ----
test("safeEntryPath strips traversal and leading slashes", () => {
  assert.equal(C.safeEntryPath("../../etc/passwd"), "etc/passwd");
  assert.equal(C.safeEntryPath("/abs/file.txt"), "abs/file.txt");
  assert.equal(C.safeEntryPath("a/./b/../c.txt"), "a/b/c.txt");
});
test("safeEntryPath handles backslashes and drive letters", () => {
  assert.equal(C.safeEntryPath("C:\\Windows\\system32\\x.dll"), "Windows/system32/x.dll");
  assert.equal(C.safeEntryPath("..\\..\\boot.ini"), "boot.ini");
  assert.equal(C.safeEntryPath("\\\\server\\share\\f.txt"), "server/share/f.txt");
});
test("safeEntryPath removes control characters and returns empty when nothing is left", () => {
  assert.equal(C.safeEntryPath("a\u0000b\u001f/c\u007f.txt"), "ab/c.txt");
  assert.equal(C.safeEntryPath("../.."), "");
  assert.equal(C.safeEntryPath(""), "");
  assert.equal(C.safeEntryPath(null), "");
});
test("safeEntryPath leaves normal nested names unchanged", () => {
  assert.equal(C.safeEntryPath("docs/guide/readme.md"), "docs/guide/readme.md");
});

test("uniquePath renames duplicates before the extension", () => {
  const used = new Set();
  assert.equal(C.uniquePath(used, "a/b.txt"), "a/b.txt");
  assert.equal(C.uniquePath(used, "a/b.txt"), "a/b (2).txt");
  assert.equal(C.uniquePath(used, "a/b.txt"), "a/b (3).txt");
  assert.equal(C.uniquePath(used, "noext"), "noext");
  assert.equal(C.uniquePath(used, "noext"), "noext (2)");
});

// ---- limits ----
test("checkArchiveLimits accepts a normal archive", () => {
  const r = C.checkArchiveLimits([{ name: "a", size: 1000, compressedSize: 400 }, { name: "b", size: 50, compressedSize: 50 }]);
  assert.equal(r.ok, true);
  assert.equal(r.totalSize, 1050);
});
test("checkArchiveLimits refuses more than 20000 entries", () => {
  const many = Array.from({ length: 20001 }, (_, i) => ({ name: `f${i}`, size: 1, compressedSize: 1 }));
  const r = C.checkArchiveLimits(many);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "entries");
  assert.match(r.message, /20001/);
});
test("checkArchiveLimits refuses over 2 GB declared total", () => {
  const r = C.checkArchiveLimits([
    { name: "a", size: 1.2 * 1024 ** 3, compressedSize: 1.1 * 1024 ** 3 },
    { name: "b", size: 1.2 * 1024 ** 3, compressedSize: 1.1 * 1024 ** 3 },
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "size");
});
test("checkArchiveLimits refuses a 1000:1 entry over 100 MB but allows it when small", () => {
  const big = C.checkArchiveLimits([{ name: "bomb.bin", size: 150 * 1024 * 1024, compressedSize: 100 * 1024 }]);
  assert.equal(big.ok, false);
  assert.equal(big.reason, "ratio");
  assert.match(big.message, /bomb\.bin/);
  const small = C.checkArchiveLimits([{ name: "zeros", size: 50 * 1024 * 1024, compressedSize: 100 }]);
  assert.equal(small.ok, true);
});

// ---- names ----
test("defaultArchiveName uses the single top-level folder", () => {
  assert.equal(C.defaultArchiveName(["photos/a.jpg", "photos/sub/b.jpg"]), "photos");
});
test("defaultArchiveName falls back to archive", () => {
  assert.equal(C.defaultArchiveName(["a.txt", "b.txt"]), "archive");
  assert.equal(C.defaultArchiveName(["one/a.txt", "two/b.txt"]), "archive");
  assert.equal(C.defaultArchiveName(["one/a.txt", "root.txt"]), "archive");
  assert.equal(C.defaultArchiveName([]), "archive");
});
test("zipFileName sanitises and appends .zip once", () => {
  assert.equal(C.zipFileName("my docs.zip"), "my docs.zip");
  assert.equal(C.zipFileName("a/b:c"), "a-b-c.zip");
  assert.equal(C.zipFileName("   "), "archive.zip");
});
test("gzipName and gunzipName", () => {
  assert.equal(C.gzipName("report.txt"), "report.txt.gz");
  assert.equal(C.gzipName("dir/data.csv"), "data.csv.gz");
  assert.equal(C.gunzipName("report.txt.gz"), "report.txt");
  assert.equal(C.gunzipName("BACKUP.SQL.GZ"), "BACKUP.SQL");
  assert.equal(C.gunzipName("src.tgz"), "src.tar");
  assert.equal(C.gunzipName("mystery"), "mystery.out");
  assert.equal(C.gunzipName(".gz"), "file");
});
test("isGzipBytes checks the magic number", () => {
  assert.equal(C.isGzipBytes(new Uint8Array([0x1f, 0x8b, 8])), true);
  assert.equal(C.isGzipBytes(new Uint8Array([0x50, 0x4b])), false);
  assert.equal(C.isGzipBytes(new Uint8Array([0x1f])), false);
});

// ---- stats ----
test("savedPercent and ratioText", () => {
  assert.equal(C.savedPercent(1000, 250), 75);
  assert.equal(C.savedPercent(0, 0), 0);
  assert.equal(C.ratioText(1000, 250), "75.0% smaller");
  assert.equal(C.ratioText(100, 120), "20.0% larger");
  assert.equal(C.ratioText(0, 5), "-");
});

// ---- zip round trips with fflate ----
test("buildZipInput zip/unzip round trip keeps paths, data and mtime", () => {
  const mtime = new Date(2024, 4, 17, 10, 30, 0);
  const text = enc("hello hello hello hello hello hello");
  const input = C.buildZipInput(
    [
      { path: "dir/a.txt", data: text, mtime },
      { path: "pic.png", data: new Uint8Array([1, 2, 3, 4]), mtime },
    ],
    6,
    true
  );
  const zipped = fflate.zipSync(input);
  const list = C.readCentralDirectory(zipped);
  assert.deepEqual(list.map((e) => e.name), ["dir/a.txt", "pic.png"]);
  assert.equal(list[0].method, 8);
  assert.equal(list[1].method, 0, "png is stored");
  assert.equal(list[0].mtime.getFullYear(), 2024);
  assert.equal(list[0].mtime.getMonth(), 4);
  assert.equal(list[0].mtime.getDate(), 17);
  const back = fflate.unzipSync(zipped);
  assert.deepEqual(Array.from(back["dir/a.txt"]), Array.from(text));
});
test("buildZipInput sanitises and de-duplicates paths", () => {
  const input = C.buildZipInput(
    [
      { path: "../evil.txt", data: enc("a") },
      { path: "evil.txt", data: enc("b") },
      { path: "", data: enc("c") },
    ],
    6,
    false
  );
  assert.deepEqual(Object.keys(input), ["evil.txt", "evil (2).txt", "file-3"]);
});
test("readCentralDirectory reports sizes and directories", () => {
  const data = enc("x".repeat(5000));
  const zipped = fflate.zipSync({ "d/": [new Uint8Array(0), { level: 0 }], "d/big.txt": [data, { level: 9 }] });
  const list = C.readCentralDirectory(zipped);
  const big = list.find((e) => e.name === "d/big.txt");
  assert.equal(big.size, 5000);
  assert.ok(big.compressedSize < 100);
  assert.equal(big.encrypted, false);
  assert.equal(list.find((e) => e.name === "d/").isDir, true);
});
test("readCentralDirectory flags encrypted entries", () => {
  const zipped = fflate.zipSync({ "s.txt": enc("secret") });
  const dv = new DataView(zipped.buffer, zipped.byteOffset, zipped.byteLength);
  for (let i = 0; i < zipped.length - 4; i++) {
    if (dv.getUint32(i, true) === 0x02014b50) dv.setUint16(i + 8, dv.getUint16(i + 8, true) | 1, true);
  }
  assert.equal(C.readCentralDirectory(zipped)[0].encrypted, true);
});
test("readCentralDirectory rejects non-zip data", () => {
  assert.throws(() => C.readCentralDirectory(enc("this is definitely not a zip file at all")), /Not a valid ZIP/);
});
test("async fflate.zip result is readable by the core", async () => {
  const out = await new Promise((res, rej) =>
    fflate.zip(C.buildZipInput([{ path: "a.txt", data: enc("abc".repeat(100)) }], 6, true), (e, d) => (e ? rej(e) : res(d)))
  );
  assert.equal(C.readCentralDirectory(out)[0].name, "a.txt");
});

// ---- gzip round trip ----
test("gzip then gunzip restores the bytes", async () => {
  const src = enc("gzip me ".repeat(500));
  const gz = fflate.gzipSync(src, { level: 9 });
  assert.equal(C.isGzipBytes(gz), true);
  assert.ok(gz.length < src.length);
  assert.deepEqual(Array.from(fflate.gunzipSync(gz)), Array.from(src));
});

// ---- hashing ----
test("normalizeHash lowercases and removes whitespace", () => {
  assert.equal(C.normalizeHash("  AB cd\n EF\t12 "), "abcdef12");
  assert.equal(C.normalizeHash(null), "");
});
test("hashesMatch is case and whitespace insensitive and rejects empty", () => {
  assert.equal(C.hashesMatch("D41D8CD98F00B204E9800998ECF8427E", " d41d8cd9 8f00b204e9800998ecf8427e "), true);
  assert.equal(C.hashesMatch("", ""), false);
  assert.equal(C.hashesMatch("abc", "abd"), false);
});
test("toHex is lowercase and zero padded", () => {
  assert.equal(C.toHex(new Uint8Array([0, 15, 16, 255])), "000f10ff");
});

const RFC1321 = [
  ["", "d41d8cd98f00b204e9800998ecf8427e"],
  ["a", "0cc175b9c0f1b6a831c399e269772661"],
  ["abc", "900150983cd24fb0d6963f7d28e17f72"],
  ["message digest", "f96b697d7cb7938d525a2f31aaf161d0"],
  ["abcdefghijklmnopqrstuvwxyz", "c3fcd3d76192e4007dfb496cca67e13b"],
  ["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", "d174ab98d277d9f5a5611c2c9f419d9f"],
  ["12345678901234567890123456789012345678901234567890123456789012345678901234567890", "57edf4a22be3c955ac49da2e2107b67a"],
];
test("MD5 passes the RFC 1321 test vectors", () => {
  for (const [input, expected] of RFC1321) assert.equal(C.md5Hex(enc(input)), expected, JSON.stringify(input));
});
test("MD5 incremental chunks match one-shot for every split size", () => {
  const data = crypto.randomBytes(1000);
  const expected = crypto.createHash("md5").update(data).digest("hex");
  for (const step of [1, 7, 55, 56, 63, 64, 65, 128, 333, 1000]) {
    const h = C.createMD5();
    for (let i = 0; i < data.length; i += step) h.update(data.subarray(i, i + step));
    assert.equal(h.digest(), expected, `step ${step}`);
  }
});
test("MD5 matches node crypto around padding boundaries and for one million a", () => {
  for (const n of [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 121]) {
    const data = crypto.randomBytes(n);
    assert.equal(C.md5Hex(data), crypto.createHash("md5").update(data).digest("hex"), `len ${n}`);
  }
  const million = new Uint8Array(1000000).fill(97);
  assert.equal(C.md5Hex(million), "7707d6ae4e027c70eea2a935c2296f21");
});
test("MD5 digest is stable when called twice and update after digest throws", () => {
  const h = C.createMD5();
  h.update(enc("abc"));
  assert.equal(h.digest(), "900150983cd24fb0d6963f7d28e17f72");
  assert.equal(h.digest(), "900150983cd24fb0d6963f7d28e17f72");
  assert.throws(() => h.update(enc("x")));
});
