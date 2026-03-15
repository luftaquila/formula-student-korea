import { Notyf } from "notyf";

let notyfInstance = null;

function getNotyf() {
  if (!notyfInstance) {
    notyfInstance = new Notyf({
      ripple: false,
      duration: 3500,
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
    error: (message) => notyf.error(escapeHtml(message)),
  };
}
