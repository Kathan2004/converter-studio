/* Apply the saved theme before the page paints (loaded in <head>, so there is no light/dark flash). */
(function () {
  try {
    var t = localStorage.getItem("converter-studio-theme");
    if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  } catch (e) { /* storage blocked: follow the device */ }
})();
