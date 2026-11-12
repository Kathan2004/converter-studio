/* Pure logic for the Protect / Unlock / Repair / Sign PDF tools (no DOM access at load time). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PdfSecureCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const IN = "/in.pdf";
  const OUT = "/out.pdf";

  // ---------- qpdf argument building ----------

  /** AES-256 encryption. The permissions (owner) password falls back to the open password. */
  function protectArgs(opts) {
    const o = opts || {};
    const user = String(o.userPassword || "");
    if (!user) throw new Error("Enter a password.");
    const owner = String(o.ownerPassword || "") || user;
    return [
      "--encrypt", user, owner, "256",
      o.allowPrint ? "--print=full" : "--print=none",
      o.allowCopy ? "--extract=y" : "--extract=n",
      o.allowModify ? "--modify=all" : "--modify=none",
      "--", IN, OUT,
    ];
  }

  function unlockArgs(password) {
    const args = [];
    if (password) args.push("--password=" + password);
    args.push("--decrypt", IN, OUT);
    return args;
  }

  function repairArgs() {
    return [IN, OUT];
  }

  // ---------- qpdf output handling ----------

  /** qpdf exits 0 (clean) or 3 (warnings, output written); 2 means an error. */
  function isSuccessExit(code) {
    return code === 0 || code === 3;
  }

  function countWarnings(text) {
    return String(text || "").split(/\r?\n/).filter((l) => /^(qpdf: )?WARNING\b/i.test(l.trim())).length;
  }

  function isBadPassword(text) {
    return /invalid password/i.test(String(text || ""));
  }

  // ---------- Passwords and names ----------

  /** Short label for the strength hint. Never stores or returns the password itself. */
  function passwordStrength(pw) {
    const s = String(pw || "");
    if (!s) return "";
    let score = 0;
    if (s.length >= 8) score++;
    if (s.length >= 12) score++;
    if (/[a-z]/.test(s) && /[A-Z]/.test(s)) score++;
    if (/\d/.test(s)) score++;
    if (/[^A-Za-z0-9]/.test(s)) score++;
    if (/^(.)\1+$/.test(s) || /^(password|12345678|qwertyui)/i.test(s)) score = 0;
    if (score <= 2) return "Weak";
    if (score === 3) return "Fair";
    return "Strong";
  }

  /** "report.pdf" + "protected" -> "report-protected.pdf" */
  function outputName(name, suffix) {
    const base = String(name || "document").replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|]+/g, "_") || "document";
    return `${base}-${suffix}.pdf`;
  }

  // ---------- Signature placement ----------

  /**
   * Place a signature on the preview. Click position (px within the displayed page) becomes the
   * centre of the box; the box is `widthFrac` of the page width and keeps the signature aspect.
   * Returns a normalized rect (fractions of the displayed page, top-left origin), clamped to the page.
   */
  function placementFromClick(clickX, clickY, dispW, dispH, aspect, widthFrac) {
    let nw = Math.min(Math.max(widthFrac, 0.02), 1);
    let nh = (nw * dispW) / (aspect * dispH);
    if (nh > 1) { nh = 1; nw = (nh * aspect * dispH) / dispW; }
    const nx = Math.min(Math.max(clickX / dispW - nw / 2, 0), 1 - nw);
    const ny = Math.min(Math.max(clickY / dispH - nh / 2, 0), 1 - nh);
    return { nx, ny, nw, nh };
  }

  /**
   * Map a normalized rect on the displayed (rotated) page to pdf-lib drawImage options.
   * view: { x0, y0, width, height } = the unrotated page box in PDF user space.
   * rotation: page /Rotate in degrees (0, 90, 180, 270), clockwise as displayed.
   * The image is rotated so it appears upright on screen.
   */
  function toPdfImageBox(rect, view, rotation) {
    const R = (((Math.round((rotation || 0) / 90) * 90) % 360) + 360) % 360;
    const W = view.width;
    const H = view.height;
    const dispW = R % 180 ? H : W;
    const dispH = R % 180 ? W : H;
    const u = rect.nx * dispW;
    const v = rect.ny * dispH;
    const w = rect.nw * dispW;
    const h = rect.nh * dispH;
    const ox = view.x0 || 0;
    const oy = view.y0 || 0;
    let x, y;
    if (R === 0) { x = u; y = H - v - h; }
    else if (R === 90) { x = v + h; y = u; }
    else if (R === 180) { x = W - u; y = v + h; }
    else { x = W - v - h; y = H - u; }
    return { x: x + ox, y: y + oy, width: w, height: h, rotate: R };
  }

  /** Pixel size for the preview canvas: fit the container width, never upscale beyond maxScale. */
  function previewScale(pageW, pageH, containerW, maxH) {
    const byW = containerW / pageW;
    const byH = maxH ? maxH / pageH : Infinity;
    return Math.max(0.1, Math.min(byW, byH, 3));
  }

  /** Bounding box of drawn ink (non-transparent pixels) so the saved PNG has no empty margin. */
  function inkBounds(rgba, width, height, pad) {
    let minX = width, minY = height, maxX = -1, maxY = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (rgba[(y * width + x) * 4 + 3] > 8) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    const p = pad || 0;
    minX = Math.max(0, minX - p); minY = Math.max(0, minY - p);
    maxX = Math.min(width - 1, maxX + p); maxY = Math.min(height - 1, maxY + p);
    return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  }

  function formatDate(d) {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  return {
    IN, OUT,
    protectArgs, unlockArgs, repairArgs,
    isSuccessExit, countWarnings, isBadPassword,
    passwordStrength, outputName,
    placementFromClick, toPdfImageBox, previewScale, inkBounds, formatDate,
  };
});
