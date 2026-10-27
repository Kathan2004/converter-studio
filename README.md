# Converter Studio

Browser-based converters and compressors for Markdown, data, documents, images and PDFs. Every conversion runs locally in the browser: files are never uploaded, and all libraries are served from this repository (no third-party CDN). It is hosted on Netlify.

## Version

- Current version: `2.1.0`
- Release tag: `v2.1.0`

## How it works

- **Home page.** Drop any file (or paste a screenshot) and pick from the tools that accept it; the tool opens with the file already loaded. Popular tools are one click away, and "All tools" shows the rest.
- **Search.** Press `Ctrl K` (or `/`) on any page to jump to any tool by name, format or keyword.
- **Tool pages.** Each category page has a sidebar with one entry per tool. Dropping a file anywhere on the page loads it into the open tool.
- **Deep links.** Every tool has a URL, for example `pdf.html#compress` or `images.html#ocr`.

## Tools

| Category | Tools |
|---|---|
| PDF (`pdf.html`) | Compress (lossless or rasterised), merge PDFs and images, split, edit pages (reorder, rotate, delete), images to PDF, PDF to images, watermark and page numbers, metadata |
| Images (`images.html`) | Compress (quality or target size), convert (PNG, JPEG, WebP, AVIF, ICO), resize, crop and rotate, **image to text (OCR)**, remove EXIF/GPS metadata, Base64 |
| Data (`data.html`) | Convert between JSON, CSV, TSV, Excel, YAML, XML and Markdown or HTML tables; JSON to styled Excel report; Excel to JSON or CSV; validate and format; compare JSON |
| Documents (`documents.html`, `markdown.html`) | Markdown to PDF, Word or HTML; Word to Markdown; HTML to Markdown; PDF to text; text utilities; batch Markdown to JSON or Excel for AI pipelines |
| Files (`files.html`) | **ZIP files and folders** (real deflate, levels 0 to 9, already-compressed formats stored), **extract ZIP** (browse, preview, pick files), gzip and gunzip, **file hashes** (MD5, SHA-1, SHA-256, SHA-512 with expected-hash check) |

OCR uses Tesseract (WebAssembly) with the English model bundled. It reads pasted screenshots, images and scanned PDFs, page by page.

## Project Structure

- `index.html`, `js/home.js`: home page (drop or paste a file, popular tools, all tools)
- `assets/catalog.js`: the single list of tools (names, icons, colours, accepted file types) that the home page, search, sidebars and file suggestions all read
- `assets/shared.js`, `assets/shared.css`: header, search palette, sidebar layout, page-wide drop, file handoff, zip writer and the "Glass" theme (light and dark)
- `markdown.html`, `js/pipeline.js`: batch Markdown to JSON or Excel
- `<category>.html`, `js/<category>.js`, `js/<category>-core.js`: each category page, its UI wiring, and its pure logic (unit tested in Node)
- `vendor/`: pinned browser libraries, listed in [vendor/VERSIONS.md](vendor/VERSIONS.md)
- `netlify/functions/md_to_pdf.js`: serverless Markdown rendering function (API below)

## Local Development

```bash
npm install
npm run dev        # Netlify dev server
```

The pages are static, so any static file server works, for example `npx serve .`.

## API Request Contract

POST to `/.netlify/functions/md_to_pdf`

```json
{
  "title": "quick-report",
  "markdown": "# Hello\n\nSample content",
  "includeToc": true,
  "tocDepth": 2,
  "outputFormat": "html"
}
```

## Deployment

- Build command: none required
- Publish directory: repository root
- Functions directory: `netlify/functions`

See [docs/netlify-deploy.md](docs/netlify-deploy.md) for deployment steps and [docs/desktop-watcher.md](docs/desktop-watcher.md) for the offline `mdconverter.py` folder watcher.

## Security

**Converter pages (client side)**

- **Local processing.** Files are processed in the browser with `File`, canvas, Web Crypto and the vendored libraries. Nothing is uploaded. A file chosen on the home page reaches its tool through the browser's own IndexedDB storage, and is deleted as soon as the tool reads it (or after two minutes).
- **Scripts.** Pages load scripts only from their own origin. A Content-Security-Policy in `netlify.toml` enforces this. `'wasm-unsafe-eval'` is allowed solely so the OCR engine's WebAssembly can compile; `eval` itself stays blocked.
- **HTML rendering.** Rendered HTML (Markdown, Word and HTML input) goes through DOMPurify before it is displayed or exported. Data previews are escaped.
- **CSV and Excel injection.** Cells beginning with `=`, `+`, `-`, `@`, tab or carriage return are prefixed with `'` by default, so exported sheets cannot run formulas.
- **XML.** XML is parsed with the browser's `DOMParser`, which does not resolve external entities.
- **Encrypted PDFs.** These are detected and rejected with a clear message. Nothing tries to bypass protection.
- **Archives.** Archive entry names are sanitised (no absolute paths or `..`). Archives that would expand past 2 GB, hold more than 20,000 entries, or compress any entry over 1000:1 are refused as likely zip bombs.
- **Metadata stripping.** EXIF/GPS and PNG text chunks are removed directly from JPEG and PNG bytes, without re-encoding. GPS data is flagged as a privacy warning.

**Serverless function**

The function renders untrusted Markdown in headless Chromium and treats every document as hostile:

- **Raw HTML.** Raw HTML in Markdown is escaped, not rendered.
- **Links and images.** Only `http(s)`, `mailto` and in-page anchors survive as links. Images are replaced by their alt text and are never fetched.
- **Renderer sandbox.** Chromium runs with JavaScript disabled and request interception that blocks everything except `data:` URLs.
- **Input and output.** Input is capped at 500,000 characters, and download filenames are sanitised.
- **Errors.** Error responses do not leak internal error messages.

## Tests

```bash
npm test                                   # unit tests for every core module
CHROMIUM_PATH=/path/to/chrome npm test     # adds end-to-end browser tests
```

With `CHROMIUM_PATH` set, the end-to-end tests drive every tool in headless Chromium. They verify each output by parsing it back: page counts with pdf-lib, workbook styling with ExcelJS, and image signatures, dimensions and metadata removal. CI runs the full suite on every push.

## Known Limitations

- Large files are bounded by browser memory (200 MB per file cap).
- PDF to text reads the text layer only. Use Image to text (OCR) for scanned PDFs.
- OCR bundles English only.
- Rasterised PDF compression makes text non-selectable and drops links and forms.
- Watermark and page-number text uses Helvetica, so it supports Latin characters only.
- Legacy `.doc` Word files are not supported (`.docx` only).
- AVIF output depends on browser support. Unsupported formats are disabled in the UI.

## Author

Made by Kathan Somani
