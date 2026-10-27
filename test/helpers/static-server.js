// Minimal static file server for the end-to-end tests. It serves the repository root and
// sends the same Content-Security-Policy as production (read from netlify.toml), so a page
// that violates the CSP fails its tests.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
};

function productionCsp() {
  const toml = fs.readFileSync(path.join(ROOT, "netlify.toml"), "utf8");
  const m = toml.match(/^\s*Content-Security-Policy\s*=\s*"([^"]+)"/m);
  if (!m) throw new Error("Content-Security-Policy not found in netlify.toml");
  return m[1];
}

async function start() {
  const csp = productionCsp();
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const file = path.normalize(path.join(ROOT, urlPath === "/" ? "index.html" : urlPath));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
      "Content-Security-Policy": csp,
      "X-Content-Type-Options": "nosniff",
    });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

module.exports = { start, ROOT };
