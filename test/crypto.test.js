const { test } = require("node:test");
const assert = require("node:assert/strict");
const C = require("../js/crypto-core.js");

const FAST = { iterations: 100000 };
const bytes = (s) => new TextEncoder().encode(s);

test("round trip restores bytes and name", async () => {
  const data = crypto.getRandomValues(new Uint8Array(5000));
  const enc = await C.encrypt(data, "report.pdf", "correct horse", FAST);
  assert.notDeepEqual(enc.slice(C.HEADER_LEN, C.HEADER_LEN + 20), data.slice(0, 20));
  const out = await C.decrypt(enc, "correct horse");
  assert.equal(out.name, "report.pdf");
  assert.deepEqual(Buffer.from(out.data), Buffer.from(data));
});

test("empty file round trips", async () => {
  const out = await C.decrypt(await C.encrypt(new Uint8Array(0), "e.txt", "pw", FAST), "pw");
  assert.equal(out.data.length, 0);
  assert.equal(out.name, "e.txt");
});

test("wrong password gives the friendly error", async () => {
  const enc = await C.encrypt(bytes("secret"), "a.txt", "right", FAST);
  await assert.rejects(() => C.decrypt(enc, "wrong"), (e) => e.code === "BADPASS" && e.message === "Incorrect password or damaged file");
});

test("a tampered byte is detected (ciphertext, header and tag)", async () => {
  const enc = await C.encrypt(bytes("secret data here"), "a.txt", "pw", FAST);
  for (const idx of [C.HEADER_LEN + 3, enc.length - 1, 12, 30]) {
    const bad = enc.slice();
    bad[idx] ^= 1;
    await assert.rejects(() => C.decrypt(bad, "pw"), (e) => e instanceof C.CryptoError);
  }
});

test("header parsing and default parameters", async () => {
  const enc = await C.encrypt(bytes("x"), "x", "pw");
  const h = C.parseHeader(enc);
  assert.equal(h.version, 1);
  assert.equal(h.iterations, 600000);
  assert.equal(h.salt.length, 16);
  assert.equal(h.iv.length, 12);
  assert.equal(Buffer.from(enc.subarray(0, 5)).toString(), "CSENC");
  assert.equal(enc.length, 38 + 2 + 1 + 1 + 16);
  assert.ok(C.isEncrypted(enc));
  assert.equal(C.parseHeader(bytes("hello world, plain")), null);
  assert.equal(C.parseHeader(new Uint8Array(0)), null);
  assert.equal(C.isEncrypted(enc.subarray(0, 20)), false);
});

test("salt and iv are random per encryption", async () => {
  const a = await C.encrypt(bytes("same"), "n", "pw", FAST);
  const b = await C.encrypt(bytes("same"), "n", "pw", FAST);
  assert.notDeepEqual(a.slice(10, 38), b.slice(10, 38));
});

test("unicode filenames survive", async () => {
  const name = "résumé 日本語 🔒.txt";
  const out = await C.decrypt(await C.encrypt(bytes("hi"), name, "pässwörd", FAST), "pässwörd");
  assert.equal(out.name, name);
});

test("unknown version is refused", async () => {
  const enc = await C.encrypt(bytes("x"), "x", "pw", FAST);
  enc[5] = 2;
  assert.equal(C.isEncrypted(enc), false);
  await assert.rejects(() => C.decrypt(enc, "pw"), (e) => e.code === "VERSION");
});

test("non-container input is refused", async () => {
  await assert.rejects(() => C.decrypt(bytes("plain text file"), "pw"), (e) => e.code === "FORMAT");
});

test("absurd iteration counts in the header are refused", async () => {
  const enc = await C.encrypt(bytes("x"), "x", "pw", FAST);
  new DataView(enc.buffer).setUint32(6, 0xffffffff, false);
  await assert.rejects(() => C.decrypt(enc, "pw"), (e) => e.code === "FORMAT");
});

test("stored names are sanitised on decrypt", () => {
  assert.equal(C.sanitizeName("../../etc/passwd"), "passwd");
  assert.equal(C.sanitizeName("a\\b\\c.txt"), "c.txt");
  assert.equal(C.sanitizeName(""), "decrypted-file");
});

test("empty password and strength labels", async () => {
  await assert.rejects(() => C.encrypt(bytes("x"), "x", ""), (e) => e.code === "PASSWORD");
  assert.equal(C.passwordStrength("").label, "");
  assert.equal(C.passwordStrength("abc").label, "Weak");
  assert.equal(C.passwordStrength("Tr0ub4dor&3xK9!pq").label, "Strong");
  assert.equal(C.encryptedName("a.txt"), "a.txt.enc");
});
