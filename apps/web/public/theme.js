// Applies the saved theme before first paint to avoid a flash. Kept as a file
// (not inline) so the Content-Security-Policy can forbid inline scripts.
try {
  var t = localStorage.getItem("drawpane:theme");
  var dark = t === "dark" || (t !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  if (dark) document.documentElement.dataset.theme = "dark";
} catch (e) {}
