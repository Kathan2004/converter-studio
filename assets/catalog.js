/*
 * The tool catalog: one entry per tool. The home page, the search palette, the sidebars and
 * the drop-a-file suggestions all read from here, so names and descriptions stay consistent.
 * Exposes window.Catalog (and module.exports for Node tests).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Catalog = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // tint: the icon colour family (Apple system colours), see .tint-* in shared.css.
  const CATEGORIES = [
    { id: "pdf", name: "PDF", page: "pdf.html", tint: "red" },
    { id: "images", name: "Images", page: "images.html", tint: "orange" },
    { id: "data", name: "Data", page: "data.html", tint: "green" },
    { id: "documents", name: "Docs", page: "documents.html", tint: "blue" },
    { id: "files", name: "Files", page: "files.html", tint: "gray" },
  ];

  const IMG = ["png", "jpg", "jpeg", "webp", "avif", "gif", "bmp", "svg", "ico"];
  const RASTER = ["png", "jpg", "jpeg", "webp", "avif", "gif", "bmp"];

  // accepts: file extensions this tool can take straight from the home-page drop zone.
  // multi: the tool benefits from several files at once (ranked higher when several are dropped).
  const TOOLS = [
    { cat: "pdf", tab: "compress", name: "Compress PDF", desc: "Shrink scans and exports", accepts: ["pdf"], short: "Compress", tile: "Compress PDF", icon: "compress", featured: true, keywords: "reduce size smaller optimize" },
    { cat: "pdf", tab: "merge", name: "Merge PDF", desc: "Combine PDFs and images", accepts: ["pdf", "jpg", "jpeg", "png"], multi: true, short: "Merge", tile: "Merge PDF", icon: "merge", featured: true, keywords: "combine join append" },
    { cat: "pdf", tab: "split", name: "Split PDF", desc: "By ranges or every N pages", accepts: ["pdf"], short: "Split", tile: "Split PDF", icon: "split", featured: true, keywords: "extract separate pages" },
    { cat: "pdf", tab: "pages", name: "Edit PDF pages", desc: "Reorder, rotate, delete", accepts: ["pdf"], short: "Edit pages", tile: "Edit pages", icon: "pages", keywords: "reorder rotate delete organize remove" },
    { cat: "pdf", tab: "images-to-pdf", name: "Images to PDF", desc: "One image per page", accepts: RASTER, multi: true, short: "Images to PDF", tile: "Images to PDF", icon: "topdf", keywords: "jpg png to pdf scan photos" },
    { cat: "pdf", tab: "pdf-to-images", name: "PDF to images", desc: "PNG or JPEG per page", accepts: ["pdf"], short: "To images", tile: "PDF to images", icon: "image", keywords: "pdf to jpg png render" },
    { cat: "pdf", tab: "stamp", name: "Watermark and page numbers", desc: "Stamp or rotate every page", accepts: ["pdf"], short: "Watermark", tile: "Watermark", icon: "drop", keywords: "watermark page numbers rotate stamp" },
    { cat: "pdf", tab: "metadata", name: "PDF metadata", desc: "View, edit or wipe", accepts: ["pdf"], short: "Metadata", tile: "PDF info", icon: "info", keywords: "author title properties privacy" },

    { cat: "images", tab: "compress", name: "Compress images", desc: "Quality or target size", accepts: IMG, multi: true, short: "Compress", tile: "Compress image", icon: "image", featured: true, keywords: "reduce size optimize jpg png webp" },
    { cat: "images", tab: "convert", name: "Convert images", desc: "PNG, JPEG, WebP, AVIF, ICO", accepts: IMG, multi: true, short: "Convert", tile: "Convert image", icon: "convert", featured: true, keywords: "png to jpg webp avif favicon ico svg" },
    { cat: "images", tab: "resize", name: "Resize images", desc: "Pixels, percent or fit", accepts: IMG, multi: true, short: "Resize", tile: "Resize", icon: "resize", featured: true, keywords: "scale dimensions width height" },
    { cat: "images", tab: "transform", name: "Crop and rotate", desc: "Ratios, flips, quarter turns", accepts: IMG, multi: true, short: "Crop and rotate", tile: "Crop", icon: "crop", keywords: "crop rotate flip aspect" },
    { cat: "images", tab: "ocr", name: "Image to text (OCR)", desc: "Paste a screenshot, copy its text", accepts: RASTER, multi: true, short: "Image to text", tile: "Image to text", icon: "scan", featured: true, keywords: "ocr extract text screenshot read scan copy" },
    { cat: "images", tab: "metadata", name: "Remove photo metadata", desc: "EXIF and GPS, lossless", accepts: IMG, multi: true, short: "Remove metadata", tile: "Remove EXIF", icon: "shield", keywords: "exif gps location privacy strip clean" },
    { cat: "images", tab: "base64", name: "Image to Base64", desc: "Data URLs both ways", accepts: IMG, short: "Base64", tile: "Base64", icon: "code", keywords: "base64 data url encode decode" },

    { cat: "data", tab: "convert", name: "Convert data", desc: "JSON, CSV, Excel, YAML, XML", accepts: ["json", "csv", "tsv", "xlsx", "yaml", "yml", "xml", "md", "html", "htm"], multi: true, short: "Convert", tile: "Convert data", icon: "braces", featured: true, keywords: "json csv yaml xml tsv excel table" },
    { cat: "data", tab: "json-to-excel", name: "JSON to Excel report", desc: "Styled sheet with summary", accepts: ["json"], multi: true, short: "JSON to Excel", tile: "JSON to Excel", icon: "table", featured: true, keywords: "json xlsx spreadsheet export sentinel" },
    { cat: "data", tab: "excel-to-data", name: "Excel to JSON or CSV", desc: "Any sheet, header row", accepts: ["xlsx"], short: "Excel to JSON", tile: "Excel to JSON", icon: "table", keywords: "xlsx spreadsheet json csv" },
    { cat: "data", tab: "format", name: "Validate and format", desc: "JSON, YAML, XML errors", accepts: ["json", "yaml", "yml", "xml"], short: "Validate", tile: "Validate", icon: "check", keywords: "lint pretty print minify beautify validator" },
    { cat: "data", tab: "diff", name: "Compare JSON", desc: "Added, removed, changed", accepts: ["json", "yaml", "yml"], short: "Compare", tile: "Compare JSON", icon: "diff", keywords: "diff compare difference" },

    { cat: "documents", tab: "md-to-pdf", name: "Markdown to PDF", desc: "Selectable text, page numbers", accepts: ["md", "markdown"], multi: true, short: "Markdown to PDF", tile: "Markdown to PDF", icon: "doc", featured: true, keywords: "markdown pdf export print" },
    { cat: "documents", tab: "md-to-docx", name: "Markdown to Word", desc: "Headings, lists, tables", accepts: ["md", "markdown"], multi: true, short: "Markdown to Word", tile: "Markdown to Word", icon: "doc", keywords: "markdown docx word" },
    { cat: "documents", tab: "md-to-html", name: "Markdown to HTML", desc: "Standalone page with TOC", accepts: ["md", "markdown"], multi: true, short: "Markdown to HTML", tile: "Markdown to HTML", icon: "code", keywords: "markdown html web page" },
    { cat: "documents", tab: "docx-to", name: "Word to Markdown", desc: "Or HTML or plain text", accepts: ["docx"], multi: true, short: "Word to Markdown", tile: "Word to Markdown", icon: "lines", featured: true, keywords: "docx word markdown html text" },
    { cat: "documents", tab: "html-to-md", name: "HTML to Markdown", desc: "Clean GitHub-style Markdown", accepts: ["html", "htm"], multi: true, short: "HTML to Markdown", tile: "HTML to Markdown", icon: "lines", keywords: "html markdown turndown" },
    { cat: "documents", tab: "pdf-to-text", name: "PDF to text", desc: "Text layer, page by page", accepts: ["pdf"], multi: true, short: "PDF to text", tile: "PDF to text", icon: "scan", keywords: "pdf text extract copy" },
    { cat: "documents", tab: "word-to-pdf", name: "Word to PDF", desc: "DOCX to a clean PDF", accepts: ["docx"], multi: true, short: "Word to PDF", tile: "Word to PDF", icon: "doc", keywords: "docx word pdf convert export" },
    { cat: "documents", tab: "html-to-pdf", name: "HTML to PDF", desc: "Web page file to PDF", accepts: ["html", "htm"], multi: true, short: "HTML to PDF", tile: "HTML to PDF", icon: "code", keywords: "html web page pdf convert print" },
    { cat: "documents", tab: "ocr-pdf", name: "Searchable PDF", desc: "OCR a scan into selectable text", accepts: ["pdf", "png", "jpg", "jpeg"], multi: true, short: "Searchable PDF", tile: "Searchable PDF", icon: "scan", keywords: "ocr scan searchable text layer pdf" },
    { cat: "documents", tab: "text-tools", name: "Text utilities", desc: "Case, Base64, URL, counts", accepts: ["txt", "md", "csv", "log"], short: "Text tools", tile: "Text tools", icon: "type", keywords: "uppercase lowercase word count base64 url encode dedupe sort" },
    { cat: "documents", page: "markdown.html", tab: "pipeline", name: "Markdown to JSON or Excel", desc: "Batch files for AI pipelines", accepts: ["md", "markdown"], multi: true, short: "Markdown to JSON", tile: "Markdown to JSON", icon: "braces", keywords: "markdown json excel ai ingestion batch" },

    { cat: "files", tab: "zip", name: "Compress files to ZIP", desc: "Real deflate, folders, levels", accepts: ["*"], multi: true, short: "Zip", tile: "Zip files", icon: "zip", featured: true, keywords: "zip compress archive folder pack" },
    { cat: "files", tab: "unzip", name: "Extract ZIP", desc: "Browse and pick files", accepts: ["zip"], short: "Unzip", tile: "Unzip", icon: "unzip", keywords: "unzip extract open archive" },
    { cat: "files", tab: "gzip", name: "Gzip and gunzip", desc: "Single-file .gz", accepts: ["*"], short: "Gzip", tile: "Gzip", icon: "zip", keywords: "gz gzip gunzip compress decompress" },
    { cat: "files", tab: "hash", name: "File hash", desc: "SHA-256, SHA-1, MD5", accepts: ["*"], multi: true, short: "Hash", tile: "File hash", icon: "hash", keywords: "checksum sha256 md5 sha1 integrity verify" },
  ];

  const byCat = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));
  TOOLS.forEach((t) => {
    t.page = t.page || byCat[t.cat].page;
    t.href = `${t.page}#${t.tab}`;
    t.id = `${t.cat}/${t.tab}`;
    t.tint = ["images/ocr", "documents/pdf-to-text", "documents/ocr-pdf"].includes(t.id) ? "purple" : byCat[t.cat].tint;
  });

  function extOf(name) {
    const n = String(name || "").toLowerCase();
    const dot = n.lastIndexOf(".");
    return dot > 0 ? n.slice(dot + 1) : "";
  }

  /** Tools that accept every one of the given file names, most specific first. */
  function suggest(fileNames) {
    const exts = [...new Set(fileNames.map(extOf))];
    if (!exts.length) return [];
    const many = fileNames.length > 1;
    const scored = [];
    TOOLS.forEach((t, order) => {
      const wildcard = t.accepts.includes("*");
      if (!wildcard && !exts.every((e) => t.accepts.includes(e))) return;
      let score = wildcard ? 1 : 10;
      if (many && t.multi) score += 3;
      if (!many && !t.multi) score += 1;
      scored.push({ t, score, order });
    });
    return scored.sort((a, b) => b.score - a.score || a.order - b.order).map((s) => s.t);
  }

  /** Rank tools for a search query (name > keywords > description > category). */
  function search(query) {
    const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return TOOLS.slice();
    const results = [];
    TOOLS.forEach((t, order) => {
      const name = t.name.toLowerCase();
      const hay = `${name} ${t.keywords} ${t.desc.toLowerCase()} ${byCat[t.cat].name.toLowerCase()} ${t.accepts.join(" ")}`;
      let score = 0;
      for (const w of words) {
        if (!hay.includes(w)) return;
        if (name.startsWith(w)) score += 6;
        else if (new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(name)) score += 4;
        else if (t.keywords.includes(w)) score += 2;
        else score += 1;
      }
      results.push({ t, score, order });
    });
    return results.sort((a, b) => b.score - a.score || a.order - b.order).map((r) => r.t);
  }

  function find(page, tab) {
    return TOOLS.find((t) => t.page === page && t.tab === tab) || null;
  }

  return { CATEGORIES, TOOLS, byCat, suggest, search, find, extOf };
});
