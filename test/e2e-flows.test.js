// Functional end-to-end tests: drive each converter in headless Chromium and verify the
// files it produces by parsing them back (pdf-lib, ExcelJS, ZIP/PNG/JPEG signatures).
// Runs when CHROMIUM_PATH points to Chrome/Chromium (set in CI); skipped otherwise.
const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const staticServer = require("./helpers/static-server");

const ROOT = staticServer.ROOT;
const CHROME = process.env.CHROMIUM_PATH;
const skip = !CHROME || !fs.existsSync(CHROME) ? "CHROMIUM_PATH not set" : false;

let server, browser, base, tmp;
const fx = {};

// ---------- fixtures ----------
function crc32(buf) {
  let c = ~0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; }
  return ~c >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** Solid-colour RGB PNG with a tEXt metadata chunk. */
function makePng(w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = y * (w * 3 + 1) + 1 + x * 3;
    raw[o] = (x * 255) / w; raw[o + 1] = (y * 255) / h; raw[o + 2] = 120;
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("tEXt", Buffer.from("Author\0Secret Person")),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

async function makePdf(PDFLib, pages, label) {
  const doc = await PDFLib.PDFDocument.create();
  const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  doc.setTitle(`${label} title`);
  doc.setAuthor("Fixture Author");
  for (let i = 1; i <= pages; i++) {
    const p = doc.addPage([595.28, 841.89]);
    p.drawText(`${label} page ${i} sample text`, { x: 60, y: 760, size: 20, font });
    p.drawRectangle({ x: 60, y: 300, width: 300, height: 200, color: PDFLib.rgb(0.1, 0.5, 0.4) });
  }
  return Buffer.from(await doc.save());
}

const PDFLib = require(path.join(ROOT, "vendor/pdf-lib.min.js"));
const pdfPages = async (buf) => (await PDFLib.PDFDocument.load(buf)).getPageCount();
const isZip = (b) => b[0] === 0x50 && b[1] === 0x4b;
const isPng = (b) => b[0] === 0x89 && b[1] === 0x50;
const isJpeg = (b) => b[0] === 0xff && b[1] === 0xd8;

before(async () => {
  if (skip) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conv-e2e-"));
  const write = (name, data) => { const p = path.join(tmp, name); fs.writeFileSync(p, data); return p; };
  fx.pdf3 = write("three.pdf", await makePdf(PDFLib, 3, "Alpha"));
  fx.pdf2 = write("two.pdf", await makePdf(PDFLib, 2, "Beta"));
  fx.png = write("photo.png", makePng(320, 200));
  fx.json = write("sentinel_table_inventory.json", JSON.stringify([
    { InteractiveRetentionDays: 90, Plan: "Analytics", TableName: "SigninLogs", TableType: null, TotalRetentionDays: 180 },
    { InteractiveRetentionDays: 30, Plan: "Basic", TableName: "AADNonInteractiveUserSignInLogs", TableType: null, TotalRetentionDays: 180 },
    { InteractiveRetentionDays: 30, Plan: "Auxiliary", TableName: "IntuneAuditLogs", TableType: null, TotalRetentionDays: 365 },
    { InteractiveRetentionDays: 90, Plan: "Analytics", TableName: "=HYPERLINK(\"x\")", TableType: null, TotalRetentionDays: 90 },
  ]));

  server = await staticServer.start();
  base = server.base;
  browser = await require("puppeteer-core").launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-gpu"] });
});

after(async () => {
  if (browser) await browser.close();
  if (server) server.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------- page helpers ----------
async function open(name, tab) {
  const page = await browser.newPage();
  page.errors = [];
  await page.setRequestInterception(true);
  page.on("request", (r) => (r.url().startsWith(base) || /^(data|blob):/.test(r.url()) ? r.continue() : r.abort()));
  page.on("pageerror", (e) => page.errors.push(e.message));
  page.on("console", (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) page.errors.push(m.text()); });
  // Capture downloads instead of letting the browser save them.
  await page.evaluateOnNewDocument(() => {
    window.__downloads = [];
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.hasAttribute("download")) { window.__downloads.push({ name: this.download, href: this.href }); return; }
      return click.call(this);
    };
    window.alert = (m) => { window.__alerts = (window.__alerts || []).concat(String(m)); };
  });
  await page.goto(`${base}/${name}${tab ? `#${tab}` : ""}`, { waitUntil: "networkidle0" });
  return page;
}

async function upload(page, dropId, ...files) {
  const input = await page.$(`#${dropId} + input[type=file]`);
  assert.ok(input, `file input after #${dropId}`);
  await input.uploadFile(...files);
}

/** Wait until a status element reaches ok/error after the action; returns {state, text}. */
async function settle(page, statusId, timeout = 60000) {
  await page.waitForFunction(
    (id) => { const s = document.getElementById(id); return s && (s.dataset.state === "ok" || s.dataset.state === "error"); },
    { timeout }, statusId,
  );
  return page.$eval(`#${statusId}`, (s) => ({ state: s.dataset.state, text: s.textContent }));
}

async function resetStatus(page, statusId) {
  await page.$eval(`#${statusId}`, (s) => { s.dataset.state = "idle"; });
}

/** Click, wait for the status to settle, and assert success. */
async function runOk(page, buttonId, statusId, timeout) {
  await resetStatus(page, statusId);
  await page.click(`#${buttonId}`);
  const st = await settle(page, statusId, timeout);
  assert.equal(st.state, "ok", `${buttonId}: ${st.text}`);
  return st;
}

async function waitDownloads(page, count, timeout = 30000) {
  await page.waitForFunction((n) => window.__downloads.length >= n, { timeout }, count);
  return page.evaluate(() => window.__downloads.slice());
}

async function fetchBytes(page, href) {
  const b64 = await page.evaluate(async (u) => {
    const buf = new Uint8Array(await (await fetch(u)).arrayBuffer());
    let s = "";
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, href);
  return Buffer.from(b64, "base64");
}

async function lastDownload(page, count) {
  const dl = await waitDownloads(page, count);
  const d = dl[count - 1];
  return { name: d.name, bytes: await fetchBytes(page, d.href) };
}

async function clickListDownload(page, listId, index = 0) {
  const buttons = await page.$$(`#${listId} button`);
  const dlButtons = [];
  for (const b of buttons) if (/download/i.test(await b.evaluate((e) => e.textContent))) dlButtons.push(b);
  assert.ok(dlButtons[index], `download button ${index} in #${listId}`);
  await dlButtons[index].click();
}

// ---------- PDF tools ----------
describe("pdf.html", { skip }, () => {
  test("merge two PDFs keeps every page", async () => {
    const page = await open("pdf.html", "merge");
    await upload(page, "merge-drop", fx.pdf2, fx.pdf3);
    await page.waitForFunction(() => document.querySelectorAll("#merge-list li").length === 2);
    await runOk(page, "merge-run", "merge-status");
    const out = await lastDownload(page, 1);
    assert.equal(await pdfPages(out.bytes), 5);
    assert.deepEqual(page.errors, []);
    await page.close();
  });

  test("split by ranges", async () => {
    const page = await open("pdf.html", "split");
    await upload(page, "split-drop", fx.pdf3);
    await page.waitForFunction(() => /3/.test(document.getElementById("split-info").textContent));
    await page.select("#split-mode", "ranges");
    await page.$eval("#split-ranges", (e) => { e.value = "1-2, 3"; e.dispatchEvent(new Event("input")); });
    await runOk(page, "split-run", "split-status");
    const out = await lastDownload(page, 1);
    assert.ok(isZip(out.bytes), "split output is a zip");
    assert.deepEqual(page.errors, []);
    await page.close();
  });

  test("lossless and strong compression produce valid PDFs", async () => {
    const page = await open("pdf.html", "compress");
    await upload(page, "compress-drop", fx.pdf3);
    await page.waitForFunction(() => document.getElementById("compress-info").textContent.trim().length > 0);
    for (const mode of ["lossless", "strong"]) {
      await page.select("#compress-mode", mode);
      await runOk(page, "compress-run", "compress-status", 120000);
      const before = await page.evaluate(() => window.__downloads.length);
      await page.click("#compress-download");
      const out = await lastDownload(page, before + 1);
      assert.equal(await pdfPages(out.bytes), 3, `${mode} page count`);
    }
    assert.deepEqual(page.errors, []);
    await page.close();
  });

  test("images to PDF", async () => {
    const page = await open("pdf.html", "images-to-pdf");
    await upload(page, "i2p-drop", fx.png);
    await page.waitForFunction(() => document.querySelectorAll("#i2p-list li").length === 1);
    await runOk(page, "i2p-run", "i2p-status");
    const out = await lastDownload(page, 1);
    assert.equal(await pdfPages(out.bytes), 1);
    await page.close();
  });

  test("PDF to images renders every page", async () => {
    const page = await open("pdf.html", "pdf-to-images");
    await upload(page, "p2i-drop", fx.pdf3);
    await page.waitForFunction(() => document.getElementById("p2i-info").textContent.trim().length > 0);
    await runOk(page, "p2i-run", "p2i-status", 120000);
    await page.click("#p2i-zip");
    const dl = await waitDownloads(page, 1);
    const zipBytes = await fetchBytes(page, dl[dl.length - 1].href);
    assert.ok(isZip(zipBytes));
    assert.equal((zipBytes.toString("latin1").match(/PK\x01\x02/g) || []).length, 3, "3 images in zip");
    assert.deepEqual(page.errors, []);
    await page.close();
  });

  test("page numbers + watermark, then metadata edit", async () => {
    let page = await open("pdf.html", "stamp");
    await upload(page, "stamp-drop", fx.pdf3);
    await page.waitForFunction(() => document.getElementById("stamp-info").textContent.trim().length > 0);
    await page.$eval("#stamp-pn", (e) => { if (!e.checked) e.click(); });
    await page.$eval("#stamp-wm", (e) => { if (!e.checked) e.click(); });
    await runOk(page, "stamp-run", "stamp-status");
    const stamped = await lastDownload(page, 1);
    assert.equal(await pdfPages(stamped.bytes), 3);
    await page.close();

    page = await open("pdf.html", "metadata");
    await upload(page, "meta-drop", fx.pdf3);
    await page.waitForFunction(() => document.getElementById("meta-title").value === "Alpha title");
    await page.$eval("#meta-title", (e) => { e.value = "Edited Title"; e.dispatchEvent(new Event("input")); });
    await runOk(page, "meta-save", "meta-status");
    const edited = await lastDownload(page, 1);
    assert.equal((await PDFLib.PDFDocument.load(edited.bytes)).getTitle(), "Edited Title");
    await page.close();
  });
});

// ---------- Data converters ----------
describe("data.html", { skip }, () => {
  test("JSON to Excel produces a styled workbook", async () => {
    const page = await open("data.html", "json-to-excel");
    await upload(page, "je-drop", fx.json);
    await runOk(page, "je-run", "je-status", 60000);
    await clickListDownload(page, "je-list");
    const out = await lastDownload(page, 1);
    assert.ok(out.name.endsWith(".xlsx"));
    // Inspect the workbook with the same vendored ExcelJS inside the page.
    const info = await page.evaluate(async (href) => {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(await (await fetch(href)).arrayBuffer());
      const ws = wb.worksheets[0];
      const h = ws.getRow(1).getCell(1);
      const names = [];
      ws.getColumn(1).eachCell((c) => names.push(c.value));
      return {
        sheets: wb.worksheets.map((s) => s.name),
        rows: ws.rowCount,
        headerBold: h.font && h.font.bold,
        headerFill: h.fill && h.fill.fgColor && h.fill.fgColor.argb,
        frozen: ws.views && ws.views[0] && ws.views[0].ySplit,
        autoFilter: Boolean(ws.autoFilter),
        header: ws.getRow(1).values.filter(Boolean),
        retentionType: typeof ws.getRow(2).values[ws.getRow(1).values.indexOf("TotalRetentionDays")],
        hasRawFormula: JSON.stringify(ws.getSheetValues()).includes('"=HYPERLINK'),
      };
    }, (await page.evaluate(() => window.__downloads[0].href)));
    assert.equal(info.rows, 5);
    assert.ok(info.headerBold);
    assert.match(String(info.headerFill), /1F3864$/i);
    assert.equal(info.frozen, 1);
    assert.ok(info.autoFilter);
    assert.ok(info.header.includes("TableName"));
    assert.equal(info.retentionType, "number");
    assert.equal(info.hasRawFormula, false, "formula injection is escaped");
    assert.ok(info.sheets.length >= 2, "summary sheet present");
    assert.deepEqual(page.errors, []);
    await page.close();
  });

  test("convert pasted CSV to JSON, YAML and XML", async () => {
    const page = await open("data.html", "convert");
    await page.$eval("#cv-text", (e) => { e.value = 'name,qty\n"Widget, large",3\nGadget,5\n'; e.dispatchEvent(new Event("input")); });
    for (const [fmt, check] of [["json", (t) => JSON.parse(t)[0].name === "Widget, large"], ["yaml", (t) => /Widget, large/.test(t)], ["xml", (t) => /<\?xml|<rows|<row/.test(t)]]) {
      const values = await page.$$eval("#cv-out option", (o) => o.map((x) => x.value));
      const v = values.find((x) => x.toLowerCase().startsWith(fmt));
      assert.ok(v, `output option ${fmt}`);
      await page.select("#cv-out", v);
      await runOk(page, "cv-run", "cv-status");
      const text = await page.$eval("#cv-text-out", (e) => e.value ?? e.textContent);
      assert.ok(check(text), `${fmt} output: ${text.slice(0, 120)}`);
    }
    assert.deepEqual(page.errors, []);
    await page.close();
  });

  test("validator reports invalid JSON position", async () => {
    const page = await open("data.html", "format");
    await page.$eval("#fm-in", (e) => { e.value = '{\n  "a": 1,\n  "b": \n}'; e.dispatchEvent(new Event("input")); });
    await resetStatus(page, "fm-status");
    await page.click("#fm-validate");
    const st = await settle(page, "fm-status");
    assert.equal(st.state, "error");
    assert.match(st.text, /line\s*\d+/i);
    await page.close();
  });

  test("JSON diff lists changes", async () => {
    const page = await open("data.html", "diff");
    await page.$eval("#df-a", (e) => { e.value = '{"a":1,"b":{"c":2},"d":[1]}'; });
    await page.$eval("#df-b", (e) => { e.value = '{"a":1,"b":{"c":3},"e":true}'; });
    await runOk(page, "df-run", "df-status");
    const cells = await page.$$eval("#df-table td", (td) => td.map((c) => c.textContent.trim()));
    assert.ok(cells.includes("b.c"), `changed path listed: ${cells}`);
    assert.ok(cells.includes("e"), "added path listed");
    assert.ok(cells.some((c) => /^d/.test(c)), "removed path listed");
    await page.close();
  });
});

// ---------- Document converters ----------
const SAMPLE_MD = "# Report Title\n\nSome **bold** and *italic* text with `code`.\n\n## Section\n\n- one\n- two\n\n| Col A | Col B |\n|---|---|\n| 1 | 2 |\n\n<script>window.__xss = 1</script>\n<img src=x onerror=\"window.__xss=2\">\n";

describe("documents.html", { skip }, () => {
  test("Markdown to Word, then Word back to Markdown", async () => {
    const page = await open("documents.html", "md-to-docx");
    await page.$eval("#docx-input", (e, md) => { e.value = md; e.dispatchEvent(new Event("input")); }, SAMPLE_MD);
    await runOk(page, "docx-run", "docx-status", 60000);
    const docx = await lastDownload(page, 1);
    assert.ok(docx.name.endsWith(".docx") && isZip(docx.bytes));
    const docxPath = path.join(tmp, "roundtrip.docx");
    fs.writeFileSync(docxPath, docx.bytes);

    await page.click('#tabs button[data-tab="docx-to"]');
    await upload(page, "dx-drop", docxPath);
    const st = await settle(page, "dx-status", 60000);
    assert.notEqual(st.state, "error", st.text);
    const md = await page.$eval("#dx-output", (e) => e.value ?? e.textContent);
    assert.match(md, /Report Title/);
    assert.match(md, /Col A/);
    assert.equal(await page.evaluate(() => window.__xss), undefined, "no script execution");
    assert.deepEqual(page.errors, []);
    await page.close();
  });

  test("Markdown to PDF yields a valid PDF and sanitizes HTML", async () => {
    const page = await open("documents.html", "md-to-pdf");
    await page.$eval("#pdf-input", (e, md) => { e.value = md; e.dispatchEvent(new Event("input")); }, SAMPLE_MD);
    await runOk(page, "pdf-run", "pdf-status", 90000);
    const out = await lastDownload(page, 1);
    assert.ok((await pdfPages(out.bytes)) >= 1);
    assert.equal(await page.evaluate(() => window.__xss), undefined, "no script execution");
    await page.close();
  });

  test("Markdown to HTML strips scripts", async () => {
    const page = await open("documents.html", "md-to-html");
    await page.$eval("#html-input", (e, md) => { e.value = md; e.dispatchEvent(new Event("input")); }, SAMPLE_MD);
    await runOk(page, "html-run", "html-status");
    const out = await lastDownload(page, 1);
    const html = out.bytes.toString("utf8");
    assert.match(html, /<h1[^>]*>Report Title/);
    assert.doesNotMatch(html, /<script>window\.__xss|onerror=/i);
    await page.close();
  });

  test("PDF to text extracts page text", async () => {
    const page = await open("documents.html", "pdf-to-text");
    await upload(page, "pt-drop", fx.pdf3);
    const st = await settle(page, "pt-status", 60000);
    assert.equal(st.state, "ok", st.text);
    const text = await page.$eval("#pt-output", (e) => e.value ?? e.textContent);
    assert.match(text, /Alpha page 1 sample text/);
    assert.match(text, /Alpha page 3 sample text/);
    await page.close();
  });

  test("HTML to Markdown and text tools", async () => {
    const page = await open("documents.html", "html-to-md");
    await page.$eval("#hm-input", (e) => { e.value = "<h2>Hello</h2><p>A <strong>b</strong></p><ul><li>x</li></ul>"; e.dispatchEvent(new Event("input")); });
    await page.waitForFunction(() => /## Hello/.test(document.getElementById("hm-output").value || document.getElementById("hm-output").textContent));
    await page.click('#tabs button[data-tab="text-tools"]');
    await page.$eval("#tt-input", (e) => { e.value = "hello world"; e.dispatchEvent(new Event("input")); });
    await page.click("#tt-case-upper");
    assert.equal(await page.$eval("#tt-output", (e) => e.value), "HELLO WORLD");
    await page.click("#tt-b64e");
    assert.equal(await page.$eval("#tt-output", (e) => e.value), Buffer.from("hello world").toString("base64"));
    assert.deepEqual(page.errors, []);
    await page.close();
  });
});

