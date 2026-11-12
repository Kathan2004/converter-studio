/*
 * Password encryption for the Encrypt file tool. Web Crypto only; no DOM access.
 *
 * Container format (version 1), all integers big-endian:
 *   offset  size  field
 *   0       5     magic "CSENC"
 *   5       1     format version (1)
 *   6       4     PBKDF2-SHA-256 iteration count (uint32)
 *   10      16    random salt
 *   26      12    random AES-GCM IV
 *   38      ...   AES-256-GCM ciphertext followed by the 16-byte tag
 * The first 38 bytes (the header) are bound to the ciphertext as GCM additional data.
 * The decrypted plaintext is: uint16 filename length + UTF-8 original filename + file bytes.
 * Key: PBKDF2-SHA-256(password as UTF-8, salt, iterations) -> 256-bit AES key.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CryptoCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MAGIC = [0x43, 0x53, 0x45, 0x4e, 0x43]; // "CSENC"
  const VERSION = 1;
  const ITERATIONS = 600000;
  const MIN_ITERATIONS = 100000;
  const MAX_ITERATIONS = 10000000;
  const SALT_LEN = 16;
  const IV_LEN = 12;
  const HEADER_LEN = 5 + 1 + 4 + SALT_LEN + IV_LEN;
  const TAG_LEN = 16;
  const MAX_BYTES = 1024 * 1024 * 1024; // 1 GB per file

  class CryptoError extends Error {
    constructor(code, message) { super(message); this.name = "CryptoError"; this.code = code; }
  }

  const subtle = () => {
    const c = globalThis.crypto;
    if (!c || !c.subtle) throw new CryptoError("UNSUPPORTED", "Encryption needs a secure (https) page.");
    return c;
  };

  function hasMagic(bytes) {
    if (!bytes || bytes.length < MAGIC.length) return false;
    for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC[i]) return false;
    return true;
  }

  /** Returns { version, iterations, salt, iv } or null when the bytes are not one of our containers. */
  function parseHeader(bytes) {
    if (!hasMagic(bytes) || bytes.length < 6) return null;
    const version = bytes[5];
    if (version !== VERSION) return { version, iterations: 0, salt: null, iv: null, supported: false };
    if (bytes.length < HEADER_LEN) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
      version,
      supported: true,
      iterations: view.getUint32(6, false),
      salt: bytes.slice(10, 10 + SALT_LEN),
      iv: bytes.slice(10 + SALT_LEN, HEADER_LEN),
    };
  }

  const isEncrypted = (bytes) => { const h = parseHeader(bytes); return Boolean(h && h.supported); };

  async function deriveKey(password, salt, iterations) {
    const c = subtle();
    const base = await c.subtle.importKey("raw", new TextEncoder().encode(String(password)), "PBKDF2", false, ["deriveKey"]);
    return c.subtle.deriveKey(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  }

  /** Strip path parts and control characters from a filename read out of an untrusted container. */
  function sanitizeName(name) {
    const cleaned = String(name || "").split(/[\\/]/).pop().replace(/[\u0000-\u001f:*?"<>|]+/g, "-").replace(/^\.+/, "").trim();
    return cleaned.slice(0, 200) || "decrypted-file";
  }

  /** Encrypt `data` (Uint8Array) under `password`; `name` is stored inside and restored on decrypt. */
  async function encrypt(data, name, password, opts) {
    const iterations = (opts && opts.iterations) || ITERATIONS;
    if (!password) throw new CryptoError("PASSWORD", "Enter a password.");
    if (data.length > MAX_BYTES) throw new CryptoError("TOOBIG", "Files over 1 GB are not supported.");
    const nameBytes = new TextEncoder().encode(String(name || "file"));
    if (nameBytes.length > 0xffff) throw new CryptoError("NAME", "The file name is too long.");
    const c = subtle();
    const salt = c.getRandomValues(new Uint8Array(SALT_LEN));
    const iv = c.getRandomValues(new Uint8Array(IV_LEN));
    const header = new Uint8Array(HEADER_LEN);
    header.set(MAGIC, 0);
    header[5] = VERSION;
    new DataView(header.buffer).setUint32(6, iterations, false);
    header.set(salt, 10);
    header.set(iv, 10 + SALT_LEN);

    const plain = new Uint8Array(2 + nameBytes.length + data.length);
    new DataView(plain.buffer).setUint16(0, nameBytes.length, false);
    plain.set(nameBytes, 2);
    plain.set(data, 2 + nameBytes.length);

    const key = await deriveKey(password, salt, iterations);
    const ct = new Uint8Array(await c.subtle.encrypt({ name: "AES-GCM", iv, additionalData: header, tagLength: 128 }, key, plain));
    const out = new Uint8Array(HEADER_LEN + ct.length);
    out.set(header, 0);
    out.set(ct, HEADER_LEN);
    return out;
  }

  /** Returns { name, data }. Throws CryptoError with code FORMAT, VERSION, BADPASS or PASSWORD. */
  async function decrypt(bytes, password) {
    const h = parseHeader(bytes);
    if (!h) throw new CryptoError("FORMAT", "This is not a file encrypted by this tool.");
    if (!h.supported) throw new CryptoError("VERSION", `Unsupported format version ${h.version}.`);
    if (!password) throw new CryptoError("PASSWORD", "Enter a password.");
    if (h.iterations < MIN_ITERATIONS || h.iterations > MAX_ITERATIONS) throw new CryptoError("FORMAT", "The file header is damaged.");
    if (bytes.length < HEADER_LEN + TAG_LEN + 2) throw new CryptoError("BADPASS", "Incorrect password or damaged file");
    const c = subtle();
    const key = await deriveKey(password, h.salt, h.iterations);
    let plain;
    try {
      plain = new Uint8Array(await c.subtle.decrypt(
        { name: "AES-GCM", iv: h.iv, additionalData: bytes.slice(0, HEADER_LEN), tagLength: 128 },
        key,
        bytes.subarray(HEADER_LEN),
      ));
    } catch (e) {
      throw new CryptoError("BADPASS", "Incorrect password or damaged file");
    }
    const nameLen = new DataView(plain.buffer, plain.byteOffset, plain.byteLength).getUint16(0, false);
    if (2 + nameLen > plain.length) throw new CryptoError("BADPASS", "Incorrect password or damaged file");
    const name = sanitizeName(new TextDecoder().decode(plain.subarray(2, 2 + nameLen)));
    return { name, data: plain.slice(2 + nameLen) };
  }

  /** Rough strength estimate for the UI label: { score 0-3, label }. */
  function passwordStrength(pw) {
    const s = String(pw || "");
    if (!s) return { score: 0, label: "" };
    let classes = 0;
    if (/[a-z]/.test(s)) classes++;
    if (/[A-Z]/.test(s)) classes++;
    if (/[0-9]/.test(s)) classes++;
    if (/[^A-Za-z0-9]/.test(s)) classes++;
    const unique = new Set(s).size;
    const bits = Math.log2(Math.max(2, [26, 52, 62, 94][Math.max(0, classes - 1)])) * Math.min(s.length, unique * 2);
    if (s.length < 8 || bits < 40) return { score: 0, label: "Weak" };
    if (bits < 60) return { score: 1, label: "Fair" };
    if (bits < 85) return { score: 2, label: "Good" };
    return { score: 3, label: "Strong" };
  }

  function encryptedName(name) { return `${name}.enc`; }

  return { MAGIC, VERSION, ITERATIONS, HEADER_LEN, MAX_BYTES, CryptoError, parseHeader, isEncrypted, encrypt, decrypt, sanitizeName, passwordStrength, encryptedName };
});
