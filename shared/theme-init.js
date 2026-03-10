export function initTheme() {
  const saved = localStorage.getItem("theme");
  if (saved) {
    document.documentElement.setAttribute("data-theme", saved);
  } else {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.setAttribute("data-theme", prefersDark ? "dark" : "light");
  }

  window.addEventListener("storage", (e) => {
    if (e.key === "theme") {
      document.documentElement.setAttribute("data-theme", e.newValue || "light");
    }
  });
}
