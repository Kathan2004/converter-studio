// End-to-end tests for Word to PDF, HTML to PDF and Searchable PDF (documents.html).
// Runs when CHROMIUM_PATH is set; skipped otherwise.
const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const staticServer = require("./helpers/static-server");

const CHROME = process.env.CHROMIUM_PATH;
const skip = !CHROME || !fs.existsSync(CHROME) ? "CHROMIUM_PATH not set" : false;

let server, browser, base, tmp, PDFLib;
const fx = {};

before(async () => {
  if (skip) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docs-pdf-e2e-"));
  PDFLib = require(path.join(staticServer.ROOT, "vendor/pdf-lib.min.js"));
  server = await staticServer.start();
  base = server.base;
  browser = await require("puppeteer-core").launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  const page = await open("documents.html");
  // A .docx made with the vendored docx library, containing known text.
  await page.addScriptTag({ url: `${base}/vendor/docx.iife.js` });
  const docxB64 = await page.evaluate(async () => {
    const { Document, Packer, Paragraph, TextRun, HeadingLevel } = window.docx;
    const doc = new Document({ sections: [{ children: [
      new Paragraph({ text: "Quarterly Report", heading: HeadingLevel.HEADING_1 }),
      new Paragraph({ children: [new TextRun("Revenue grew steadily across every region.")] }),
    ] }] });
    const blob = await Packer.toBlob(doc);
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = "";
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(s);
  });
  fx.docx = path.join(tmp, "report.docx");
  fs.writeFileSync(fx.docx, Buffer.from(docxB64, "base64"));
  // A "scanned" PDF: large text drawn on a canvas and embedded as a PNG (no text layer).
  const pngB64 = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 1400; c.height = 500;
    const g = c.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, 1400, 500);
    g.fillStyle = "#000"; g.font = "bold 110px Arial";
    g.fillText("Invoice 48213", 60, 180);
    g.fillText("Payment received", 60, 380);
    return c.toDataURL("image/png").split(",")[1];
  });
  await page.close();
  const pdf = await PDFLib.PDFDocument.create();
  const img = await pdf.embedPng(Buffer.from(pngB64, "base64"));
  const p = pdf.addPage([560, 200]);
  p.drawImage(img, { x: 0, y: 0, width: 560, height: 200 });
  fx.scan = path.join(tmp, "scan.pdf");
  fs.writeFileSync(fx.scan, Buffer.from(await pdf.save()));
});

after(async () => {
  if (browser) await browser.close();
  if (server) server.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

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

function head(bytes) {
  return bytes.subarray(0, 5).toString("latin1");
}

describe("documents: PDF tools", { skip }, () => {
  test("Word to PDF turns a generated .docx into a valid PDF", async () => {
    const page = await open("documents.html#word-to-pdf");
    await (await page.$('[data-panel="word-to-pdf"] input[type=file]')).uploadFile(fx.docx);
    const st = await settle(page, "#wp-status");
    assert.equal(st.state, "ok", st.text);
    assert.equal(await page.$eval("#wp-batch .name", (n) => n.textContent), "report.pdf");
    await page.click("#wp-batch button");
    const d = await download(page, 0);
    assert.equal(d.name, "report.pdf");
    assert.equal(head(d.bytes), "%PDF-");
    const doc = await PDFLib.PDFDocument.load(d.bytes);
    assert.ok(doc.getPageCount() >= 1);
    assert.deepEqual(page.errors, []);
    await page.close();
  });

  test("HTML to PDF strips scripts and handlers and still yields a PDF", async () => {
    const page = await open("documents.html#html-to-pdf");
    await page.type("#hp-input", '<h1>Hello PDF</h1><p>Body text.</p><script>window.__pwned = 1;</script><img src="x" onerror="window.__pwned = 2"><img src="https://example.com/a.png"><p onclick="window.__pwned = 3">click</p>');
    await page.waitForFunction(() => document.getElementById("hp-preview").textContent.includes("Hello PDF"));
    const preview = await page.$eval("#hp-preview", (n) => n.innerHTML);
    assert.ok(!/<script|onerror|onclick|example\.com/i.test(preview), preview);
    await page.click("#hp-run");
    const d = await download(page, 0);
    assert.match(d.name, /\.pdf$/);
    assert.equal(head(d.bytes), "%PDF-");
    assert.ok((await PDFLib.PDFDocument.load(d.bytes)).getPageCount() >= 1);
    assert.equal(await page.evaluate(() => window.__pwned), undefined);
    assert.deepEqual(page.errors, []);
    await page.close();
  });

  test("Searchable PDF adds a text layer to a scanned page", { timeout: 180000 }, async () => {
    const page = await open("documents.html#ocr-pdf", { intercept: false });
    await (await page.$('[data-panel="ocr-pdf"] input[type=file]')).uploadFile(fx.scan);
    const st = await settle(page, "#op-status", 150000);
    assert.equal(st.state, "ok", st.text);
    await page.click("#op-batch button");
    const d = await download(page, 0);
    assert.equal(d.name, "scan-searchable.pdf");
    assert.equal(head(d.bytes), "%PDF-");
    const doc = await PDFLib.PDFDocument.load(d.bytes);
    assert.equal(doc.getPageCount(), 1);
    const size = doc.getPage(0).getSize();
    assert.ok(Math.abs(size.width - 560) < 1 && Math.abs(size.height - 200) < 1, JSON.stringify(size));
    // Extract the text layer with pdf.js in the page.
    const text = await page.evaluate(async (b64) => {
      const pdfjs = await import("/vendor/pdf.min.mjs");
      pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.min.mjs";
      const bin = atob(b64);
      const data = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
      const pdf = await pdfjs.getDocument({ data }).promise;
      const tc = await (await pdf.getPage(1)).getTextContent();
      return tc.items.map((i) => i.str).join(" ");
    }, d.bytes.toString("base64"));
    for (const w of ["Invoice", "48213", "Payment", "received"]) assert.ok(text.includes(w), `missing "${w}" in: ${text}`);
    assert.deepEqual(page.errors, []);
    await page.close();
  });
});
