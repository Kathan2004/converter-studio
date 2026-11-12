const { test } = require("node:test");
const assert = require("node:assert/strict");
const Q = require("../js/qr-core.js");

const BS = String.fromCharCode(92); // backslash
test("wifi payload escapes special characters", () => {
  const raw = "a" + BS + "b;c,d:e\"f";
  assert.equal(Q.escapeWifi(raw), "a" + BS + BS + "b" + BS + ";c" + BS + ",d" + BS + ":e" + BS + '"f');
  assert.equal(
    Q.wifiPayload({ ssid: "My;Net", password: 'p:w"d,' + BS, security: "WPA", hidden: false }),
    "WIFI:T:WPA;S:My" + BS + ";Net;P:p" + BS + ":w" + BS + '"d' + BS + "," + BS + BS + ";;",
  );
});

test("wifi payload: hidden flag, open and WEP networks", () => {
  assert.equal(Q.wifiPayload({ ssid: "x", password: "y", security: "WPA", hidden: true }), "WIFI:T:WPA;S:x;P:y;H:true;;");
  assert.equal(Q.wifiPayload({ ssid: "open", password: "ignored", security: "nopass" }), "WIFI:T:nopass;S:open;;");
  assert.equal(Q.wifiPayload({ ssid: "w", password: "k", security: "WEP" }), "WIFI:T:WEP;S:w;P:k;;");
});

test("email payload encodes subject and body", () => {
  assert.equal(Q.emailPayload({ to: "a@b.com" }), "mailto:a@b.com");
  assert.equal(
    Q.emailPayload({ to: " a@b.com ", subject: "Hi & bye", body: "line1\nline2" }),
    "mailto:a@b.com?subject=Hi%20%26%20bye&body=line1%0D%0Aline2",
  );
  assert.equal(Q.emailPayload({ to: 'x"<y>@z.com' }), "mailto:xy@z.com");
});

test("matrix to SVG", () => {
  const m = [[1, 1, 0], [0, 1, 0], [1, 0, 1]];
  const svg = Q.matrixToSvg(m, { margin: 1, fg: "#112233", bg: "#fff" });
  assert.match(svg, /viewBox="0 0 5 5"/);
  assert.ok(svg.includes('fill="#112233"') && svg.includes('fill="#fff"'));
  assert.ok(svg.includes("M1 1h2v1h-2z")); // run of two modules in row 0
  assert.ok(svg.includes("M2 2h1v1h-1z"));
  assert.equal((svg.match(/M\d/g) || []).length, 4);
});

test("matrix to SVG rejects unsafe colours and accepts an object matrix", () => {
  const svg = Q.matrixToSvg({ count: 1, isDark: () => true }, { margin: 0, fg: '"/><script>', bg: "red" });
  assert.ok(!svg.includes("script"));
  assert.ok(svg.includes('fill="#000000"') && svg.includes('fill="#ffffff"'));
  assert.match(Q.matrixToSvg([[1]], { size: 200 }), /width="200" height="200"/);
});

test("URL detection only accepts http(s)", () => {
  assert.ok(Q.isHttpUrl("https://example.com/a?b=1"));
  assert.ok(Q.isHttpUrl("http://x.org"));
  assert.ok(!Q.isHttpUrl("javascript:alert(1)"));
  assert.ok(!Q.isHttpUrl("hello world"));
  assert.ok(!Q.isHttpUrl("https://a.com has spaces"));
  assert.ok(!Q.isHttpUrl("WIFI:T:WPA;S:x;;"));
});

test("matrixFromQr reads a qrcode-generator object", () => {
  const qr = { getModuleCount: () => 2, isDark: (r, c) => r === c };
  assert.deepEqual(Q.matrixFromQr(qr), [[true, false], [false, true]]);
});
