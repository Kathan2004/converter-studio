/*
 * Pure helpers for the QR code tool: Wi-Fi and e-mail payload builders (with escaping),
 * module matrix -> SVG, and URL detection. No DOM access.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.QrCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /** Escape the characters that are special in the WIFI: payload grammar. */
  const BS = String.fromCharCode(92);
  const WIFI_SPECIAL = new RegExp("([" + BS + BS + ";,:\"])", "g");
  function escapeWifi(value) {
    return String(value ?? "").replace(WIFI_SPECIAL, (m) => BS + m);
  }

  /** WIFI:T:<WPA|WEP|nopass>;S:<ssid>;P:<password>;H:true;; */
  function wifiPayload({ ssid, password, security, hidden }) {
    const sec = security === "WEP" ? "WEP" : security === "nopass" || security === "none" ? "nopass" : "WPA";
    let out = `WIFI:T:${sec};S:${escapeWifi(ssid)};`;
    if (sec !== "nopass") out += `P:${escapeWifi(password)};`;
    if (hidden) out += "H:true;";
    return `${out};`;
  }

  /** mailto: URI; subject and body are percent-encoded, CR/LF normalised to %0D%0A. */
  function emailPayload({ to, subject, body }) {
    const addr = String(to || "").trim().replace(/[\s<>"]/g, "");
    const enc = (s) => encodeURIComponent(String(s).replace(/\r?\n/g, "\r\n"));
    const params = [];
    if (subject) params.push(`subject=${enc(subject)}`);
    if (body) params.push(`body=${enc(body)}`);
    return `mailto:${addr}${params.length ? `?${params.join("&")}` : ""}`;
  }

  const COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
  const safeColor = (c, fallback) => (COLOR_RE.test(String(c)) ? String(c) : fallback);

  /**
   * Build an SVG from a module matrix (array of rows of truthy/falsy) or { count, isDark(r, c) }.
   * Dark modules are merged into horizontal runs inside a single path.
   */
  function matrixToSvg(matrix, opts) {
    const o = opts || {};
    const margin = o.margin ?? 4;
    const fg = safeColor(o.fg, "#000000");
    const bg = safeColor(o.bg, "#ffffff");
    const count = Array.isArray(matrix) ? matrix.length : matrix.count;
    const dark = Array.isArray(matrix) ? (r, c) => Boolean(matrix[r][c]) : (r, c) => Boolean(matrix.isDark(r, c));
    const total = count + margin * 2;
    let d = "";
    for (let r = 0; r < count; r++) {
      let c = 0;
      while (c < count) {
        if (!dark(r, c)) { c++; continue; }
        let end = c;
        while (end < count && dark(r, end)) end++;
        d += `M${c + margin} ${r + margin}h${end - c}v1h${c - end}z`;
        c = end;
      }
    }
    const px = o.size ? ` width="${Math.round(o.size)}" height="${Math.round(o.size)}"` : "";
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}"${px} shape-rendering="crispEdges">` +
      `<rect width="${total}" height="${total}" fill="${bg}"/><path d="${d}" fill="${fg}"/></svg>`;
  }

  /** Extract the module matrix from a qrcode-generator object. */
  function matrixFromQr(qr) {
    const n = qr.getModuleCount();
    const rows = [];
    for (let r = 0; r < n; r++) {
      const row = [];
      for (let c = 0; c < n; c++) row.push(qr.isDark(r, c));
      rows.push(row);
    }
    return rows;
  }

  /** True only for http(s) URLs; used to decide whether to offer an Open link. */
  function isHttpUrl(text) {
    const s = String(text || "").trim();
    if (/\s/.test(s)) return false;
    try { const u = new URL(s); return u.protocol === "http:" || u.protocol === "https:"; } catch (e) { return false; }
  }

  return { escapeWifi, wifiPayload, emailPayload, matrixToSvg, matrixFromQr, isHttpUrl, safeColor };
});
