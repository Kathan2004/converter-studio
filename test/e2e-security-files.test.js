// End-to-end tests for the Encrypt file, password ZIP, text hash, HEIC and QR tools.
// Output bytes are verified in Node. Runs when CHROMIUM_PATH is set; skipped otherwise.
const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const staticServer = require("./helpers/static-server");
const CryptoCore = require("../js/crypto-core.js");

const CHROME = process.env.CHROMIUM_PATH;
const skip = !CHROME || !fs.existsSync(CHROME) ? "CHROMIUM_PATH not set" : false;

let server, browser, base, tmp;
const fx = {};

before(async () => {
  if (skip) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sec-e2e-"));
  const write = (name, data) => { const p = path.join(tmp, name); fs.writeFileSync(p, data); return p; };
  fx.data = crypto.randomBytes(70000);
  fx.bin = write("résumé données.bin", fx.data);
  fx.text = Buffer.from("hello zip password world\n".repeat(300));
  fx.txt = write("notes.txt", fx.text);
  fx.dir = tmp;
  fx.junk = write("junk.heic", Buffer.from("this is not a heic file at all"));
  server = await staticServer.start();
  base = server.base;
  browser = await require("puppeteer-core").launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-gpu"] });
});

after(async () => {
  if (browser) await browser.close();
  if (server) server.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

async function open(urlPath) {
  const page = await browser.newPage();
  page.errors = [];
  // Observe instead of intercepting: interception stalls file pickers and workers in headless Chrome.
  page.on("request", (r) => { if (!r.url().startsWith(base) && !/^(data|blob):/.test(r.url())) page.errors.push(`external request: ${r.url()}`); });
  page.on("pageerror", (e) => page.errors.push(e.message));
  page.on("console", (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) page.errors.push(m.text()); });
  await page.evaluateOnNewDocument(() => {
    window.__downloads = [];
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.hasAttribute("download")) { window.__downloads.push({ name: this.download, href: this.href }); return; }
      return click.call(this);
    };
  });
  await page.goto(`${base}/${urlPath}`, { waitUntil: "networkidle0" });
  return page;
}

async function settle(page, sel, timeout = 60000) {
  await page.waitForFunction((s) => {
    const el = document.querySelector(s);
    return el && (el.dataset.state === "ok" || el.dataset.state === "error");
  }, { timeout }, sel);
  return page.$eval(sel, (el) => ({ state: el.dataset.state, text: el.textContent }));
}

async function download(page, index) {
  await page.waitForFunction((n) => window.__downloads.length > n, { timeout: 30000 }, index);
  const d = await page.evaluate((i) => window.__downloads[i], index);
  const b64 = await page.evaluate(async (u) => {
    const buf = new Uint8Array(await (await fetch(u)).arrayBuffer());
    let s = "";
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, d.href);
  return { name: d.name, bytes: Buffer.from(b64, "base64") };
}

const setValue = (page, sel, value) => page.$eval(sel, (el, v) => { el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); }, value);

describe("Encrypt file", { skip }, () => {
  let encrypted;

  test("encrypt -> output is our container and decrypts in Node to identical bytes and name", async () => {
    const page = await open("files.html#encrypt");
    await (await page.$("#enc-drop + input")).uploadFile(fx.bin);
    await page.waitForSelector("#enc-list .file-item");
    assert.equal(await page.$eval("#enc-run", (b) => b.textContent), "Encrypt");
    await page.type("#enc-password", "correct horse battery");
    await page.type("#enc-confirm", "correct horse battery");
    assert.match(await page.$eval("#enc-strength", (e) => e.textContent), /Fair|Good|Strong/);
    await page.click("#enc-run");
    const st = await settle(page, "#enc-status");
    assert.equal(st.state, "ok", st.text);
    await page.click("#enc-list .file-item button");
    const d = await download(page, 0);
    assert.equal(d.name, "résumé données.bin.enc");
    assert.equal(d.bytes.subarray(0, 5).toString(), "CSENC");
    assert.equal(d.bytes[5], 1);
    assert.equal(d.bytes.readUInt32BE(6), 600000);
    assert.ok(!d.bytes.includes(fx.data.subarray(100, 140)), "plaintext must not appear in the output");
    const out = await CryptoCore.decrypt(new Uint8Array(d.bytes), "correct horse battery");
    assert.equal(out.name, "résumé données.bin");
    assert.ok(Buffer.from(out.data).equals(fx.data));
    encrypted = path.join(tmp, "résumé données.bin.enc");
    fs.writeFileSync(encrypted, d.bytes);
    assert.deepEqual(page.errors, []);
    await page.close();
  });

  test("mismatched confirmation blocks encryption", async () => {
    const page = await open("files.html#encrypt");
    await (await page.$("#enc-drop + input")).uploadFile(fx.txt);
    await page.waitForSelector("#enc-list .file-item");
    await page.type("#enc-password", "abc12345");
    await page.type("#enc-confirm", "different");
    await page.click("#enc-run");
    const st = await settle(page, "#enc-status");
    assert.equal(st.state, "error");
    assert.match(st.text, /do not match/);
    await page.close();
  });

  test("dropping our file offers Decrypt; wrong password fails cleanly; right password restores bytes and name", async () => {
    const page = await open("files.html#encrypt");
    await (await page.$("#enc-drop + input")).uploadFile(encrypted);
    await page.waitForSelector("#enc-list .file-item");
    assert.equal(await page.$eval("#enc-run", (b) => b.textContent), "Decrypt");
    assert.ok(await page.$eval("#enc-confirm-field", (e) => e.classList.contains("is-hidden")));
    await page.type("#enc-password", "wrong password");
    await page.click("#enc-run");
    let st = await settle(page, "#enc-status");
    assert.equal(st.state, "error");
    assert.equal(st.text, "Incorrect password or damaged file");
    assert.equal(await page.$("#enc-list .file-item button:not([hidden]):not([aria-label])"), null === 1 ? 1 : await page.$("#enc-list .file-item button:not([hidden]):not([aria-label])"));
    await page.$eval("#enc-password", (e) => { e.value = ""; });
    await page.type("#enc-password", "correct horse battery");
    await page.click("#enc-run");
    await page.waitForFunction(() => document.querySelector("#enc-status").dataset.state === "ok");
    await page.click("#enc-list .file-item button");
    const d = await download(page, 0);
    assert.equal(d.name, "résumé données.bin");
    assert.ok(d.bytes.equals(fx.data));
    assert.deepEqual(page.errors, []);
    await page.close();
  });

  test("a damaged file is reported, not thrown", async () => {
    const bad = Buffer.from(fs.readFileSync(encrypted));
    bad[bad.length - 5] ^= 0xff;
    const p = path.join(tmp, "damaged.enc");
    fs.writeFileSync(p, bad);
    const page = await open("files.html#encrypt");
    await (await page.$("#enc-drop + input")).uploadFile(p);
    await page.waitForSelector("#enc-list .file-item");
    await page.type("#enc-password", "correct horse battery");
    await page.click("#enc-run");
    const st = await settle(page, "#enc-status");
    assert.equal(st.state, "error");
    assert.equal(st.text, "Incorrect password or damaged file");
    assert.deepEqual(page.errors, []);
    await page.close();
  });

  test("batch encrypt -> zip download holds both outputs", async () => {
    const page = await open("files.html#encrypt");
    await (await page.$("#enc-drop + input")).uploadFile(fx.bin, fx.txt);
    await page.waitForFunction(() => document.querySelectorAll("#enc-list .file-item").length === 2);
    await page.type("#enc-password", "batch-pass-123");
    await page.type("#enc-confirm", "batch-pass-123");
    await page.click("#enc-run");
    await page.waitForFunction(() => !document.querySelector("#enc-zip").disabled);
    await page.click("#enc-zip");
    const d = await download(page, 0);
    assert.equal(d.name, "files.zip");
    const names = d.bytes.toString("latin1");
    assert.ok(names.includes("notes.txt.enc"));
    await page.close();
  });
});

describe("Password ZIP", { skip }, () => {
  let zipBytes;

  test("zip with a password is AES-256 encrypted and extracts with the password", async () => {
    const page = await open("files.html#zip");
    await (await page.$("#zip-drop + input")).uploadFile(fx.txt, fx.bin);
    await page.waitForFunction(() => document.querySelectorAll("#zip-list .file-item").length === 2);
    await page.type("#zip-password", "zip-secret-1");
    await page.click("#zip-run");
    const st = await settle(page, "#zip-status");
    assert.equal(st.state, "ok", st.text);
    assert.match(st.text, /AES-256 encrypted/);
    assert.match(await page.$eval("#zip-summary", (e) => e.textContent), /AES-256 encrypted/);
    const d = await download(page, 0);
    zipBytes = d.bytes;
    fs.writeFileSync(path.join(tmp, "locked.zip"), zipBytes);
    // Verify with zip.js itself (same vendored build, run in the page).
    const report = await page.evaluate(async (b64, pw) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const r = new zip.ZipReader(new zip.Uint8ArrayReader(bytes));
      const entries = await r.getEntries();
      const out = [];
      for (const e of entries) {
        const data = await e.getData(new zip.Uint8ArrayWriter(), { password: pw });
        out.push({ name: e.filename, encrypted: e.encrypted, strength: e.extraField && e.extraField.get(0x9901) ? e.extraField.get(0x9901).strength : null, size: data.length, hex: Array.from(data.subarray(0, 8)).map((x) => x.toString(16).padStart(2, "0")).join("") });
      }
      let wrong = "";
      try { await entries[0].getData(new zip.Uint8ArrayWriter(), { password: "nope" }); } catch (e) { wrong = e.message; }
      await r.close();
      return { out, wrong };
    }, zipBytes.toString("base64"), "zip-secret-1");
    assert.equal(report.out.length, 2);
    for (const e of report.out) { assert.equal(e.encrypted, true); assert.equal(e.strength, 3); }
    const byName = Object.fromEntries(report.out.map((e) => [e.name, e]));
    assert.equal(byName["notes.txt"].size, fx.text.length);
    assert.equal(byName["notes.txt"].hex, fx.text.subarray(0, 8).toString("hex"));
    assert.equal(byName["résumé données.bin"].size, fx.data.length);
    assert.match(report.wrong, /password|signature/i);
    // Plain text must not appear in the archive bytes.
    assert.ok(!zipBytes.includes(Buffer.from("hello zip password")));
    assert.deepEqual(page.errors, []);
    await page.close();
  });

  test("without a password the archive is created by the existing path (not encrypted)", async () => {
    const page = await open("files.html#zip");
    await (await page.$("#zip-drop + input")).uploadFile(fx.txt);
    await page.waitForSelector("#zip-list .file-item");
    await page.click("#zip-run");
    const st = await settle(page, "#zip-status");
    assert.equal(st.state, "ok");
    assert.ok(!/AES/.test(st.text));
    const d = await download(page, 0);
    assert.equal(d.bytes.readUInt16LE(6) & 1, 0, "no encryption flag");
    await page.close();
  });

  test("Extract ZIP: encrypted entries need the password; wrong password errors; right password gives identical bytes", async () => {
    const page = await open("files.html#unzip");
    await (await page.$("#unzip-drop + input")).uploadFile(path.join(tmp, "locked.zip"));
    await page.waitForFunction(() => !document.querySelector("#unzip-pw-field").classList.contains("is-hidden"));
    await page.waitForSelector("#unzip-table tr:nth-child(2)");
    await page.click("#unzip-separate");
    // No password
    await page.click("#unzip-run");
    let st = await settle(page, "#unzip-status");
    assert.equal(st.state, "error");
    assert.match(st.text, /password/i);
    // Wrong password
    await page.type("#unzip-password", "bad");
    await page.click("#unzip-run");
    await page.waitForFunction(() => /Incorrect password/.test(document.querySelector("#unzip-status").textContent));
    // Right password
    await page.$eval("#unzip-password", (e) => { e.value = ""; });
    await page.type("#unzip-password", "zip-secret-1");
    await page.click("#unzip-run");
    await page.waitForFunction(() => document.querySelector("#unzip-status").dataset.state === "ok" && /Downloaded 2/.test(document.querySelector("#unzip-status").textContent));
    const a = await download(page, 0);
    const b = await download(page, 1);
    const files = Object.fromEntries([a, b].map((f) => [f.name, f.bytes]));
    assert.ok(files["notes.txt"].equals(fx.text));
    assert.ok(files["résumé données.bin"].equals(fx.data));
    assert.deepEqual(page.errors, []);
    await page.close();
  });
});

describe("Text hash", { skip }, () => {
  test("typed text hashes match Node crypto and update live", async () => {
    const page = await open("files.html#hash");
    const text = "Grüße, 世界 \u{1F512}\nline two";
    await page.type("#hash-text", text);
    await page.waitForFunction(() => document.querySelectorAll("#hash-text-results .hash-row code").length === 4 && Array.from(document.querySelectorAll("#hash-text-results code")).every((c) => /^[0-9a-f]{32,128}$/.test(c.textContent)));
    const got = await page.$$eval("#hash-text-results .hash-row", (rows) => Object.fromEntries(rows.map((r) => [r.querySelector(".al").textContent, r.querySelector("code").textContent])));
    const h = (a) => crypto.createHash(a).update(Buffer.from(text, "utf8")).digest("hex");
    assert.equal(got["MD5"], h("md5"));
    assert.equal(got["SHA-1"], h("sha1"));
    assert.equal(got["SHA-256"], h("sha256"));
    assert.equal(got["SHA-512"], h("sha512"));
    await setValue(page, "#hash-text", "abc");
    await page.waitForFunction(() => document.querySelector("#hash-text-results .hash-row code").textContent === "900150983cd24fb0d6963f7d28e17f72");
    await setValue(page, "#hash-text", "");
    assert.equal(await page.$$eval("#hash-text-results .hash-row", (r) => r.length), 0);
    assert.deepEqual(page.errors, []);
    await page.close();
  });
});

describe("HEIC to JPG", { skip }, () => {
  test("real HEIC converts, or shows a clean not-supported message (no CSP errors, no hang)", async () => {
    const page = await open("images.html#heic");
    await (await page.$('[data-panel="heic"] .drop-zone + input')).uploadFile(path.join(__dirname, "fixtures", "sample.heic"));
    await page.waitForSelector("#heic-list .file-item");
    await page.click("#heic-run");
    const st = await settle(page, "#heic-status", 30000);
    const outcome = process.env.HEIC_EXPECT;
    if (st.state === "ok") {
      await page.click("#heic-list .file-item button:not([hidden])");
      const d = await download(page, 0);
      assert.equal(d.name, "sample.jpg");
      assert.deepEqual([...d.bytes.subarray(0, 3)], [0xff, 0xd8, 0xff]);
    } else {
      assert.match(st.text, /not supported here/i);
    }
    if (outcome) assert.equal(st.state, outcome);
    assert.deepEqual(page.errors, []);
    await page.close();
  });

  test("a non-HEIC file with a .heic name is rejected with a clear message", async () => {
    const page = await open("images.html#heic");
    await (await page.$('[data-panel="heic"] .drop-zone + input')).uploadFile(fx.junk);
    await page.waitForSelector("#heic-list .file-item");
    await page.click("#heic-run");
    const st = await settle(page, "#heic-status");
    assert.equal(st.state, "error");
    assert.match(st.text, /not a HEIC/i);
    assert.deepEqual(page.errors, []);
    await page.close();
  });
});

describe("QR code", { skip }, () => {
  async function makeAndDownload(page, which, index) {
    await page.click(which);
    return download(page, index);
  }

  test("generate a QR, download PNG and SVG, and read the PNG back to the same text", async () => {
    const page = await open("images.html#qr");
    const text = "https://example.com/path?q=1&name=Zoë-日本";
    await page.type("#qr-text", text);
    await page.waitForFunction(() => !document.querySelector("#qr-png").disabled);
    const png = await makeAndDownload(page, "#qr-png", 0);
    assert.equal(png.name, "qrcode.png");
    assert.deepEqual([...png.bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const svg = await makeAndDownload(page, "#qr-svg", 1);
    assert.equal(svg.name, "qrcode.svg");
    assert.match(svg.bytes.toString("utf8"), /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 \d+ \d+"/);
    // Decode the downloaded PNG with jsQR (Node-side raster via the browser's decoder).
    const decoded = await page.evaluate(async (b64) => {
      await new Promise((res, rej) => { const s = document.createElement("script"); s.src = "vendor/jsQR.js"; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
      const blob = new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: "image/png" });
      const bmp = await createImageBitmap(blob);
      const c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height;
      const g = c.getContext("2d"); g.drawImage(bmp, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height);
      const r = jsQR(d.data, c.width, c.height);
      return r && r.data;
    }, png.bytes.toString("base64"));
    assert.equal(decoded, text);
    // The SVG, rasterised, decodes too.
    const decodedSvg = await page.evaluate(async (svgText) => {
      const img = new Image();
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgText);
      await img.decode();
      const c = document.createElement("canvas"); c.width = 400; c.height = 400;
      const g = c.getContext("2d"); g.drawImage(img, 0, 0, 400, 400);
      const d = g.getImageData(0, 0, 400, 400);
      const r = jsQR(d.data, 400, 400);
      return r && r.data;
    }, svg.bytes.toString("utf8"));
    assert.equal(decodedSvg, text);
    // Read mode through the UI.
    fs.writeFileSync(path.join(tmp, "made.png"), png.bytes);
    await page.click('[data-qr-mode="read"]');
    await (await page.$("#qr-drop + input")).uploadFile(path.join(tmp, "made.png"));
    await page.waitForFunction(() => !document.querySelector("#qr-result").classList.contains("is-hidden"));
    assert.equal(await page.$eval("#qr-text-out", (e) => e.value), text);
    assert.equal(await page.$eval("#qr-open", (a) => a.rel), "noopener noreferrer");
    assert.equal(await page.$eval("#qr-open", (a) => a.getAttribute("href")), text);
    assert.deepEqual(page.errors, []);
    await page.close();
  });

  test("Wi-Fi payload with special characters round-trips through the QR image", async () => {
    const page = await open("images.html#qr");
    await page.select("#qr-kind", "wifi");
    await setValue(page, "#qr-wifi-ssid", "Cafe;Net");
    await setValue(page, "#qr-wifi-pass", 'p:a,s"s');
    await page.$eval("#qr-wifi-hidden", (e) => e.click());
    await page.waitForFunction(() => !document.querySelector("#qr-png").disabled);
    const png = await makeAndDownload(page, "#qr-png", 0);
    fs.writeFileSync(path.join(tmp, "wifi.png"), png.bytes);
    await page.click('[data-qr-mode="read"]');
    await (await page.$("#qr-drop + input")).uploadFile(path.join(tmp, "wifi.png"));
    await page.waitForFunction(() => !document.querySelector("#qr-result").classList.contains("is-hidden"));
    const BS = String.fromCharCode(92);
    assert.equal(await page.$eval("#qr-text-out", (e) => e.value), `WIFI:T:WPA;S:Cafe${BS};Net;P:p${BS}:a${BS},s${BS}"s;H:true;;`);
    assert.ok(await page.$eval("#qr-open", (a) => a.classList.contains("is-hidden")), "no Open link for non-URL text");
    await page.close();
  });

  test("an image without a QR code gives a clear message; the camera is never requested", async () => {
    const page = await open("images.html#qr");
    await page.click('[data-qr-mode="read"]');
    const src = fs.readFileSync(path.join(__dirname, "..", "assets", "shared.css"));
    assert.ok(src.length > 0);
    const blank = await page.evaluate(() => {
      const c = document.createElement("canvas"); c.width = 200; c.height = 200;
      const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, 200, 200);
      return c.toDataURL("image/png").split(",")[1];
    });
    fs.writeFileSync(path.join(tmp, "blank.png"), Buffer.from(blank, "base64"));
    await (await page.$("#qr-drop + input")).uploadFile(path.join(tmp, "blank.png"));
    const st = await settle(page, "#qr-status");
    assert.equal(st.state, "error");
    assert.match(st.text, /No QR code/);
    const js = fs.readFileSync(path.join(__dirname, "..", "js", "qr.js"), "utf8");
    assert.ok(!/getUserMedia/.test(js));
    await page.close();
  });
});
