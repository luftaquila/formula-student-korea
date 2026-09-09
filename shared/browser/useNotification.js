import { toast } from "vue-sonner";

// notyf 호출부는 문자열 또는 옵션 객체({ message })를 넘긴다. 둘 다 받아 메시지만 추출.
function msgOf(arg) {
  return typeof arg === "string" ? arg : (arg && arg.message) || "";
}

// notyf 인스턴스 호환 shim.
// `const { notyf } = useNotification()` 후 `notyf.open({ type, message })`,
// `notyf.success(...)` 등을 직접 호출하는 기존 화면을 수정 없이 동작시킨다.
// sonner 는 메시지를 텍스트 노드로 렌더하므로 별도 HTML escape 불필요(XSS 안전).
const notyf = {
  success: (arg) => toast.success(msgOf(arg)),
  error: (arg) => toast.error(msgOf(arg)),
  warning: (arg) => toast.warning(msgOf(arg)),
  open: ({ type, message } = {}) => {
    const fn = type && typeof toast[type] === "function" ? toast[type] : toast.message;
    return fn(msgOf(message ?? ""));
  },
  dismiss: (id) => toast.dismiss(id),
};

export function useNotification() {
  return {
    notyf,
    success: (msg) => toast.success(msg),
    error: (msg) => toast.error(msg),
    warning: (msg) => toast.warning(msg),
  };
}
