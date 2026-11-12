/* Protect, Unlock and Repair PDF (qpdf compiled to WebAssembly, vendor/qpdf). Everything runs locally. */
(function () {
  "use strict";

  const T = window.Tools;
  const U = window.PdfUi;
  const C = window.PdfSecureCore;
  const $ = (id) => document.getElementById(id);

  // ---------- qpdf runner ----------

  /** Fresh instance per operation (callMain is not reliably re-callable). Never logs arguments. */
  async function runQpdf(args, bytes) {
    await U.loadScript("vendor/qpdf/qpdf.js");
    let log = "";
    const collect = (c) => { if (c !== null && c !== undefined && c !== 0) log += String.fromCharCode(c & 255); };
    let inst;
    try {
      inst = await window.Module({
        locateFile: () => new URL("vendor/qpdf/qpdf.wasm", location.href).href,
        noInitialRun: true,
        noFSInit: true,
      });
      inst.FS.init(null, collect, collect);
      inst.FS.writeFile(C.IN, bytes);
    } catch (e) {
      throw new Error("Could not start the PDF engine.");
    }
    let code = 0;
    try {
      const r = inst.callMain(args);
      if (typeof r === "number") code = r;
    } catch (e) {
      code = e && typeof e.status === "number" ? e.status : 2;
    }
    let data = null;
    try { data = inst.FS.readFile(C.OUT); } catch (e) { /* no output written */ }
    return { code, log, data: C.isSuccessExit(code) && data && data.length ? data : null };
  }

  async function isEncrypted(bytes) {
    const L = await U.lib();
    try {
      await L.PDFDocument.load(bytes, { updateMetadata: false });
      return false;
    } catch (e) {
      // Depending on the pdf-lib build this is an EncryptedPDFError or a plain Error with this message.
      return (L.EncryptedPDFError && e instanceof L.EncryptedPDFError) || /document .* is encrypted/i.test(String((e && e.message) || ""));
    }
  }

  const readBytes = async (file) => new Uint8Array(await file.arrayBuffer());

  function addLink(statusEl, href, text) {
    const a = document.createElement("a");
    a.href = href;
    a.textContent = text;
    statusEl.append(" ", a);
  }

  function fileLine(el, file) {
    el.textContent = `${file.name}, ${T.formatBytes(file.size)}`;
  }

  // ---------- Protect ----------
  (function protect() {
    const status = $("protect-status");
    const runBtn = $("protect-run");
    const pw = $("protect-pw");
    const confirm = $("protect-pw2");
    const owner = $("protect-owner");
    const toggle = $("protect-show");
    let cur = null;

    U.pdfZone("protect-drop", (file) => U.run(status, [runBtn], async () => {
      T.setStatus(status, "Reading...", "busy");
      const bytes = await readBytes(file);
      cur = null;
      runBtn.disabled = true;
      if (await isEncrypted(bytes)) {
        T.setStatus(status, "This PDF is already password-protected. Use Unlock first.", "error");
        addLink(status, "#unlock", "Open Unlock PDF");
        $("protect-info").textContent = "";
        return;
      }
      cur = { file, bytes };
      fileLine($("protect-info"), file);
      runBtn.disabled = false;
      T.setStatus(status, "", "idle");
    }), status);

    pw.addEventListener("input", () => { $("protect-strength").textContent = C.passwordStrength(pw.value); });
    toggle.addEventListener("click", () => {
      const show = pw.type === "password";
      [pw, confirm, owner].forEach((i) => { i.type = show ? "text" : "password"; });
      toggle.textContent = show ? "Hide" : "Show";
      toggle.setAttribute("aria-pressed", String(show));
    });

    runBtn.addEventListener("click", () => U.run(status, [runBtn], async () => {
      if (!cur) return;
      if (!pw.value) throw new Error("Enter a password.");
      if (pw.value !== confirm.value) throw new Error("The passwords do not match.");
      T.setStatus(status, "Encrypting...", "busy");
      const args = C.protectArgs({
        userPassword: pw.value,
        ownerPassword: owner.value,
        allowPrint: $("protect-print").checked,
        allowCopy: $("protect-copy").checked,
        allowModify: $("protect-edit").checked,
      });
      const r = await runQpdf(args, cur.bytes);
      if (!r.data) throw new Error("Could not protect this PDF.");
      T.download(r.data, C.outputName(cur.file.name, "protected"), "application/pdf");
      T.setStatus(status, `Protected with AES-256 (${T.formatBytes(r.data.length)})`, "ok");
    }));
  })();

  // ---------- Unlock ----------
  (function unlock() {
    const status = $("unlock-status");
    const runBtn = $("unlock-run");
    const pwField = $("unlock-pw-field");
    const pw = $("unlock-pw");
    let cur = null; // { file, bytes, ready: Uint8Array|null }

    function finish(data) {
      T.download(data, C.outputName(cur.file.name, "unlocked"), "application/pdf");
      T.setStatus(status, `Unlocked (${T.formatBytes(data.length)})`, "ok");
    }

    U.pdfZone("unlock-drop", (file) => U.run(status, [runBtn], async () => {
      T.setStatus(status, "Reading...", "busy");
      cur = null;
      runBtn.disabled = true;
      pwField.classList.add("is-hidden");
      pw.value = "";
      const bytes = await readBytes(file);
      if (!(await isEncrypted(bytes))) {
        $("unlock-info").textContent = "";
        T.setStatus(status, "This PDF is not protected.", "error");
        return;
      }
      fileLine($("unlock-info"), file);
      cur = { file, bytes, ready: null };
      // Permission-only PDFs open with an empty password.
      const r = await runQpdf(C.unlockArgs(""), bytes);
      if (r.data) {
        cur.ready = r.data;
        T.setStatus(status, "No password needed. Only restrictions are set.", "ok");
      } else if (C.isBadPassword(r.log)) {
        pwField.classList.remove("is-hidden");
        pw.focus();
        T.setStatus(status, "Enter the password to unlock this PDF.", "idle");
      } else {
        cur = null;
        throw new Error("Could not read this PDF.");
      }
      runBtn.disabled = false;
    }), status);

    runBtn.addEventListener("click", () => U.run(status, [runBtn], async () => {
      if (!cur) return;
      if (cur.ready) { finish(cur.ready); return; }
      if (!pw.value) throw new Error("Enter the password.");
      T.setStatus(status, "Unlocking...", "busy");
      const r = await runQpdf(C.unlockArgs(pw.value), cur.bytes);
      if (r.data) { finish(r.data); return; }
      throw new Error(C.isBadPassword(r.log) ? "Incorrect password" : "Could not unlock this PDF.");
    }));
    pw.addEventListener("keydown", (e) => { if (e.key === "Enter" && !runBtn.disabled) runBtn.click(); });
  })();

  // ---------- Repair ----------
  (function repair() {
    const status = $("repair-status");
    const runBtn = $("repair-run");
    let cur = null;

    /** The bundled qpdf cannot always rebuild a broken cross-reference table itself; pdf-lib
     *  re-reads the objects directly and rewrites a clean file, which qpdf then normalises. */
    async function rebuild(bytes) {
      const L = await U.lib();
      let doc;
      try {
        doc = await L.PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false });
      } catch (e) {
        if (e && e.name === "EncryptedPDFError") {
          const err = new Error("This PDF is password-protected. Unlock it first.");
          err.encrypted = true;
          throw err;
        }
        return null;
      }
      return new Uint8Array(await doc.save());
    }

    U.pdfZone("repair-drop", async (file) => {
      cur = { file, bytes: await readBytes(file) };
      fileLine($("repair-info"), file);
      runBtn.disabled = false;
      T.setStatus(status, "", "idle");
    }, status);

    runBtn.addEventListener("click", () => U.run(status, [runBtn], async () => {
      if (!cur) return;
      T.setStatus(status, "Repairing...", "busy");
      let note;
      let out;
      const first = await runQpdf(C.repairArgs(), cur.bytes);
      if (first.data) {
        out = first.data;
        const n = C.countWarnings(first.log);
        note = n ? `${n} problem${n === 1 ? "" : "s"} fixed` : "No problems found";
      } else {
        const rebuilt = await rebuild(cur.bytes);
        if (!rebuilt) throw new Error("This file is too damaged to repair.");
        const second = await runQpdf(C.repairArgs(), rebuilt);
        out = second.data || rebuilt;
        note = "Rebuilt the file structure";
      }
      T.download(out, C.outputName(cur.file.name, "repaired"), "application/pdf");
      T.setStatus(status, `${note} (${T.formatBytes(out.length)})`, "ok");
    }));
  })();
})();
