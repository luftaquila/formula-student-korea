export const KIOSK_FULLSCREEN_CLASS = "kiosk-fullscreen";

export function isFullscreenSupported(documentLike = globalThis.document) {
  return typeof documentLike?.documentElement?.requestFullscreen === "function"
    && typeof documentLike?.exitFullscreen === "function";
}

export function syncFullscreenLayout(documentLike = globalThis.document) {
  const fullscreen = !!documentLike?.fullscreenElement;
  documentLike?.body?.classList?.toggle(KIOSK_FULLSCREEN_CLASS, fullscreen);
  return fullscreen;
}

export function clearFullscreenLayout(documentLike = globalThis.document) {
  documentLike?.body?.classList?.remove(KIOSK_FULLSCREEN_CLASS);
}

export async function toggleFullscreen(documentLike = globalThis.document) {
  if (!isFullscreenSupported(documentLike)) {
    throw new Error("Fullscreen API is unavailable");
  }
  if (documentLike.fullscreenElement) {
    await documentLike.exitFullscreen();
  } else {
    await documentLike.documentElement.requestFullscreen();
  }
}
