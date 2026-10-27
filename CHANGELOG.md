# Changelog

All notable changes to this project are documented in this file.

## [2.2.0] - 2026-10-27

### Added

- Light/Dark toggle in the menu bar, remembered on the device and applied before the page paints (first visit starts in the device's mode). Switching is seamless: the new theme grows as a circle from the toggle, with a colour cross-fade where View Transitions are unavailable or motion is reduced

### Changed

- Tool pages follow the home page design: centered icon and title, the category's tools as pills, and a soft glow in the category colour
- Quieter controls: outlined secondary buttons, list-row actions as text links, Apple-style pop-up menus, file icons in lists, category-tinted drop zones, stat tiles for results, a floating page grid in the PDF page editor
- Less fine print: static notes under tools are hidden; live warnings and results stay
- Image to text: one drop target that also takes a pasted screenshot

### Fixed

- Tool pages were wider than a phone screen (the tool row stretched the layout) and showed a large empty gap above the title

## [2.1.0] - 2026-10-27

### Changed

- New minimalist "Glass" interface in the style of Apple's design language: system font, Apple system colours, translucent blurred surfaces with hairline borders, iOS-style grouped tool lists and a Spotlight-style search. Light and dark follow the device setting; motion and transparency respect the reduced-motion and reduced-transparency settings.
- Navigation rebuilt around one tool catalog: drop a file on the home page to get matching tools, a Spotlight-style `Ctrl K` search on every page, and a sidebar per category
- Dropping a file anywhere on a tool page loads it into the open tool. Files chosen on the home page open in the picked tool already loaded.
- The single-file Markdown studio is removed (Documents covers Markdown to HTML, PDF and Word). The batch Markdown to JSON/Excel pipeline moved to `markdown.html`.

### Added

- Image to text (OCR): paste a screenshot, drop images or scanned PDFs, then copy the text. It runs locally with Tesseract and the English model.
- Files page: ZIP files and whole folders with real deflate (levels 0 to 9, already-compressed formats stored), extract ZIP with preview and selective download, gzip and gunzip, and MD5, SHA-1, SHA-256 and SHA-512 hashes with expected-hash matching
- End-to-end tests for the home page handoff, search palette, sidebar, Files tools and OCR

### Security

- Zip-bomb limits and entry-name sanitisation for archives
- CSP allows `'wasm-unsafe-eval'` for the OCR engine only; `eval` remains blocked
- Google Fonts removed (system fonts only): pages make no third-party requests, and the CSP allows no external origin
- Google Fonts removed (system fonts only), so pages make no third-party requests at all and the CSP no longer allows any external origin

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
