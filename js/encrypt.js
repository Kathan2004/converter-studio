/* UI wiring for the Encrypt file tab (files.html). Crypto lives in crypto-core.js (Web Crypto only). */
(function () {
  "use strict";

  const K = window.CryptoCore;
  const T = window.Tools;
  const C = window.FilesCore;
  const $ = (id) => document.getElementById(id);
  const fmt = T.formatBytes;
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const panel = document.querySelector('[data-panel="encrypt"]');
  if (!panel || !K) return;

  const status = $("enc-status");
  const list = $("enc-list");
  const runBtn = $("enc-run");
  const zipBtn = $("enc-zip");
  const clearBtn = $("enc-clear");
  const pw = $("enc-password");
  const pw2 = $("enc-confirm");
  const strength = $("enc-strength");
  let items = []; // { file, mode: "encrypt" | "decrypt" | "unsupported", result, error, ui }
  let running = false;

  const cell = (tag, text, cls) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    el.textContent = text;
    return el;
  };

  function friendly(e) {
    if (e && e.code) return e.message;
    return "Could not process this file.";
  }

  function needsConfirm() { return items.some((i) => i.mode === "encrypt"); }

  function refresh() {
    const enc = items.filter((i) => i.mode === "encrypt").length;
    const dec = items.filter((i) => i.mode === "decrypt").length;
    runBtn.textContent = enc && dec ? "Run" : dec ? "Decrypt" : "Encrypt";
    runBtn.disabled = running || !items.some((i) => i.mode !== "unsupported");
    clearBtn.disabled = running || !items.length;
    zipBtn.disabled = running || items.filter((i) => i.result).length < 2;
    $("enc-confirm-field").classList.toggle("is-hidden", !needsConfirm());
    $("enc-pw-fields").classList.toggle("is-hidden", !items.length);
  }

  function updateStrength() {
    const s = K.passwordStrength(pw.value);
    strength.textContent = needsConfirm() && s.label ? s.label : "";
    strength.dataset.level = String(s.score);
  }

  function renderRow(item) {
    const u = item.ui;
    u.tag.textContent = item.mode === "decrypt" ? "Decrypt" : item.mode === "encrypt" ? "Encrypt" : "Unsupported";
    u.note.hidden = !(item.error || item.result);
    u.note.className = item.error ? "note error" : "note";
    u.note.textContent = item.error || (item.result ? `${item.result.name} (${fmt(item.result.blob.size)})` : "");
    u.dl.hidden = !item.result;
  }

  function buildRow(item) {
    const li = document.createElement("li");
    li.className = "file-item";
    const tag = cell("span", "", "meta");
    const dl = cell("button", "Download", "ghost");
    dl.type = "button";
    dl.hidden = true;
    dl.addEventListener("click", () => item.result && T.download(item.result.blob, item.result.name));
    const rm = cell("button", "Remove", "ghost");
    rm.type = "button";
    rm.setAttribute("aria-label", `Remove ${item.file.name}`);
    rm.addEventListener("click", () => { if (running) return; items = items.filter((i) => i !== item); li.remove(); refresh(); updateStrength(); });
    const note = cell("p", "", "note");
    note.hidden = true;
    li.append(cell("span", item.file.name, "name"), cell("span", fmt(item.file.size), "meta"), tag, dl, rm, note);
    item.ui = { li, tag, dl, note };
    return li;
  }

  async function add(files) {
    const refused = [];
    for (const file of files) {
      if (file.size > K.MAX_BYTES) { refused.push(file.name); continue; }
      const head = new Uint8Array(await file.slice(0, K.HEADER_LEN).arrayBuffer());
      const h = K.parseHeader(head);
      let mode = "encrypt";
      if (h) mode = h.supported ? "decrypt" : "unsupported";
      const item = { file, mode, result: null, error: h && !h.supported ? `Unsupported format version ${h.version}.` : "" };
      items.push(item);
      list.appendChild(buildRow(item));
      renderRow(item);
    }
    if (refused.length) T.setStatus(status, `Not added (over 1 GB): ${refused.join(", ")}`, "error");
    else T.setStatus(status, `${items.length} file${items.length === 1 ? "" : "s"} ready.`, "idle");
    refresh();
    updateStrength();
  }

  // Drop zone: own wiring because the shared helper rejects files over 200 MB (this tool allows 1 GB).
  const zone = $("enc-drop");
  const picker = document.createElement("input");
  picker.type = "file";
  picker.multiple = true;
  picker.className = "hidden-file-input";
  zone.after(picker);
  zone.setAttribute("role", "button");
  zone.tabIndex = 0;
  zone.addEventListener("click", () => picker.click());
  zone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); picker.click(); } });
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("is-over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("is-over"));
  zone.addEventListener("drop", (e) => { e.preventDefault(); zone.classList.remove("is-over"); add(Array.from(e.dataTransfer.files)); });
  picker.addEventListener("change", () => { add(Array.from(picker.files)); picker.value = ""; });

  $("enc-show").addEventListener("change", (e) => {
    const t = e.target.checked ? "text" : "password";
    pw.type = t;
    pw2.type = t;
  });
  pw.addEventListener("input", updateStrength);

  clearBtn.addEventListener("click", () => {
    if (running) return;
    items = [];
    list.textContent = "";
    T.setStatus(status, "", "idle");
    refresh();
    updateStrength();
  });

  runBtn.addEventListener("click", async () => {
    if (running) return;
    if (!pw.value) { T.setStatus(status, "Enter a password.", "error"); pw.focus(); return; }
    if (needsConfirm() && pw.value !== pw2.value) { T.setStatus(status, "The passwords do not match.", "error"); pw2.focus(); return; }
    running = true;
    refresh();
    let ok = 0;
    let failed = 0;
    try {
      const todo = items.filter((i) => i.mode !== "unsupported");
      for (let n = 0; n < todo.length; n++) {
        const item = todo[n];
        item.result = null;
        item.error = "";
        T.setStatus(status, `${item.mode === "decrypt" ? "Decrypting" : "Encrypting"} ${n + 1}/${todo.length}: ${item.file.name}`, "busy");
        await tick();
        try {
          const bytes = new Uint8Array(await item.file.arrayBuffer());
          if (item.mode === "encrypt") {
            const out = await K.encrypt(bytes, item.file.name, pw.value);
            item.result = { blob: new Blob([out], { type: "application/octet-stream" }), name: K.encryptedName(T.safeFilename(item.file.name)) };
          } else {
            const out = await K.decrypt(bytes, pw.value);
            item.result = { blob: new Blob([out.data]), name: out.name };
          }
          ok += 1;
        } catch (e) {
          item.error = friendly(e);
          failed += 1;
        }
        renderRow(item);
      }
      const last = items.find((i) => i.error);
      T.setStatus(status, failed && !ok ? last.error : `Done: ${ok} processed${failed ? `, ${failed} failed` : ""}.`, failed && !ok ? "error" : "ok");
    } catch (e) {
      T.setStatus(status, friendly(e), "error");
    } finally {
      running = false;
      refresh();
    }
  });

  zipBtn.addEventListener("click", async () => {
    const used = new Set();
    const files = items.filter((i) => i.result).map((i) => ({ name: C.uniquePath(used, i.result.name), data: i.result.blob }));
    if (files.length < 2) return;
    try {
      T.setStatus(status, "Building zip...", "busy");
      T.download(await T.zip(files), "files.zip", "application/zip");
      T.setStatus(status, `Zip with ${files.length} files downloaded.`, "ok");
    } catch (e) {
      T.setStatus(status, "Could not build the zip.", "error");
    }
  });

  refresh();
})();
