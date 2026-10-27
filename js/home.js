/* Home page: drop or paste a file -> matching tools; popular tools grid; every tool on demand. */
(function () {
  "use strict";

  const Cat = window.Catalog;
  const T = window.Tools;
  const $ = (id) => document.getElementById(id);
  let pending = [];

  /** An icon tile for a tool. Icon markup comes from catalog constants only; the label is text. */
  function tile(tool, tag, index) {
    const el = document.createElement(tag);
    el.className = tag === "button" ? "chip" : "app-tile";
    if (tag === "a") el.href = tool.href;
    else el.type = "button";
    el.title = tool.name;
    el.style.animationDelay = `${Math.min(index, 20) * 25}ms`;
    el.innerHTML = T.toolIcon(tool, 60);
    el.append(tool.tile);
    return el;
  }

  // ---------- Popular + all tools ----------
  const featured = Cat.TOOLS.filter((t) => t.featured);
  featured.forEach((t, i) => $("featured").appendChild(tile(t, "a", i)));

  const allBtn = $("showAll");
  const all = $("allTools");
  allBtn.textContent = `All ${Cat.TOOLS.length} tools`;
  Cat.CATEGORIES.forEach((c) => {
    const section = document.createElement("section");
    const h = document.createElement("h2");
    h.textContent = c.name;
    const grid = document.createElement("div");
    grid.className = "app-grid";
    Cat.TOOLS.filter((t) => t.cat === c.id).forEach((t, i) => grid.appendChild(tile(t, "a", i)));
    section.append(h, grid);
    all.appendChild(section);
  });
  function setAll(open) {
    all.classList.toggle("is-hidden", !open);
    $("featured").classList.toggle("is-hidden", open);
    allBtn.setAttribute("aria-expanded", String(open));
    allBtn.textContent = open ? "Popular tools" : `All ${Cat.TOOLS.length} tools`;
  }
  allBtn.addEventListener("click", () => setAll(all.classList.contains("is-hidden")));
  if (location.hash === "#tools") setAll(true);

  // ---------- Drop / choose / paste ----------
  const drop = $("smartDrop");
  const input = $("homeFiles");
  const suggest = $("suggest");
  const chips = $("suggestChips");
  const meta = $("suggestMeta");

  async function openTool(tool) {
    try {
      await T.handoff.save(pending, tool.id);
    } catch (e) {
      // Storage blocked (private mode): the tool still opens; the file is added there again.
    }
    location.href = tool.href;
  }

  function showSuggestions(files) {
    pending = files;
    const tools = Cat.suggest(files.map((f) => f.name));
    meta.textContent = "";
    meta.append(files.length === 1 ? files[0].name : `${files.length} files`);
    if (!tools.length) meta.append(" - no tool takes this type");
    chips.textContent = "";
    tools.slice(0, 12).forEach((t, i) => {
      const b = tile(t, "button", i);
      b.addEventListener("click", () => openTool(t));
      chips.appendChild(b);
    });
    suggest.classList.remove("is-hidden");
    $("featured").classList.add("is-hidden");
    allBtn.classList.add("is-hidden");
    all.classList.add("is-hidden");
    const first = chips.querySelector("button");
    if (first) first.focus();
  }

  drop.addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    if (input.files.length) showSuggestions(Array.from(input.files));
    input.value = "";
  });

  let depth = 0;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
  document.addEventListener("dragenter", (e) => { if (hasFiles(e)) { depth += 1; drop.classList.add("is-over"); } });
  document.addEventListener("dragleave", (e) => { if (hasFiles(e) && --depth <= 0) { depth = 0; drop.classList.remove("is-over"); } });
  document.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    drop.classList.remove("is-over");
    const files = Array.from(e.dataTransfer.files);
    if (files.length) showSuggestions(files);
  });

  // A pasted screenshot goes straight to Image to text.
  document.addEventListener("paste", (e) => {
    if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    const files = Array.from((e.clipboardData && e.clipboardData.items) || [])
      .filter((it) => it.kind === "file" && /^image\//.test(it.type))
      .map((it, i) => {
        const f = it.getAsFile();
        const ext = (f.type.split("/")[1] || "png").replace("jpeg", "jpg");
        return new File([f], f.name && f.name !== "image.png" ? f.name : `pasted-image-${i + 1}.${ext}`, { type: f.type });
      });
    if (!files.length) return;
    e.preventDefault();
    pending = files;
    openTool(Cat.TOOLS.find((t) => t.id === "images/ocr"));
  });
})();
