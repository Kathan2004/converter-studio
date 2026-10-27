// End-to-end smoke tests for every converter page in headless Chromium.
// Runs when CHROMIUM_PATH points to a Chrome/Chromium binary (set in CI); skipped otherwise.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const staticServer = require("./helpers/static-server");

const CHROME = process.env.CHROMIUM_PATH;
const skip = !CHROME || !fs.existsSync(CHROME) ? "CHROMIUM_PATH not set" : false;

let server;
let browser;
let base;

before(async () => {
  if (skip) return;
  server = await staticServer.start();
  base = server.base;
  const puppeteer = require("puppeteer-core");
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"],
  });
});

after(async () => {
  if (browser) await browser.close();
  if (server) server.close();
});

/** Open a page, collect console errors and failed requests (ignoring external font CDNs). */
async function open(name) {
  const page = await browser.newPage();
  const errors = [];
  // Only same-origin requests are allowed; the external font stylesheet is aborted so the
  // test is deterministic offline. Any other off-origin request is reported as a failure.
  await page.setRequestInterception(true);
  page.on("request", (r) => {
    const url = r.url();
    if (url.startsWith(base) || url.startsWith("data:") || url.startsWith("blob:")) r.continue();
    else if (/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(url)) r.abort();
    else { errors.push(`external request: ${url}`); r.abort(); }
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/^Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  page.on("requestfailed", (r) => { if (r.url().startsWith(base)) errors.push(`requestfailed: ${r.url()}`); });
  await page.goto(`${base}/${name}`, { waitUntil: "networkidle0" });
  return { page, errors };
}

for (const name of ["index.html", "data.html", "documents.html", "images.html", "pdf.html"]) {
  test(`${name} loads, every tab opens, no errors`, { skip }, async () => {
    const { page, errors } = await open(name);
    const tabs = await page.$$eval("#tabs button[data-tab]", (b) => b.map((x) => x.dataset.tab));
    if (name !== "index.html") assert.ok(tabs.length >= 4, `expected tabs on ${name}`);
    for (const id of tabs) {
      await page.click(`#tabs button[data-tab="${id}"]`);
      const visible = await page.$eval(`[data-panel="${id}"]`, (el) => !el.classList.contains("is-hidden") && el.offsetParent !== null);
      assert.ok(visible, `panel ${id} visible on ${name}`);
    }
    const navLinks = await page.$$eval(".site-links a", (a) => a.length);
    assert.equal(navLinks, 5);
    assert.deepEqual(errors, []);
    await page.close();
  });
}
