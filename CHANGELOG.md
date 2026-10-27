# Changelog

All notable changes to this project are documented in this file.

## [2.0.0] - 2026-10-27

### Added

- Converter Studio: shared navigation, tool hub, and four new browser-only tool pages
- Data converters (`data.html`): JSON, CSV, TSV, Excel, YAML, XML, Markdown and HTML tables in any direction; JSON to formatted Excel with summary sheet; Excel to JSON/CSV; format and validate; JSON/YAML diff
- Document converters (`documents.html`): Markdown to PDF, Word and HTML; Word to Markdown, HTML and text; HTML to Markdown; PDF to text; text utilities
- Image tools (`images.html`): compress (quality or target size), convert (PNG, JPEG, WebP, AVIF, ICO), resize, crop and rotate, lossless EXIF/GPS and PNG metadata stripping, Base64
- PDF tools (`pdf.html`): merge, split, page editor, lossless and rasterised compression, images to PDF, PDF to images, watermark and page numbers, metadata editor
- Batch processing with zip download (`assets/shared.js` store-only zip writer)
- Vendored, pinned browser libraries listed in `vendor/VERSIONS.md`
- Unit tests for every core module, plus end-to-end browser tests that run each tool and verify its output files

### Security

- Site-wide Content-Security-Policy (`script-src 'self'`) and hardening headers in `netlify.toml`. The end-to-end tests serve pages with the production CSP.
- CSV and Excel formula-injection escaping, on by default
- All rendered HTML sanitised with DOMPurify
- Encrypted PDFs detected and rejected

## [1.0.0] - 2026-08-10

### Added

- Netlify-hosted Markdown to HTML workflow
- Live preview UI with drag-and-drop upload
- Serverless conversion endpoint for readable HTML export
- Simplified sober UI and footer attribution
- Repository documentation and versioning metadata
