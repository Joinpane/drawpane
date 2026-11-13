// Applies the saved theme before first paint to avoid a flash. Kept as a file
// (not inline) so the Content-Security-Policy can forbid inline scripts.
(() => {
  try {
    const saved = localStorage.getItem("drawpane:theme");
    const dark =
      saved === "dark" || (saved !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
    if (dark) document.documentElement.dataset.theme = "dark";
  } catch {
    // Storage can be blocked; the system theme still applies via CSS.
  }
})();
