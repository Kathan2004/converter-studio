# Vendored browser libraries

All conversions run in the browser. These files are copied verbatim from npm and served from this origin (no third-party CDN).

| File | Package | Version | Global |
|---|---|---|---|
| exceljs.min.js | exceljs | 4.4.0 | `ExcelJS` |
| js-yaml.min.js | js-yaml | 4.3.2 | `jsyaml` |
| pdf-lib.min.js | pdf-lib | 1.17.1 | `PDFLib` |
| pdf.min.mjs, pdf.worker.min.mjs | pdfjs-dist (legacy build) | 4.10.38 | ES module import |
| mammoth.browser.min.js | mammoth | 1.13.0 | `mammoth` |
| docx.iife.js | docx | 9.14.0 | `docx` |
| turndown.js | turndown | 7.2.4 | `TurndownService` |
| purify.min.js | dompurify | 3.4.17 | `DOMPurify` |
| marked.min.js | marked | 14.1.4 | `marked` |
| fflate.min.js | fflate (UMD build) | 0.8.3 | `fflate` |
| tesseract/tesseract.min.js, tesseract/worker.min.js | tesseract.js | 5.1.1 | `Tesseract` |
| tesseract/core/*.wasm.js | tesseract.js-core (LSTM builds, SIMD and non-SIMD) | 5.1.1 | loaded by the OCR worker |
| tesseract/lang/eng.traineddata.gz | @tesseract.js-data/eng (4.0.0_best_int) | 1.0.0 | English OCR model |
| jspdf.umd.min.js, html2canvas.min.js, jspdf.plugin.autotable.min.js | pre-existing | - | `jspdf`, `html2canvas` |
