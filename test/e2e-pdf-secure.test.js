// End-to-end tests for Protect / Unlock / Sign / Repair PDF. Runs when CHROMIUM_PATH is set.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const staticServer = require("./helpers/static-server");

const CHROME = process.env.CHROMIUM_PATH;
const skip = !CHROME || !fs.existsSync(CHROME) ? "CHROMIUM_PATH not set" : false;
const PDFLib = require(path.join(staticServer.ROOT, "vendor/pdf-lib.min.js"));

// pdf-lib reports encryption as EncryptedPDFError (or an Error with the same message in this build).
const isEncryptedError = (e) => (PDFLib.EncryptedPDFError && e instanceof PDFLib.EncryptedPDFError) || /is encrypted/.test(e.message);

let server, browser, base, tmp;
const fx = {};

before(async () => {
  if (skip) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "secure-e2e-"));
  const write = (name, data) => { const p = path.join(tmp, name); fs.writeFileSync(p, data); return p; };
  const doc = await PDFLib.PDFDocument.create();
  const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  for (let i = 1; i <= 3; i++) doc.addPage([400, 300]).drawText(`Page ${i}`, { x: 40, y: 200, size: 24, font });
  doc.getPage(1).setRotation(PDFLib.degrees(90));
  const bytes = Buffer.from(await doc.save({ useObjectStreams: false }));
  fx.plain = write("plain.pdf", bytes);
  // Damaged: break an xref entry and the startxref pointer.
  const s = bytes.toString("latin1");
  const sx = s.lastIndexOf("startxref");
  const xi = s.indexOf("\nxref\n") + 1;
  const damaged = s.slice(0, xi) + "xref\n0 1\n0000000000 65535 f \n" + s.slice(s.indexOf("trailer")).replace(/startxref\s+\d+/, "startxref\n99999");
  assert.ok(sx > 0);
  fx.damaged = write("damaged.pdf", Buffer.from(damaged, "latin1"));
  server = await staticServer.start();
  base = server.base;
  browser = await require("puppeteer-core").launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-gpu"] });
});

after(async () => {
  if (browser) await browser.close();
  if (server) server.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

async function open(hash) {
  const page = await browser.newPage();
  page.errors = [];
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
  await page.goto(`${base}/pdf.html#${hash}`, { waitUntil: "networkidle0" });
  return page;
}

const upload = async (page, tab, file) => {
  const input = await page.$(`[data-panel="${tab}"] .drop-zone + input[type=file]`);
  await input.uploadFile(file);
};

async function settle(page, sel, timeout = 60000) {
  await page.waitForFunction((s) => {
    const el = document.querySelector(s);
    return el && (el.dataset.state === "ok" || el.dataset.state === "error");
  }, { timeout }, sel);
  return page.$eval(sel, (el) => ({ state: el.dataset.state, text: el.textContent }));
}

async function waitStatus(page, sel, re, timeout = 60000) {
  await page.waitForFunction((s, r) => {
    const el = document.querySelector(s);
    return el && new RegExp(r, "i").test(el.textContent);
  }, { timeout }, sel, re.source);
}

async function download(page, index = 0) {
  await page.waitForFunction((i) => window.__downloads.length > i, { timeout: 30000 }, index);
  const d = await page.evaluate((i) => window.__downloads[i], index);
  const arr = await page.evaluate(async (href) => Array.from(new Uint8Array(await (await fetch(href)).arrayBuffer())), d.href);
  return { name: d.name, bytes: Buffer.from(arr) };
}

async function protectFile(file, password, extra = {}) {
  const page = await open("protect");
  await upload(page, "protect", file);
  await page.waitForFunction(() => !document.getElementById("protect-run").disabled);
  await page.type("#protect-pw", password);
  await page.type("#protect-pw2", extra.confirm || password);
  if (extra.edit) await page.click("#protect-edit");
  await page.click("#protect-run");
  return page;
}

test("protect encrypts the PDF (AES-256) and unlock restores it", { skip }, async () => {
  const page = await protectFile(fx.plain, "Sup3r-secret!");
  const st = await settle(page, "#protect-status");
  assert.equal(st.state, "ok", st.text);
  assert.ok(!st.text.includes("Sup3r"), "status must not echo the password");
  const out = await download(page);
  assert.equal(out.name, "plain-protected.pdf");
  await assert.rejects(() => PDFLib.PDFDocument.load(out.bytes), isEncryptedError);
  assert.match(out.bytes.toString("latin1"), /\/Encrypt/);
  assert.deepEqual(page.errors, []);
  await page.close();
  const protectedPath = path.join(tmp, "protected.pdf");
  fs.writeFileSync(protectedPath, out.bytes);

  // Wrong password fails cleanly, right password restores a loadable PDF.
  const u = await open("unlock");
  await upload(u, "unlock", protectedPath);
  await u.waitForFunction(() => !document.getElementById("unlock-pw-field").classList.contains("is-hidden"));
  await u.type("#unlock-pw", "not-the-password");
  await u.click("#unlock-run");
  const bad = await settle(u, "#unlock-status");
  assert.equal(bad.state, "error");
  assert.match(bad.text, /Incorrect password/);
  assert.equal(await u.evaluate(() => window.__downloads.length), 0);
  await u.$eval("#unlock-pw", (el) => { el.value = ""; });
  await u.type("#unlock-pw", "Sup3r-secret!");
  await u.click("#unlock-run");
  await waitStatus(u, "#unlock-status", /Unlocked/);
  const un = await download(u);
  assert.equal(un.name, "protected-unlocked.pdf");
  const re = await PDFLib.PDFDocument.load(un.bytes);
  assert.equal(re.getPageCount(), 3);
  assert.deepEqual(u.errors, []);
  await u.close();
});

test("protect with separate permissions password and restrictions", { skip }, async () => {
  const page = await protectFile(fx.plain, "open-pass-1", { edit: false });
  await page.type("#protect-owner", "owner-pass-2");
  // owner field typed after run click is irrelevant; run again now
  await page.waitForFunction(() => window.__downloads.length > 0);
  await page.click("#protect-run");
  await page.waitForFunction(() => window.__downloads.length > 1, { timeout: 30000 });
  const out = await download(page, 1);
  await assert.rejects(() => PDFLib.PDFDocument.load(out.bytes), isEncryptedError);
  await page.close();
});

test("protect refuses mismatched passwords and encrypted input", { skip }, async () => {
  let page = await protectFile(fx.plain, "abcdef12", { confirm: "different" });
  const st = await settle(page, "#protect-status");
  assert.equal(st.state, "error");
  assert.match(st.text, /do not match/);
  assert.equal(await page.evaluate(() => window.__downloads.length), 0);
  await page.close();

  const enc = await protectFile(fx.plain, "abcdef12");
  const out = await download(enc);
  await enc.close();
  const p = path.join(tmp, "enc2.pdf");
  fs.writeFileSync(p, out.bytes);
  page = await open("protect");
  await upload(page, "protect", p);
  await waitStatus(page, "#protect-status", /already password-protected/);
  assert.equal(await page.$eval("#protect-run", (b) => b.disabled), true);
  await page.close();
});

test("unlock reports an unprotected PDF", { skip }, async () => {
  const page = await open("unlock");
  await upload(page, "unlock", fx.plain);
  await waitStatus(page, "#unlock-status", /not protected/);
  assert.equal(await page.$eval("#unlock-run", (b) => b.disabled), true);
  await page.close();
});

test("repair fixes a damaged cross-reference table", { skip }, async () => {
  const page = await open("repair");
  await upload(page, "repair", fx.damaged);
  await page.waitForFunction(() => !document.getElementById("repair-run").disabled);
  await page.click("#repair-run");
  const st = await settle(page, "#repair-status");
  assert.equal(st.state, "ok", st.text);
  const out = await download(page);
  assert.equal(out.name, "damaged-repaired.pdf");
  const doc = await PDFLib.PDFDocument.load(out.bytes);
  assert.equal(doc.getPageCount(), 3);
  // The rewritten file must have a valid startxref that points at a real xref section.
  const s = out.bytes.toString("latin1");
  const off = Number(s.match(/startxref\s+(\d+)\s+%%EOF\s*$/)[1]);
  assert.match(s.slice(off, off + 40), /^(xref|\d+ \d+ obj)/);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("sign places a drawn signature as an image on the page", { skip }, async () => {
  const page = await open("sign");
  await page.setViewport({ width: 1000, height: 1400 });
  await upload(page, "sign", fx.plain);
  await page.waitForFunction(() => !document.getElementById("sign-work").classList.contains("is-hidden"));
  await page.waitForFunction(() => { const c = document.getElementById("sign-page"); return c && c.width > 10; });
  // Draw
  const box = await (await page.$("#sign-canvas")).boundingBox();
  await page.mouse.move(box.x + 30, box.y + 120);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(box.x + 30 + i * 12, box.y + 60 + Math.sin(i / 2) * 40, { steps: 2 });
  await page.mouse.up();
  await page.select("#sign-pen", "#1a47b8");
  await page.click("#sign-date");
  // Place on page 1 (rotated), then switch to page 3 and place again.
  const pb = await (await page.$("#sign-page")).boundingBox();
  await page.mouse.click(pb.x + pb.width * 0.5, pb.y + pb.height * 0.5);
  await page.waitForFunction(() => document.querySelectorAll("#sign-list .file-item").length === 1);
  await page.select("#sign-page-select", "3");
  await page.waitForFunction(() => document.querySelectorAll("#sign-overlays .sig-ph").length === 0);
  await new Promise((r) => setTimeout(r, 400));
  const pb3 = await (await page.$("#sign-page")).boundingBox();
  await page.mouse.click(pb3.x + pb3.width * 0.7, pb3.y + pb3.height * 0.8);
  await page.waitForFunction(() => document.querySelectorAll("#sign-list .file-item").length === 2);
  await page.click("#sign-save");
  await waitStatus(page, "#sign-status", /Saved with 2 signatures/);
  const out = await download(page);
  assert.equal(out.name, "plain-signed.pdf");
  const doc = await PDFLib.PDFDocument.load(out.bytes);
  assert.equal(doc.getPageCount(), 3);
  const imagesOn = (p) => {
    const xo = p.node.Resources().lookup(PDFLib.PDFName.of("XObject"));
    if (!xo) return 0;
    return xo.entries().filter(([, ref]) => {
      const o = doc.context.lookup(ref);
      return o && o.dict && String(o.dict.get(PDFLib.PDFName.of("Subtype"))) === "/Image";
    }).length;
  };
  assert.equal(imagesOn(doc.getPage(0)), 1);
  assert.equal(imagesOn(doc.getPage(1)), 0);
  assert.equal(imagesOn(doc.getPage(2)), 1);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("sign accepts a typed signature and can remove placements", { skip }, async () => {
  const page = await open("sign");
  await page.setViewport({ width: 1000, height: 1600 });
  await upload(page, "sign", fx.plain);
  await page.waitForFunction(() => !document.getElementById("sign-work").classList.contains("is-hidden"));
  await page.waitForFunction(() => document.getElementById("sign-page").width > 10);
  await page.click("#sign-mode-type");
  await page.type("#sign-text", "Kathan Somani");
  const pb = await (await page.$("#sign-page")).boundingBox();
  await page.mouse.click(pb.x + pb.width * 0.4, pb.y + pb.height * 0.4);
  await page.waitForFunction(() => document.querySelectorAll("#sign-list .file-item").length === 1);
  assert.equal(await page.$eval("#sign-save", (b) => b.disabled), false);
  await page.click("#sign-list .file-item button");
  await page.waitForFunction(() => document.querySelectorAll("#sign-list .file-item").length === 0);
  assert.equal(await page.$eval("#sign-save", (b) => b.disabled), true);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("other PDF tools point encrypted files to Unlock", { skip }, async () => {
  const enc = await protectFile(fx.plain, "abcdef12");
  const out = await download(enc);
  await enc.close();
  const p = path.join(tmp, "enc3.pdf");
  fs.writeFileSync(p, out.bytes);
  const page = await open("metadata");
  await upload(page, "metadata", p);
  const st = await settle(page, "#meta-status");
  assert.equal(st.state, "error");
  assert.match(st.text, /password-protected/);
  assert.equal(await page.$eval("#meta-status a", (a) => a.getAttribute("href")), "pdf.html#unlock");
  await page.close();
});
