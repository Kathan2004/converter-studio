# Converter Studio

Browser-based converters and compressors for Markdown, data, documents, images and PDFs. Every conversion runs locally in the browser: files are never uploaded, and all libraries are served from this repository (no third-party CDN). It is hosted on Netlify.

## Version

- Current version: `2.0.0`
- Release tag: `v2.0.0`

## Tools

| Page | Tools |
|---|---|
| `index.html` | **Markdown studio.** Live preview, TOC, HTML export through the serverless function, and the multi-file Markdown to JSON/Excel pipeline. |
| `data.html` | **Data converters.** JSON, CSV, TSV, Excel (.xlsx), YAML, XML, Markdown table and HTML table, in any direction. Also: **JSON to formatted Excel** (styled header, frozen row, filters, auto-fit, summary sheet, one sheet or one workbook per file), Excel to JSON/CSV, format and validate (with line and column of each error), and JSON/YAML structural diff. |
| `documents.html` | **Document converters.** Markdown to PDF, Word (.docx) and standalone HTML. Word to Markdown, HTML or text. HTML to Markdown. PDF to text. Text utilities: case conversion, line tools, Base64, URL encoding, word counts. |
| `images.html` | **Image tools.** Compress (quality or target size), convert (PNG, JPEG, WebP, AVIF, ICO), resize, crop and rotate, strip EXIF/GPS and PNG text metadata (lossless for JPEG and PNG), and image to and from Base64. All are batch tools with a zip download. |
| `pdf.html` | **PDF tools.** Merge PDFs and images, split by ranges or every N pages, reorder, delete or rotate pages, compress (lossless or rasterised), images to PDF, PDF to images, watermark and page numbers, and view, edit or strip metadata. |

Tools can be deep-linked by tab, for example `data.html#json-to-excel` or `pdf.html#compress`.

## Project Structure

- `index.html`, `ui.css`, `ui.js`: Markdown studio
- `data.html`, `documents.html`, `images.html`, `pdf.html`: converter pages
- `js/<group>-core.js`: pure conversion logic for each page, unit tested in Node
- `js/<group>.js`: UI wiring for each page
- `assets/shared.css`, `assets/shared.js`: shared layout, drop zones, tabs, downloads and the zip writer (`window.Tools`)
- `vendor/`: pinned browser libraries; versions are listed in [vendor/VERSIONS.md](vendor/VERSIONS.md)
- `netlify/functions/md_to_pdf.js`: serverless Markdown conversion function
- `netlify.toml`: Netlify build, function and header config

## Local Development

```bash
npm install
npm run dev        # Netlify dev server (function + static pages)
```

The converter pages are static. Any static file server works for them, for example `npx serve .`.

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

- **Local processing.** Files are processed in the browser with `File`, canvas and the vendored libraries. Nothing is uploaded.
- **Scripts.** Pages load scripts only from their own origin. A Content-Security-Policy in `netlify.toml` enforces this.
- **HTML rendering.** Rendered HTML (Markdown, Word and HTML input) goes through DOMPurify before it is displayed or exported. Data previews are escaped.
- **CSV and Excel injection.** Cells beginning with `=`, `+`, `-`, `@`, tab or carriage return are prefixed with `'` by default, so exported sheets cannot run formulas.
- **XML.** XML is parsed with the browser's `DOMParser`, which does not resolve external entities.
- **Encrypted PDFs.** These are detected and rejected with a clear message. Nothing tries to bypass protection.
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
- PDF to text has no OCR, so scanned PDFs without a text layer return no text.
- Rasterised PDF compression makes text non-selectable and drops links and forms.
- Watermark and page-number text uses Helvetica, so it supports Latin characters only.
- Legacy `.doc` Word files are not supported (`.docx` only).
- AVIF output depends on browser support. Unsupported formats are disabled in the UI.

## Author

Made by Kathan Somani
