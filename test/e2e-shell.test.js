// End-to-end tests for the site shell (home drop -> tool handoff, search palette, sidebar)
// and for the Files and OCR tools. Runs when CHROMIUM_PATH is set; skipped otherwise.
const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const staticServer = require("./helpers/static-server");

const CHROME = process.env.CHROMIUM_PATH;
const skip = !CHROME || !fs.existsSync(CHROME) ? "CHROMIUM_PATH not set" : false;

let server, browser, base, tmp;
const fx = {};

before(async () => {
  if (skip) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shell-e2e-"));
  const write = (name, data) => { const p = path.join(tmp, name); fs.writeFileSync(p, data); return p; };
  fx.text = write("notes.txt", "The quick brown fox jumps over the lazy dog.\n".repeat(200));
  fx.json = write("data.json", JSON.stringify([{ a: 1, b: "x" }, { a: 2, b: "y" }]));
  const PDFLib = require(path.join(staticServer.ROOT, "vendor/pdf-lib.min.js"));
  const doc = await PDFLib.PDFDocument.create();
  doc.addPage();
  fx.pdf = write("one.pdf", Buffer.from(await doc.save()));
  server = await staticServer.start();
  base = server.base;
  browser = await require("puppeteer-core").launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  // Screenshot-like PNG with known text, rendered by the browser itself.
  const page = await browser.newPage();
  const b64 = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 900; c.height = 160;
    const g = c.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, 900, 160);
    g.fillStyle = "#000"; g.font = "48px Arial";
    g.fillText("Invoice number 48213", 30, 95);
    return c.toDataURL("image/png").split(",")[1];
  });
  await page.close();
  fx.ocrPng = write("invoice.png", Buffer.from(b64, "base64"));
});

after(async () => {
  if (browser) await browser.close();
  if (server) server.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

// intercept: false for pages that start Web Workers (OCR). Puppeteer request interception can
// stall requests made from inside a worker; offline, external font requests simply fail.
async function open(urlPath, { intercept = true } = {}) {
  const page = await browser.newPage();
  page.errors = [];
  if (intercept) {
    await page.setRequestInterception(true);
    page.on("request", (r) => (r.url().startsWith(base) || /^(data|blob):/.test(r.url()) ? r.continue() : r.abort()));
  }
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

describe("site shell", { skip }, () => {
  test("home: dropping a PDF suggests PDF tools and hands the file to the chosen tool", async () => {
    const page = await open("index.html");
    const input = await page.$("#homeFiles");
    await input.uploadFile(fx.pdf);
    await page.waitForSelector("#suggestChips .chip");
    const chips = await page.$$eval("#suggestChips .chip", (c) => c.map((x) => x.textContent));
    assert.equal(chips[0], "Compress PDF");
    assert.ok(chips.includes("Merge PDF"));
    assert.ok(!chips.includes("Compress images"), "image tools are not offered for a PDF");
    await Promise.all([page.waitForNavigation({ waitUntil: "networkidle0" }), page.click("#suggestChips .chip")]);
    assert.match(page.url(), /pdf\.html#compress$/);
    await page.waitForFunction(() => /1 page|Ready|page/i.test(document.getElementById("compress-info").textContent + document.getElementById("compress-status").textContent));
    assert.equal(await page.$eval("h1", (h) => h.textContent), "Compress PDF");
    assert.equal(await page.title(), "Compress PDF - Converter Studio");
    assert.deepEqual(page.errors, []);
    await page.close();
  });

  test("home: popular tools, then every tool on demand", async () => {
    const page = await open("index.html");
    const featured = await page.$$eval("#featured .app-tile", (a) => a.length);
    assert.equal(featured, 12);
    await page.click("#showAll");
    const all = await page.$$eval("#allTools .app-tile", (a) => a.length);
    const Cat = require("../assets/catalog.js");
    assert.equal(all, Cat.TOOLS.length);
    assert.equal(await page.$eval("#showAll", (b) => b.getAttribute("aria-expanded")), "true");
    assert.deepEqual(page.errors, []);
    await page.close();
  });

  test("search palette: Ctrl+K, type, Enter opens the tool", async () => {
    const page = await open("data.html");
    await page.keyboard.down("Control");
    await page.keyboard.press("k");
    await page.keyboard.up("Control");
    await page.waitForSelector("dialog.palette[open]");
    await page.keyboard.type("split pdf");
    const first = await page.$eval(".palette-list a", (a) => a.textContent);
    assert.match(first, /^Split PDF/);
    await Promise.all([page.waitForNavigation({ waitUntil: "networkidle0" }), page.keyboard.press("Enter")]);
    assert.match(page.url(), /pdf\.html#split$/);
    const active = await page.$eval('#tabs button[aria-selected="true"]', (b) => b.textContent);
    assert.equal(active, "Split");
    assert.equal(await page.$eval("h1", (h) => h.textContent), "Split PDF");
    assert.deepEqual(page.errors, []);
    await page.close();
  });

  test("sidebar follows catalog order and same-page palette switches tab", async () => {
    const page = await open("pdf.html");
    const order = await page.$$eval("#tabs button", (b) => b.map((x) => x.dataset.tab));
    assert.deepEqual(order.slice(0, 3), ["compress", "merge", "split"]);
    await page.click("#openSearch");
    await page.keyboard.type("metadata pdf");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => location.hash === "#metadata" && document.querySelector("h1").textContent === "PDF metadata");
    assert.equal(await page.$eval('#tabs button[aria-selected="true"]', (b) => b.dataset.tab), "metadata");
    await page.close();
  });

  test("markdown pipeline page loads files", async () => {
    const page = await open("markdown.html");
    const input = await page.$("#multiFileInput");
    const md = path.join(tmp, "a.md");
    fs.writeFileSync(md, "# Title\n\nHello\n\n| A | B |\n|---|---|\n| 1 | 2 |\n");
    await input.uploadFile(md);
    await page.waitForFunction(() => /"fileCount": 1/.test(document.getElementById("jsonPreview").textContent));
    assert.deepEqual(page.errors, []);
    await page.close();
  });
});

describe("files.html", { skip }, () => {
  test("zip, then extract the result", async () => {
    let page = await open("files.html#zip");
    const input = await page.$('[data-panel="zip"] .drop-zone + input[type=file]');
    await input.uploadFile(fx.text, fx.json);
    await page.waitForFunction(() => document.querySelectorAll("#zip-list li").length === 2);
    await page.click("#zip-run");
    const st = await settle(page, "#zip-status");
    assert.equal(st.state, "ok", st.text);
    const zip = await download(page, 0);
    assert.equal(zip.bytes.subarray(0, 2).toString("latin1"), "PK");
    assert.ok(zip.bytes.length < fs.statSync(fx.text).size, "text compressed");
    const zipPath = path.join(tmp, "out.zip");
    fs.writeFileSync(zipPath, zip.bytes);
    assert.deepEqual(page.errors, []);
    await page.close();

    page = await open("files.html#unzip");
    await (await page.$('[data-panel="unzip"] .drop-zone + input[type=file]')).uploadFile(zipPath);
    await settle(page, "#unzip-status");
    const names = await page.$$eval("#unzip-table .name-btn", (b) => b.map((x) => x.textContent).sort());
    assert.deepEqual(names, ["data.json", "notes.txt"]);
    await page.$$eval("#unzip-table .name-btn", (b) => b.find((x) => x.textContent === "data.json").click());
    await page.waitForFunction(() => /"b"/.test(document.getElementById("unzip-preview").textContent));
    await page.close();
  });

  test("gzip round trip", async () => {
    let page = await open("files.html#gzip");
    await (await page.$('[data-panel="gzip"] .drop-zone + input[type=file]')).uploadFile(fx.text);
    await page.waitForFunction(() => !document.getElementById("gzip-run").disabled);
    assert.equal(await page.$eval("#gzip-mode", (s) => s.value), "compress");
    await page.click("#gzip-run");
    assert.equal((await settle(page, "#gzip-status")).state, "ok");
    const gz = await download(page, 0);
    assert.equal(gz.name, "notes.txt.gz");
    assert.equal(zlib.gunzipSync(gz.bytes).toString(), fs.readFileSync(fx.text, "utf8"));
    await page.close();
  });

  test("hashes match Node crypto and expected-hash highlights", async () => {
    const page = await open("files.html#hash");
    await (await page.$('[data-panel="hash"] .drop-zone + input[type=file]')).uploadFile(fx.text);
    assert.equal((await settle(page, "#hash-status")).state, "ok");
    const codes = await page.$$eval("#hash-results code", (c) => c.map((x) => x.textContent));
    const data = fs.readFileSync(fx.text);
    for (const algo of ["md5", "sha1", "sha256", "sha512"]) {
      assert.ok(codes.includes(crypto.createHash(algo).update(data).digest("hex")), `${algo} matches`);
    }
    await page.type("#hash-expected", crypto.createHash("sha256").update(data).digest("hex").toUpperCase());
    await page.waitForSelector(".hash-row.is-match");
    assert.deepEqual(page.errors, []);
    await page.close();
  });
});

/** Wait for OCR output containing `needle`; on timeout, fail with the tool's own status for diagnosis. */
async function waitForOcr(page, needle) {
  try {
    await page.waitForFunction((n) => document.getElementById("ocr-output").value.includes(n), { timeout: 120000 }, needle);
  } catch (e) {
    const st = await page.evaluate(() => {
      const s = document.getElementById("ocr-status");
      const g = document.getElementById("ocr-stage");
      return `status=${s && s.dataset.state}: ${s && s.textContent} | stage=${g && g.textContent}`;
    });
    throw new Error(`OCR did not finish: ${st} | page errors: ${page.errors.join("; ")}`);
  }
}

describe("OCR", { skip }, () => {
  test("image to text reads a rendered image", async () => {
    const page = await open("images.html#ocr", { intercept: false });
    const input = await page.$('[data-panel="ocr"] .drop-zone + input[type=file]');
    await input.uploadFile(fx.ocrPng);
    await waitForOcr(page, "48213");
    const text = await page.$eval("#ocr-output", (t) => t.value);
    assert.match(text, /Invoice number 48213/);
    assert.deepEqual(page.errors, []);
    await page.close();
  });

  test("pasting a screenshot on the home page opens OCR with it", async () => {
    const page = await open("index.html", { intercept: false });
    const b64 = fs.readFileSync(fx.ocrPng).toString("base64");
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle0" }),
      page.evaluate((data) => {
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], "image.png", { type: "image/png" }));
        document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
      }, b64),
    ]);
    assert.match(page.url(), /images\.html#ocr$/);
    await waitForOcr(page, "48213");
    await page.close();
  });
});
