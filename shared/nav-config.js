export const services = [
  { name: "홈", href: "/", icon: "home" },
  { name: "검차 대기열", href: "/queue", icon: "queue" },
  { name: "에너지미터", href: "/energymeter", icon: "energy" },
  { name: "규정집", href: "/rules", icon: "rules" },
];

export const officials = [
  { name: "검차 관리", href: "/queue/admin", icon: "queue-admin" },
  { name: "계측 시스템", href: "/traffic", icon: "traffic" },
  { name: "경기 기록", href: "/record", icon: "record" },
  { name: "엔트리 관리", href: "/entry", icon: "entry" },
];

export const icons = {
  home: "🏠",
  queue: "🔧",
  energy: "⚡",
  rules: "📖",
  "queue-admin": "🛠️",
  traffic: "🚦",
  record: "📊",
  entry: "🏁",
};

export function getIcon(type) {
  return icons[type] || "📌";
}
