const { test } = require("node:test");
const assert = require("node:assert/strict");
const C = require("../js/pdf-secure-core.js");

test("protectArgs builds AES-256 arguments with defaults", () => {
  const a = C.protectArgs({ userPassword: "pw", allowPrint: true, allowCopy: true, allowModify: false });
  assert.deepEqual(a, ["--encrypt", "pw", "pw", "256", "--print=full", "--extract=y", "--modify=none", "--", "/in.pdf", "/out.pdf"]);
});

test("protectArgs uses a separate owner password and restrictions", () => {
  const a = C.protectArgs({ userPassword: "open", ownerPassword: "owner", allowPrint: false, allowCopy: false, allowModify: true });
  assert.deepEqual(a.slice(0, 4), ["--encrypt", "open", "owner", "256"]);
  assert.ok(a.includes("--print=none") && a.includes("--extract=n") && a.includes("--modify=all"));
  assert.equal(a.indexOf("--"), a.length - 3);
});

test("protectArgs rejects an empty password", () => {
  assert.throws(() => C.protectArgs({ userPassword: "" }));
});

test("unlockArgs and repairArgs", () => {
  assert.deepEqual(C.unlockArgs("secret"), ["--password=secret", "--decrypt", "/in.pdf", "/out.pdf"]);
  assert.deepEqual(C.unlockArgs(""), ["--decrypt", "/in.pdf", "/out.pdf"]);
  assert.deepEqual(C.repairArgs(), ["/in.pdf", "/out.pdf"]);
});

test("exit codes, warnings and password errors", () => {
  assert.ok(C.isSuccessExit(0) && C.isSuccessExit(3));
  assert.ok(!C.isSuccessExit(2));
  assert.equal(C.countWarnings("WARNING: a\nfoo\nWARNING: b (offset 3)\nqpdf: operation succeeded with warnings"), 2);
  assert.equal(C.countWarnings(""), 0);
  assert.ok(C.isBadPassword("q: /in.pdf: invalid password"));
  assert.ok(!C.isBadPassword("fine"));
});

test("passwordStrength", () => {
  assert.equal(C.passwordStrength(""), "");
  assert.equal(C.passwordStrength("abc"), "Weak");
  assert.equal(C.passwordStrength("password123"), "Weak");
  assert.equal(C.passwordStrength("Abcdefg1"), "Fair");
  assert.equal(C.passwordStrength("Tr0ub4dor&Horse-Staple"), "Strong");
});

test("outputName", () => {
  assert.equal(C.outputName("Report.PDF", "protected"), "Report-protected.pdf");
  assert.equal(C.outputName("a/b.pdf", "signed"), "a_b-signed.pdf");
  assert.equal(C.outputName("", "repaired"), "document-repaired.pdf");
});

test("placementFromClick centres, keeps aspect and clamps", () => {
  const r = C.placementFromClick(300, 400, 600, 800, 3, 0.3);
  assert.ok(Math.abs(r.nw - 0.3) < 1e-9);
  assert.ok(Math.abs(r.nw * 600 / (r.nh * 800) - 3) < 1e-9);
  assert.ok(Math.abs(r.nx + r.nw / 2 - 0.5) < 1e-9 && Math.abs(r.ny + r.nh / 2 - 0.5) < 1e-9);
  const c = C.placementFromClick(0, 0, 600, 800, 3, 0.3);
  assert.equal(c.nx, 0); assert.equal(c.ny, 0);
  const d = C.placementFromClick(600, 800, 600, 800, 3, 0.3);
  assert.ok(Math.abs(d.nx + d.nw - 1) < 1e-9 && Math.abs(d.ny + d.nh - 1) < 1e-9);
});

// Independent forward model: where does pdf-lib's drawImage({x,y,width,height,rotate}) land in
// unrotated user space, and where is that on screen for a page displayed with rotation R?
function occupied(b) {
  const t = (b.rotate * Math.PI) / 180;
  const wd = [Math.cos(t), Math.sin(t)];
  const hd = [-Math.sin(t), Math.cos(t)];
  const pts = [[0, 0], [b.width, 0], [0, b.height], [b.width, b.height]].map(([a, c]) => [
    b.x + a * wd[0] + c * hd[0], b.y + a * wd[1] + c * hd[1]]);
  const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}
function toDisplay(x, y, W, H, R) {
  if (R === 0) return [x, H - y];
  if (R === 90) return [y, x];
  if (R === 180) return [W - x, y];
  return [H - y, W - x];
}

test("toPdfImageBox is consistent with on-screen placement for every rotation", () => {
  const view = { x0: 0, y0: 0, width: 600, height: 800 };
  const rect = { nx: 0.1, ny: 0.2, nw: 0.3, nh: 0.1 };
  for (const R of [0, 90, 180, 270]) {
    const dispW = R % 180 ? 800 : 600; const dispH = R % 180 ? 600 : 800;
    const box = C.toPdfImageBox(rect, view, R);
    assert.equal(box.rotate, R);
    assert.ok(Math.abs(box.width - rect.nw * dispW) < 1e-9 && Math.abs(box.height - rect.nh * dispH) < 1e-9);
    const o = occupied(box);
    const [ax, ay] = toDisplay(o.minX, o.minY, 600, 800, R);
    const [bx, by] = toDisplay(o.maxX, o.maxY, 600, 800, R);
    const left = Math.min(ax, bx); const right = Math.max(ax, bx);
    const top = Math.min(ay, by); const bottom = Math.max(ay, by);
    assert.ok(Math.abs(left - rect.nx * dispW) < 1e-6, `left R=${R}`);
    assert.ok(Math.abs(right - (rect.nx + rect.nw) * dispW) < 1e-6, `right R=${R}`);
    assert.ok(Math.abs(top - rect.ny * dispH) < 1e-6, `top R=${R}`);
    assert.ok(Math.abs(bottom - (rect.ny + rect.nh) * dispH) < 1e-6, `bottom R=${R}`);
  }
});

test("toPdfImageBox honours the page box origin and negative rotation", () => {
  const b = C.toPdfImageBox({ nx: 0, ny: 0, nw: 0.5, nh: 0.5 }, { x0: 10, y0: 20, width: 100, height: 200 }, 0);
  assert.deepEqual([b.x, b.y, b.width, b.height], [10, 20 + 100, 50, 100]);
  assert.equal(C.toPdfImageBox({ nx: 0, ny: 0, nw: 1, nh: 1 }, { x0: 0, y0: 0, width: 1, height: 1 }, -90).rotate, 270);
});

test("previewScale and inkBounds", () => {
  assert.equal(C.previewScale(600, 800, 300, 0), 0.5);
  assert.equal(C.previewScale(600, 800, 3000, 0), 3);
  assert.equal(C.previewScale(600, 800, 600, 400), 0.5);
  const px = new Uint8Array(10 * 10 * 4);
  px[(3 * 10 + 4) * 4 + 3] = 255; px[(5 * 10 + 6) * 4 + 3] = 255;
  assert.deepEqual(C.inkBounds(px, 10, 10, 0), { x: 4, y: 3, width: 3, height: 3 });
  assert.deepEqual(C.inkBounds(px, 10, 10, 1), { x: 3, y: 2, width: 5, height: 5 });
  assert.equal(C.inkBounds(new Uint8Array(40), 10, 1, 0), null);
});

test("formatDate", () => {
  assert.equal(C.formatDate(new Date(2026, 0, 5)), "2026-01-05");
});
