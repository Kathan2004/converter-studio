// Functional end-to-end tests for images.html: run each tool in headless Chromium and
// verify the produced bytes (signatures, dimensions, metadata removal).
// Runs when CHROMIUM_PATH points to Chrome/Chromium (set in CI); skipped otherwise.
const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const staticServer = require("./helpers/static-server");

const CHROME = process.env.CHROMIUM_PATH;
const skip = !CHROME || !fs.existsSync(CHROME) ? "CHROMIUM_PATH not set" : false;

let server, browser, base, tmp;
const fx = {};

function crc32(buf) {
  let c = ~0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function makePng(w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = y * (w * 3 + 1) + 1 + x * 3;
    raw[o] = (x * 255) / w; raw[o + 1] = (y * 255) / h; raw[o + 2] = (x * y) % 255;
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("tEXt", Buffer.from("Author\0Secret Person")),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
/** Big-endian EXIF APP1 with Make="Canon" and a GPS IFD (GPSLatitudeRef = N). */
function exifApp1() {
  const tiff = Buffer.alloc(56);
  tiff.write("MM", 0, "latin1"); tiff.writeUInt16BE(42, 2); tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(2, 8);
  tiff.writeUInt16BE(0x010f, 10); tiff.writeUInt16BE(2, 12); tiff.writeUInt32BE(6, 14); tiff.writeUInt32BE(38, 18);
  tiff.writeUInt16BE(0x8825, 22); tiff.writeUInt16BE(4, 24); tiff.writeUInt32BE(1, 26); tiff.writeUInt32BE(44, 30);
  tiff.writeUInt32BE(0, 34);
  tiff.write("Canon\0", 38, "latin1");
  tiff.writeUInt16BE(1, 44);
  tiff.writeUInt16BE(0x0001, 46); tiff.writeUInt16BE(2, 48); tiff.writeUInt32BE(2, 50); tiff.write("N\0", 54, "latin1");
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff, Buffer.alloc(4)]);
  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}
function pngDims(b) { return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; }

before(async () => {
  if (skip) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "img-e2e-"));
  fx.png = path.join(tmp, "photo.png");
  fs.writeFileSync(fx.png, makePng(320, 200));

  server = await staticServer.start();
  base = server.base;
  browser = await require("puppeteer-core").launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-gpu"] });

  // Build a real JPEG with the browser's encoder, then splice an EXIF/GPS segment after SOI.
  const page = await browser.newPage();
  const b64 = await page.evaluate(async () => {
    const c = document.createElement("canvas"); c.width = 240; c.height = 160;
    const g = c.getContext("2d"); g.fillStyle = "#2a7"; g.fillRect(0, 0, 240, 160); g.fillStyle = "#fff"; g.fillRect(40, 40, 80, 60);
    return c.toDataURL("image/jpeg", 0.9).split(",")[1];
  });
  await page.close();
  const jpeg = Buffer.from(b64, "base64");
  fx.jpg = path.join(tmp, "gps.jpg");
  fs.writeFileSync(fx.jpg, Buffer.concat([jpeg.subarray(0, 2), exifApp1(), jpeg.subarray(2)]));
});

after(async () => {
  if (browser) await browser.close();
  if (server) server.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

async function open(tab) {
  const page = await browser.newPage();
  page.errors = [];
  await page.setRequestInterception(true);
  page.on("request", (r) => (r.url().startsWith(base) || /^(data|blob):/.test(r.url()) ? r.continue() : r.abort()));
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
  await page.goto(`${base}/images.html#${tab}`, { waitUntil: "networkidle0" });
  return page;
}

const panel = (tab) => `[data-panel="${tab}"]`;

/** Upload files to a tab, press Run, wait for ok, then download output #index and return its bytes. */
async function runTool(page, tab, files, index = 0) {
  const input = await page.$(`${panel(tab)} [data-role="drop"] + input[type=file]`);
  await input.uploadFile(...files);
  await page.waitForFunction((sel, n) => document.querySelectorAll(`${sel} [data-role="list"] li`).length === n, {}, panel(tab), files.length);
  await page.click(`${panel(tab)} [data-role="run"]`);
  await page.waitForFunction((sel) => {
    const s = document.querySelector(`${sel} [data-role="status"]`);
    return s && (s.dataset.state === "ok" || s.dataset.state === "error");
  }, { timeout: 60000 }, panel(tab));
  const st = await page.$eval(`${panel(tab)} [data-role="status"]`, (s) => ({ state: s.dataset.state, text: s.textContent }));
  assert.equal(st.state, "ok", st.text);
  const buttons = await page.$$(`${panel(tab)} [data-role="list"] li button`);
  const dl = [];
  for (const b of buttons) if ((await b.evaluate((e) => e.textContent)) === "Download") dl.push(b);
  const before = await page.evaluate(() => window.__downloads.length);
  await dl[index].click();
  await page.waitForFunction((n) => window.__downloads.length > n, {}, before);
  const href = await page.evaluate(() => window.__downloads[window.__downloads.length - 1].href);
  const b64 = await page.evaluate(async (u) => {
    const buf = new Uint8Array(await (await fetch(u)).arrayBuffer());
    let s = "";
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, href);
  return Buffer.from(b64, "base64");
}

describe("images.html", { skip }, () => {
  test("compress PNG to WebP", async () => {
    const page = await open("compress");
    await page.select("#c-format", "image/webp");
    const out = await runTool(page, "compress", [fx.png]);
    assert.equal(out.subarray(0, 4).toString("latin1"), "RIFF");
    assert.equal(out.subarray(8, 12).toString("latin1"), "WEBP");
    assert.ok(out.length < fs.statSync(fx.png).size, "WebP is smaller than source PNG");
    assert.deepEqual(page.errors, []);
    await page.close();
  });

  test("convert to JPEG and ICO", async () => {
    const page = await open("convert");
    await page.select("#v-format", "image/jpeg");
    let out = await runTool(page, "convert", [fx.png]);
    assert.ok(out[0] === 0xff && out[1] === 0xd8, "JPEG signature");
    await page.select("#v-format", "ico");
    await page.click(`${panel("convert")} [data-role="run"]`);
    await page.waitForFunction(() => /^Done/.test(document.querySelector('[data-panel="convert"] [data-role="status"]').textContent));
    await page.$$eval(`${panel("convert")} [data-role="list"] li button`, (b) => b.find((x) => x.textContent === "Download").click());
    await page.waitForFunction(() => window.__downloads.length >= 2);
    const icoName = await page.evaluate(() => window.__downloads[1].name);
    assert.match(icoName, /\.ico$/);
    out = Buffer.from(await page.evaluate(async () => {
      const b = new Uint8Array(await (await fetch(window.__downloads[1].href)).arrayBuffer());
      return Array.from(b.subarray(0, 6));
    }));
    assert.deepEqual([...out], [0, 0, 1, 0, out[4], 0]);
    assert.ok(out[4] >= 1, "ICO has entries");
    assert.deepEqual(page.errors, []);
    await page.close();
  });

  test("resize by percent halves dimensions", async () => {
    const page = await open("resize");
    await page.select("#r-mode", "percent");
    await page.$eval("#r-pct", (e) => { e.value = "50"; e.dispatchEvent(new Event("input")); e.dispatchEvent(new Event("change")); });
    await page.select("#r-format", "image/png");
    const out = await runTool(page, "resize", [fx.png]);
    assert.deepEqual(pngDims(out), { w: 160, h: 100 });
    await page.close();
  });

  test("rotate 90 swaps dimensions", async () => {
    const page = await open("transform");
    await page.select("#t-rotate", "90");
    await page.select("#t-format", "image/png");
    const out = await runTool(page, "transform", [fx.png]);
    assert.deepEqual(pngDims(out), { w: 200, h: 320 });
    await page.close();
  });

  test("strip metadata removes EXIF/GPS and PNG text, flags GPS", async () => {
    const page = await open("metadata");
    const input = await page.$(`${panel("metadata")} [data-role="drop"] + input[type=file]`);
    await input.uploadFile(fx.jpg);
    await page.waitForFunction(() => /GPS/i.test(document.querySelector('[data-panel="metadata"] [data-role="list"]').textContent), { timeout: 15000 });
    await page.close();

    const p2 = await open("metadata");
    const jpg = await runTool(p2, "metadata", [fx.jpg]);
    assert.ok(jpg[0] === 0xff && jpg[1] === 0xd8);
    assert.ok(!jpg.includes(Buffer.from("Exif\0\0", "latin1")), "EXIF removed");
    assert.ok(!jpg.includes(Buffer.from("Canon")), "Make removed");
    assert.ok(jpg.length < fs.statSync(fx.jpg).size);
    await p2.close();

    const p3 = await open("metadata");
    const png = await runTool(p3, "metadata", [fx.png]);
    assert.ok(!png.includes(Buffer.from("Secret Person")), "PNG text chunk removed");
    assert.deepEqual(pngDims(png), { w: 320, h: 200 });
    await p3.close();
  });

  test("image to Base64 data URL", async () => {
    const page = await open("base64");
    const input = await page.$(`${panel("base64")} [data-role="drop"] + input[type=file]`);
    await input.uploadFile(fx.png);
    await page.waitForFunction(() => /^data:image\/png;base64,iVBOR/.test(document.getElementById("b-out").value));
    assert.deepEqual(page.errors, []);
    await page.close();
  });
});
