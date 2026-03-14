import { Notyf } from "notyf";

let notyfInstance = null;

function getNotyf() {
  if (!notyfInstance) {
    notyfInstance = new Notyf({
      ripple: false,
      duration: 3500,
      types: [
        {
          type: "warning",
          background: "#f59e0b",
          icon: {
            className: "notyf__icon--warning",
            tagName: "i",
            text: "",
          },
        },
      ],
    });
  }
  return notyfInstance;
}

function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function useNotification() {
  const notyf = getNotyf();

  return {
    notyf,
    success: (message) => notyf.success(escapeHtml(message)),
    error: (message) => notyf.error(escapeHtml(message)),
  };
}
