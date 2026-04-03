export function initTestBanner() {
  if (!window.__TEST_SERVER__) return;

  document.documentElement.classList.add("test-server");

  // Visible h1 prefix via CSS
  const style = document.createElement("style");
  style.textContent = `.test-server .header h1::before { content: "\\26A0\\FE0F  TEST "; }`;
  document.head.appendChild(style);

  // document.title prefix
  const prefixTitle = () => {
    if (!document.title.startsWith("TEST ")) {
      document.title = `TEST ${document.title}`;
    }
  };
  prefixTitle();
  const titleEl = document.querySelector("title");
  if (titleEl) {
    new MutationObserver(prefixTitle).observe(titleEl, { childList: true });
  }

  // Favicon → ⚠️
  const link =
    document.querySelector('link[rel="icon"]') ||
    document.createElement("link");
  link.rel = "icon";
  link.href =
    "data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>%E2%9A%A0%EF%B8%8F</text></svg>";
  if (!link.parentElement) document.head.appendChild(link);
}
