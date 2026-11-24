// Menu icon names shared by the navigation and the SITE_LINKS validator.
// "svg" marks an icon the browser renders from inline SVG markup.
export const NAV_ICONS = Object.freeze({
  home: "🏠",
  queue: "🔧",
  registration: "🎫",
  energy: "⚡",
  notice: "💡",
  rules: "📖",
  forum: "svg",
  "queue-admin": "🛠️",
  "registration-admin": "🎛️",
  traffic: "🚦",
  entry: "🏁",
  sheet: "📋",
  score: "📊",
  course: "📍",
  auth: "🔑",
  email: "✉️",
  logs: "📜",
  pitbot: "💽",
  documents: "📄",
  "documents-admin": "📑",
  files: "📁",
  calendar: "📅",
});

export function isNavIcon(name) {
  return Object.hasOwn(NAV_ICONS, name);
}
